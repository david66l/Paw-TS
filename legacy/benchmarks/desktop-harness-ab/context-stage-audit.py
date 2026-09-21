"""Inventory captured model inputs by phase; no model or generated-code execution."""
import hashlib
import json
import pathlib
import sys


def read(file):
    return json.loads(file.read_text(encoding="utf-8"))


def rows(file):
    return [json.loads(line) for line in file.read_text(encoding="utf-8").splitlines()] if file.exists() else []


def chars(value):
    return len(value.encode("utf-16-le")) // 2


def serialized(value):
    return json.dumps(value, ensure_ascii=False, separators=(",", ":"))


def goal_copies(value, goal):
    if isinstance(value, str):
        if value.strip() == goal.strip():
            return 1
        try:
            nested = json.loads(value)
        except (ValueError, TypeError):
            return 0
        return goal_copies(nested, goal) if not isinstance(nested, str) else 0
    if isinstance(value, list):
        return sum(goal_copies(v, goal) for v in value)
    if isinstance(value, dict):
        return sum(goal_copies(v, goal) for v in value.values())
    return 0


def audit(run):
    protocol = read(run / "protocol.json")
    parsed = rows(run / "parsed.jsonl")
    wire = rows(run / "wire.jsonl")
    phases = rows(run / "phases.jsonl")
    request_rows = []
    for file in sorted(run.glob("request-*.json"), key=lambda p: int(p.stem.split("-")[-1])):
        request_id = int(file.stem.split("-")[-1])
        request = read(file)
        messages = request["messages"]
        receipt = next(r for r in wire if r["type"] == "request" and r["id"] == request_id)
        call_id = receipt["callId"]
        phase = next((r.get("phase") for r in phases if r["type"] == "start" and r["callId"] == call_id), "unknown")
        usage = next((r.get("usage") for r in parsed if r["type"] == "finish" and r["id"] == call_id), None)
        totals = dict(system=0, goalAndUser=0, hostAdvice=0, assistantText=0, historicalReasoning=0, toolArguments=0, toolResults=0)
        advice = []
        calls = {}
        recent_results = []
        for index, message in enumerate(messages):
            role = message["role"]
            content = message.get("content") or ""
            assert isinstance(content, str)
            if role == "system":
                totals["system"] += chars(content)
            elif role == "user":
                kind = "hostAdvice" if content.startswith("[Paw ") else "goalAndUser"
                totals[kind] += chars(content)
                if kind == "hostAdvice":
                    advice.append({"messageIndex": index, "messagesAfter": len(messages) - index - 1,
                                   "header": content.splitlines()[0],
                                   "id": next((line.split("=", 1)[1] for line in content.splitlines() if line.startswith("adviceId=")), None),
                                   "markedHistorical": "past threshold crossing" in content})
            elif role == "assistant":
                totals["assistantText"] += chars(content)
                totals["historicalReasoning"] += chars(message.get("reasoning_content") or "")
                for call in message.get("tool_calls", []):
                    totals["toolArguments"] += chars(call["function"]["arguments"])
                    calls[call["id"]] = call["function"]["name"]
            elif role == "tool":
                totals["toolResults"] += chars(content)
                recent_results.append(calls.get(message.get("tool_call_id"), "unknown"))
        text = "\n".join(m.get("content") or "" for m in messages)
        request_rows.append({
            "requestId": request_id, "requestSha256": hashlib.sha256(file.read_bytes()).hexdigest(),
            "phase": phase, "roles": [m["role"] for m in messages], "messageCount": len(messages),
            "toolCount": len(request.get("tools", [])), "chars": totals,
            "contentCharsExcludingEnvelopeAndTools": sum(totals.values()),
            "serializedToolChars": chars(serialized(request.get("tools", []))),
            "exactGoalCopiesInMessageContent": sum(goal_copies(m.get("content"), protocol["goal"]) for m in messages),
            "hasLegacyCurrentState": "[Current State]" in text,
            "hasTaskCheckpointSection": "task_checkpoint" in text,
            "advice": advice, "recentToolResults": recent_results[-4:], "usage": usage,
        })
    return {"run": run.name, "protocolSha256": hashlib.sha256((run / "protocol.json").read_bytes()).hexdigest(),
            "settings": {k: protocol.get(k) for k in ["taskMode", "memory", "singleAgent", "environmentAudit", "budget", "capabilities"]},
            "requests": request_rows}


if __name__ == "__main__":
    output = pathlib.Path(sys.argv[1]).resolve()
    if output.exists():
        raise SystemExit("Use a fresh output directory")
    runs = [pathlib.Path(p).resolve() for p in sys.argv[2:]]
    reports = [audit(run) for run in runs]
    output.mkdir(parents=True)
    (output / "audit.json").write_text(json.dumps(reports, ensure_ascii=False, indent=2), encoding="utf-8")
    source = pathlib.Path(__file__)
    (output / source.name).write_bytes(source.read_bytes())
    for report in reports:
        selected = [r for r in report["requests"] if len(report["requests"]) <= 3 or r["requestId"] in [1, 3, 4, 6, 10, 15, 22, 23]]
        for r in selected:
            print(json.dumps({"run": report["run"], **{k: r[k] for k in ["requestId", "phase", "messageCount", "chars", "exactGoalCopiesInMessageContent", "advice", "usage"]}}, ensure_ascii=True))
