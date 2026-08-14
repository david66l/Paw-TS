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
