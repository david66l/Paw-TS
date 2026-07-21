# P6: LLM 成本精细化管控 — 实施计划

## Context

paw 的记忆系统有两条 LLM 提取通道：
- **零成本**：`extractSessionHighlightsToAutoMemory`（复用 compact 输出）、`memory.save` 工具（纯文件写入）
- **付费**：`maybeExtractMemoriesAfterRun`（end-of-run LLM 提取）、`maybeGenerateShortSessionMemory`（短 Run LLM 摘要）

当前问题：
1. 付费通道没有独立总开关（`maybeGenerateShortSessionMemory` 不受 `memoryExtraction` 控制）
2. 长 Run 场景下 compact 不触发时，记忆长期不更新（只能等 end-of-run）
3. 没有单 Run 提取次数上限

## 实施

### 1. Settings schema — 3 个新字段

**文件：** `packages/settings/src/schema.ts`

在 `pawSettingsLocalSchema` 中新增：

```typescript
paid_memory_extraction: z.boolean().optional(),              // 默认 true
background_review_interval: z.number().int().min(0).optional(), // 默认 0 = 关闭
max_extractions_per_run: z.number().int().min(1).optional(),    // 默认 3
```

### 2. 全局付费开关

**文件：** `packages/agent/src/orchestrator.ts`

**A. `maybeExtractMemoriesAfterRun`**（line ~2541）：读 `paid_memory_extraction`，false 时 return。

**B. `maybeGenerateShortSessionMemory` 调用点**（line ~649）：外层加 guard，读 `paid_memory_extraction`，false 时跳过。

### 3. BackgroundReview — 周期性轻量提取

**新建文件：** `packages/agent/src/orchestrator/background-review.ts`

```typescript
export async function runBackgroundReview(opts: {
  runId: string;
  workspaceRoot: string;
  model: LanguageModel;
  ctxMgr: ContextManager;
  provider: MemoryProvider;
  emit: (event: RunEvent) => void;
}): Promise<void>
```

逻辑：
1. 取 ctxMgr 最近 ~20 条消息
2. 用 auxiliary model + `completeAuxiliaryTask` 生成极简摘要（15s 超时）
3. 写入 SessionMemoryStore
4. 调用已有的 `extractSessionHighlightsToAutoMemory`（零成本管线复用）
5. best-effort：失败静默忽略

**System prompt 极简**（单句指令，对标 hermes 的轻量）

**集成点：** `executeTurn` 中 action 处理完成后（line ~1345 区域），新增：

```typescript
await this.maybeBackgroundReview(ctx, _memoryProvider, sessionMemoryStore);
```

**`maybeBackgroundReview` private method**：

```typescript
private _backgroundReviewLastTurn = -1;
private _extractionCount = 0;

private async maybeBackgroundReview(
  ctx: PhaseContext, provider: MemoryProvider,
  sessionMemoryStore: SessionMemoryStore,
): Promise<void> {
  const settings = readPawSettingsLocal(ctx.workspaceRoot) as Record<string, unknown> | undefined;
  const interval = (settings?.background_review_interval as number) ?? 0;
  if (interval <= 0 || !this.auxiliaryModel) return;
  
  // 互斥：compact 刚跑过 → 跳过
  if (this.compactCooldownTurns > 0) return;
  
  // 间隔检查
  if (ctx.turn - this._backgroundReviewLastTurn < interval) return;
  
  // 付费开关
  if (settings?.paid_memory_extraction === false) return;
  
  // 限流
  const maxExtractions = (settings?.max_extractions_per_run as number) ?? 3;
  if (this._extractionCount >= maxExtractions) return;

  this._backgroundReviewLastTurn = ctx.turn;
  this._extractionCount++;

  runBackgroundReview({...}).catch(() => {});
}
```

### 4. 提取次数限流

在 `maybeExtractMemoriesAfterRun` 和 `maybeGenerateShortSessionMemory` 调用点共用 `_extractionCount` 计数器 + `max_extractions_per_run` 设置。

`maybeExtractMemoriesAfterRun` 开始处：
```typescript
if (this._extractionCount >= maxExtractions) return;
// … 执行后 this._extractionCount++
```

`maybeGenerateShortSessionMemory` 外围同理。

## 文件改动汇总

| 文件 | 改动 |
|------|------|
| `packages/settings/src/schema.ts` | +3 个 optional 字段 |
| `packages/agent/src/orchestrator.ts` | +2 counter、+1 method `maybeBackgroundReview`、guard ×3 |
| `packages/agent/src/orchestrator/background-review.ts` | **新文件** ~60 行 |

总计：~90 行新增，~15 行修改。

## 验证

1. `cd packages/settings && npx tsc --noEmit` — schema 编译通过
2. `cd packages/memory && npx vitest run` — 153 tests 全绿
3. `cd packages/agent && npx vitest run` — orchestrator tests 全绿
4. 手动验证 4 个路径：付费开关关闭 / BackgroundReview 周期触发 / compact 互斥 / 限流生效
