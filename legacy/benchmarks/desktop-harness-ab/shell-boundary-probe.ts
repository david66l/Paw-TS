/** Analyze the recorded command; never execute it or start a container. */
import fs from "node:fs";
import path from "node:path";
import { resolveShellSandboxConfig } from "../../packages/agent/src/resolve-shell-sandbox.js";
import { validateShellCommand } from "../../packages/harness/src/shell-guard.js";

const run = path.resolve(process.argv[2]!);
const protocol = JSON.parse(fs.readFileSync(path.join(run, "protocol.json"), "utf8"));
const calls = fs.readFileSync(path.join(run, "events.jsonl"), "utf8").trim().split(/\r?\n/).map((line) => JSON.parse(line));
const call = calls.find(({ event }) => event.type === "tool.call" && event.tool === "workspace_run_shell" && event.args.command.includes("%cd_root%"));
if (!call) throw new Error("Recorded scope-escape command not found");
const result = {
  commandExecuted: false,
  sandboxMode: resolveShellSandboxConfig(protocol.workspaceRoot).mode,
  guard: validateShellCommand(call.event.args.command),
  recordedCallId: call.event.callId,
  explanation: "The benchmark approval callback returned true for every request. An allowed guard result is not filesystem isolation; normal desktop sessions use the user's approval callback.",
};
fs.writeFileSync(path.join(run, "shell-boundary-probe.json"), JSON.stringify(result, null, 2));
console.log(JSON.stringify(result));
