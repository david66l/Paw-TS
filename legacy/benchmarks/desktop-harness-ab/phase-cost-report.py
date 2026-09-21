"""Attribute settled wire requests without exposing prompts or estimating prices."""
import collections
import json
import pathlib
import sys


def read_rows(path):
    return [json.loads(line) for line in path.read_text(encoding="utf-8").splitlines()]


def report(directory):
    root = pathlib.Path(directory)
    if not (root / "result.json").exists():
        raise ValueError("Wait for a settled run before reporting costs")
    phases = read_rows(root / "phases.jsonl")
    starts = {r["callId"]: r for r in phases if r["type"] == "start"}
    ends = {r["callId"]: r for r in phases if r["type"] == "end"}
    usage = {r["callId"]: r["event"]["usage"] for r in phases
             if r["type"] == "observation" and r["event"].get("usage")}
    wire = [r for r in read_rows(root / "wire.jsonl") if r["type"] == "request"]
    mixed_file = root / "audit-live.json"
    mixed = json.loads(mixed_file.read_text(encoding="utf-8")) if mixed_file.exists() else None
    if len({r["callId"] for r in wire}) != len(wire):
        raise ValueError("Multiple wire requests share one usage observation; per-request attribution is ambiguous")
    groups = {}
    per_request = []
    for item in wire:
        request = json.loads((root / f"request-{item['id']}.json").read_text(encoding="utf-8"))
        call_id = item["callId"]
        start = starts[call_id]
        phase = start["phase"]
        if phase == "agent_loop":
            phase += ":child" if start.get("runId", "").startswith("child-run-") else ":root"
        replayed = bool(mixed and item["id"] <= mixed["rootReplayedRequests"])
        live_ids = mixed.get("liveAuditRequestIds", list(range(mixed["rootReplayedRequests"] + 1, mixed["rootReplayedRequests"] + mixed["liveAuditRequests"] + 1))) if mixed else []
        rejected = bool(mixed and not replayed and item["id"] not in live_ids)
        origin = "replayed" if replayed else "rejected" if rejected else "live"
        group = groups.setdefault((origin + ":" if origin != "live" else "") + phase, collections.Counter())
        group["replayedRequests" if replayed else "rejectedRequests" if rejected else "physicalRequests"] += 1
        measured = usage.get(call_id)
        if measured is None:
            group["requestsWithoutUsage"] += 1
        else:
            for key in ("promptTokens", "completionTokens", "totalTokens"):
                if key in measured:
                    group[key] += measured[key]
            if "cachedPromptTokens" in measured:
                group["cachedPromptTokens"] += measured["cachedPromptTokens"]
            else:
                group["requestsWithoutCacheUsage"] += 1
            if "cacheMissPromptTokens" in measured:
                group["cacheMissPromptTokens"] += measured["cacheMissPromptTokens"]
        sizes = collections.Counter()
        for message in request.get("messages", []):
            content = message.get("content")
            if isinstance(content, str):
                sizes[f"{message['role']}ContentChars"] += len(content)
            reasoning = message.get("reasoning_content")
            if isinstance(reasoning, str):
                sizes["nativeReasoningChars"] += len(reasoning)
            for tool in message.get("tool_calls", []):
                sizes["toolArgumentChars"] += len(tool.get("function", {}).get("arguments", ""))
        group.update(sizes)
        end = ends.get(call_id)
        per_request.append({"id": item["id"], "phase": phase,
                            **({"origin": origin} if mixed else {}),
                            "seconds": (end["at"]-start["at"])/1000 if end else None,
                            "status": end.get("status") if end else "unknown",
                            "usage": measured, "contentChars": dict(sizes)})
    totals = collections.Counter()
    replayed_totals = collections.Counter()
    rejected_totals = collections.Counter()
    for name, group in groups.items():
        (replayed_totals if name.startswith("replayed:") else rejected_totals if name.startswith("rejected:") else totals).update(group)
    result = {"schemaVersion": "paw.phase-cost-report.v1", "phases": groups,
              "totals": totals, "requests": per_request,
              **({"replayedTotals": replayed_totals, "rejectedTotals": rejected_totals} if mixed else {}),
              "notes": ["Provider-reported usage includes cached prompt tokens; it is not a price estimate.",
                        "Missing usage stays unknown; totals cover only reported requests.",
                        "Character sizes count repeated transmission and are not token estimates."]}
    if mixed:
        assert totals.get("physicalRequests", 0) == mixed["liveAuditRequests"], "Live request attribution mismatch"
        result["notes"].append("Totals include only newly sent live audit requests. Replayed root usage is historical and is listed separately, never counted as new consumption.")
    (root / "phase-cost-report.json").write_text(json.dumps(result, indent=2) + "\n", encoding="utf-8")
    return {"phases": groups, "totals": totals}


if __name__ == "__main__":
    print(json.dumps(report(sys.argv[1]), indent=2))
