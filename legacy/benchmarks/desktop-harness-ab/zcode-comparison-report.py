"""Audit ZCode's raw stream and grade settled work in an isolated container.

Usage: python zcode-comparison-report.py <paw-run> <zcode-run> [--observe]
Observe never executes generated code or writes a final comparison.
"""
import hashlib
import json
import pathlib
import subprocess
import sys
import uuid


def read(file):
    return json.loads(file.read_text(encoding="utf-8"))


def rows(file):
    return [json.loads(line) for line in file.read_text(encoding="utf-8").splitlines()] if file.exists() else []


def audit(folder, protocol):
    wire = rows(folder / "wire.jsonl")
    requests = []
    for request in (r for r in wire if r["type"] == "request" and r["route"] == "/v1/messages"):
        events = []
        first_tool_offset = first_action_offset = None
        offset = 0
        raw = folder / "relay" / (request["id"] + ".body")
        for line in raw.read_bytes().splitlines(keepends=True) if raw.exists() else []:
            offset += len(line)
            if line.startswith(b"data: "):
                try:
                    event = json.loads(line[6:])
                    events.append(event)
                    if event.get("content_block", {}).get("type") == "tool_use":
                        first_tool_offset = first_tool_offset or offset
                        first_action_offset = first_action_offset or offset
                    if event.get("delta", {}).get("text") or event.get("content_block", {}).get("text"):
                        first_action_offset = first_action_offset or offset
                except json.JSONDecodeError:
                    pass  # A currently arriving final line may be incomplete.
        thinking = text = ""
        blocks = {}
        start_usage = end_usage = stop_reason = None
        for event in events:
            kind = event.get("type")
            if kind == "message_start":
                start_usage = event["message"].get("usage")
            elif kind == "content_block_start":
                block = event["content_block"]
                if block["type"] == "tool_use":
                    blocks[event["index"]] = {"id": block["id"], "name": block["name"], "arguments": "", "initialInput": block.get("input")}
                thinking += block.get("thinking", "")
                text += block.get("text", "")
            elif kind == "content_block_delta":
                delta = event["delta"]
                thinking += delta.get("thinking", "")
                text += delta.get("text", "")
                if event["index"] in blocks:
                    blocks[event["index"]]["arguments"] += delta.get("partial_json", "")
            elif kind == "message_delta":
                end_usage = event.get("usage", end_usage)
                stop_reason = event.get("delta", {}).get("stop_reason", stop_reason)
        tools = []
        for block in blocks.values():
            try:
                arguments = json.loads(block["arguments"]) if block["arguments"] else block["initialInput"]
                valid = isinstance(arguments, dict)
            except json.JSONDecodeError:
                valid = False
            tools.append({"id": block["id"], "name": block["name"], "argumentsComplete": valid})
        related = [r for r in wire if r.get("id") == request["id"]]
        def arrival(byte_offset):
            if byte_offset is None:
                return None
            count = 0
            for row in related:
                if row["type"] == "chunk":
                    count += row["bytes"]
                    if count >= byte_offset:
                        return (row["at"] - request["at"]) / 1000
            return None
        end = next((r["at"] for r in related if r["type"] == "end"), None)
        last_chunk = next((r["at"] for r in reversed(related) if r["type"] == "chunk"), None)
        requests.append({
            "id": request["id"], "startSeconds": (request["at"] - protocol["startedAt"]) / 1000,
            "seconds": (end - request["at"]) / 1000 if end else None,
            "streamObservedSeconds": (last_chunk - request["at"]) / 1000 if last_chunk else None,
            "firstActionSeconds": arrival(first_action_offset), "firstToolSeconds": arrival(first_tool_offset),
            "parameters": {k: request.get(k) for k in ["model", "max_tokens", "thinking", "output_config"]},
            "thinkingChars": len(thinking.encode("utf-16-le")) // 2,
            "textChars": len(text.encode("utf-16-le")) // 2, "tools": tools,
            "startUsage": start_usage, "endUsage": end_usage, "stopReason": stop_reason,
            "messageStop": any(e.get("type") == "message_stop" for e in events),
        })
    # Tool calls count as executed only when the next native request carries a result.
    results = {}
    for request in requests:
        body = read(folder / ("request-" + request["id"] + ".json"))
        for message in body.get("messages", []):
            content = message.get("content", [])
            for block in content if isinstance(content, list) else []:
                if block.get("type") == "tool_result":
                    results.setdefault(block["tool_use_id"], {"error": bool(block.get("is_error", False)), "observedBySeconds": request["startSeconds"]})
    for request in requests:
        for tool in request["tools"]:
            tool["result"] = results.get(tool["id"])
    return {"requests": requests, "files": rows(folder / "files.jsonl")}


