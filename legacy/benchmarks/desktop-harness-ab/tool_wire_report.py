"""Independently assemble tool calls from captured provider SSE, without Paw's parser."""
import bisect
import hashlib
import json
import pathlib
import sys


def read(path):
    return json.loads(path.read_text(encoding="utf-8"))


def records(path):
    return [json.loads(line) for line in path.read_text(encoding="utf-8").splitlines() if line.strip()]


def analyze(run):
    protocol = read(run / "protocol.json")
    wire = records(run / "wire.jsonl")
    parsed = records(run / "parsed.jsonl")
    events = records(run / "events.jsonl")
    verification = read(run / "verification.json")
    result = read(run / "result.json")
    repo = pathlib.Path(__file__).resolve().parents[3]
    source_root = run / "source-snapshot" if (run / "source-snapshot").is_dir() else repo
    if not all(hashlib.sha256((source_root / name).read_bytes()).hexdigest() == expected for name, expected in protocol["sourceHashes"].items()):
        raise ValueError("Captured source files have changed")
    requests = [r for r in wire if r["type"] == "request"]
    analyzed = []
    for request in requests:
        request_id, call_id = request["id"], request["callId"]
        body = read(run / f"request-{request_id}.json")
        chunks = [r for r in wire if r["type"] == "chunk" and r["id"] == request_id]
        ends, cumulative = [], 0
        for chunk in chunks:
            cumulative += chunk["bytes"]
            ends.append(cumulative)
        response_path = run / f"response-{request_id}.sse"
        response_captured = response_path.exists()
        if not response_captured:
            # A request aborted before fetch returns has no response capture.
            # Missing data from a received response is still an integrity error.
            failed = any(r["type"] == "error" and r["id"] == call_id for r in parsed)
            received = any(r["id"] == request_id and r["type"] != "request" for r in wire)
            if not failed or received:
                raise ValueError(f"Missing response capture for request {request_id}")
        raw = response_path.read_bytes() if response_captured else b""
        if len(raw) != cumulative:
            raise ValueError("Captured bytes do not match chunk receipt records")
        slots, finishes, field_names = {}, [], set()
        first_tool_at = None
        first_reasoning_at = None
        raw_thinking_chars, raw_text_chars, offset, tool_fragments = 0, 0, 0, 0
        payloads = []
        if body.get("stream"):
            for line in raw.splitlines(keepends=True):
                offset += len(line)
                if not line.startswith(b"data:"):
                    continue
                data = line[5:].strip()
                if data != b"[DONE]":
                    payloads.append((json.loads(data), offset))
        elif response_captured:
            payloads.append((json.loads(raw), len(raw)))
        for payload, offset in payloads:
            receipt_at = chunks[bisect.bisect_left(ends, offset)]["at"]
            for choice in payload.get("choices", []):
                if choice.get("index", 0) != 0:
                    raise ValueError("Unexpected additional completion choice")
                if choice.get("finish_reason"):
                    finishes.append(choice["finish_reason"])
                delta = choice.get("delta", choice.get("message", {}))
                field_names.update(delta.keys())
                reasoning = delta.get("reasoning_content") or ""
                # Match JavaScript string.length, including supplementary Unicode.
                raw_thinking_chars += len(reasoning.encode("utf-16-le")) // 2
                raw_text_chars += len((delta.get("content") or "").encode("utf-16-le")) // 2
                if reasoning and first_reasoning_at is None:
                    first_reasoning_at = receipt_at
                for index, fragment in enumerate(delta.get("tool_calls") or []):
                    tool_fragments += 1
                    if first_tool_at is None:
                        first_tool_at = receipt_at
                    slot = slots.setdefault(fragment.get("index", index), {"id": "", "name": "", "arguments": ""})
                    if fragment.get("id"):
                        if slot["id"] and slot["id"] != fragment["id"]:
                            raise ValueError("Conflicting raw tool ID")
                        slot["id"] = fragment["id"]
                    function = fragment.get("function") or {}
                    if function.get("name"):
                        if slot["name"] and slot["name"] != function["name"]:
                            raise ValueError("Conflicting raw tool name")
                        slot["name"] = function["name"]
                    slot["arguments"] += function.get("arguments") or ""
        raw_tools = [dict(index=index, **slot) for index, slot in sorted(slots.items())]
        parsed_tools = [dict(index=r["sourceIndex"], id=r["toolId"], name=r["name"], arguments=r["input"]) for r in parsed if r["type"] == "tool" and r["id"] == call_id]
        all_equal = raw_tools == parsed_tools
        counts = next((r for r in parsed if r["type"] == "counts" and r["id"] == call_id), None)
        counts_equal = None if counts is None else counts["thinkingChars"] == raw_thinking_chars and counts["textChars"] == raw_text_chars
        initial = body["messages"][0].get("content", "")
        row = {
            "requestId": request_id, "callId": call_id, "stream": bool(body.get("stream")), "maxTokens": body.get("max_tokens"), "effort": body.get("reasoning_effort"),
            "toolChoice": body.get("tool_choice", "omitted"), "offeredTools": [t["function"]["name"] for t in body.get("tools", [])],
            "systemPreview": initial[:220] if isinstance(initial, str) else "structured",
            "rawToolFragments": tool_fragments, "rawTools": raw_tools, "parsedTools": parsed_tools, "toolFieldsIdentical": all_equal,
            "rawThinkingChars": raw_thinking_chars, "rawTextChars": raw_text_chars, "textAndThinkingCountsIdentical": counts_equal,
            "deltaFields": sorted(field_names), "finishReasons": finishes,
            "firstChunkMs": chunks[0]["at"]-request["at"] if chunks else None,
            "firstReasoningMs": first_reasoning_at-request["at"] if first_reasoning_at is not None else None,
            "firstRawToolMs": first_tool_at-request["at"] if first_tool_at is not None else None,
            "largestReceiptGapMs": max((b["at"]-a["at"] for a,b in zip(chunks,chunks[1:])), default=0),
            "rawBytes": len(raw), "rawSha256": hashlib.sha256(raw).hexdigest(),
            "responseCaptured": response_captured,
        }
        analyzed.append(row)
    writes = [e for e in events if e["event"].get("type") == "tool.result" and e["event"].get("tool") == "workspace_write_file" and e["event"].get("ok")]
    report = {
        "sourceBasis": "frozen snapshot" if source_root != repo else "current source",
        "runtimeResult": json.loads(result["text"]) if "text" in result else result,
        "verification": verification, "requests": analyzed,
        "allToolFieldsIdentical": all(r["toolFieldsIdentical"] for r in analyzed),
        "allStreamTextAndThinkingCountsIdentical": all(r["textAndThinkingCountsIdentical"] is True for r in analyzed if r["stream"]),
        "firstSuccessfulWriteMs": writes[0]["at"]-protocol["startedAt"] if writes else None,
        "requestsWithoutResponse": [r["requestId"] for r in analyzed if not r["responseCaptured"]],
    }
    (run / "wire-analysis.json").write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")
    print(json.dumps({"runtimeStatus": report["runtimeResult"].get("status"), "exactFile": verification["exactBytes"], "seconds": verification["seconds"], "requests": len(analyzed), "firstSuccessfulWriteMs": report["firstSuccessfulWriteMs"], "allToolFieldsIdentical": report["allToolFieldsIdentical"], "allStreamTextAndThinkingCountsIdentical": report["allStreamTextAndThinkingCountsIdentical"], "calls": [{k:r[k] for k in ("requestId", "maxTokens", "effort", "rawToolFragments", "firstRawToolMs", "finishReasons")} for r in analyzed]}))
    if not report["allToolFieldsIdentical"] or not report["allStreamTextAndThinkingCountsIdentical"]:
        raise ValueError("Raw provider output and Paw parsed output differ; inspect wire-analysis.json")


if __name__ == "__main__":
    analyze(pathlib.Path(sys.argv[1]).resolve())
