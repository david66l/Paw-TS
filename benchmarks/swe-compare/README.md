# Paw vs Claude Code — public SWE-bench comparison

This harness compares the two coding-agent products while holding the public
task, repository commit, DeepSeek V4 Flash model family, effort, workspace,
budget, patch collection, and official SWE-bench verifier fixed.

The first five instances are an engineering smoke set, not a headline score.
They must pass the no-model official Docker preflight before either agent runs.

```bash
# Build the runtime manifest from the fixed local SWE-bench Lite JSONL.
bun run packages/eval/scripts/prepare-swe-compare.ts

# Force a real official verifier run without exposing the task to an agent.
bun run packages/eval/scripts/preflight-swe-compare.ts \
  --instance pallets__flask-5063
```

Generated manifests, preflight predictions, run artifacts, and official logs
are intentionally ignored by Git. The selection rules and hashes are produced
by tracked source; each clean baseline commit regenerates its own manifest.
