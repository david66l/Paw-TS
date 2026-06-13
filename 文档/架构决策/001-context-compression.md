# ADR 001: Three-layer context compression

**Status**: Accepted  
**Date**: 2026-05-22  
**Context**: Paw-TS agent runs accumulate large tool outputs and long chat history. Model context windows are finite; unbounded growth causes failures, latency, and cost spikes.

## Decision

Use **three layers** with increasing cost and decreasing frequency:

1. **L1 — Deterministic prune** (`pruneToolResults` + `tool-result-storage`)
   - Persist oversized or evicted tool results to `.paw/sessions/{runId}/tool-results/`; context keeps preview + path.
   - Keep the **5 most recent** compactable tool results in full; no LLM calls; safe every turn.

2. **L2 — LLM compact** (`ContextCompactor` + `runCompressionAgent`)
   - When estimated tokens exceed ~70% of window (minus buffer), summarize the **middle** segment.
   - Preserve **head** (system + initial goal) and **tail** (recent turns) via `determineBoundaries`.
   - Circuit breaker after repeated compression failures.

3. **L3 — Structural protect** (`ContextManager`)
   - Always retain system prompt, injected memories, and protected message classes regardless of L1/L2.

Compression emits run events: `compression.prune.done`, `compression.auto_compact.*`, `compression.skipped`.

## Alternatives considered

| Approach | Why not alone |
|----------|----------------|
| Sliding window only | Drops decisions and file context from early turns |
| Full-history summarization each turn | Expensive; summary drift; loses tail fidelity |
| Vector “memory” instead of compact | Does not replace need to trim tool blobs in active thread |
| Single-shot truncate | Loses structure; bad for tool-call pairing |

## Consequences

**Positive**

- L1 removes majority of tokens in tool-heavy sessions (see `benchmark:compression`, ~76% on synthetic fixture with keep-5 + disk persist).
- L2 defers LLM cost until threshold; head/tail protection keeps task anchor and recent state.
- Events make compression observable in TUI and session logs.

**Negative**

- L2 summary quality depends on compression sub-agent; errors propagate as “compressed truth”.
- Threshold tuning is model/window specific (`DEFAULT_COMPACTOR_CONFIG`).
- No automatic rollback if summary omits critical facts (checkpoint helps tool state, not semantic recall).

## Verification

- Unit: `packages/core/test/context-pruner.test.ts`, `context-compactor.test.ts`
- Agent: `packages/agent/test/compression-agent.test.ts`, orchestrator integration
- Benchmark: `bun run benchmark:compression`
