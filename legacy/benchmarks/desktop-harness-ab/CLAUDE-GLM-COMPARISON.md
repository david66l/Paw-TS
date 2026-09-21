# Claude Code / Paw: GLM-5.3-Flash comparison

## Protocol

One sequential sample per runtime on the complete persistent job queue task in `tasks.ts`. Paw runs first, Claude Code second. The exact user task, REQUIREMENTS.md, empty implementation, Node.js 24, no package installation, 12-minute wall allowance, 40 model-request ceiling, max effort and 128000 requested output cap are shared. Both start from a fresh Git workspace. No live project is given to either agent.

- Paw: current `runDesktopNext -> runFreshPawNextTaskV3 -> runAgentLoop`, single coding agent, memory and environment audit disabled, completion review retained, no experimental thinking-recovery wrapper. Existing desktop profile, including v7 verification repair and convergence advice, remains unchanged.
- Claude Code: 2.1.224, native prompt and loop, `--effort max`, `--max-turns 32`, `CLAUDE_CODE_MAX_OUTPUT_TOKENS=128000`, coding tools Bash/Read/Write/Edit/Glob/Grep. User/project settings, MCP servers, skills and delegated agents are excluded. Native default system instructions are retained.
- Paw uses the configured BigModel OpenAI endpoint; Claude Code uses the same account's [official Anthropic-compatible endpoint](https://docs.bigmodel.cn/cn/guide/develop/claude/introduction). These protocols and effort representations are different; matching their intent does not prove identical backend sampling behavior.
- Claude Code's [programmatic stream output](https://code.claude.com/docs/en/headless) and raw provider responses are retained. Its USD estimator is not used as a GLM bill.

Paw shell tools use the production Docker sandbox (Node Alpine, 1 GB / 2 CPU, network denied). Claude Code runs inside a separate read-only container with the same CPU/memory allocation, no Docker socket and no network. Its image adds Claude Code, Bash, Git and ripgrep. A file relay forwards only model message/count requests to the fixed BigModel endpoint. Real credentials remain in host memory; the container only receives a placeholder credential. The relay adds filesystem/polling overhead, so close latency differences should not be interpreted as a product ranking.

The isolation checks confirmed read-only root, absent Docker socket, blocked network and successful offline Claude Code transport. Offline transport-check responses are synthetic and excluded from model results. A separate minimal live connection check is excluded from the task comparison.

Paw maxSteps and Claude Code max-turns are not identical accounting units. Both own prompts/tool sets are preserved as product behavior; this is not a system-prompt-only or loop-only ablation. Paw offers 24 tools after delegation is removed; Claude Code offers six coding tools. Tool schema sizes are similar despite this count difference.

## Reproduction

Build the isolated Claude Code image from this directory's `Claude.Dockerfile`, tag it `paw-claude-bench:2.1.224`, and put Docker on PATH. Use fresh output directories and the locally ignored GLM settings; do not put API keys in commands.

```powershell
bun run benchmarks/desktop-harness-ab/tool-wire-probe.ts <paw-output> --queue --single-agent --wall-and-call-budget --docker
bun run benchmarks/desktop-harness-ab/claude-glm-probe.ts <paw-output> <claude-output> queue
python benchmarks/desktop-harness-ab/claude-comparison-report.py <paw-output> <claude-output>
```

The reporter runs each delivered `npm test` and the same frozen 15-check independent verifier in network-isolated containers. Grade only settled runs. All requirements, own tests, independent checks and an actual completed result must pass for full task completion. Fifteen checks do not establish exhaustive correctness. Interrupted requests without usage are unknown cost, never zero cost.

## Results

Completed on 2026-09-07. Evidence is retained in ignored `.runs/2026-09-07-glm-claude-comparison-paw` and `.runs/2026-09-07-glm-claude-comparison-claude`. The latter contains `comparison.json`, raw requests/responses, timestamped Claude events and source snapshots. Production runtime settings are unchanged.

| Observed measure | Paw desktop V3 + GLM | Claude Code + GLM |
| --- | ---: | ---: |
| Runtime elapsed | 720.068 s | 704.065 s |
| Stop reason | Wall budget; aborted | `error_max_turns`; no final completion |
| Physical model requests | 3 | 32 |
| First completed tool call emitted | 8.282 s | 6.553 s |
| First successful file write | None | 164.341 s |
| Longest request | About 705.8 s, interrupted | 124.208 s |
| Independent checks | 0/15 | 14/15 |
| Delivered `npm test` | Missing | 43/43 pass, exit 0 |
| README | Missing | Missing |
| Full task completion | No | No |

Both began calling inspection tools promptly. Paw read the requirements and then spent the entire remaining allowance in request 3: 117440 reasoning characters, zero text characters, zero parsed tools. Raw SSE also contains no tool-call deltas for that request. The pause was upstream of tool execution, not hidden file writes or an absent UI update. The v7 verification/convergence advisor never had a completed implementation step from which to intervene.

Claude Code inspected the workspace, spent 124.208 seconds in its next request, then proceeded through implementation and tests. It first wrote `src/queue.js` at 164.341 seconds and first invoked `npm test` at 472.38 seconds. Another request took 88.139 seconds while investigating CLI behavior. It corrected erroneous expectations about FIFO and restoring running jobs to pending, repaired `npm test` from `node --test test` to `node --test`, and continued editing through the limit. The last emitted Edit received a successful tool result before the max-turns error; it was not a lost final tool batch. It never created README or supplied a final completion response.

Claude Code's test commands often piped into `tail`, so exit zero on those tool calls was not treated as verification. The evaluator directly reran the delivered `npm test`: all 43 tests pass. An initial evaluator run used a different UID and failed to traverse Claude-created mode-0700 temporary directories with capabilities dropped. That evaluator defect was corrected by preserving UID 1000:1000. The invalid initial result remains as `comparison-initial-grader-uid.json`; it is excluded from the table. No generated implementation or test was edited by the evaluator. An earlier Git inspection also hit Docker bind-mount ownership checks; it did not prevent coding and remains recorded as an environment difference.

### Reported usage

All 32 Claude Code task requests returned usage; raw SSE sums match its final usage event:

| Usage | Tokens |
| --- | ---: |
| Uncached input | 34165 |
| Cached input | 668608 |
| Output, including reasoning as reported by provider | 25168 |
| Total including cached input | 727941 |

Paw's first two requests reported 7564 total tokens. Request 3 was interrupted without usage, so **Paw's total is unknown**. This sample cannot establish token savings or compare actual GLM bills. The minimal Claude connection check (three requests) and synthetic relay check are excluded from these task totals. Claude's internal model metadata displayed a 32000 output limit, but all actual captured task requests sent 128000; the wire requests are authoritative for the requested cap.

### Interpretation and next experiment

This sample shows a large difference in implementation progress with the same named model: Claude Code delivered working functionality and passing tests while Paw did not enter implementation. It also reproduces long thinking in Claude Code and incomplete closeout in both products. It does **not** establish that the model alone, Paw's system prompt alone, or the loop alone caused the difference.

The most useful next control is Paw using BigModel's Anthropic-compatible protocol with the same task and matched reasoning/output requests, while keeping its current prompt and tool set. That separates API adaptation from prompt/loop behavior. A later controlled prompt/tool experiment can then test bounded implementation steps and earlier verification. Merely copying the legacy runtime's 120-second timeout would have interrupted Claude's productive 124-second request too; deadline-and-retry alone is not evidence of a better harness.
