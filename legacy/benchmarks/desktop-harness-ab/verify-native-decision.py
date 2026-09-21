"""Independent native ZCode/Paw-system input and raw response audit; no tool execution."""
import hashlib
import json
import pathlib
import re
import sys

from jsonschema import Draft202012Validator


def read(p):
    return json.loads(p.read_text(encoding="utf-8"))


def digest(p):
    return hashlib.sha256(p.read_bytes()).hexdigest()


def length(s):
    return len(s.encode("utf-16-le")) // 2


def verify(root):
    protocol, request, result = [read(root / (n + ".json")) for n in ["protocol", "request", "result"]]
    source = pathlib.Path(protocol["source"])
    original = read(source)
    assert digest(source) == protocol["sourceSha256"]
    assert digest(root / "source-snapshot.ts") == protocol["scriptSha256"]
    assert digest(root / "prompt-source-snapshot.ts") == protocol["promptSourceSha256"]
    assert protocol["removedReasoningChars"] == 0 and protocol["wallMs"] == 360000
    assert protocol["endpoint"] == "https://open.bigmodel.cn/api/anthropic/v1/messages"
    assert request["thinking"] == {"type": "enabled", "budget_tokens": 32000}
    assert request["output_config"] == {"effort": "max"} and request["max_tokens"] == 128000
    assert len(request["tools"]) == 8
    if protocol["arm"] == "native-zcode":
        assert request == original
        changes = []
    else:
        assert protocol["arm"] == "native-paw-system"
        expected = json.loads(json.dumps(original))
        prompt = (root / "prompt-source-snapshot.ts").read_text(encoding="utf-8")
        for index, name in enumerate(["PAW_AGENT_SYSTEM_PROMPT", "PAW_CODING_EXECUTION_GUIDANCE"]):
            match = re.search(r"export const " + name + r" = `([^`]+)`;", prompt)
            assert match and "${" not in match[1]
            expected["system"][index]["text"] = match[1]
        assert request == expected
        changes = ["system[0].text", "system[1].text"]
    assert request["messages"] == original["messages"]
    slots = {}
    thinking = visible = ""
    usage, finish, terminal = None, None, False
    for line in (root / "response.sse").read_bytes().splitlines():
        if not line.startswith(b"data:"):
            continue
        value = line[5:].strip()
        if not value:
            continue
        event = json.loads(value)
        assert not terminal, "Unexpected data after message_stop"
        kind = event["type"]
        if kind == "message_start":
            usage = event.get("message", {}).get("usage")
        if event.get("usage") is not None:
            usage = {**(usage or {}), **event["usage"]}
        if kind == "message_delta":
            finish = event.get("delta", {}).get("stop_reason") or finish
        if kind == "message_stop":
            terminal = True
        if kind == "content_block_start":
            b = event["content_block"]
            thinking += b.get("thinking", "")
            visible += b.get("text", "")
            if b["type"] == "tool_use":
                assert not b.get("input"), "Expected streamed tool arguments"
                slots[event["index"]] = {"index": event["index"], "id": b["id"], "name": b["name"], "arguments": ""}
        if kind == "content_block_delta":
            d = event["delta"]
            thinking += d.get("thinking", "")
            visible += d.get("text", "")
            if d.get("partial_json"):
                slots[event["index"]]["arguments"] += d["partial_json"]
    calls = list(slots.values())
    assert length(thinking) == result["thinkingChars"] and length(visible) == result["textChars"]
    assert calls == result["tools"] and usage == result["usage"] and finish == result["finishReason"]
    assert terminal == (result["status"] == "provider_done")
    schemas = {t["name"]: t["input_schema"] for t in request["tools"]}
    if terminal:
        assert len({t["id"] for t in calls}) == len(calls)
        for call in calls:
            Draft202012Validator(schemas[call["name"]]).validate(json.loads(call["arguments"]))
    report = {"passed": True, "arm": protocol["arm"], "onlyChangedFields": changes, "nativeHistoryExact": True,
              "rawResponseExact": True, "providerDone": terminal, "durationMs": result["durationMs"],
              "firstToolMs": result["firstToolMs"], "thinkingChars": length(thinking), "textChars": length(visible),
              "tools": [{"name": c["name"], "argumentChars": length(c["arguments"])} for c in calls],
              "finalUsage": usage if terminal else None, "finishReason": finish, "toolsExecuted": False,
              "sourceSha256": protocol["sourceSha256"], "verifierSha256": digest(pathlib.Path(__file__))}
    (root / "independent-check.json").write_text(json.dumps(report, indent=2), encoding="utf-8")
    print(json.dumps(report))


if __name__ == "__main__":
    for arg in sys.argv[1:]:
        verify(pathlib.Path(arg).resolve())
