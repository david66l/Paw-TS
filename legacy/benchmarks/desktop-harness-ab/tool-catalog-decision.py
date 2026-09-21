"""Prepare and independently check a frozen tool-catalog decision experiment."""
import contextlib
import importlib.util
import io
import json
import pathlib
import sys
from hashlib import sha256

HERE = pathlib.Path(__file__).resolve()
KEEP = frozenset([
    "context_recall", "workspace_apply_patch", "workspace_edit_file",
    "workspace_git_diff", "workspace_git_status", "workspace_list_dir",
    "workspace_read_file", "workspace_run_shell", "workspace_search",
    "workspace_todo_write", "workspace_write_file",
])
SOURCE_SHA = "2d112d270ffc3c3e3f9e9f7dffda3f7e0586e82e4210c6c9fa6f0a9db3125e30"


def read(file):
    return json.loads(file.read_text(encoding="utf-8"))


def digest(file):
    return sha256(file.read_bytes()).hexdigest()


def write(file, obj):
    file.write_text(json.dumps(obj, indent=2, ensure_ascii=False), encoding="utf-8")


def prepare(source, output):
    source, output = source.resolve(), output.resolve()
    assert digest(source) == SOURCE_SHA, "Expected frozen V14 request 3"
    request = read(source)
    assert len(request["tools"]) == 24
    history = {c["function"]["name"] for m in request["messages"] for c in m.get("tool_calls", [])}
    assert history <= KEEP, "Cannot remove a historically referenced tool"
    kept = [t for t in request["tools"] if t["function"]["name"] in KEEP]
    assert len(kept) == len(KEEP) == 11
    removed = [t["function"]["name"] for t in request["tools"] if t["function"]["name"] not in KEEP]
    output.mkdir(parents=True, exist_ok=False)
    write(output / "request.json", dict(request, tools=kept))
    (output / "source-snapshot.py").write_bytes(HERE.read_bytes())
    write(output / "derivation.json", {
        "source": str(source), "sourceSha256": digest(source),
        "derivedSha256": digest(output / "request.json"),
        "generatorSha256": digest(HERE),
        "kept": [t["function"]["name"] for t in kept], "removed": removed,
        "historicallyReferenced": sorted(history),
        "onlyChange": "Filter tools without changing remaining definitions or order",
    })
    print(json.dumps({"kept": len(kept), "removed": removed, "historyPreserved": True}))


def verify(control, treatment):
    control, treatment = control.resolve(), treatment.resolve()
    ps = [read(run / "protocol.json") for run in (control, treatment)]
    for key in ("arm", "endpoint", "scriptSha256", "wallMs", "waitPolicy", "removedReasoningChars"):
        assert ps[0][key] == ps[1][key], f"Unmatched control: {key}"
    assert ps[0]["arm"] == "anthropic-default-sampling"
    assert ps[0]["wallMs"] == 360000
    assert ps[0]["sourceSha256"] == SOURCE_SHA
    derived = pathlib.Path(ps[1]["source"])
    derivation = read(derived.parent / "derivation.json")
    assert digest(derived) == ps[1]["sourceSha256"] == derivation["derivedSha256"]
    source = pathlib.Path(derivation["source"])
    assert digest(source) == derivation["sourceSha256"] == SOURCE_SHA
    assert digest(derived.parent / "source-snapshot.py") == derivation["generatorSha256"]
    original = read(source)
    kept = [t for t in original["tools"] if t["function"]["name"] in KEEP]
    assert len(kept) == 11 and len(original["tools"]) == 24
    assert read(derived) == dict(original, tools=kept)
    history = {c["function"]["name"] for m in original["messages"] for c in m.get("tool_calls", [])}
    assert history <= KEEP
    assert derivation["kept"] == [t["function"]["name"] for t in kept]
    assert derivation["removed"] == [t["function"]["name"] for t in original["tools"] if t["function"]["name"] not in KEEP]
    rs = [read(run / "request.json") for run in (control, treatment)]
    assert rs[1] == dict(rs[0], tools=[t for t in rs[0]["tools"] if t["name"] in KEEP])
    spec = importlib.util.spec_from_file_location("protocol_check", HERE.with_name("verify-protocol-decision.py"))
    checker = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(checker)
    for run in (control, treatment):
        with contextlib.redirect_stdout(io.StringIO()):
            checker.verify(run)
    report = {
        "onlyRequestDifference": "Tool catalog filtered from 24 to 11",
        "historyAndRemainingDefinitionsExact": True,
        "rawStreamsIndependentlyVerified": True,
        "sourceSha256": SOURCE_SHA, "derivedSha256": digest(derived),
        "verifierSha256": digest(HERE), "kept": derivation["kept"],
        "removed": derivation["removed"],
        "rows": [read(run / "independent-check.json") for run in (control, treatment)],
        "toolsExecuted": False, "taskCompletionEvaluated": False,
        "limitations": ["Prior control; no randomized or concurrent pair", "Catalog size and membership change together", "Timeouts are censored; final usage unknown"],
    }
    write(treatment / "catalog-comparison.json", report)
    print(json.dumps(report))


if __name__ == "__main__":
    if len(sys.argv) != 4 or sys.argv[1] not in ("prepare", "verify"):
        raise SystemExit("Usage: tool-catalog-decision.py prepare source fresh-output | verify control-run treatment-run")
    (prepare if sys.argv[1] == "prepare" else verify)(pathlib.Path(sys.argv[2]), pathlib.Path(sys.argv[3]))
