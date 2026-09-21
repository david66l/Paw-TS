"""Audit a settled V33 run's actual wire guidance without printing model reasoning.

Usage: python execution-budget-report.py <run> <baseline>
Run threeway-grade.py and threeway-adjudicate.py first.
"""
import hashlib
import json
import pathlib
import re
import sys


def read(path):
    return json.loads(path.read_text(encoding="utf-8"))


def rows(path):
    return [json.loads(line) for line in path.read_text(encoding="utf-8").splitlines() if line]


def audit(root, baseline):
    assert (root / "result.json").exists(), "Run must settle before audit"
    protocol = read(root / "protocol.json")
    previous = read(baseline / "protocol.json")
    assert not protocol.get("seedFrom") and not previous.get("seedFrom"), "Artifact continuations are not fresh-task comparisons"
    fields = ["goal", "budget", "runtimeProfile", "capabilities", "environmentAudit",
              "singleAgent", "taskMode", "memory", "tokenThresholdEnforced", "configuredProfile"]
    matched = {key: protocol.get(key) == previous.get(key) for key in fields}
    matched["imageId"] = protocol["isolation"]["imageId"] == previous["isolation"]["imageId"]
    assert all(matched.values()), matched
    for name, expected in protocol["sourceHashes"].items():
        assert hashlib.sha256((root / "source-snapshot" / name).read_bytes()).hexdigest() == expected, name
    phases = read(root / "phase-cost-report.json")
    by_id = {item["id"]: item for item in phases["requests"]}
    wire = [item for item in rows(root / "wire.jsonl") if item["type"] == "request"]
    requests = []
    remaining = []
    for item in wire:
        payload = read(root / f"request-{item['id']}.json")
        phase = by_id[item["id"]]
        if phase["phase"] != "agent_loop:root":
            continue
        content = "\n".join(str(message.get("content", "")) for message in payload["messages"])
        values = re.findall(r"\[Paw execution budget v1\] Host-observed remaining time: (\d+) seconds", content)
        assert len(values) == 1, (item["id"], "expected exactly one host budget hint")
        seconds = int(values[0])
        remaining.append(seconds)
        incremental = "[Paw incremental verification v1]" in content
        assert incremental, (item["id"], "missing incremental verification guidance")
        assert payload.get("model") == "glm-5.3-flash" and payload.get("reasoning_effort") == "high"
        assert payload.get("max_tokens") == 128_000
        requests.append({
            "id": item["id"], "atSeconds": (item["at"] - protocol["startedAt"]) / 1000,
            "remainingSeconds": seconds,
            "closeoutHint": "The verification and delivery reserve has been reached." in content,
            "durationSeconds": phase["seconds"], "status": phase["status"],
            "maxOutputTokens": payload.get("max_tokens"), "usage": phase["usage"],
        })
    assert remaining and all(a >= b for a, b in zip(remaining, remaining[1:])), "Time regained"
    grade = read(root / "threeway-grade.json")
    old_grade = read(baseline / "threeway-grade.json")
    matched["originalVerifier"] = grade["verifierHash"] == old_grade["verifierHash"]
    for key in ["storageAdjudication", "isolationAdjudication"]:
        matched[key] = grade[key]["verifierHash"] == old_grade[key]["verifierHash"]
        name = "workflow-storage-adjudication.mjs" if key == "storageAdjudication" else "workflow-isolation-adjudication.mjs"
        assert grade[key]["verifierHash"] == protocol["sourceHashes"]["legacy/benchmarks/desktop-harness-ab/" + name]
    assert all(matched.values()), "Acceptance criteria changed"

    def summary(value):
        return {key: value.get(key) for key in ["seconds", "physicalRequests", "completed", "usage",
                                               "firstSuccessfulWriteSeconds"]} | {
            "acceptance": {key: value["adjudicatedFunctional"][key] for key in ["passed", "total"]},
            "selfTestsExitCode": value["ownTests"]["exitCode"],
            "selfTestCounts": value["ownTests"]["counts"],
        }

    result = {"schemaVersion": "paw.execution-budget-audit.v1", "matched": matched,
              "current": summary(grade), "baseline": summary(old_grade), "rootRequests": requests,
              "limitations": ["One sequential follow-up sample, not a paired repeated causal experiment.",
                              "Missing provider usage is unknown; token sums are not prices.",
                              "A prompt reaching the provider does not prove the model followed it."]}
    (root / "execution-budget-audit.json").write_text(json.dumps(result, indent=2) + "\n", encoding="utf-8")
    return result


if __name__ == "__main__":
    print(json.dumps(audit(pathlib.Path(sys.argv[1]).resolve(), pathlib.Path(sys.argv[2]).resolve()), indent=2))
