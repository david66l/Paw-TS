# MemoryAgentBench adapter (paw-ts)

P0 四维验：对接 [MemoryAgentBench](https://github.com/HUST-AI-HYZ/MemoryAgentBench)（ICLR 2026）协议，并加 coding 改造 + SF 断言。

详设：`文档/记忆机制spec-v2/11.评测与灰度.md` §11.3.1。

## 协议

1. 将 `context` 切成 chunks，每 chunk 作为独立 session 写入记忆库  
2. 每个问题开启**新 session**（`explicit_query`），不附带完整历史  
3. `memory on` vs `memory off` 配对，报 AR/TTL/LRU/CR/SF 分项 Δ  
4. SF：问「现在」时注入包不得含旧事实；问「以前」仍能答旧事实  

## 达标口径（收紧）

- 有对照维度的平均 Δ **> 0**（严格正增益；零增益不算过）  
- 配对统计：同题 on/off → **wins > losses**（另报 pairedAdvantage / 决胜 winRate / 符号检验 P）  
- 若跑了 SF current：旧事实抑制率 ≥ 0.8  
- 样本不足 → `passed: null`（CLI fail-closed）

## 快速跑（内置 coding-mini，无需 HF）

```bash
export DATABASE_URL=postgresql://postgres@127.0.0.1:54329/paw_memory_test   # 按本机改
bun run cli -- memory mab --builtin --provider deepseekv4flash --json

# 或直接脚本（落盘 last-run.json）
cd packages/memory && DATABASE_URL=... bun run scripts/run-mab-builtin.ts
```

**实测（2026-08-10，deepseekv4flash，builtin 5 样本 / 12 LLM）**：墙钟约 **12–22s**，最终 `passed=true`，平均 Δ=1，SF 抑制率=1。报告见 `last-run.json`。

## 官方 HF 全量（本地 parquet）

数据放在（已 gitignore）：

`benchmarks/memory-agent-bench/hf-dataset/data/*-{Accurate_Retrieval,Test_Time_Learning,Long_Range_Understanding,Conflict_Resolution}-*.parquet`

来源：[ai-hyz/MemoryAgentBench](https://huggingface.co/datasets/ai-hyz/MemoryAgentBench)（约 146 样本 / 合计三千余题；单条 context 可达百万字符）。

```bash
# 读本地 parquet 实跑（默认每样本 5 题、chunk 抽稀至 96）
DATABASE_URL=... bun run packages/memory/scripts/run-mab-hf.ts

# 冒烟
MAB_DIMENSIONS=CR,SF MAB_MAX_SAMPLES=3 MAB_MAX_QA_PER_SAMPLE=2 \
  bun run packages/memory/scripts/run-mab-hf.ts

# 可调
# MAB_HF_PARQUET=.../hf-dataset/data
# MAB_MAX_QA_PER_SAMPLE=5   # 官方单样本可有上百题
# MAB_MAX_CHUNKS=96
# MAB_CHUNK_SIZE=2048
# MAB_LLM_BUDGET=50000
```

报告：`benchmarks/memory-agent-bench/last-run-hf.json`。

| HF split | 维度 | 官方行数（本地下载） |
|---|---|---|
| Accurate_Retrieval | AR | 22 |
| Test_Time_Learning | TTL | 6 |
| Long_Range_Understanding | LRU | 110 |
| Conflict_Resolution | CR | 8 |

官方 CR 对应 FactConsolidation；paw 额外用内置 `coding-sf-*` 测 SF。

> 注意：若对全部题目×全部分块做无截断评测，LLM 调用可达数千次；默认 `MAB_MAX_QA_PER_SAMPLE` / `MAB_MAX_CHUNKS` 是为可完成实跑设的工程上限，报告里会写明。

可选：

```bash
bun run cli -- memory mab --builtin --dimension AR,SF --max-samples 2 --chunk-size 512
bun run cli -- memory mab --data ./Accurate_Retrieval.json --dimension AR --provider <name>
```

## 夹具

- 内置：`packages/memory` 内 `BUILTIN_CODING_FIXTURES`（coding AR/TTL/LRU/CR/SF）  
- `hf-cache/`：官方导出，勿提交超大文件  
