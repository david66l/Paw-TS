"""Read settled probe artifacts; never execute model-generated code."""
import hashlib
import json
import pathlib
import sys


def read(path):
    return json.loads(path.read_text(encoding="utf-8"))


def rows(path):
    return [json.loads(line) for line in path.read_text(encoding="utf-8").splitlines()] if path.exists() else []


def union_seconds(intervals):
    """Parallel tools contribute elapsed time once, not once per tool."""
    merged = []
    for start, end in sorted(intervals):
        assert end >= start
        if merged and start <= merged[-1][1]:
            merged[-1][1] = max(merged[-1][1], end)
        else:
            merged.append([start, end])
    return sum(end - start for start, end in merged) / 1000


def stream_counts(path):
    counts = {"reasoningChars": 0, "textChars": 0, "toolArgumentChars": 0}
    if not path.exists():
        return counts
    for line in path.read_text(encoding="utf-8").splitlines():
        if not line.startswith("data:") or line[5:].strip() == "[DONE]":
            continue
        try:
            payload = json.loads(line[5:])
        except json.JSONDecodeError:
            continue
        for choice in payload.get("choices", []):
            delta = choice.get("delta", {})
            counts["reasoningChars"] += len(delta.get("reasoning_content") or "")
            counts["textChars"] += len(delta.get("content") or "")
            counts["toolArgumentChars"] += sum(len(tool.get("function", {}).get("arguments") or "") for tool in delta.get("tool_calls", []))
    return counts


def normalized_initial_request(run, protocol):
    request = read(run / "request-1.json")
    request.pop("reasoning_effort")
    root = protocol["workspaceRoot"]

    def normalize(value):
        if isinstance(value, str):
            return value.replace(json.dumps(root)[1:-1], "<WORKSPACE>").replace(root, "<WORKSPACE>")
        if isinstance(value, list):
            return [normalize(item) for item in value]
        if isinstance(value, dict):
            return {key: normalize(item) for key, item in value.items()}
        return value

    return normalize(request)


