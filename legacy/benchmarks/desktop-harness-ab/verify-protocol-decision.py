"""Verify protocol-ablation inputs and independently parse captured responses."""
import hashlib
import importlib.util
import json
import pathlib
import sys
from jsonschema import Draft202012Validator

spec = importlib.util.spec_from_file_location("decision", pathlib.Path(__file__).with_name("verify-thinking-decision.py"))
decision = importlib.util.module_from_spec(spec)
spec.loader.exec_module(decision)
read = decision.read


def canonical(messages):
    out = []
    for m in messages:
        row = {"role": m["role"], "content": m.get("content", "")}
        if m.get("tool_call_id"):
            row["tool_call_id"] = m["tool_call_id"]
        if m.get("tool_calls"):
            row["tool_calls"] = [{"id": c["id"], "name": c["function"]["name"], "input": json.loads(c["function"]["arguments"])} for c in m["tool_calls"]]
        out.append(row)
    return out


def verify(run):
    protocol, request, result = (read(run / f"{name}.json") for name in ("protocol", "request", "result"))
    source = pathlib.Path(protocol["source"])
    assert decision.digest(source) == protocol["sourceSha256"]
    assert decision.digest(run / "source-snapshot.ts") == protocol["scriptSha256"]
    original = read(source)
    assert protocol["arm"] in ("openai", "anthropic", "anthropic-default-sampling")
    wait_policy = protocol.get("waitPolicy", "default-240s")
    assert wait_policy in ("default-240s", "extended-360s")
    assert protocol["wallMs"] == (360000 if wait_policy == "extended-360s" else 240000)
    removed = sum(decision.js_length(m.get("reasoning_content", "")) for m in original["messages"])
    assert removed == protocol["removedReasoningChars"]
    if protocol["arm"] == "openai":
        for m in original["messages"]:
            m.pop("reasoning_content", None)
        assert request == original, "Unexpected OpenAI control difference"
        reasoning, text, calls, usage, finish, done = decision.assemble(run / "response.sse")
        reasoning_count, text_count = decision.js_length(reasoning), decision.js_length(text)
    else:
        restored = [{"role": "system", "content": b["text"]} for b in request["system"]]
        for m in request["messages"]:
            if m["role"] == "user" and all(b["type"] == "tool_result" for b in m["content"]):
                restored.extend({"role": "tool", "content": b["content"], "tool_call_id": b["tool_use_id"]} for b in m["content"])
            else:
                assert all(b["type"] in ("text", "tool_use") for b in m["content"]), "Unexpected/synthesized provider state"
                row = {"role": m["role"], "content": "".join(b["text"] for b in m["content"] if b["type"] == "text")}
                tools = [{"id": b["id"], "type": "function", "function": {"name": b["name"], "arguments": json.dumps(b["input"])}} for b in m["content"] if b["type"] == "tool_use"]
                if tools:
                    row["tool_calls"] = tools
                restored.append(row)
        assert canonical(restored) == canonical(original["messages"]), "Logical history changed"
        assert request["tools"] == [{"name": t["function"]["name"], "description": t["function"]["description"], "input_schema": t["function"]["parameters"]} for t in original["tools"]]
        assert request["model"] == original["model"] and request["max_tokens"] == original["max_tokens"]
        assert request["thinking"] == {"type": "enabled", "budget_tokens": 32000}
        assert request["output_config"] == {"effort": "max"} and request["tool_choice"] == {"type": "auto"}
        if protocol["arm"] == "anthropic":
            assert request["temperature"] == original["temperature"] and request["top_p"] == original["top_p"]
        else:
            assert "temperature" not in request and "top_p" not in request
        slots, reasoning_count, text_count, usage, finish, done = {}, 0, 0, {}, None, False
        for line in (run / "response.sse").read_bytes().splitlines():
            if not line.startswith(b"data:"):
                continue
            data = line[5:].strip()
            if not data:
                continue
            event = json.loads(data)
            assert not done, "Data after message_stop"
            if event["type"] == "message_start":
                usage.update(event.get("message", {}).get("usage", {}))
            usage.update(event.get("usage", {}))
            if event["type"] == "message_delta":
                finish = event.get("delta", {}).get("stop_reason") or finish
            if event["type"] == "message_stop":
                done = True
            if event["type"] == "content_block_start":
                b = event["content_block"]
                if b["type"] == "tool_use":
                    assert not b.get("input"), "Verifier expects streamed tool JSON"
                    slots[event["index"]] = {"index": event["index"], "id": b["id"], "name": b["name"], "arguments": ""}
                reasoning_count += decision.js_length(b.get("thinking", ""))
                text_count += decision.js_length(b.get("text", ""))
            if event["type"] == "content_block_delta":
                d = event["delta"]
                reasoning_count += decision.js_length(d.get("thinking", ""))
                text_count += decision.js_length(d.get("text", ""))
                if d.get("partial_json"):
                    slots[event["index"]]["arguments"] += d["partial_json"]
        calls = list(slots.values())
        usage = usage or None
    assert reasoning_count == result["thinkingChars"] and text_count == result["textChars"]
    assert calls == result["tools"] and finish == result["finishReason"] and usage == result["usage"]
    assert done == (result["status"] == "provider_done")
    if done and calls:
        assert len({c["id"] for c in calls}) == len(calls)
        schemas = {t["function"]["name"]: t["function"]["parameters"] for t in original["tools"]}
        for c in calls:
            assert c["id"] and c["name"] in schemas and isinstance(json.loads(c["arguments"]), dict)
            Draft202012Validator(schemas[c["name"]]).validate(json.loads(c["arguments"]))
    report = {"arm": protocol["arm"], "logicalInputPreserved": True, "removedReasoningChars": removed, "rawResponseMatches": True, "providerDone": done, "status": result["status"], "durationMs": result["durationMs"], "firstToolMs": result["firstToolMs"], "thinkingChars": reasoning_count, "textChars": text_count, "tools": [{"name": c["name"], "argumentChars": decision.js_length(c["arguments"])} for c in calls], "finishReason": finish, "usage": usage, "usageFinal": done, "sourceSha256": protocol["sourceSha256"], "verifierSha256": decision.digest(pathlib.Path(__file__)), "toolsExecuted": False}
    report.update({"waitPolicy": wait_policy, "wallMs": protocol["wallMs"], "toolSchemasValid": True if done and calls else None})
    (run / "independent-check.json").write_text(json.dumps(report, indent=2), encoding="utf-8")
    print(json.dumps(report))


if __name__ == "__main__":
    verify(pathlib.Path(sys.argv[1]).resolve())
