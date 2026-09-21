"""Compare settled, independently graded runs; never execute generated code."""
import collections
import json
import pathlib
import sys


def read(path):
    return json.loads(path.read_text(encoding="utf-8"))


def rows(path):
    return [json.loads(line) for line in path.read_text(encoding="utf-8").splitlines()]


def load(directory):
    root = pathlib.Path(directory)
    if not (root / "result.json").exists():
        raise ValueError("Both runs must settle before comparison")
    protocol = read(root / "protocol.json")
    grade = read(root / "single-agent-report.json")
    costs = read(root / "phase-cost-report.json")
    phases = rows(root / "phases.jsonl")
    starts = {row["callId"]: row for row in phases if row["type"] == "start"}
    child_runs = {row["runId"] for row in starts.values()
                  if row.get("runId", "").startswith("child-run-")}
    root_parameters = []
    for wire in rows(root / "wire.jsonl"):
        if wire["type"] != "request":
            continue
        start = starts[wire["callId"]]
        if start["phase"] != "agent_loop" or start.get("runId", "").startswith("child-run-"):
            continue
        request = read(root / f"request-{wire['id']}.json")
        root_parameters.append({key: value for key, value in request.items() if key != "messages"})
    if not root_parameters or any(value != root_parameters[0] for value in root_parameters):
        raise ValueError("Root wire settings/tools changed within the run")
    successful_tools = collections.Counter(
        row["event"]["tool"] for row in rows(root / "events.jsonl")
        if row["event"]["type"] == "tool.result" and row["event"].get("ok"))
    first_audit = min((row["id"] for row in costs["requests"]
                       if row["phase"] == "agent_loop:child"), default=None)
    stages = {"beforeFirstAudit": collections.Counter(), "auditAndSubsequentWork": collections.Counter()}
    for row in costs["requests"]:
        stage = stages["auditAndSubsequentWork" if first_audit is not None and row["id"] >= first_audit
                       else "beforeFirstAudit"]
        stage["physicalRequests"] += 1
        if row["usage"] is None:
            stage["requestsWithoutUsage"] += 1
        else:
            for key in ("promptTokens", "completionTokens", "totalTokens", "cachedPromptTokens", "cacheMissPromptTokens"):
                if key in row["usage"]:
                    stage[key] += row["usage"][key]
    return {
        "directory": str(root), "protocol": protocol,
        "rootWireParameters": root_parameters[0],
        "metrics": {
            "seconds": grade["seconds"], "completedAndVerified": grade["completedAndVerified"],
            "runtime": grade["runtime"], "functional": {
                "passed": grade["functional"]["passed"], "total": grade["functional"]["total"]},
            "ownTests": grade["ownTests"]["status"], "auditChildRuns": len(child_runs),
            "successfulTools": dict(successful_tools), "costs": costs["totals"],
            "phases": costs["phases"],
            "stages": stages,
        },
    }


def compare(before, after):
    old, new = load(before), load(after)
    fixed = ["goal", "budget", "tokenThresholdEnforced", "runtimeProfile", "baselineRuntimeProfile",
             "compositionVersion", "reasoningOverride", "capabilities", "taskMode", "environmentAudit",
             "configuredProfile", "recoveryFrom", "singleAgent", "journalReasoningRecovery",
             "thinkingRecovery", "taskVariant", "memory", "backgroundMemory", "desktopChainBudget",
             "toolChoiceOverride"]
    checks = {key: old["protocol"][key] == new["protocol"][key] for key in fixed}
    checks["rootWireParametersIncludingTools"] = old["rootWireParameters"] == new["rootWireParameters"]
    for key in ("imageId", "checks", "sandbox"):
        checks[f"isolation.{key}"] = old["protocol"]["isolation"][key] == new["protocol"]["isolation"][key]
    if not all(checks.values()):
        raise ValueError("Comparison settings differ: " + ", ".join(k for k, v in checks.items() if not v))
    old_hashes, new_hashes = old["protocol"]["sourceHashes"], new["protocol"]["sourceHashes"]
    changed = sorted(key for key in old_hashes.keys() | new_hashes.keys()
                     if old_hashes.get(key) != new_hashes.get(key))
    return {
        "schemaVersion": "paw.high-run-comparison.v1", "matchedChecks": checks,
        "changedFrozenSources": changed,
        "before": {"directory": old["directory"], **old["metrics"]},
        "after": {"directory": new["directory"], **new["metrics"]},
        "limitations": [
            "Single fresh samples: not a controlled replay or an estimated success rate.",
            "Generated implementations, memory contents, provider cache/load and host concurrency may differ.",
            "Provider token totals include cache hits; missing usage is unknown, not zero.",
            "Audit child count describes execution, not the correctness of each audit verdict.",
            "Frozen source lists cover recorded files, not every dependency in the workspace.",
        ],
    }


if __name__ == "__main__":
    result = compare(sys.argv[1], sys.argv[2])
    target = pathlib.Path(sys.argv[2]) / "high-run-comparison.json"
    target.write_text(json.dumps(result, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(json.dumps({"matched": all(result["matchedChecks"].values()),
                      "changedFrozenSources": result["changedFrozenSources"],
                      "before": result["before"], "after": result["after"]}, ensure_ascii=True))
