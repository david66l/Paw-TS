import { describe, expect, test } from "bun:test";

import { truncateHistory } from "../src/context/policy.js";
import {
  ArtifactRegistry,
  type ChatMessage,
  computeSegments,
  extractRecentToolCallPaths,
  listCompactionCommits,
  loadCompactionSnapshot,
  saveCompactionCommit,
} from "../src/index.js";

const msg = (role: "user" | "assistant", content: string): ChatMessage => ({
  role,
  content,
});

describe("P4.2 生命周期驱逐 — computeSegments", () => {
  test("reuses non-overlapping assistant-boundary units", () => {
    const messages = [
      msg("assistant", "action one"),
      msg("user", "observation one"),
      msg("assistant", "action two"),
      msg("user", "observation two"),
    ];
    expect(computeSegments(messages, { tailTurnCount: 1 })).toEqual([
      { start: 0, end: 1, state: "evictable" },
      { start: 2, end: 3, state: "active" },
    ]);
  });

  test("首条目标 + 尾部最近回合 = active", () => {
    const messages = [
      msg("user", "fix the bug in main.ts"),
      msg("assistant", "ok, investigating"),
      msg("user", "found it, fixing now"),
      msg("assistant", "patched"),
      msg("user", "run tests"),
      msg("assistant", "all tests pass"),
      msg("user", "next task: add feature X"),
      msg("assistant", "starting"),
      msg("user", "what's the plan"),
      msg("assistant", "plan: ..."),
    ];
    const segs = computeSegments(messages, { tailTurnCount: 2 });
    // 段 0（首条目标）active
    expect(segs[0]?.state).toBe("active");
    // 尾部 2 个回合 active
    expect(segs[segs.length - 1]?.state).toBe("active");
    expect(segs[segs.length - 2]?.state).toBe("active");
    // 中间段：有完成证据（all tests pass）→ completed
    const completed = segs.find((s) => s.state === "completed");
    expect(completed).toBeDefined();
    // 无完成证据的中间段 → evictable
    expect(segs.some((s) => s.state === "evictable")).toBe(true);
  });

  test("AC-P4-3 状态转换：TASK_PIVOT 之后旧 completed 段升格 evictable", () => {
    const messages = [
      msg("user", "task A: refactor module"),
      msg("assistant", "done, tests pass"),
      msg("user", "next task: rewrite the README"),
      msg("assistant", "started"),
    ];
    const segs = computeSegments(messages, { tailTurnCount: 1 });
    // task A 段有完成证据，但后续出现 next task → 升格 evictable
    const taskA = segs.find((s) => s.start === 1);
    expect(taskA?.state).toBe("evictable");
  });
});

describe("P4.2 残差效用门控", () => {
  test("extractRecentToolCallPaths 提取最近工具调用引用的路径", () => {
    const messages = [
      msg(
        "assistant",
        '{"tool":"workspace.read_file","args":{"path":"src/a.ts"}}',
      ),
      msg("user", "[Tool workspace.read_file completed]\nsrc/a.ts"),
      msg(
        "assistant",
        '{"tool":"workspace.edit_file","args":{"path":"src/b.ts","old_string":"x"}}',
      ),
    ];
    const paths = extractRecentToolCallPaths(messages, 6);
    expect(paths.has("src/a.ts")).toBe(true);
    expect(paths.has("src/b.ts")).toBe(true);
  });

  test("AC-P4-4 残差效用：文件仍被最近 tool call 引用的消息保留（completed ≠ 可删）", () => {
    // 预算只够保留部分消息：无引用的陈旧段先被驱逐，残差效用命中的保留
    const messages: ChatMessage[] = [
      msg("user", "goal"),
      msg("assistant", "read the config file"), // evictable，无路径引用
      msg("assistant", "src/hot.ts is the cause"), // evictable，被最近调用引用
      msg(
        "assistant",
        '{"tool":"workspace.read_file","args":{"path":"src/hot.ts"}}',
      ), // 最近引用（tail 保护）
      msg("user", "final"),
    ];
    const truncated = truncateHistory([...messages], {
      maxMessages: 40,
      budgetOptions: {
        budget: 110,
        useTokens: false,
        tailTurnCount: 1,
        estimator: {
          count: (t: string) => Math.ceil(t.length / 4),
          countMessages: (m: readonly ChatMessage[]) =>
            m.reduce((s, x) => s + Math.ceil(x.content.length / 4), 0),
        },
      },
    });
    // 残差效用命中（src/hot.ts 仍被最近 tool call 引用）→ 取消生命周期扣分 → 保留
    const kept = truncated.map((m: ChatMessage) => m.content).join("\n");
    expect(kept).toContain("src/hot.ts is the cause");
    // 无引用的陈旧段（read the config file）被驱逐
    expect(kept).not.toContain("read the config file");
  });
});

