"""Compare settled offline desktop replays. Reads data only; grading is separate."""
import hashlib
import json
import pathlib
import sys


def read(path):
    return json.loads(path.read_text(encoding="utf-8"))


def rows(path):
    return [json.loads(line) for line in path.read_text(encoding="utf-8").splitlines()]


def summarize(run):
    replay = read(run / "replay.json")
    assert replay["kind"] == "offline_recorded_model_replay"
    assert replay["replayed"] == replay["available"]
    for item in replay["sourceResponses"]:
        assert hashlib.sha256((run / item["name"]).read_bytes()).hexdigest() == item["sha256"]
    for name, digest in replay.get("profiledSources", {}).items():
        assert hashlib.sha256((run / "replay-source-snapshot" / name).read_bytes()).hexdigest() == digest
    protocol = read(run / "protocol.json")
    terminal = read(run / "result.json")
    assert terminal["ok"] and json.loads(terminal["text"])["status"] == "completed"
    verification = read(run / "single-agent-report.json")
    assert verification["completedAndVerified"]
    events = rows(run / "events.jsonl")
    phases = rows(run / "phases.jsonl")
    starts = {row["event"]["callId"]: row["at"] for row in events if row["event"]["type"] == "tool.call"}
    intervals = sorted((starts[row["event"]["callId"]], row["at"]) for row in events if row["event"]["type"] == "tool.result")
    merged = []
    for start, end in intervals:
        if merged and start <= merged[-1][1]:
            merged[-1][1] = max(merged[-1][1], end)
        else:
            merged.append([start, end])
    tool_seconds = sum(end - start for start, end in merged) / 1000
    model_starts = {row["callId"]: row["at"] for row in phases if row["type"] == "start"}
    model_seconds = sum(row["at"] - model_starts[row["callId"]] for row in phases if row["type"] == "end") / 1000
    seconds = (terminal["finishedAt"] - protocol["startedAt"]) / 1000
    workspace = pathlib.Path(protocol["workspaceRoot"])
    deliverables = ["src/queue.js", "src/store.js", "src/cli.js", "test/queue.test.js", "package.json", "README.md", "REQUIREMENTS.md"]
    return {
        "run": str(run), "seconds": seconds, "toolUnionSeconds": tool_seconds,
        "recordedResponseHandlingSeconds": round(model_seconds, 3),
        "otherHostResidualSeconds": round(seconds - tool_seconds - model_seconds, 3),
        "requests": replay["replayed"], "completedAndVerified": True,
        "deliverablesSha256": {name: hashlib.sha256((workspace / name).read_bytes()).hexdigest() for name in deliverables},
    }, replay, protocol


if __name__ == "__main__":
    before, before_replay, before_protocol = summarize(pathlib.Path(sys.argv[1]).resolve())
    after, after_replay, after_protocol = summarize(pathlib.Path(sys.argv[2]).resolve())
    assert before_replay["sourceResponses"] == after_replay["sourceResponses"]
    assert before_protocol["isolation"]["imageId"] == after_protocol["isolation"]["imageId"]
    assert before_protocol["goal"] == after_protocol["goal"]
    assert before["deliverablesSha256"] == after["deliverablesSha256"]
    result = {
        "kind": "offline_recorded_model_replay_comparison", "before": before, "after": after,
        "elapsedReductionPercent": round(100 * (1 - after["seconds"] / before["seconds"]), 2),
        "limits": "One ordered replay per condition, immediate recorded responses, CPU profiler enabled. Not a live-model completion, reasoning, or paid-token benchmark. Residual is not measured component CPU time.",
    }
    pathlib.Path(sys.argv[3]).write_text(json.dumps(result, indent=2), encoding="utf-8")
    print(json.dumps(result))
