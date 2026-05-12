# Paw (TypeScript)

Self-contained Bun monorepo: `packages/*`, `apps/*`. Install and run **from this directory**:

```bash
cd paw-ts
bun install
bun run tui
bun run cli -- --help
```

From the repository root you can use the same scripts via `bun run tui` etc. (they `cd paw-ts` for you).

Do not add Python imports or depend on `../src/paw` from this tree.

## Agent tools (harness)

Runs use `AgentOrchestrator` with a single **system** message that includes `toolCatalogText()` plus the workspace root. The model must emit **one JSON object on its own line** for tools or structured actions.

| Tool | Purpose | Default approval (when `resolveToolApproval` is set) |
|------|---------|------------------------------------------------------|
| `workspace.read_file` | Read UTF-8 file (relative path, optional offset/limit) | No |
| `workspace.list_dir` | List directory (optional recursive) | No |
| `workspace.search` | Search text under workspace (pattern, path, glob, regex flag, caps) | No |
| `workspace.write_file` | Write/overwrite file | Yes |
| `workspace.run_shell` | Run shell command; `cwd` relative to workspace; `timeout_sec` default 60 | Yes |

Example tool line:

```json
{"tool":"workspace.run_shell","args":{"command":"npm test","cwd":".","timeout_sec":120}}
```

Shell commands pass a **guard** (blocks e.g. `$(`, subshell markers, `rm` / `sudo` as leading tokens, known destructive strings). Execution uses `/bin/sh -c` on Unix and `cmd.exe /c` on Windows.

## Tests

Unit tests live under each package or app’s `test/` directory. From this directory:

```bash
bun run check:ts   # biome lint + tsc on all workspaces + every package/app test
bun run test:ts    # tests only
```

Single workspace: `cd packages/agent && bun run test`.
