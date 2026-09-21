import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createOperationDeadline } from "@paw/core";
import { getSql } from "@paw/memory/db";

export interface MemoryJobLocator {
  workspaceRoot: string;
  runId: string;
  configHash: string;
  sourceThroughSeq: number;
}
export interface MemoryJob extends MemoryJobLocator {
  id: string;
  token: string;
  attempts: number;
}
export interface MemoryJobStore {
  put(id: string, locator: MemoryJobLocator): Promise<void>;
  claim(): Promise<MemoryJob | undefined>;
  finish(
    job: MemoryJob,
    status: "completed" | "retry" | "blocked",
    reasonCode?: string,
  ): Promise<void>;
}
function parseLocator(value: unknown): MemoryJobLocator {
  const v = value as MemoryJobLocator;
  if (
    !v ||
    Object.keys(v).sort().join(",") !== "configHash,runId,sourceThroughSeq,workspaceRoot" ||
    typeof v.workspaceRoot !== "string" ||
    !path.isAbsolute(v.workspaceRoot) ||
    !/^desktop-next-[\w-]+$/.test(v.runId) ||
    !/^[a-f0-9]{64}$/.test(v.configHash) ||
    !Number.isSafeInteger(v.sourceThroughSeq) ||
    v.sourceThroughSeq <= 0
  )
    throw new Error("InvalidMemoryJobLocator");
  return {
    workspaceRoot: v.workspaceRoot,
    runId: v.runId,
    configHash: v.configHash,
    sourceThroughSeq: v.sourceThroughSeq,
  };
}
function identity(v: MemoryJobLocator) {
  return createHash("sha256")
    .update(JSON.stringify(parseLocator(v)))
    .digest("hex");
}

