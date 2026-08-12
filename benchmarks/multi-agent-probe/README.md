# Multi-agent probe

Live architecture check of paw's roster multi-agent (狸花 + workers) against a real GitHub repo.

## Repo under test

- Clone: https://github.com/pgilad/leasot (TypeScript, ~800★, has mocha tests)
- Local path: `E:/A_Louis/paw-multiagent-probe/leasot` (outside paw-ts so `.paw` root discovery stays local)

## Run

```bash
# from paw-ts
bun run benchmarks/multi-agent-probe/run.ts
```

Report: `E:/A_Louis/paw-multiagent-probe/runs/leasot-hack-*.json`

## Recommended GitHub targets (broader)

| Target | URL | Use |
|---|---|---|
| SWE-bench / Lite / Verified | https://github.com/SWE-bench/SWE-bench | Real issue→patch; complex repos |
| Multi-SWE-bench | https://github.com/multi-swe-bench/multi-swe-bench | Multilingual issue resolve |
| SWE-Lancer | https://github.com/openai/SWELancer-Benchmark | Freelance-scale tasks |
| Mid feature repos | e.g. leasot, sindresorhus/is | Multi-file feature + tests |

SWE-* measures "complex project bugfix"; this probe measures "roster multi-agent can ship a scoped feature".
