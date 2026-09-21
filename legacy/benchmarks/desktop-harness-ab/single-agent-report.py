"""Settle and independently grade a single-agent queue experiment; never grade live files."""
import hashlib
import json
import pathlib
import re
import subprocess
import sys
import uuid

run = pathlib.Path(sys.argv[1]).resolve()
protocol = json.loads((run / "protocol.json").read_text(encoding="utf-8"))
result = json.loads((run / "result.json").read_text(encoding="utf-8"))
metrics = json.loads((run / "verification.json").read_text(encoding="utf-8"))
assert protocol["singleAgent"] and protocol["taskVariant"] == "queue"
assert isinstance(protocol["environmentAudit"], bool)
isolation = protocol.get("isolation")
assert isolation and isolation.get("ok"), "Unattended grading requires verified Docker isolation"
for relative, expected in protocol["sourceHashes"].items():
    snapshot = run / "source-snapshot" / relative
    assert hashlib.sha256(snapshot.read_bytes()).hexdigest() == expected, relative

def jsonl(name):
    file = run / name
    return [json.loads(line) for line in file.read_text(encoding="utf-8").splitlines()] if file.exists() else []

requests = [json.loads(file.read_text(encoding="utf-8")) for file in run.glob("request-*.json")]
main = [request for request in requests if request.get("tools")]
assert main
assert all(request.get("max_tokens") == protocol["capabilities"]["maxOutputTokens"] and request.get("reasoning_effort") == protocol["runtimeProfile"]["reasoningEffort"] and request.get("model") == protocol["runtimeProfile"]["model"] for request in main)
assert all("workspace_delegate" not in [tool["function"]["name"] for tool in request.get("tools", [])] for request in requests)
events = jsonl("events.jsonl")
assert not any(row["event"].get("tool") == "workspace_delegate" for row in events)
parsed = jsonl("parsed.jsonl")
starts = {row["id"] for row in parsed if row["type"] == "start"}
with_usage = {row["id"] for row in parsed if row["type"] == "finish" and row.get("usage")}
recovery = jsonl("recovery.jsonl")
# Production V3 recovers through a new journaled loop turn, not the opt-in
# adapter's recovery.jsonl. Count distinct host guidance anchors in actual wire
# requests; later incremental requests repeat the same anchor and are not retries.
journal_recovery_sources = sorted({
    int(match.group(1))
    for request in requests
    for message in request.get("messages", [])
    if message.get("role") == "user" and isinstance(message.get("content"), str)
    for match in [re.match(r"\[Paw execution recovery; sourceSeq=(\d+)\]", message["content"])]
    if match is not None
})
experimental_recoveries = sum(row["type"] == "retry" for row in recovery)

workspace = pathlib.Path(protocol["workspaceRoot"])
verifier = run / "source-snapshot/legacy/benchmarks/desktop-harness-ab/verify.mjs"

def container_run(command, *, independent=False):
    name = "paw-grade-" + uuid.uuid4().hex[:16]
    args = ["docker", "run", "--rm", "--name", name, "--pull", "never",
            "--network", "none", "--read-only", "--cap-drop", "ALL",
            "--security-opt", "no-new-privileges", "--memory", "1024m",
            "--cpus", "2", "--pids-limit", "128", "--tmpfs", "/tmp:exec,nosuid,size=256m",
            "-w", "/workspace", "--mount", f"type=bind,source={workspace},target=/workspace" + (",readonly" if independent else "")]
    if independent:
        args += ["--mount", f"type=bind,source={verifier},target=/verifier.mjs,readonly"]
    args += [isolation["imageId"], *command]
    try:
        return subprocess.run(args, capture_output=True, text=True, encoding="utf-8", errors="replace", timeout=90, creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0))
    finally:
        subprocess.run(["docker", "rm", "-f", name], capture_output=True, timeout=15, creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0))

# Run the delivered test command, not a replacement chosen by the evaluator.
own = {"status": "missing", "exitCode": None}
package = workspace / "package.json"
if package.exists():
    metadata = json.loads(package.read_text(encoding="utf-8"))
    if metadata.get("scripts", {}).get("test"):
        try:
            process = container_run(["npm", "test"])
            own = {"status": "passed" if process.returncode == 0 else "failed", "exitCode": process.returncode, "stdout": process.stdout, "stderr": process.stderr}
        except subprocess.TimeoutExpired:
            own = {"status": "timeout", "exitCode": None}

# Verify after the generated tests finish so any source changes they make are included.
grade = container_run(["node", "/verifier.mjs", "queue", "/workspace"], independent=True)
if grade.returncode:
    raise RuntimeError("Independent verifier failed: " + grade.stderr)
functional = json.loads(grade.stdout)

try:
    terminal = json.loads(result.get("text", "{}"))
except json.JSONDecodeError:
    terminal = {}
writes = [row for row in events if row["event"].get("type") == "tool.result" and row["event"].get("ok") and row["event"].get("tool") in ("workspace_write_file", "workspace_edit_file", "workspace_apply_patch")]
report = {
    "model": protocol["runtimeProfile"]["model"],
    "reasoningEffort": protocol["runtimeProfile"]["reasoningEffort"],
    "environmentAudit": protocol["environmentAudit"],
    "nativeOutputLimit": protocol["capabilities"]["maxOutputTokens"],
    "seconds": metrics["seconds"],
    "physicalRequests": metrics["physicalRequests"],
    "reportedTokens": metrics["reportedTokens"],
    "requestsWithoutUsage": len(starts - with_usage),
    "totalTokenCostKnown": not (starts - with_usage),
    "firstSuccessfulFileToolSeconds": (writes[0]["at"] - protocol["startedAt"]) / 1000 if writes else None,
    "successfulFileTools": len(writes),
    "recoveries": experimental_recoveries + len(journal_recovery_sources),
    "experimentalAdapterRecoveries": experimental_recoveries,
    "journalRecoveryGuidanceSourceSeqs": journal_recovery_sources,
    "reporterSourceSha256": hashlib.sha256(pathlib.Path(__file__).read_bytes()).hexdigest(),
    "runtime": {"ok": result.get("ok"), "status": terminal.get("status"), "acceptance": terminal.get("acceptance")},
    "functional": functional,
    "ownTests": own,
    "completedAndVerified": result.get("ok") is True and terminal.get("status") == "completed" and (not protocol["environmentAudit"] or terminal.get("acceptance") == "verified") and functional["passed"] == functional["total"] and own["status"] == "passed",
    "memoryEnabled": bool(protocol.get("memory")),
    "limits": ["One sample, no success-rate inference", "Configured main effort/native output confirmed from actual requests", "No delegated workers; auxiliary completion review retained", "Environment audit enabled" if protocol["environmentAudit"] else "Environment audit disabled", "Historical runs are descriptive only; not a matched ablation", "Unknown usage from interrupted requests prevents a claim of token savings"],
}
(run / "single-agent-report.json").write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")
print(json.dumps({key: report[key] for key in ("seconds", "recoveries", "reportedTokens", "requestsWithoutUsage", "completedAndVerified")}))
print(json.dumps({"functional": f'{functional["passed"]}/{functional["total"]}', "ownTests": own["status"]}))