/** Synchronous local ingress survives an unavailable DB and contains no credentials. */
export function enqueueDesktopMemoryJob(directory: string, locator: MemoryJobLocator): string {
  const value = parseLocator(locator);
  fs.mkdirSync(directory, { recursive: true });
  const id = identity(value);
  const target = path.join(directory, `${id}.json`);
  const temporary = path.join(directory, `${id}.${randomUUID()}.tmp`);
  fs.writeFileSync(temporary, JSON.stringify(value), {
    mode: 0o600,
    flag: "wx",
  });
  try {
    try {
      fs.linkSync(temporary, target);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
  } finally {
    fs.unlinkSync(temporary);
  }
  return id;
}

export function postgresMemoryJobStore(
  hostId = createHash("sha256")
    .update(JSON.stringify([os.hostname(), os.userInfo().username, fs.realpathSync(process.cwd())]))
    .digest("hex"),
): MemoryJobStore {
  return {
    async put(id, locator) {
      if (id !== identity(locator)) throw new Error("MemoryJobIdentityMismatch");
      await getSql()`INSERT INTO desktop_memory_jobs (id,host_id,locator) VALUES (${`${hostId}:${id}`},${hostId},${getSql().json({ ...locator })}) ON CONFLICT (id) DO NOTHING`;
    },
    async claim() {
      const sql = getSql();
      await sql`UPDATE desktop_memory_jobs SET status='dead', reason_code='MemoryRetryExhausted', updated_at=now() WHERE host_id=${hostId} AND status='running' AND lease_until<=now() AND attempts>=3`;
      const token = randomUUID();
      const rows = await sql`WITH due AS (
        SELECT id FROM desktop_memory_jobs WHERE host_id=${hostId} AND attempts<3 AND
          ((status='pending' AND available_at<=now()) OR (status='running' AND lease_until<=now()))
        ORDER BY available_at,id FOR UPDATE SKIP LOCKED LIMIT 1
      ) UPDATE desktop_memory_jobs j SET status='running', attempts=j.attempts+1, lease_token=${token}, lease_until=now()+interval '90 seconds', updated_at=now()
        FROM due WHERE j.id=due.id RETURNING j.id,j.locator,j.attempts`;
      const row = rows[0];
      if (!row) return undefined;
      const locator = parseLocator(row.locator);
      if (row.id !== `${hostId}:${identity(locator)}`) throw new Error("MemoryJobIdentityMismatch");
      return {
        ...locator,
        id: row.id as string,
        token,
        attempts: Number(row.attempts),
      };
    },
    async finish(job, status, reasonCode) {
      const state =
        status === "completed"
          ? "completed"
          : status === "blocked" || job.attempts >= 3
            ? "dead"
            : "pending";
      await getSql()`UPDATE desktop_memory_jobs SET status=${state}, reason_code=${reasonCode?.slice(0, 160) ?? null},
        available_at=now()+${Math.min(300, 30 * 2 ** (job.attempts - 1))} * interval '1 second',
        lease_token=NULL, lease_until=NULL, updated_at=now()
        WHERE id=${job.id} AND status='running' AND lease_token=${job.token} AND lease_until>now()`;
    },
  };
}

/** One idle worker. PostgreSQL leases schedule; the run lease authorizes journal/store work. */
export function createDesktopMemoryWorker(input: {
  directory: string;
  store: MemoryJobStore;
  idle: () => boolean;
  run: (
    job: MemoryJob,
    signal: AbortSignal,
  ) => Promise<{
    status: "completed" | "retry" | "blocked";
    reasonCode?: string;
  }>;
}) {
  let active = false;
  let stopped = false;
  let abort: AbortController | undefined;
  let execution: Promise<unknown> | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  async function tick() {
    if (stopped || active || execution || !input.idle()) return;
    active = true;
    try {
      const files = fs.existsSync(input.directory)
        ? fs
            .readdirSync(input.directory)
            .filter((name) => /^[a-f0-9]{64}\.json$/.test(name))
            .slice(0, 128)
        : [];
      for (const name of files) {
        if (stopped || !input.idle()) return;
        const file = path.join(input.directory, name);
        const stat = fs.lstatSync(file);
        if (!stat.isFile() || stat.size > 8192) continue;
        let value: MemoryJobLocator;
        try {
          value = parseLocator(JSON.parse(fs.readFileSync(file, "utf8")));
          if (`${identity(value)}.json` !== name) continue;
        } catch {
          continue;
        }
        await input.store.put(identity(value), value);
        fs.unlinkSync(file);
      }
      if (stopped || !input.idle()) return;
      const job = await input.store.claim();
      if (!job) return;
      if (stopped || !input.idle()) {
        await input.store.finish(job, "retry", "MemoryForegroundRequested");
        return;
      }
      abort = new AbortController();
      const operation = createOperationDeadline(abort.signal, 40_000);
      try {
        if (stopped) abort.abort();
        const result = await operation.run((signal) => {
          const task = input.run(job, signal);
          execution = task;
          void task
            .finally(() => {
              if (execution === task) execution = undefined;
            })
            .catch(() => {});
          return task;
        });
        await input.store.finish(job, result.status, result.reasonCode);
      } catch {
        await input.store.finish(
          job,
          "retry",
          operation.signal.aborted ? "MemoryJobInterrupted" : "MemoryJobFailed",
        );
      } finally {
        operation.dispose();
        abort = undefined;
      }
    } finally {
      active = false;
    }
  }
  function schedule() {
    if (stopped) return;
    timer = setTimeout(async () => {
      try {
        await tick();
      } catch {
        /* Durable ingress/jobs remain for the next bounded poll. */
      } finally {
        schedule();
      }
    }, 30_000);
    timer.unref?.();
  }
  return {
    tick,
    start: schedule,
    async yieldToForeground() {
      // The scheduler's abort race can finish before the runtime releases its
      // journal lease. Wait for that actual cleanup before starting foreground work.
      const pending = execution;
      abort?.abort(new Error("MemoryForegroundRequested"));
      if (!pending) return;
      const join = createOperationDeadline(new AbortController().signal, 40_000);
      try {
        await join.run(() => pending.catch(() => {}));
      } finally {
        join.dispose();
      }
    },
    stop() {
      stopped = true;
      if (timer) clearTimeout(timer);
      abort?.abort(new Error("MemoryWorkerStopped"));
    },
  };
}
