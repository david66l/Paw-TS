# Paw vs Claude Code — public SWE-bench comparison

This harness compares the two coding-agent products while holding the public
task, repository commit, DeepSeek V4 Flash model family, effort, workspace,
wall-clock cap, patch collection, and official SWE-bench verifier fixed. Paw's
64-step safety cap is recorded separately because Claude Code exposes no
equivalent public max-turn flag; both runners record their actual turns.

The five `formal-dev-v1` instances are a frozen paired diagnostic development
set, not a headline score. They must pass the no-model official Docker preflight
before either agent runs. `pallets__flask-5063` was used only to validate the
runner and is excluded because Paw saw it before the shared runner baseline.

```bash
# Build the runtime manifest from the fixed local SWE-bench Lite JSONL.
bun run packages/eval/scripts/prepare-swe-compare.ts

# Force a real official verifier run without exposing the task to an agent.
bun run packages/eval/scripts/preflight-swe-compare.ts \
  --instance astropy__astropy-12907

# Run one frozen arm. Omit --skip-verifier for the official score.
bun run packages/eval/scripts/run-swe-compare.ts \
  --instance astropy__astropy-12907 --runner paw
bun run packages/eval/scripts/run-swe-compare.ts \
  --instance astropy__astropy-12907 --runner claude
```

Generated manifests, preflight predictions, run artifacts, and official logs
are intentionally ignored by Git. The selection rules and hashes are produced
by tracked source; each clean baseline commit regenerates its own manifest.

## Paw-only seen development set

`paw-seen-dev-v1` contains eight cross-repository tasks already exposed to Paw
during engineering. It exists only to diagnose Paw's architecture before any
unseen holdout is opened. Its results are neither a holdout nor a headline
score, and the CLI rejects Claude runs against this manifest.

```bash
bun run packages/eval/scripts/prepare-paw-seen-dev.ts
bun run packages/eval/scripts/preflight-swe-compare.ts \
  --manifest paw-seen-dev-v1.json --instance pylint-dev__pylint-7228
bun run packages/eval/scripts/run-swe-compare.ts \
  --manifest paw-seen-dev-v1.json --instance pylint-dev__pylint-7228 --runner paw
```

If a Paw run finished but Git patch collection failed, its successful
`workspace.edit_file` events can be replayed in a clean checkout without
calling the model again:

```bash
bun run packages/eval/scripts/run-swe-compare.ts \
  --recover-paw-result-patch benchmarks/swe-compare/runs/<run-id>/result.json
```

`--replace-replayed-patch` is a deliberately narrow repair switch for
recomputing a patch that already has `patchSource=paw_trace_edit_replay` (for
example after fixing replay compatibility). It refuses to overwrite workspace,
Claude, or manually sourced patches.

## Paw-only fresh development set

`paw-fresh-dev-v2` freezes five task IDs that have no known local Paw
trajectory. Selection never reads problem text or gold: it excludes every
known exposed ID, applies public F2P/P2P count bounds, sorts by a fixed salted
SHA-256 of the instance ID, and takes at most one task per repository. Once
run, these tasks become seen development evidence and are never promoted to a
holdout or headline score.

```bash
bun run packages/eval/scripts/prepare-paw-fresh-dev.ts
bun run packages/eval/scripts/preflight-swe-compare.ts \
  --manifest paw-fresh-dev-v2.json --instance <frozen-instance-id>
bun run packages/eval/scripts/run-swe-compare.ts \
  --manifest paw-fresh-dev-v2.json --instance <frozen-instance-id> --runner paw
```

The frozen v2 batch finished **4/5 resolved**. It is architecture-development
evidence only: every candidate patch changed one product file, the run used
memory off, and the Paw completion policy could hand local harness failures to
the official external verifier after inspecting the diff. It therefore does
not establish multi-file long-task reliability, memory benefit, self-verifying
completion, or a Paw-vs-Claude result. The five IDs are permanently exposed
after this batch and must be excluded from every later fresh selection.

The next Paw-only batch is intentionally a different qualification stage. Its
protocol must be frozen before task text is inspected and must:

- select five still-unseen repositories deterministically, excluding all prior
  seen and fresh-v2 IDs;
- increase the public acceptance surface (test-count metadata only), without
  reading problem text, gold patches, or test patches for selection;
- keep memory off so the first question remains whether the core loop can
  finish normally;
- use a relaxed safety ceiling rather than an optimization budget;
- require Paw to produce trustworthy local verification evidence or finish
  honestly incomplete; the official SWE-bench harness runs only afterwards to
  score the frozen candidate and cannot retroactively turn a local claim into
  evidence;
- report resolved rate together with changed-file count, turns, model calls,
  tokens, pruning/compaction, reviewer retries, terminal reason, and evidence
  quality. A batch of one-file fixes cannot close the multi-file qualification
  gate even if resolved is high.

Do not implement this by silently changing `paw-fresh-dev-v2`. Introduce a new
versioned manifest rule and deterministic tests, freeze it from a clean commit,
run no-model preflight, then execute each selected task once in frozen order.
