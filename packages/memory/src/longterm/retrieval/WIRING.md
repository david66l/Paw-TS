# 检索管线接线说明（M6 → orchestrator/harness）

`TriggeredRetriever`（`./triggered.ts`）实现 spec v2 §6 的 T1–T4 触发式检索。
orchestrator 侧接线**刻意未做**（packages/agent 有未提交改动），以下为粘贴级接线片段。

## 构造（进程级单例）

```ts
import { PostgresMemoryStoreEngine } from "@paw/memory/longterm";
import { TriggeredRetriever } from "@paw/memory/longterm";

const retriever = new TriggeredRetriever({
  engine: new PostgresMemoryStoreEngine(),
  reranker: { complete: (prompt) => myFastModel.complete(prompt) }, // 快模型，缺省则召回直取
  emit: (event) => orchestrator.emit(event),   // RunEvent memory.trigger/memory.inject
});
```

返回的 `InjectionPackage`：`pkg.render()` 为带 XML 标签的注入文本（空包返回空串，
直接跳过即可——空库/无命中零开销）。注入位置由 ContextBuilder 统一控制（§6.6）。

## T1 task_start — orchestrator run 创建处

调用点：`packages/agent/src/orchestrator.ts` run.started 之后、首个 model 请求之前。

```ts
const pkg = await retriever.retrieve({
  type: "task_start",
  taskDescription: goal,
  branch: currentBranch,
  repo: repoId,
  runId,
});
if (pkg.totalTokens > 0) contextBuilder.addMemorySection(pkg.render());
```

## T2 action_failed — harness 工具结果处理处

调用点：工具结果处理器（退出码非零/测试失败处）。`lastActionSummary` 按 §6.2
模板生成（工具名 + 命令/参数摘要 + 退出码，≤100 字符，不调 LLM）：

```ts
if (result.exitCode !== 0) {
  const pkg = await retriever.retrieve({
    type: "action_failed",
    errorOutput: result.stderr.slice(0, 400),
    lastActionSummary: `${tool.name} ${summarizeArgs(tool.args)} (exit ${result.exitCode})`,
    repo: repoId,
    runId,
  });
  if (pkg.totalTokens > 0) contextBuilder.addMemorySection(pkg.render());
}
// 权限拒绝/用户中止在 retriever 内部被 isActionableError 拦掉，无需调用方判断
```

## T3 post_compact — auto_compact.done 事件处

调用点：监听 `compression.auto_compact.done` 处。必须传 `existingContextHints`
（SessionMemory 的 Key Decisions/constraints 文本），retriever 内部去重（§6.1）：

```ts
const pkg = await retriever.retrieve({
  type: "post_compact",
  summaryHead: summary.split("\n")[0],
  goal: workingMemory.goal,
  existingContextHints: sessionMemory.keyDecisions.concat(sessionMemory.constraints),
  repo: repoId,
  runId,
});
if (pkg.totalTokens > 0) contextBuilder.addMemorySection(pkg.render());
```

## T4 explicit_query — 用户显式提问（"上次怎么改的"）

CLI/TUI 的记忆查询入口：`retrieve({ type: "explicit_query", question, repo })`。
T4 可见已失效条目（带失效时间标注），这是唯一能看到 tInvalid≠null 条目的触发点。

## 注意

- 每次注入已自动完成：op-log `read.trigger`/`read.inject`、ledger freq+1、RunEvent 发射。
- 采纳率判定（read.adopted）的接线属 M8 评测范围：`recordAdoption(runId, entryIds)`。
