"""Compare settled old/new desktop prompt runs without changing the workspaces."""
import hashlib
import json
import pathlib
import sys

old_dir, new_dir = [pathlib.Path(arg).resolve() for arg in sys.argv[1:3]]

def read(root, name):
    return json.loads((root / name).read_text(encoding="utf-8"))

old, new = [read(root, "protocol.json") for root in (old_dir, new_dir)]
for key in ("goal", "budget", "runtimeProfile", "capabilities", "taskMode", "environmentAudit", "singleAgent", "thinkingRecovery", "taskVariant", "memory", "toolChoiceOverride"):
    assert old[key] == new[key], f"Not a prompt-only comparison: {key}"
assert old.get("tokenThresholdEnforced", True) == new.get("tokenThresholdEnforced", True), "Not a prompt-only comparison: tokenThresholdEnforced"
allowed_changes = {"apps/desktop/agent-host/paw-next-profile.ts", "legacy/benchmarks/desktop-harness-ab/tool-wire-probe.ts"}
changed = {name for name, value in old["sourceHashes"].items() if new["sourceHashes"].get(name) != value}
assert changed <= allowed_changes, f"Unexpected source changes: {changed}"
for root, protocol in ((old_dir, old), (new_dir, new)):
    for relative, expected in protocol["sourceHashes"].items():
        assert hashlib.sha256((root / "source-snapshot" / relative).read_bytes()).hexdigest() == expected
before, after = [read(root, "request-1.json") for root in (old_dir, new_dir)]
assert before["messages"][0]["role"] == after["messages"][0]["role"] == "system"
assert before["messages"][0]["content"] != after["messages"][0]["content"]
assert before["messages"][1:] == after["messages"][1:]
assert {k: v for k, v in before.items() if k != "messages"} == {k: v for k, v in after.items() if k != "messages"}

def summarize(root):
    report = read(root, "single-agent-report.json")
    wire = read(root, "wire-analysis.json")
    assert wire["allToolFieldsIdentical"] and wire["allStreamTextAndThinkingCountsIdentical"]
    parsed = [json.loads(line) for line in (root / "parsed.jsonl").read_text(encoding="utf-8").splitlines()]
    starts = {row["id"]: row["at"] for row in parsed if row["type"] == "start"}
    endings = {row["id"]: row["at"] for row in parsed if row["type"] in ("counts", "finish", "error")}
    longest = max((row for row in wire["requests"] if row["stream"]), key=lambda row: endings[row["callId"]] - starts[row["callId"]])
    return {
        "seconds": report["seconds"],
        "calls": report["physicalRequests"],
        "reportedTokens": report["reportedTokens"],
        "requestsWithoutUsage": report["requestsWithoutUsage"],
        "firstSuccessfulFileToolSeconds": report["firstSuccessfulFileToolSeconds"],
        "functional": f'{report["functional"]["passed"]}/{report["functional"]["total"]}',
        "ownTests": report["ownTests"]["status"],
        "runtimeStatus": report["runtime"]["status"],
        "completedAndVerified": report["completedAndVerified"],
        "longestCall": {
            "id": longest["callId"],
            "seconds": (endings[longest["callId"]] - starts[longest["callId"]]) / 1000,
            "firstRawToolMs": longest["firstRawToolMs"],
            "thinkingChars": longest["rawThinkingChars"],
        },
    }

comparison = {
    "verifiedIntervention": "Initial provider request differs only in system content; task, model, tools, recovery and budgets match",
    "changedSourceFiles": sorted(changed),
    "old": summarize(old_dir),
    "new": summarize(new_dir),
    "limits": ["One run per prompt; not an estimated success rate or proof of causality", "Prompt language and wording changed together", "Historical baseline partly overlapped another provider's run; latency is descriptive", "Only files listed in the frozen manifests are source-verified"],
}
(new_dir / "prompt-comparison.json").write_text(json.dumps(comparison, ensure_ascii=False, indent=2), encoding="utf-8")
print(json.dumps(comparison, ensure_ascii=False))
