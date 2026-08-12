# SWE-Exp pairing protocol (paw-ts)

P1 编码收益验收：复用 [SWE-Exp](https://github.com/YerbaPage/SWE-Exp) 的**配对协议思想**，不移植其完整 agent。叠在现有 `benchmarks/swe-bench/` 上。

详设：`文档/记忆机制spec-v2/11.评测与灰度.md` §11.3.1。

## 核心问题

同一代码问题（probe），**memory off vs on**，最终测试是否通过？

```text
Δ = resolve_rate(memory on) − resolve_rate(memory off)
```

配对符号：on 过 & off 不过 = win；反之 = loss；同过/同不过 = tie。

## 协议（四阶段，对齐 §11.3.1）

1. **History**：同仓库历史 issue **无记忆**跑，收集成功/失败轨迹  
2. **Distill**：从轨迹写入 episodic / trial（失败先 trial；测试通过才转正）  
3. **Probe**：同仓库**相似**后续 issue 上，分别跑 memory off / on  
4. **Score**：官方 SWE-bench harness（或本地测试）判 `resolved`；汇总 Δ / 配对 w/l/t  

建议规模：同仓库 **30–50 对**（先小后大）。

## Agent 模式（真实 Lite 配对）

```bash
# 1 对冒烟：agent on/off + 官方 harness（Docker；Windows 用 win_shim）
$env:DATABASE_URL="postgresql://postgres@127.0.0.1:54329/paw_memory_test"
bun run packages/eval/scripts/run-swe-exp-agent.ts --max-pairs 1

# 先只跑 agent 产 patch（跳过 harness，稍后补评）
bun run packages/eval/scripts/run-swe-exp-agent.ts --max-pairs 1 --skip-harness

# 中断续跑（同一 suite-run-id，跳过已完成臂）
bun run packages/eval/scripts/run-swe-exp-agent.ts --suite-run-id agent-... --max-pairs 5

# 已有 checkpoint 只补跑/重跑官方 harness，不再调用模型
bun run packages/eval/scripts/run-swe-exp-agent.ts --suite-run-id agent-... --eval-only --max-pairs 5

# 或 CLI
bun run apps/cli/src/main.ts eval swe-exp --mode agent --max-samples 1 --json
```

真实 agent 默认采用能力优先预算：64 步 / 25 分钟；`--max-steps`、`--timeout-ms` 仍可显式覆盖。`[coding_phase_budget]` 导航阈值仅保留为实验变量，不在 SWE-Exp 默认 goal 中启用。

隔离：每臂独立 git worktree + `repository_id` + `memory-config.enable` + conversationId。  
History seed：只用 history `problem_statement`（+hints），**禁止 gold patch**。  
Checkpoint：`benchmarks/swe-exp/runs/<suiteRunId>/pairs/<pairId>/{off,on}.json`。
运行前会先 ping memory DB；不可达则在任何模型臂之前 fail-fast。Windows 官方 harness 通过 LF launcher 生成 Linux `eval.sh`，避免 CRLF 造成全测试假失败。

## 2026-08-12 真实首对闭环

Sphinx `8282 history → 8435 probe`，同 commit/模型/32 步，官方 SWE-bench Docker verifier：

| 臂 | recall | patch | 官方结果 |
|---|---:|---:|---:|
| off | false | 0 chars | unresolved |
| on | true | 1254 chars | **resolved**；FAIL_TO_PASS 1/1 + PASS_TO_PASS 16/16 |

配对：**1 win / 0 loss / 0 tie，resolved Δ=+1**。报告：`runs/agent-paired-p0-v1-20260812/report.json`。

限制：只有 1 对，不能外推总体修复率；两臂 inner loop 都耗尽 32 步，说明 resolved 与 agent 自身收口仍未一致。下一阶段先固定 5 对复现，再扩到 30–50 对。

| 模式 | 含义 |
|---|---|
| `fake` | 夹具预设结局；CI 冒烟 |
| `deterministic` | 记忆召回 → 应用已知补丁 → 跑测试（证明「注入→测试」因果链） |
| `agent` | 真实 AgentOrchestrator + Lite 配对 +（可选）官方 harness |
| `external` | 合并官方 harness 的 on/off resolve 结果 |

## 从 SWE-bench JSONL 构对

```ts
import { loadSweInstancesJsonl, buildSameRepoPairs } from "@paw/eval";

const instances = loadSweInstancesJsonl("swe-bench-lite.jsonl");
const pairs = buildSameRepoPairs(instances, { maxPairs: 50, minSimilarity: 0.08 });
```

启发式：同 `repo` + `problem_statement` token Jaccard。正式子集建议再人工/issue-type 审核。

## 叠官方 SWE-bench 适配器

```bash
# 1) 下载 Lite → swe-bench-lite.jsonl（见 ../swe-bench/README.md）

# 2) memory off 跑 predictions
python benchmarks/swe-bench/run.py \
  --input swe-bench-lite.jsonl \
  --memory off \
  --output benchmarks/swe-exp/preds-off.jsonl \
  --max-instances 5

# 3) memory on（需先把 history 轨迹蒸馏进库；当前适配器写 enable 开关）
python benchmarks/swe-bench/run.py \
  --input swe-bench-lite.jsonl \
  --memory on \
  --output benchmarks/swe-exp/preds-on.jsonl \
  --max-instances 5

# 4) 官方 harness 分别评估 → 用 mergeExternalResolveResults 合成配对报告
python -m swebench.harness.run_evaluation \
  --dataset_name princeton-nlp/SWE-bench_Lite \
  --predictions_path benchmarks/swe-exp/preds-on.jsonl
```

> 表述纪律：builtin deterministic 证明的是**评测通路 + 注入→测试**因果；完整 agent + 官方 harness 才可声称「记忆机制提高修复成功率」。

## 与 P0 MemoryAgentBench 的关系

| | MemoryAgentBench | SWE-Exp pairing |
|---|---|---|
| 主场 | 检索/学习/长程/冲突 | 代码修复是否过测试 |
| 主指标 | QA Δ | **resolved Δ** |
| 状态 | P0 已收口 | **本目录开工中** |
