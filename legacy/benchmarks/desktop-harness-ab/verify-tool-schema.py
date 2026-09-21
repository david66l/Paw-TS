"""Check captured JSON Schemas and a tools-only revision without model calls."""
import hashlib
import json
import pathlib
import re
import sys

from jsonschema import Draft202012Validator


def read(path):
    return json.loads(path.read_text(encoding="utf-8"))


if __name__ == "__main__":
    original_file, revised_folder, high_folder = [pathlib.Path(p).resolve() for p in sys.argv[1:4]]
    original = read(original_file)
    revised = read(revised_folder / "request.json")
    derivation = read(revised_folder / "derivation.json")
    assert hashlib.sha256(original_file.read_bytes()).hexdigest() == derivation["sourceSha256"]
    for file, sha in derivation["sourceHashes"].items():
        assert hashlib.sha256((revised_folder / "source-snapshot" / file).read_bytes()).hexdigest() == sha
    assert {k: v for k, v in original.items() if k != "tools"} == {k: v for k, v in revised.items() if k != "tools"}
    names = lambda body: [t["function"]["name"] for t in body["tools"]]
    assert names(original) == names(revised)
    changed = []
    for old, new in zip(original["tools"], revised["tools"]):
        if old != new:
            changed.append(old["function"]["name"])
    assert changed == derivation["changed"]
    for body in [original, revised]:
        assert len(names(body)) == len(set(names(body))) <= 128
        for tool in body["tools"]:
            f = tool["function"]
            assert tool["type"] == "function" and re.fullmatch(r"[a-zA-Z0-9_-]{1,64}", f["name"])
            assert isinstance(f["description"], str) and f["description"]
            schema = f["parameters"]
            Draft202012Validator.check_schema(schema)
            assert schema["type"] == "object"
            assert set(schema.get("required", [])) <= set(schema.get("properties", {}))
    old_schemas = {t["function"]["name"]: t["function"]["parameters"] for t in original["tools"]}
    new_schemas = {t["function"]["name"]: t["function"]["parameters"] for t in revised["tools"]}
    samples = {
        "workspace_write_file": {"path": "src/queue.js", "content": "export class JobQueue {}\n"},
        "workspace_read_file": {"path": "REQUIREMENTS.md", "offset": 0, "limit": 20},
        "workspace_run_shell": {"command": "node --version"},
        "workspace_todo_write": {"todos": [{"id": "1", "content": "Implement queue", "status": "in_progress"}]},
        "context_recall": {"id": "paw-payload:v1:" + "a" * 64, "part": "chunk", "offset": 0, "limit": 8000},
    }
    for name, args in samples.items():
        Draft202012Validator(old_schemas[name]).validate(args)
        Draft202012Validator(new_schemas[name]).validate(args)
    assert not Draft202012Validator(new_schemas["workspace_write_file"]).is_valid({"path": "src/queue.js"})
    legacy_recall = {"id": "search words"}
    assert Draft202012Validator(old_schemas["context_recall"]).is_valid(legacy_recall)
    assert not Draft202012Validator(new_schemas["context_recall"]).is_valid(legacy_recall)
    high = read(high_folder / "request-1.json")
    report = {
        "originalToolCount": len(names(original)), "revisedToolCount": len(names(revised)),
        "allSchemasValidDraft202012": True, "namesAndRequiredFieldsValid": True,
        "onlyToolsChanged": True, "changedDefinitions": changed,
        "basicCallExamplesValidBeforeAndAfter": list(samples),
        "legacyRecallIdNowRejectedBySchema": True,
        "sameToolsAsHistoricalSuccessfulHigh": original["tools"] == high["tools"],
        "serializedToolChars": {"original": len(json.dumps(original["tools"], ensure_ascii=False, separators=(",", ":"))), "revised": len(json.dumps(revised["tools"], ensure_ascii=False, separators=(",", ":")))},
        "limits": ["JSON Schema validity does not prove provider generation reliability", "Historical high comparison differs in effort and uncontrolled sampling", "Descriptions and recall constraints change together; not a grammar-only intervention"],
    }
    probes = []
    for arg in sys.argv[4:]:
        folder = pathlib.Path(arg).resolve()
        body = read(folder / "control-request.json")
        result = read(folder / "control-result.json")
        assert body == original or body == revised
        schemas = {t["function"]["name"]: t["function"]["parameters"] for t in body["tools"]}
        assert result["status"] == "provider_done" and result["finishReason"] == "tool_calls"
        for call in result["toolCalls"]:
            Draft202012Validator(schemas[call["name"]]).validate(json.loads(call["arguments"]))
        probes.append({"run": folder.name, "condition": "original" if body == original else "revised", "firstToolMs": result["firstToolMs"], "durationMs": result["durationMs"], "tools": [c["name"] for c in result["toolCalls"]], "argumentsMatchSchemas": True, "toolsExecuted": False})
    report["probes"] = probes
    (revised_folder / "schema-check.json").write_text(json.dumps(report, indent=2), encoding="utf-8")
    print(json.dumps(report, indent=2))