describe("P4.1 降级链 — 引用桩 → 裸 ID → 删除", () => {
  test("裸 ID 桩可解析；downgradeStubToBare 保留寻址键", () => {
    const r = new ArtifactRegistry({ maxStubsInContext: 1 });
    r.startTurn(0);
    const id = r.store("x".repeat(100), {
      tool: "run_shell",
      ok: true,
      turn: 1,
    })!;
    const stub = r.toStub(id);
    const bare = r.downgradeStubToBare(stub);
    expect(bare).toBe(`[archived id=${id}]`);
    // Cited 桩不降级
    r.markCited(id);
    expect(r.downgradeStubToBare(stub)).toBe(stub);
  });

  test("AC-P4-2 有界化两级降级：完整桩 → 裸 ID → 删除", () => {
    const r = new ArtifactRegistry({
      maxStubsInContext: 1,
      maxBareStubsInContext: 1,
    });
    r.startTurn(0);
    const a = r.store("A".repeat(50), {
      tool: "run_shell",
      ok: true,
      turn: 1,
    })!;
    const b = r.store("B".repeat(50), {
      tool: "run_shell",
      ok: true,
      turn: 2,
    })!;
    const c = r.store("C".repeat(50), {
      tool: "run_shell",
      ok: true,
      turn: 3,
    })!;
    const messages = [
      { content: `[${r.toStub(a)}]` },
      { content: `[${r.toStub(b)}]` },
      { content: `[${r.toStub(c)}]` },
    ];
    // 完整桩 3 > 1 → 最旧 2 个降级为裸 ID；裸 ID 2 > 1 → 最旧 1 个删除
    const { messages: out } = r.trimStubsInMessages(messages);
    const text = out.map((m) => m.content).join("\n");
    // a 被删除（降级后被裸 ID 上限淘汰）
    expect(text).not.toContain(`id=${a}`);
    // b 保留为裸 ID（无元数据）
    expect(text).toContain(`[archived id=${b}]`);
    expect(text).not.toContain(`id=${b}, tool=run_shell`);
    // c 保留完整桩
    expect(text).toContain(`id=${c}, tool=run_shell`);
  });

  test("Cited 桩永不降级不删除", () => {
    const r = new ArtifactRegistry({
      maxStubsInContext: 1,
      maxBareStubsInContext: 1,
    });
    r.startTurn(0);
    const a = r.store("A".repeat(50), {
      tool: "run_shell",
      ok: true,
      turn: 1,
    })!;
    const b = r.store("B".repeat(50), {
      tool: "run_shell",
      ok: true,
      turn: 2,
    })!;
    r.markCited(a);
    const { messages: out } = r.trimStubsInMessages([
      { content: `[${r.toStub(a)}]` },
      { content: `[${r.toStub(b)}]` },
    ]);
    const text = out.map((m) => m.content).join("\n");
    // Cited 桩 a 保持完整桩（不降级）
    expect(text).toContain(`id=${a}, tool=run_shell`);
    // 非 Cited 桩 b 降级为裸 ID（降级链第 3 级），但裸 ID 数量未超上限 → 不删除
    expect(text).toContain(`[archived id=${b}]`);
    expect(text).not.toContain(`id=${b}, tool=run_shell`);
  });
});

describe("P4.4 压缩版本化 — compaction commits", () => {
  test("save → list → load 快照往返", () => {
    const root = "C:/work/ver";
    const runId = "run-v1";
    const before: ChatMessage[] = [
      msg("user", "goal"),
      msg("assistant", "old context"),
    ];
    const after: ChatMessage[] = [
      msg("user", "goal"),
      msg("user", "[Context Summary]\ncompressed"),
    ];
    const p1 = saveCompactionCommit({
      workspaceRoot: root,
      runId,
      commit: {
        n: 1,
        ts: 1,
        reason: "auto_compact",
        beforeMessages: before,
        afterMessages: after,
        beforeTokens: 100,
        afterTokens: 20,
      },
    });
    saveCompactionCommit({
      workspaceRoot: root,
      runId,
      commit: {
        n: 2,
        ts: 2,
        reason: "resume",
        beforeMessages: after,
        afterMessages: before,
        beforeTokens: 20,
        afterTokens: 100,
      },
    });
    expect(p1).toContain("compaction-commits");
    const commits = listCompactionCommits(root, runId);
    expect(commits.map((c) => c.n)).toEqual([1, 2]);
    // 回滚点：第 1 次压缩的压缩前快照
    const snap = loadCompactionSnapshot(root, runId, 1);
    expect(snap?.beforeMessages.map((m) => m.content)).toEqual([
      "goal",
      "old context",
    ]);
    // 无 commit 的 run → 空列表
    expect(listCompactionCommits(root, "nope")).toEqual([]);
  });
});
