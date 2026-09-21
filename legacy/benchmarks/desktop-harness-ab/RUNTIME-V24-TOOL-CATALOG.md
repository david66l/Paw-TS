# V24: frozen Paw request with a smaller tool catalog

2026-09-08. Decision-only follow-up to V23; no production tool exposure, prompt, model or runtime behavior changes.

## Intervention and controls

Start with the same frozen V14 post-inspection request. Filter its 24 tool definitions to 11, preserving their original relative order, names, descriptions and parameter schemas. The actual Anthropic request is otherwise identical to V23: full system/user/history/results, sampling omissions, `glm-5.3-flash`, max effort, enabled thinking with a 32,000 budget, 128,000 output limit, auto tool choice and a 360-second full-response observation window. Both requests omit the same 67 historical reasoning characters for the already documented conversion constraint.

Retained tools:

- `context_recall` for bounded archived output retrieval.
- `workspace_list_dir`, `workspace_search`, `workspace_read_file` for inspection.
- `workspace_write_file`, `workspace_edit_file`, `workspace_apply_patch` for implementation and repair.
- `workspace_run_shell` for Node/npm commands and tests in the declared task environment.
- `workspace_git_status`, `workspace_git_diff` for workspace change inspection.
- `workspace_todo_write` for task progress.

The 13 omitted tools are Git log, glob, five managed-background-job tools, LSP, progress read, symbol search, MCP, web fetch and web search. This task explicitly requires built-in Node.js libraries and no external network or package installation. It does not require background services. Ordinary file listing/search, foreground commands, editing and testing remain available, and every tool referenced by the existing history is retained. This is a task-scoped diagnostic selection, not a proposed universal production catalog; future tasks may need omitted capabilities.

The intervention changes both catalog membership and its size. It cannot attribute an effect to the number of tools, a particular description, naming, schema shape or model familiarity independently. It does not change the remaining definitions to ZCode's tools or modify historical results to resemble ZCode.

The control is the already settled V23 24-tool response, so provider load, cache age and random variation remain uncontrolled. A positive result requires a fresh control/repetition and full-task verification before implementing automatic tool selection. These probes use direct fetch after input capture; generated tools do not execute, no Docker starts, and there is no retry or effort downgrade.

## Results

| Arm | First thinking | Observed duration | Thinking characters | Visible text | Tool calls | Result |
| --- | ---: | ---: | ---: | ---: | ---: | --- |
| V23 control: 24 tools | 4.621 s | 360.007 s | 69,138 | 0 | 0 | Wall timeout |
| V24: 11 retained tools | 5.678 s | 360.018 s | 62,569 | 0 | 0 | Wall timeout |

Both return HTTP 200 and ongoing thinking but no tool event or provider terminal event. Counts are UTF-16 characters, not tokens, progress or a quality score. Both initial usage records contain zero values; these are provisional and final usage remains unknown. The lower character count does not establish cheaper execution or faster action.

Paired verification passes: the derived source differs only in tool filtering; remaining definitions and historical references are intact; the transmitted requests differ only in their tool arrays; the endpoint, probe snapshot and observation window match; both raw SSE streams reproduce the recorded counts and lack of tool events. No tool arguments exist to validate, no generated tool executes, and coding quality/task completion are not evaluated.

## Interpretation and next isolation

Reducing this catalog from 24 to 11 tools did not produce action within six minutes in this sample. This weakens the proposed remedy of simply removing unrelated tools, but cannot prove catalog composition is irrelevant or that either censored response would never finish. The old control, single samples and joint size/membership intervention limit causal conclusions.

The problem in these captures still precedes tool dispatch; it is not a missed execution of a tool call already present in the raw response. Context produced by the harness remains a possible influence. V21's successful native-context responses provide a useful positive reference, but successful TodoWrite calls alone do not establish completed coding.

A read-only comparison identifies a narrower tool-guidance difference: native ZCode's TodoWrite describes a task list rendered to the user as a working plan, whereas the frozen Paw `workspace_todo_write` description emphasizes replacing the durable list once per batch and updating completion status. Their schemas also differ (Paw requires task IDs and uses `done`; ZCode uses `completed`). This is an observed contract difference, not a demonstrated explanation for the stall. Do not copy an incompatible schema into Paw or claim a missing planning tool: Paw already has one.

The next useful experiment should change one remaining semantic component while retaining a known control: for example, clarify the planning purpose in only the existing Paw todo description while preserving its name/schema and all other tools/history. Separately compare historical result presentation and the retained native environment/context-management guidance. Avoid changing all of these together, forcing every task to plan, or treating a planning-only transition as the final success criterion. Any positive decision result still needs repetition and actual isolated task execution before a production fix is justified.

This negative result does not change production tool exposure. Only the offline input/verification helper, report and benchmark index were added/updated. Syntax checking, exact input comparison, paired raw-response verification and changed-file whitespace checks pass. No application behavior changed, so the broad application suite was not rerun. The paid probe has settled and no model request from this experiment remains active.

## Evidence and reproduction

Original source: `.runs/2026-09-08-v14-live-queue-max/request-3.json`, SHA-256 `2d112d270ffc3c3e3f9e9f7dffda3f7e0586e82e4210c6c9fa6f0a9db3125e30`.

Derived source: `.runs/2026-09-08-v24-catalog-input/request.json`, SHA-256 `f4cb2dfb09f0cc3551b4d23175a6317c77014a22a7e2dc71f592413101993b75`.
Helper SHA-256: `44f3ce1bab2390c24198cc0a65bd713d0d22b42fa44e1c71aef033c04d19fcf9`.
Treatment evidence: `.runs/2026-09-08-v24-catalog-11-360`, including the transmitted request, protocol/probe snapshot, raw SSE, result, independent check and catalog comparison.

`tool-catalog-decision.py prepare` only accepts this frozen source, asserts historical tool references remain available, preserves the original JSON except tools, and stores source/derived hashes plus its own snapshot in a fresh input directory. The existing protocol probe runs unchanged. `verify` traces the derived source back to the original, checks exact remaining definitions and request equality except tool filtering, then independently reconstructs both raw responses using the protocol verifier. It records `catalog-comparison.json` in the treatment directory.

```powershell
python benchmarks/desktop-harness-ab/tool-catalog-decision.py prepare benchmarks/desktop-harness-ab/.runs/2026-09-08-v14-live-queue-max/request-3.json benchmarks/desktop-harness-ab/.runs/2026-09-08-v24-catalog-input
bun run benchmarks/desktop-harness-ab/protocol-decision-probe.ts benchmarks/desktop-harness-ab/.runs/2026-09-08-v24-catalog-input/request.json benchmarks/desktop-harness-ab/.runs/2026-09-08-v24-catalog-11-360 anthropic-default-sampling --extended
python benchmarks/desktop-harness-ab/tool-catalog-decision.py verify benchmarks/desktop-harness-ab/.runs/2026-09-08-v23-default-sampling-360 benchmarks/desktop-harness-ab/.runs/2026-09-08-v24-catalog-11-360
```

Run from the repository root with fresh directories and existing ignored local credentials. The prepare/verify commands are offline; only the probe sends a paid request.
