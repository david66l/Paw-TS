"""Verify the inspection-only state intervention independently of TypeScript."""
import hashlib
import json
import pathlib
import sys

root = pathlib.Path(sys.argv[1])
read = lambda p: json.loads(p.read_text(encoding="utf-8"))
digest = lambda p: hashlib.sha256(p.read_bytes()).hexdigest()
derivation = read(root / "derivation.json")
source = pathlib.Path(derivation["source"])
original = read(source)
revised = read(root / "request.json")
assert digest(source) == derivation["sourceSha256"]
assert digest(root / "request.json") == derivation["requestSha256"]
assert revised["messages"][:-1] == original["messages"]
assert {k: v for k, v in revised.items() if k != "messages"} == {k: v for k, v in original.items() if k != "messages"}
assert revised["reasoning_effort"] == "max" and revised["max_tokens"] == 128000
assert len(revised["tools"]) == 24
state_message = revised["messages"][-1]
assert state_message["role"] == "user"
state = json.loads(state_message["content"].splitlines()[-1])
snapshot = read(root / "snapshot.json")
calls = {e["fact"]["callId"]: e["fact"] for e in snapshot["entries"] if e["fact"]["type"] == "tool.call_observed"}
reads = []
for e in snapshot["entries"]:
    f = e["fact"]
    if f["type"] != "tool.settled":
        continue
    call = calls[f["callId"]]
    assert call["tool"] in ["workspace_read_file", "workspace_list_dir", "workspace_git_status"]
    assert f["status"] == "completed" and f["observation"]["isError"] is False
    if call["tool"] == "workspace_read_file":
        reads.append({"sourceSeq": e["seq"], "path": call["args"]["path"]})
assert state["fileReads"] == {"items": reads, "omitted": 0}
assert state["workspaceChanges"]["confirmedOperations"] == 0
assert state["workspaceChanges"]["uncertainOperations"] == 0
assert state["latestVerificationByTarget"]["items"] == []
assert state["recentUnsuccessfulActions"]["items"] == []
assert state["sourceThroughSeq"] == 26
for name, expected in derivation["sourceHashes"].items():
    assert digest(root / "source-snapshot" / name) == expected
result = {"passed": True, "onlyChange": "one factual tail message", "stateChars": len(state_message["content"]), "nativeHistoryUnchanged": True, "maxAndToolsUnchanged": True, "readFactsVerified": reads}
(root / "independent-check.json").write_text(json.dumps(result, indent=2), encoding="utf-8")
print(json.dumps(result))