def summarize(run):
    protocol = read(run / "protocol.json")
    result = read(run / "result.json")
    metrics = read(run / "verification.json")
    started = protocol["startedAt"]
    assert result["finishedAt"] >= started
    for name, expected in protocol["sourceHashes"].items():
        assert hashlib.sha256((run / "source-snapshot" / name).read_bytes()).hexdigest() == expected, name
    parsed = rows(run / "parsed.jsonl")
    phases = rows(run / "phases.jsonl")
    events = rows(run / "events.jsonl")
    wire = rows(run / "wire.jsonl")
    requests = [read(file) for file in sorted(run.glob("request-*.json"))]
    main = [request for request in requests if request.get("tools")]
    assert main
    assert all(request["model"] == protocol["runtimeProfile"]["model"] and request["reasoning_effort"] == protocol["runtimeProfile"]["reasoningEffort"] and request["max_tokens"] == protocol["capabilities"]["maxOutputTokens"] for request in main)
    try:
        terminal = json.loads(result.get("text", "{}"))
    except json.JSONDecodeError:
        terminal = {}
    starts = {row["id"]: row for row in parsed if row["type"] == "start"}
    finishes = {row["id"]: row for row in parsed if row["type"] == "finish"}
    phase_starts = {row["callId"]: row for row in phases if row["type"] == "start"}
    phase_ends = {row["callId"]: row for row in phases if row["type"] == "end"}
    calls = []
    for call_id, start in starts.items():
        observations = [row for row in phases if row["callId"] == call_id and row["type"] == "observation"]
        end = phase_ends.get(call_id)
        thinking = next((row["at"] for row in observations if row["event"]["type"] == "delta" and row["event"]["kind"] == "thinking"), None)
        outward = next((row["at"] for row in observations if row["event"]["type"] == "delta" and row["event"]["kind"] in ("text", "tool_fragment")), None)
        counts = next((row for row in parsed if row["type"] == "counts" and row["id"] == call_id), {})
        calls.append({
            "callId": call_id,
            "phase": phase_starts.get(call_id, {}).get("phase", "unknown"),
            "startSeconds": round((start["at"] - started) / 1000, 3),
            "seconds": round((end["at"] - start["at"]) / 1000, 3) if end else None,
            "status": end.get("status") if end else "unsettled_observation",
            "observedReasoningOnlySeconds": round((min(value for value in [outward, end["at"] if end else None] if value is not None) - thinking) / 1000, 3) if thinking is not None and (outward is not None or end) else None,
            "thinkingChars": counts.get("thinkingChars"),
            "textChars": counts.get("textChars"),
            "toolCalls": counts.get("toolCalls"),
            "usage": finishes.get(call_id, {}).get("usage"),
            "wireRequestIds": [row["id"] for row in wire if row["type"] == "request" and row["callId"] == call_id],
            "rawOutputCounts": [stream_counts(run / f'response-{row["id"]}.sse') for row in wire if row["type"] == "request" and row["callId"] == call_id],
        })
    tool_starts = {row["event"]["callId"]: row for row in events if row["event"]["type"] == "tool.call"}
    tool_results = [row for row in events if row["event"]["type"] == "tool.result"]
    successful = [row for row in tool_results if row["event"].get("ok")]
    writes = [row for row in successful if row["event"].get("tool") in ("workspace_write_file", "workspace_edit_file", "workspace_apply_patch")]
    phase_seconds = {}
    for call in calls:
        if call["seconds"] is not None:
            phase_seconds[call["phase"]] = round(phase_seconds.get(call["phase"], 0) + call["seconds"], 3)
    tool_seconds = union_seconds((tool_starts[row["event"]["callId"]]["at"], row["at"]) for row in tool_results if row["event"]["callId"] in tool_starts)
    unknown_usage = [call["callId"] for call in calls if not call["usage"]]
    usage_rows = [call["usage"] for call in calls if call["usage"]]
    grade = read(run / "single-agent-report.json") if protocol["taskVariant"] == "queue" else None
    summary = {
        "runDirectory": str(run), "compositionVersion": protocol["compositionVersion"],
        "reporterSourceSha256": hashlib.sha256(pathlib.Path(__file__).read_bytes()).hexdigest(),
        "normalizedInitialRequestSha256": hashlib.sha256(json.dumps(normalized_initial_request(run, protocol), ensure_ascii=False, sort_keys=True).encode()).hexdigest(),
        "task": protocol["taskVariant"], "effort": protocol["runtimeProfile"]["reasoningEffort"],
        "seconds": metrics["seconds"], "runtimeOk": result.get("ok"), "status": terminal.get("status"),
        "firstSuccessfulToolSeconds": round((successful[0]["at"] - started) / 1000, 3) if successful else None,
        "firstSuccessfulFileWriteSeconds": round((writes[0]["at"] - started) / 1000, 3) if writes else None,
        "successfulFileTools": len(writes), "physicalRequests": metrics["physicalRequests"],
        "reportedTokens": metrics["reportedTokens"], "requestsWithoutUsage": unknown_usage,
        "reportedPromptTokens": sum(usage.get("promptTokens", 0) for usage in usage_rows),
        "reportedCompletionTokens": sum(usage.get("completionTokens", 0) for usage in usage_rows),
        "reportedCachedPromptTokens": sum(usage["cachedPromptTokens"] for usage in usage_rows) if all("cachedPromptTokens" in usage for usage in usage_rows) else None,
        "phaseSeconds": phase_seconds, "toolSeconds": round(tool_seconds, 3),
        "otherHostSeconds": round(metrics["seconds"] - sum(phase_seconds.values()) - tool_seconds, 3),
        "functional": grade["functional"] if grade else {"passed": int(metrics["exactBytes"]), "total": 1},
        "ownTestsStatus": grade["ownTests"]["status"] if grade else "not_required",
        "completedAndVerified": grade["completedAndVerified"] if grade else result.get("ok") is True and metrics["exactBytes"],
        "calls": calls,
        "limits": ["One sample per condition; ordering, cache and provider load are uncontrolled", "High is a benchmark-only main-request override; auxiliary settings remain native", "Single agent, memory and independent environment auditor disabled; completion review retained", "Observed reasoning span is local first-thinking to first-output/tool or interruption, not server CPU time", "Other host time is a residual, not a measured component profile", "Missing usage is unknown cost, not zero cost"],
    }
    (run / "runtime-validation.json").write_text(json.dumps(summary, ensure_ascii=False, indent=2), encoding="utf-8")
    return summary, protocol


if __name__ == "__main__":
    summaries = [summarize(pathlib.Path(arg).resolve()) for arg in sys.argv[1:]]
    assert summaries, "Pass settled run directories"
    first = summaries[0][1]
    for _, protocol in summaries[1:]:
        assert protocol["sourceHashes"] == first["sourceHashes"], "Sources changed between cases"
        assert protocol["compositionVersion"] == first["compositionVersion"]
        assert protocol["baselineRuntimeProfile"] == first["baselineRuntimeProfile"]
        assert protocol["isolation"]["imageId"] == first["isolation"]["imageId"]
        for field in ["singleAgent", "environmentAudit", "memory", "tokenThresholdEnforced", "taskMode", "capabilities", "thinkingRecovery", "journalReasoningRecovery"]:
            assert protocol[field] == first[field], field
    for summary, protocol in summaries:
        for other, other_protocol in summaries:
            if summary["task"] == other["task"]:
                assert protocol["goal"] == other_protocol["goal"]
                assert protocol["budget"] == other_protocol["budget"]
                assert summary["normalizedInitialRequestSha256"] == other["normalizedInitialRequestSha256"], "Initial request differs beyond effort and temporary root"
        print(json.dumps({key: summary[key] for key in ["task", "effort", "seconds", "status", "firstSuccessfulToolSeconds", "firstSuccessfulFileWriteSeconds", "reportedTokens", "requestsWithoutUsage", "phaseSeconds", "functional", "ownTestsStatus", "completedAndVerified"]}, ensure_ascii=False))
