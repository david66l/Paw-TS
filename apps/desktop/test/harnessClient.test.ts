import { describe, expect, test } from "bun:test";

import { waitForRequestId } from "../src/agent/harnessClient";

/**
 * 这三个用例对应原实现里的三个坑（见 `waitForRequestId` 的文档注释）：
 * TDZ 的 `off`、`subscribe` 抛异常时挂死的 promise 与未清的定时器、
 * 以及同步回调时漏掉的订阅释放。
 */
describe("waitForRequestId", () => {
  test("匹配到 requestId 才 resolve，并释放订阅", async () => {
    let released = false;
    const payload = { requestId: "r2", value: 1 };
    const result = await waitForRequestId<{ requestId: string; value: number }>(
      "r2",
      (cb) => {
        cb({ requestId: "r1", value: 0 }); // 不匹配的那条应当被忽略
        queueMicrotask(() => cb(payload));
        return () => {
          released = true;
        };
      },
      50,
    );
    expect(result).toEqual(payload);
    expect(released).toBe(true);
  });

  test("subscribe 抛异常时 reject，而不是永远挂着", async () => {
    await expect(
      waitForRequestId("r1", () => {
        throw new Error("bridge unavailable");
      }),
    ).rejects.toThrow("bridge unavailable");
  });

  test("同步回调也能释放订阅（回调早于句柄赋值）", async () => {
    let released = false;
    const result = await waitForRequestId<{ requestId: string }>("sync", (cb) => {
      cb({ requestId: "sync" });
      return () => {
        released = true;
      };
    });
    expect(result).toEqual({ requestId: "sync" });
    expect(released).toBe(true);
  });

  test("超时后 reject，且不会因为引用未赋值的 off 而抛出别的错", async () => {
    await expect(waitForRequestId("never", () => () => {}, 10)).rejects.toThrow("请求超时");
  });
});
