# Paw-TS agent / harness — near-term plan

## Done (baseline)

- Harness: `workspace.read_file`, `workspace.list_dir`, `workspace.write_file` with path guard.
- `AgentOrchestrator`: system prompt includes `toolCatalogText()`, workspace root line, tool loop, approvals.
- `FakeLanguageModel`: list / read / write intents for tests.
- Orchestrator tests: write + `resolveToolApproval` approve/deny.

## Phase A — Search tool ✅

1. **Workspace**: `searchWorkspaceText` — bounded recursive scan, ignore dirs (same list as `listWorkspaceFiles`), max file size, max matches, optional glob + regex flag.
2. **Harness**: `workspace.search`, catalog line, `toolRequiresApproval` treats search like read (no gate by default).
3. **Agent UX**: `formatToolResultEventDetail` for match payloads; fake model “search/grep” intent; orchestrator smoke test.

## Phase B — TUI approvals ✅

1. **`approvalPolicyWhenStrict(strict)`** in `apps/tui/src/approval-policy.ts` + unit test.
2. Interactive `y`/`n` flow unchanged in `App.tsx`; `/help` documents `PAW_TUI_STRICT_TOOL_APPROVAL`.

## Phase C — `run_shell` + docs ✅

- **`workspace.run_shell`**: `shell-guard.ts` + `run-shell.ts` (`cwd` under workspace, timeout clamp 1s–300s, capped stdout/stderr).
- **README**: tools table + JSON example + guard note.
