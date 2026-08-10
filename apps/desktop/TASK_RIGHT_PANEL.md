# Task: Wire desktop RightPanel to real Agent run events

## Goal
Replace placeholder RightPanel tabs with live data derived from Electron IPC agent events already flowing into the desktop UI.

## Scope (do this)
1. **Plan tab** — show plan steps when available; empty state when not.
2. **Changes tab** — list files touched this run via tools.
3. **Context tab** — light live snapshot from `context.budget` / `cost.update` / `loop.tick` if easy.
4. **Memory tab** — show last `memory.retrieve.done` summary (count) if easy.

Out of scope: multi-turn chat history, tool approval modal, session list, Figma pixel polish.

## Architecture (existing)
```
React UI --ipc--> Electron main --stdin/stdout JSON--> bun agent-host
Events already forwarded: agent:event with RunEventEnvelope
Hook: apps/desktop/src/agent/useAgentRun.ts listens via window.pawDesktop.onEvent
RightPanel: apps/desktop/src/components/RightPanel.tsx (placeholder only)
App: apps/desktop/src/App.tsx — RightPanel has no props yet
```

## Event sources (from packages/core RunEvent)
- `plan.updated` — `{ revision, itemCount, reason }` only (NO full items list)
- `agent.action` — when present with `action.type === "plan_update"` has `newItems`, `deprecatedItems`, `reason`
- `tool.call` — `{ tool, args }`
- `tool.result` — `{ tool, ok, summary, detail? }`
- `context.budget` — token pools
- `cost.update` — tokens / cost
- `loop.tick` — turn / maxSteps / estimatedTokens
- `memory.retrieve.done` — selectedCount etc.
- `run.started` / `run.completed` / `run.failed`

## Plan data strategy (important)
Because `plan.updated` lacks item text, accumulate client-side:
1. On `agent.action` with plan_update: merge `newItems` into local plan list (parse flexibly: string | {text|content|task_id|id|status}).
2. On `plan.updated`: update meta `{ revision, itemCount, reason }`; if itemCount becomes 0 clear list.
3. Optionally derive soft status from tool progress (not required).
4. Empty state when no plan items and no meta.

## Changes data strategy
On `tool.call` / `tool.result` for write-like tools, extract path from args:
- tools: `workspace.write_file`, `workspace.edit_file`, anything with `path` / `relPath` / `file` in args
- Record: `{ path, tool, ok?, summary?, at }`
- Dedupe by path (keep latest)
- On new run (`run.started`): clear changes list (and plan for that run)

## Implementation outline
1. Extend run-side state in `useAgentRun.ts` (or small new hook `useRightPanelData.ts` fed from same events):
   - `plan: { revision?, reason?, items: { id, text, status? }[] }`
   - `changes: { path, tool, ok?, summary? }[]`
   - `context: { turn?, maxSteps?, estimatedTokens?, budget?, cost? } | null`
   - `memory: { selectedCount?, query? } | null`
2. Clear panel state on new send / run.started.
3. Pass data into `RightPanel` from `App.tsx`.
4. Redesign `RightPanel.tsx` + CSS:
   - Plan: step list with status dots; show reason/revision footer
   - Changes: file list with ok/fail tint; empty state
   - Context / Memory: compact stats or empty
5. Keep glass styling consistent with existing tokens (light glass UI).
6. Typecheck must pass. Prefer small focused unit tests for pure reducers if you extract event→state pure functions.

## Acceptance
```bash
cd /Users/Zhuanz/Documents/CS/项目/paw-ts/apps/desktop
bun run typecheck
bun test ../desktop/test 2>/dev/null || bun test test
```
Manual / code-level:
- RightPanel no longer only shows static placeholder forever when events arrive
- Plan tab renders items when plan_update / plan.updated fired
- Changes tab lists write paths after write tools
- Empty states still look good when idle
- Do not break chat stream / thinking / markdown

## Constraints
- Work only under `apps/desktop/` unless a tiny shared type is necessary
- No new heavy UI libraries
- Surgical diffs; no drive-by refactors
- Do not commit unless asked

## Deliver
- Code changes
- Brief summary of files changed and how to verify
EOF
pwd
ls -la /Users/Zhuanz/Documents/CS/项目/paw-ts/apps/desktop/TASK_RIGHT_PANEL.md
