"""Measure actual delivery-ledger exposure and adoption in a settled Paw run.

Does not print prompts, reasoning, tool arguments, or claim requirement coverage.
Run phase-cost-report.py (or threeway-grade.py) first.
"""
import collections
import hashlib
import json
import pathlib
import re
import sys


def read(path):
    return json.loads(path.read_text(encoding="utf-8"))


def rows(path):
    return [json.loads(line) for line in path.read_text(encoding="utf-8").splitlines() if line]


def report(root):
    if not (root / "result.json").exists():
        raise ValueError("Wait for the run to settle")
    protocol = read(root / "protocol.json")
    phases = {item["id"]: item for item in read(root / "phase-cost-report.json")["requests"]}
    requests = []
    for item in rows(root / "wire.jsonl"):
        if item["type"] != "request" or phases[item["id"]]["phase"] != "agent_loop:root":
            continue
        payload = read(root / f"request-{item['id']}.json")
        definitions = [tool for tool in payload.get("tools", [])
                       if tool.get("function", {}).get("name") == "workspace_acceptance_update"]
        assert len(definitions) <= 1, "Duplicate delivery tool"
        states = [message["content"] for message in payload.get("messages", [])
                  if isinstance(message.get("content"), str)
                  and message["content"].startswith("[Paw Delivery State]")]
        requests.append({"id": item["id"], "toolExposed": bool(definitions),
                         "definitionHash": hashlib.sha256(json.dumps(definitions, sort_keys=True).encode()).hexdigest() if definitions else None,
                         "stateMessages": len(states), "stateCharacters": sum(map(len, states))})
    events = rows(root / "events.jsonl")
    calls = collections.Counter()
    ledger = []
    settlements = {row["event"]["callId"]: row["event"] for row in events
                   if row["event"].get("type") == "tool.result"}
    direct_tests = []
    for row in events:
        event = row["event"]
        if event.get("type") != "tool.call":
            continue
        calls[event["tool"]] += 1
        result = settlements.get(event["callId"], {})
        if event["tool"] == "workspace_acceptance_update":
            args = event.get("args", {})
            ledger.append({"callId": event["callId"],
                           "atSeconds": (row["at"] - protocol["startedAt"]) / 1000,
                           "addedCount": len(args.get("add", [])),
                           "updatedCount": len(args.get("updates", [])), "ok": result.get("ok")})
        command = " ".join(event.get("args", {}).get("command", "").split())
        if event["tool"] == "workspace_run_shell" and re.fullmatch(r"(?:cd (?:/workspace|\.) && )?npm test(?: 2>&1)?", command):
            direct_tests.append({"callId": event["callId"],
                                 "atSeconds": (row["at"] - protocol["startedAt"]) / 1000,
                                 "toolOk": result.get("ok")})
    result = {"schemaVersion": "paw.delivery-state-report.v1", "rootRequests": requests,
              "toolCalls": dict(calls), "ledgerCalls": ledger, "directNpmTestCalls": direct_tests,
              "terminalEvents": [{key: row["event"][key] for key in ("type", "status", "message") if key in row["event"]}
                                 for row in events if row["event"].get("type") in ("run.completed", "run.failed")],
              "notes": ["Exposed tools and delivered guidance do not prove model adoption.",
                        "Ledger declarations are not independent acceptance results.",
                        "Tool success is not a semantic test verdict; use independent grading.",
                        "Direct npm test detection covers the benchmark root invocation, optional cd /workspace or cd ., and optional 2>&1 only.",
                        "Character counts are not token or price estimates."]}
    (root / "delivery-state-report.json").write_text(json.dumps(result, indent=2) + "\n", encoding="utf-8")
    return result


if __name__ == "__main__":
    print(json.dumps(report(pathlib.Path(sys.argv[1]).resolve()), indent=2))
