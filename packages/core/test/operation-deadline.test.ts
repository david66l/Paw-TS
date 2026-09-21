import { expect, test } from "bun:test";
import { createOperationDeadline } from "../src/operation-deadline.js";

test("deadline settles an uncooperative operation and consumes its late rejection", async () => {
  let rejectLate!: (error: Error) => void;
  const deadline = createOperationDeadline(undefined, 15);
  try {
    await expect(
      deadline.run(
        () =>
          new Promise((_, reject) => {
            rejectLate = reject;
          }),
      ),
    ).rejects.toMatchObject({ name: "TimeoutError" });
    expect(deadline.timedOut).toBe(true);
    expect(deadline.signal.aborted).toBe(true);
    rejectLate(new Error("late failure"));
    await Promise.resolve();
  } finally {
    deadline.dispose();
  }
});

test("parent cancellation stops a hanging operation and prevents subsequent stages", async () => {
  const parent = new AbortController();
  const reason = new Error("user stopped");
  const deadline = createOperationDeadline(parent.signal, 1000);
  try {
    const pending = deadline.run(() => {
      parent.abort(reason);
      return new Promise(() => {});
    });
    await expect(pending).rejects.toBe(reason);
    expect(deadline.timedOut).toBe(false);
    let nextCalls = 0;
    await expect(
      deadline.run(() => {
        nextCalls++;
      }),
    ).rejects.toBe(reason);
    expect(nextCalls).toBe(0);
  } finally {
    deadline.dispose();
  }
});

test("successful stages share the original deadline and do not reset it", async () => {
  const deadline = createOperationDeadline(undefined, 20);
  try {
    expect(await deadline.run(() => 1)).toBe(1);
    await new Promise((resolve) => setTimeout(resolve, 35));
    let calls = 0;
    await expect(
      deadline.run(() => {
        calls++;
        return 2;
      }),
    ).rejects.toMatchObject({ name: "TimeoutError" });
    expect(calls).toBe(0);
  } finally {
    deadline.dispose();
  }
});

test("success and synchronous exceptions cleanly release cancellation listeners", async () => {
  const parent = new AbortController();
  const deadline = createOperationDeadline(parent.signal, 1000);
  expect(await deadline.run(() => 42)).toBe(42);
  await expect(
    deadline.run(() => {
      throw new Error("fixture");
    }),
  ).rejects.toThrow("fixture");
  deadline.dispose();
  parent.abort();
  expect(deadline.signal.aborted).toBe(false);
  await expect(deadline.run(() => 0)).rejects.toThrow("disposed");
});
