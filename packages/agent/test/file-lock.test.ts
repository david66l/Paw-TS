import { describe, expect, test } from "bun:test";
import {
  FileLockManager,
  normalizeLockPath,
} from "../src/orchestrator/file-lock.js";

describe("normalizeLockPath", () => {
  test("去 ./ 前缀、统一分隔符", () => {
    expect(normalizeLockPath("./src/a.ts")).toBe("src/a.ts");
    expect(normalizeLockPath("src\\a.ts")).toBe("src/a.ts");
    expect(normalizeLockPath("a.ts")).toBe("a.ts");
  });
});

describe("FileLockManager", () => {
  test("获取与释放", () => {
    const m = new FileLockManager();
    expect(m.tryAcquire(["a.ts"], "dog-1").ok).toBe(true);
    expect(m.holderOf("a.ts")).toBe("dog-1");
    m.releaseAll("dog-1");
    expect(m.holderOf("a.ts")).toBeUndefined();
    expect(m.size).toBe(0);
  });

  test("冲突：他人占用返回 holder 与 path；同 owner 幂等", () => {
    const m = new FileLockManager();
    m.tryAcquire(["src/x.ts"], "dog-1");
    const conflict = m.tryAcquire(["src/x.ts"], "dog-2");
    expect(conflict.ok).toBe(false);
    expect(conflict.holder).toBe("dog-1");
    expect(conflict.path).toBe("src/x.ts");
    // 同 owner 重复获取不阻塞
    expect(m.tryAcquire(["src/x.ts"], "dog-1").ok).toBe(true);
    // 路径写法不同也判同一把锁
    const conflict2 = m.tryAcquire(["./src/x.ts"], "dog-2");
    expect(conflict2.ok).toBe(false);
  });

  test("多文件原子获取：一个不自由则整批失败", () => {
    const m = new FileLockManager();
    m.tryAcquire(["b.ts"], "dog-1");
    const r = m.tryAcquire(["a.ts", "b.ts"], "dog-2");
    expect(r.ok).toBe(false);
    // a.ts 未被部分占用
    expect(m.holderOf("a.ts")).toBeUndefined();
  });

  test("acquire 等待：持有者释放后获得", async () => {
    const m = new FileLockManager();
    m.tryAcquire(["x.ts"], "dog-1");
    setTimeout(() => m.releaseAll("dog-1"), 120);
    let waited = 0;
    const r = await m.acquire(["x.ts"], "dog-2", 2000, () => waited++);
    expect(r.ok).toBe(true);
    expect(waited).toBe(1);
    expect(m.holderOf("x.ts")).toBe("dog-2");
  });

  test("acquire 超时返回冲突", async () => {
    const m = new FileLockManager();
    m.tryAcquire(["x.ts"], "dog-1");
    const r = await m.acquire(["x.ts"], "dog-2", 150);
    expect(r.ok).toBe(false);
    expect(r.holder).toBe("dog-1");
  });

  test("releaseAll 只释放指定 owner", () => {
    const m = new FileLockManager();
    m.tryAcquire(["a.ts"], "dog-1");
    m.tryAcquire(["b.ts"], "dog-2");
    m.releaseAll("dog-1");
    expect(m.holderOf("a.ts")).toBeUndefined();
    expect(m.holderOf("b.ts")).toBe("dog-2");
  });
});
