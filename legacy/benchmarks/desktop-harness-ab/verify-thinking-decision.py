"""Independently verify extended decision replays; never execute emitted tools."""
import hashlib
import json
import pathlib
import sys


def read(file):
    return json.loads(file.read_text(encoding="utf-8"))


def digest(file):
    return hashlib.sha256(file.read_bytes()).hexdigest()


def js_length(text):
    return len(text.encode("utf-16-le")) // 2


def assemble(file):
    reasoning, text, slots, usage, finish, done = "", "", {}, None, None, False
    for line in file.read_bytes().splitlines():
        if not line.startswith(b"data:"):
            continue
        data = line[5:].strip()
        if data == b"[DONE]":
            done = True
            continue
        if not data:
            continue
        event = json.loads(data)
        assert not done, "Data after provider DONE"
        if event.get("usage") is not None:
            usage = event["usage"]
        for choice in event.get("choices", []):
            assert choice.get("index", 0) == 0, "Unexpected extra choice"
            finish = choice.get("finish_reason") or finish
            delta = choice.get("delta", {})
            reasoning += delta.get("reasoning_content") or ""
            text += delta.get("content") or ""
            for part in delta.get("tool_calls") or []:
                slot = slots.setdefault(part["index"], {"id": "", "name": "", "arguments": ""})
                if part.get("id"):
                    assert not slot["id"] or slot["id"] == part["id"], "Conflicting tool ID"
                    slot["id"] = part["id"]
                slot["name"] += part.get("function", {}).get("name") or ""
                slot["arguments"] += part.get("function", {}).get("arguments") or ""
    return reasoning, text, [dict(index=i, **v) for i, v in sorted(slots.items())], usage, finish, done


def verify(run):
    protocol = read(run / "protocol.json")
    source = pathlib.Path(protocol["source"])
    assert digest(source) == protocol["sourceSha256"], "Captured input changed"
    assert digest(run / "source-snapshot.ts") == protocol["scriptSha256"], "Probe snapshot changed"
    original = read(source)
    history = []
    # Match each completed assistant turn to its original provider bytes.
    for number, msg in enumerate((m for m in original["messages"] if m["role"] == "assistant"), 1):
        reasoning, text, calls, _, _, _ = assemble(source.parent / f"response-{number}.sse")
        assert msg.get("reasoning_content", "") == reasoning, "Reasoning passback changed"
        assert (msg.get("content") or "") == text, "Assistant text changed"
        expected_calls = [{"id": c["id"], "type": "function", "function": {"name": c["name"], "arguments": c["arguments"]}} for c in calls]
        assert msg.get("tool_calls", []) == expected_calls, "Native tool history changed"
        history.append({"response": number, "reasoningChars": js_length(reasoning), "exact": True})
    rows = []
    for arm in protocol["order"]:
        assert arm in ("control", "high"), "Verifier is for unmodified extended controls only"
        request = read(run / f"{arm}-request.json")
        result = read(run / f"{arm}-result.json")
        expected = dict(original, reasoning_effort="high") if arm == "high" else original
        assert request == expected, "Unexpected experimental variable"
        reasoning, text, calls, usage, finish, done = assemble(run / f"{arm}.sse")
        assert js_length(reasoning) == result["thinkingChars"]
        assert js_length(text) == result["textChars"]
        assert calls == result["toolCalls"]
        assert usage == result["usage"] and finish == result["finishReason"]
        assert done == (result["status"] == "provider_done")
        valid_arguments = None
        if done and finish == "tool_calls":
            assert calls, "Tool finish without calls"
            names = {t["function"]["name"] for t in request["tools"]}
            for call in calls:
                assert call["id"] and call["name"] in names
                assert isinstance(json.loads(call["arguments"]), dict)
            valid_arguments = True
        rows.append({"arm": arm, "requestDiff": [] if arm == "control" else ["reasoning_effort"], "rawCountsAndToolsExact": True, "providerDone": done, "toolArgumentsAreJsonObjects": valid_arguments, "thinkingChars": js_length(reasoning), "textChars": js_length(text), "tools": [{"name": c["name"], "argumentChars": js_length(c["arguments"])} for c in calls], "usage": usage, "finishReason": finish, "durationMs": result["durationMs"], "firstToolMs": result["firstToolMs"], "status": result["status"]})
    report = {"verifierSha256": digest(pathlib.Path(__file__)), "sourceSha256": protocol["sourceSha256"], "history": history, "rows": rows, "toolsExecuted": False, "taskCompletionEvaluated": False}
    (run / "independent-check.json").write_text(json.dumps(report, indent=2), encoding="utf-8")
    print(json.dumps(report))


if __name__ == "__main__":
    verify(pathlib.Path(sys.argv[1]).resolve())
