# 写入管线接线说明（M4/M5 → orchestrator/harness）

`MemoryWritePipeline`（`./pipeline.ts`）实现 spec v2 §5 的写入五道关
（事件收集 → 验证门控 → 密钥拦截 → 蒸馏 → Governor 裁决），全异步。
orchestrator 侧接线**刻意未做**（packages/agent 有未提交改动），以下为粘贴级接线片段。

## 构造（进程级单例）

```ts
import { MemoryWritePipeline, MemoryDistiller, LongtermGovernor } from "@paw/memory/longterm";

const pipeline = new MemoryWritePipeline({
  distiller: new MemoryDistiller({ complete: (p) => myModel.complete(p) }),
  governorLlm: { complete: (p) => myStrongModel.complete(p) }, // 裁决用强模型（A10）
  correctionConfirmer: { confirm: async (text) => confirmWithLlm(text) },
  emit: (event) => orchestrator.emit(event),  // memory.write.*/memory.governed RunEvent
});
pipeline.start(); // worker：串行处理，任务间隔默认 2s，崩溃不丢（db outbox）
```

## 任务成功/失败 — orchestrator 完成/失败事件处

```ts
// run.completed（verdict 复用 Verifier Gate 的 outcome）
await pipeline.enqueue({
  type: "task_succeeded", runId, trajectoryRef: `runs/${runId}`,
  repo, goal, trajectory: trajectoryDigest,
  verdict: { kind: "test", passed: testSummary.failed === 0 },
});
// run.failed → type: "task_failed"（试用通道，不直接入库）
```

`verdict` 缺省 = 无反馈信号 → 禁止盲改条款拒固化（§5.3）。

## 用户纠正 — 用户消息分类处

```ts
import { detectUserCorrection } from "@paw/memory/longterm";

if (detectUserCorrection(userText).isCorrection) {
  await pipeline.enqueue({ type: "user_correction", text: userText, messageRef: msgId, runId, repo });
}
// 管线内：CorrectionConfirmer 确认 → 直写（返回 undoHint: memory forget <id>）；
// 否认/无确认器 → 保守走蒸馏通道（confidence ≤0.6）
```

## session finalize — finalizeConversationMemory 处

```ts
await pipeline.enqueue({
  type: "session_finalize", conversationId, runId, repo,
  goal: wm.goal, trajectory: finalTrajectoryDigest,
}); // 兜底蒸馏，confidence ≤0.6
```

## 效用结算 + 试用转正（§7.1 / §4.2）

管线内置：`settleRunOutcome` 在 task_succeeded（verdict pass / user_accepted）
处理时自动执行——按 runId 查 op-log `read.inject` 的正式条目 utility+1，
并按 §10.3 规则（detectAdoption）记 read.adopted；同时查 `read.inject.trial`
把本 run 随行注入过的试用教训转正为 episodic（`source=trial_graduated`）并从 trial 池删除。
**接线侧无需额外调用**，只要求注入时走了 TriggeredRetriever（会落 read.inject / read.inject.trial）。

## Profile 画像写入（§4.2 / §7.3）

`admitProfile` / `enforceProfileCapacity`（`./profile.ts`）已导出：

- **证据门槛**：`evidence` 去重后 ≥3，且 insight 须为行为描述（拒绝「很谨慎」）
- **同主题**：词面重叠 ≥2 → EDIT 合并证据（不占新名额）
- **满 15**：REMOVE 效用最低的非 `user_statement` 再 ADD；无可腾位 → reject
- **janitor**：`runLifecycleOnce` 调用 `enforceProfileCapacity` 强制腾位（不再只报告）

从 episodic 周期性抽象画像属 **v3 巩固调度**（§7.6）；v2 提供可调用门面，供 CLI / 巩固任务 / 测试直接写入。

## 注意

- readonly 模式（CI）：构造时传 `readonly: () => loadMemoryConfig().readonly`，
  enqueue 全部丢弃并记 write.dropped（M9）。
- 失败重试 3 次进死信（outbox_events status='dead_letter'），排障从死信行 payload 入手。
