import { expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { closeSql, getSql } from "@paw/memory/db";
import { enqueueDesktopMemoryJob, postgresMemoryJobStore } from "../agent-host/memory-jobs.js";

test.skipIf(process.env.PAW_TEST_MEMORY_JOBS_DB !== "1")(
  "PostgreSQL isolates machines, fences stale workers, respects backoff and caps crash recovery",
  async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "paw-memory-jobs-db-"));
    const host = `test-${randomUUID()}`;
    const otherHost = `test-${randomUUID()}`;
    const sql = getSql();
    const store = postgresMemoryJobStore(host);
    const other = postgresMemoryJobStore(otherHost);
    const locator = {
      workspaceRoot: root,
      runId: "desktop-next-test",
      configHash: "b".repeat(64),
      sourceThroughSeq: 10,
    };
    const id = enqueueDesktopMemoryJob(root, locator);
    let cleanupFailure: Error | undefined;
    try {
      await store.put(id, locator);
      await store.put(id, locator);
      expect(await other.claim()).toBeUndefined();
      const claims = await Promise.all([store.claim(), store.claim()]);
      expect(claims.filter(Boolean)).toHaveLength(1);
      const first = claims.find(Boolean)!;
      await sql`UPDATE desktop_memory_jobs SET lease_until=now()-interval '1 second' WHERE id=${first.id}`;
      const resumed = await postgresMemoryJobStore(host).claim();
      expect(resumed?.attempts).toBe(2);
      await store.finish(first, "completed");
      expect(
        (await sql`SELECT status FROM desktop_memory_jobs WHERE id=${first.id}`)[0]?.status,
      ).toBe("running");
      await store.finish(resumed!, "retry", "ProviderBusy");
      expect(await store.claim()).toBeUndefined();
      await sql`UPDATE desktop_memory_jobs SET available_at=now()-interval '1 second' WHERE id=${first.id}`;
      const last = await store.claim();
      expect(last?.attempts).toBe(3);
      await sql`UPDATE desktop_memory_jobs SET lease_until=now()-interval '1 second' WHERE id=${first.id}`;
      expect(await store.claim()).toBeUndefined();
      expect(
        (await sql`SELECT status,attempts FROM desktop_memory_jobs WHERE id=${first.id}`)[0],
      ).toMatchObject({ status: "dead", attempts: 3 });
      const secondLocator = { ...locator, sourceThroughSeq: 11 };
      const secondId = enqueueDesktopMemoryJob(root, secondLocator);
      await other.put(secondId, secondLocator);
      expect(await store.claim()).toBeUndefined();
      const completed = await other.claim();
      expect(completed).toBeDefined();
      await other.finish(completed!, "completed");
      await other.put(secondId, secondLocator);
      expect(await other.claim()).toBeUndefined();
    } finally {
      await sql`DELETE FROM desktop_memory_jobs WHERE host_id IN (${host},${otherHost})`;
      await closeSql();
      if (
        path.dirname(root) !== path.resolve(os.tmpdir()) ||
        !path.basename(root).startsWith("paw-memory-jobs-db-")
      ) {
        cleanupFailure = new Error("Unexpected fixture path");
      } else {
        fs.rmSync(root, { recursive: true, force: true });
      }
    }
    if (cleanupFailure) throw cleanupFailure;
  },
);
