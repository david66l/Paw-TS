import { describe, expect, test } from "bun:test";

import {
  ArtifactRegistry,
  ARCHIVE_STUB_PATTERN,
  DEFAULT_ARCHIVE_OPTIONS,
  parseArchiveStub,
  simpleHash,
} from "../src/index.js";

const meta = (over: Partial<{ tool: string; ok: boolean; turn: number; callerText?: string }> = {}) => ({
  tool: over.tool ?? "workspace.run_shell",
  ok: over.ok ?? true,
  turn: over.turn ?? 3,
  ...(over.callerText !== undefined ? { callerText: over.callerText } : {}),
});

describe("ArtifactRegistry — P3 冷库", () => {
  test("AC-P3-1 store 去重：相同内容共享同一 id", () => {
    const r = new ArtifactRegistry();
    const content = "git status output\n".repeat(500);
    const a = r.store(content, meta());
    const b = r.store(content, meta({ turn: 9 }));
    expect(a).toBe(b);
    expect(r.size).toBe(1);
    const e = r.get(a!);
    expect(e?.content).toBe(content);
  });

  test("AC-P3-2 元数据：turn / tool / ok / size / preview", () => {
    const r = new ArtifactRegistry();
    const content = "line1\nline2\nline3\n".repeat(50);
    const id = r.store(content, meta({ tool: "workspace.grep", ok: false, turn: 7 }));
    const e = r.get(id!);
    expect(e?.tool).toBe("workspace.grep");
    expect(e?.ok).toBe(false);
    expect(e?.turn).toBe(7);
    expect(e?.size).toBe(content.length);
    expect(e?.preview.length).toBeGreaterThan(0);
    expect(e?.preview).not.toContain("\n");
  });

  test("AC-P3-3 动作+结果配对：callerText 保留", () => {
    const r = new ArtifactRegistry();
    const id = r.store("big output".repeat(100), meta({ callerText: "run_shell: npm test" }));
    expect(r.get(id!)?.callerText).toBe("run_shell: npm test");
  });

  test("AC-P3-6 超长取回：head / tail / chunk 分块游标不重叠、可重建", () => {
    const r = new ArtifactRegistry();
    const content = "0123456789".repeat(2_000); // 20K
    const id = r.store(content, meta())!;

    r.startTurn(1);
    const head = r.tryRecall(id, { part: "head", limit: 8_000 });
    expect(head.ok).toBe(true);
    expect(head.window?.total).toBe(20_000);
    expect(head.content).toBe(content.slice(0, 8_000));

    r.startTurn(2);
    const c1 = r.tryRecall(id, { part: "chunk", offset: 8_000, limit: 8_000 });
    expect(c1.ok).toBe(true);
    expect(c1.content).toBe(content.slice(8_000, 16_000));

    r.startTurn(3);
    const c2 = r.tryRecall(id, { part: "chunk", offset: 16_000, limit: 8_000 });
    expect(c2.content).toBe(content.slice(16_000, 20_000));

    r.startTurn(4);
    const tail = r.tryRecall(id, { part: "tail", limit: 8_000 });
    expect(tail.ok).toBe(true);
    expect(tail.content).toBe(content.slice(12_000));

    // 精确重建：head + chunk 游标（8K/次，不重叠）拼回全文
    expect(content).toBe(
      (head.content ?? "") + (c1.content ?? "") + (c2.content ?? ""),
    );
  });

  test("AC-P3-4 单次上限 8K：limit 超限被压到 8K", () => {
    const r = new ArtifactRegistry();
    const id = r.store("x".repeat(30_000), meta())!;
    const out = r.tryRecall(id, { limit: 99_999 });
    expect(out.ok).toBe(true);
    expect(out.content?.length).toBe(DEFAULT_ARCHIVE_OPTIONS.recallPerCallChars);
  });

  test("AC-P3-4 每轮物化总预算 16K + 每步 ≤2 次", () => {
    const r = new ArtifactRegistry();
    r.startTurn(1);
    const id = r.store("y".repeat(12_000), meta())!;
    // 第 1 次：窗口 8K 在预算内
    expect(r.tryRecall(id).ok).toBe(true);
    // 第 2 次：同 id 重复取回不重复计费（内容已在上下文中）→ 放行
    expect(r.tryRecall(id).ok).toBe(true);
    // 第 3 次：每步 ≤2 次 → 拒绝
    const third = r.tryRecall(id);
    expect(third.ok).toBe(false);
    expect(third.reason).toContain("recall budget");
    // 新轮重置预算
    r.startTurn(2);
    expect(r.tryRecall(id).ok).toBe(true);
  });

  test("AC-P3-4 超限不注入：紧凑预算下第二轮超 16K 上限 → 拒绝", () => {
    // 自定义紧凑预算（12K）：两条 10K 条目各取 8K 窗口 → 16K > 12K → 拒绝
    const r = new ArtifactRegistry({ recallPerTurnChars: 12_000 });
    r.startTurn(1);
    const a = r.store("a".repeat(10_000), meta())!;
    const b = r.store("b".repeat(10_000), meta({ turn: 4 }))!;
    expect(r.tryRecall(a).ok).toBe(true);
    // 10K + 10K（窗口 8K+8K）> 12K 且无可回退的旧物化 → 拒绝
    const out = r.tryRecall(b);
    expect(out.ok).toBe(false);
    expect(out.reason).toContain("budget");
  });

  test("AC-P3-5 LRU 回退：最久未用条目被回退，id 仍可寻址", () => {
    const r = new ArtifactRegistry({ recallPerTurnChars: 12_000 });
    const old = r.store("o".repeat(9_000), meta({ turn: 1 }))!;
    const fresh = r.store("f".repeat(9_000), meta({ turn: 2 }))!;
    r.startTurn(1);
    expect(r.tryRecall(old).ok).toBe(true);
    // 第 2 轮：物化 fresh（8K）
    r.startTurn(2);
    expect(r.tryRecall(fresh).ok).toBe(true);
    // 第 3 轮：再取 old（8K）→ 8K+8K > 12K → LRU 回退上一轮物化的 fresh
    // 释放预算 → 放行；fresh 的 stub 仍可寻址（下一轮可重新取回）
    r.startTurn(3);
    expect(r.tryRecall(old).ok).toBe(true);
    r.startTurn(4);
    expect(r.tryRecall(fresh).ok).toBe(true);
  });

  test("AC-P3-9 无效 ID → 关键词检索候选（不静默失败）", () => {
    const r = new ArtifactRegistry();
    r.store("test suite failed: 42 assertions\n" + "a".repeat(500), meta({ tool: "workspace.run_shell" }));
    r.store("README section about deploy\n" + "b".repeat(500), meta({ tool: "workspace.read_file" }));
    const out = r.tryRecall("no-such-id-99");
    expect(out.ok).toBe(false);
    expect(out.candidates).toBeDefined();
    const hits = r.search("deploy");
    expect(hits.length).toBe(1);
    expect(hits[0]?.tool).toBe("workspace.read_file");
  });

  test("AC-P3-7 Cited 契约：recall 过的 id 不可驱逐", () => {
    const r = new ArtifactRegistry();
    r.startTurn(1);
    const content = "cited content ".repeat(100);
    const id = r.store(content, meta())!;
    expect(r.tryRecall(id).ok).toBe(true);
    expect(r.isCited(id)).toBe(true);
    expect(r.get(id)?.cited).toBe(true);
  });

  test("AC-P3-8 目录有界化：非 Cited 旧桩降级为裸 ID，Cited 桩完整保留", () => {
    const r = new ArtifactRegistry({ maxStubsInContext: 2 });
    r.startTurn(0);
    const a = r.store("A".repeat(100), meta({ turn: 1 }))!;
    const b = r.store("B".repeat(100), meta({ turn: 2 }))!;
    const c = r.store("C".repeat(100), meta({ turn: 3 }))!;
    // Cited 中间桩（b）→ 永久有效
    r.markCited(b);
    const messages = [
      { content: `msg0 [${r.toStub(a)}]` },
      { content: `msg1 [${r.toStub(b)}]` },
      { content: `msg2 [${r.toStub(c)}]` },
    ];
    const { messages: out, removed } = r.trimStubsInMessages(messages);
    expect(removed).toBe(1);
    // 最旧非 Cited 桩降级为裸 ID（降级链：引用桩 → 裸 ID，id 仍可寻址）
    expect(out[0]?.content).toContain(`[archived id=${a}]`);
    expect(out[0]?.content).not.toContain(`id=${a}, tool=`);
    expect(out[1]?.content).toContain(`id=${b}, tool=`); // cited 完整保留
    expect(out[2]?.content).toContain(`id=${c}, tool=`); // 最新完整保留
  });

  test("stub 格式：toStub 可被 parseArchiveStub 精确解析", () => {
    const r = new ArtifactRegistry();
    const id = r.store("preview text here " + "x".repeat(200), meta({ tool: "workspace.run_shell", turn: 7 }))!;
    const stub = r.toStub(id);
    expect(ARCHIVE_STUB_PATTERN.test(stub)).toBe(true);
    const parsed = parseArchiveStub(stub);
    expect(parsed?.id).toBe(id);
    expect(parsed?.tool).toBe("workspace.run_shell");
    expect(parsed?.turn).toBe(7);
    expect(parsed?.size).toBeGreaterThan(200);
  });

  test("hash 寻址：getByHash 与去重键一致", () => {
    const r = new ArtifactRegistry();
    const content = "dedupe-key content ".repeat(100);
    const id = r.store(content, meta())!;
    expect(r.getByHash(simpleHash(content))?.id).toBe(id);
    expect(r.getByHash("deadbeef")?.id).toBeUndefined();
  });
});
