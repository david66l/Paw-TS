# Benchmark results (sample)

Generated on local run via:

```bash
bun run benchmark:compression
bun run benchmark:memory
```

## Context compression (synthetic fixture)

| Metric | Value |
|--------|-------|
| Messages (fixture) | 29 |
| Context window | 1,000,000 tokens (DeepSeek V4) |
| Tokens before L1 prune | 29,277 |
| Tokens after L1 prune | 6,883 |
| L1 freed tokens | 22,394 (**76.5%**) |
| L2 shouldCompact (post-prune) | false |
| L2 threshold tokens (整窗 check) | 690,000 |
| Production L2 (history 池) | ~585,000 |

Fixture: 12 large `workspace.read_file` tool results + head/tail conversation. L1 uses `keepRecentTools: 5` + disk persist under a temp tool-results dir.

## Memory retrieval (golden set, 7 memories, 5 queries)

| Aggregate | Value |
|-----------|-------|
| recall@5 | **100%** |
| MRR | **1.000** |

Cases cover keyword match, path/basename relevance, topic match, and negative (no spurious recall for unrelated `cost-tracker.ts` goal).

Re-run after retriever changes; for production session logs use `bun run analyze:memory`.
