import { describe, expect, test } from "bun:test";

import { type ToolClassificationV1, ToolResourceLockV1 } from "../src/index.js";

describe("Paw Next global tool resource lock", () => {
  test("compatible reads overlap but read/write and write/write serialize", async () => {
    const lock = new ToolResourceLockV1();
    const signal = new AbortController().signal;
    const readOne = await lock.acquire(classification("read"), signal);
    const readTwo = await lock.acquire(classification("read"), signal);

    let writeAcquired = false;
    const write = lock
      .acquire(classification("write"), signal)
      .then((lease) => {
        writeAcquired = true;
        return lease;
      });
    await Promise.resolve();
    expect(writeAcquired).toBe(false);
    readOne.release();
    await Promise.resolve();
    expect(writeAcquired).toBe(false);
    readTwo.release();
    const writeLease = await write;
    expect(writeAcquired).toBe(true);

    let secondWriteAcquired = false;
    const secondWrite = lock
      .acquire(classification("write"), signal)
      .then((lease) => {
        secondWriteAcquired = true;
        return lease;
      });
    await Promise.resolve();
    expect(secondWriteAcquired).toBe(false);
    writeLease.release();
    (await secondWrite).release();
  });

  test("workspace-wide shell excludes other resources and aborted wait never runs", async () => {
    const lock = new ToolResourceLockV1();
    const signal = new AbortController().signal;
    const shell = await lock.acquire(
      {
        lockDomain: "/repo",
        effectClass: "unknown",
        permissionCategory: "shell",
        concurrencyMode: "exclusive",
        resources: [{ key: "/repo/*", access: "write" }],
      },
      signal,
    );
    const waitingAbort = new AbortController();
    const waiting = lock.acquire(classification("read"), waitingAbort.signal);
    waitingAbort.abort();
    await expect(waiting).rejects.toThrow("cancelled");
    shell.release();
    const next = await lock.acquire(classification("read"), signal);
    next.release();
  });

  test("different workspace domains never block each other", async () => {
    const lock = new ToolResourceLockV1();
    const signal = new AbortController().signal;
    const first = await lock.acquire(classification("write"), signal);
    const second = await lock.acquire(
      {
        ...classification("write"),
        lockDomain: "/another-repo",
        resources: [{ key: "/another-repo/a.txt", access: "write" }],
      },
      signal,
    );
    second.release();
    first.release();
  });

  test("a queued writer in one workspace does not head-of-line block another workspace", async () => {
    const lock = new ToolResourceLockV1();
    const signal = new AbortController().signal;
    const activeA = await lock.acquire(classification("write"), signal);
    const waitingA = lock.acquire(classification("write"), signal);
    let acquiredB = false;
    const leaseB = await lock
      .acquire(
        {
          ...classification("write"),
          lockDomain: "/repo-b",
          resources: [{ key: "/repo-b/a.txt", access: "write" }],
        },
        signal,
      )
      .then((lease) => {
        acquiredB = true;
        return lease;
      });

    expect(acquiredB).toBe(true);
    leaseB.release();
    activeA.release();
    (await waitingA).release();
  });
});

function classification(access: "read" | "write"): ToolClassificationV1 {
  return {
    lockDomain: "/repo",
    effectClass: access,
    permissionCategory: access,
    concurrencyMode: access === "read" ? "parallel" : "exclusive",
    resources: [{ key: "/repo/a.txt", access }],
  };
}