def grade(protocol, image, verifier):
    workspace = pathlib.Path(protocol["workspaceRoot"])
    def run(command, independent):
        name = "paw-zcode-grade-" + uuid.uuid4().hex[:12]
        args = ["docker", "run", "--rm", "--name", name, "--pull", "never", "--network", "none", "--read-only", "--cap-drop", "ALL", "--security-opt", "no-new-privileges", "--memory", "1024m", "--cpus", "2", "--pids-limit", "128", "--tmpfs", "/tmp:exec,nosuid,size=256m", "-w", "/workspace", "--mount", f"type=bind,source={workspace},target=/workspace" + (",readonly" if independent else "")]
        if protocol.get("zcodeVersion"):
            args += ["--user", "1000:1000"]
        if independent:
            args += ["--mount", f"type=bind,source={verifier},target=/verifier.mjs,readonly"]
        try:
            p = subprocess.run(args + [image, *command], capture_output=True, text=True, encoding="utf-8", errors="replace", timeout=90, creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0))
            return {"exitCode": p.returncode, "stdout": p.stdout, "stderr": p.stderr}
        except subprocess.TimeoutExpired:
            return {"exitCode": None, "status": "timeout"}
        finally:
            subprocess.run(["docker", "rm", "-f", name], capture_output=True, timeout=15, creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0))
    # Grade delivered bytes before the generated test suite can modify anything.
    verification = run(["node", "/verifier.mjs", "queue", "/workspace"], True)
    assert verification["exitCode"] == 0, verification
    package = workspace / "package.json"
    own = run(["npm", "test"], False) if package.exists() and read(package).get("scripts", {}).get("test") else {"exitCode": None, "status": "missing"}
    diagnostic = run(["node", "--test"], False) if own.get("exitCode") not in [None, 0] else None
    return {"functional": json.loads(verification["stdout"]), "ownTests": own, "directTestDiagnostic": diagnostic}


if __name__ == "__main__":
    sys.stdout.reconfigure(encoding="utf-8")
    paw, zcode = (pathlib.Path(p).resolve() for p in sys.argv[1:3])
    pp, zp = read(paw / "protocol.json"), read(zcode / "protocol.json")
    assert pp["goal"] == zp["goal"] and not zp["transportCheckOnly"]
    observation = audit(zcode, zp)
    if "--observe" in sys.argv:
        print(json.dumps(observation, ensure_ascii=False, indent=2))
        sys.exit(0)
    assert (paw / "result.json").exists() and (zcode / "result.json").exists(), "Grade only settled runs"
    verifier = paw / "source-snapshot/legacy/benchmarks/desktop-harness-ab/verify.mjs"
    verifier_hash = hashlib.sha256(verifier.read_bytes()).hexdigest()
    assert verifier_hash == pp["sourceHashes"]["legacy/benchmarks/desktop-harness-ab/verify.mjs"] == zp["sourceHashes"]["verify.mjs"]
    result = {"sameGoal": True, "verifierSha256": verifier_hash,
              "paw": {"result": read(paw / "result.json"), **grade(pp, pp["isolation"]["imageId"], verifier)},
              "zcode": {"result": read(zcode / "result.json"), **observation, **grade(zp, pp["isolation"]["imageId"], verifier)}}
    (zcode / "comparison.json").write_text(json.dumps(result, ensure_ascii=False, indent=2), encoding="utf-8")
    for name in ["paw", "zcode"]:
        r = result[name]
        print(json.dumps({"runtime": name, "functional": f"{r['functional']['passed']}/{r['functional']['total']}", "ownTestsExit": r["ownTests"]["exitCode"], "result": r["result"]}, ensure_ascii=False))
