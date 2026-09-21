"""Prepare/verify a one-description intervention without executing tools."""
import contextlib
import copy
import importlib.util
import io
import json
import pathlib
import sys
from hashlib import sha256

HERE = pathlib.Path(__file__).resolve()
SOURCE_SHA = "f4cb2dfb09f0cc3551b4d23175a6317c77014a22a7e2dc71f592413101993b75"
TOOL = "workspace_todo_write"
PREFIX = "Create and update a task list as your working plan for the current task. "


def read(file):
    return json.loads(file.read_text(encoding="utf-8"))


def digest(file):
    return sha256(file.read_bytes()).hexdigest()


def write(file, obj):
    file.write_text(json.dumps(obj, indent=2, ensure_ascii=False), encoding="utf-8")


def transform(request, anthropic=False):
    result = copy.deepcopy(request)
    targets = [t if anthropic else t["function"] for t in result["tools"]]
    matches = [t for t in targets if t["name"] == TOOL]
    assert len(matches) == 1 and len(targets) == 11
    assert matches[0]["description"] == "Replace the durable task-progress list once per tool batch. Keep at most one item in_progress and update completed items immediately."
    matches[0]["description"] = PREFIX + matches[0]["description"]
    return result


def prepare(source, output):
    source, output = source.resolve(), output.resolve()
    assert digest(source) == SOURCE_SHA, "Expected frozen V24 11-tool input"
    request = transform(read(source))
    output.mkdir(parents=True, exist_ok=False)
    write(output / "request.json", request)
    (output / "source-snapshot.py").write_bytes(HERE.read_bytes())
    write(output / "derivation.json", {
        "source": str(source), "sourceSha256": digest(source),
        "derivedSha256": digest(output / "request.json"),
        "generatorSha256": digest(HERE), "tool": TOOL, "descriptionPrefix": PREFIX,
    })
    print(json.dumps({"onlyChange": "One tool description prefix", "prefix": PREFIX, "tools": 11}))


def verify(control, treatment):
    control, treatment = control.resolve(), treatment.resolve()
    protocols = [read(run / "protocol.json") for run in (control, treatment)]
    for key in ("arm", "endpoint", "scriptSha256", "wallMs", "waitPolicy", "removedReasoningChars"):
        assert protocols[0][key] == protocols[1][key], f"Unmatched control: {key}"
    assert protocols[0]["sourceSha256"] == SOURCE_SHA
    assert protocols[0]["arm"] == "anthropic-default-sampling" and protocols[0]["wallMs"] == 360000
    source = pathlib.Path(protocols[0]["source"])
    derived = pathlib.Path(protocols[1]["source"])
    derivation = read(derived.parent / "derivation.json")
    assert pathlib.Path(derivation["source"]) == source
    assert digest(source) == derivation["sourceSha256"] == SOURCE_SHA
    assert digest(derived) == derivation["derivedSha256"] == protocols[1]["sourceSha256"]
    assert digest(derived.parent / "source-snapshot.py") == derivation["generatorSha256"]
    assert derivation["tool"] == TOOL and derivation["descriptionPrefix"] == PREFIX
    assert read(derived) == transform(read(source))
    assert read(treatment / "request.json") == transform(read(control / "request.json"), anthropic=True)
    spec = importlib.util.spec_from_file_location("protocol_check", HERE.with_name("verify-protocol-decision.py"))
    checker = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(checker)
    for run in (control, treatment):
        with contextlib.redirect_stdout(io.StringIO()):
            checker.verify(run)
    report = {
        "onlyRequestDifference": "Prefix added to workspace_todo_write description",
        "prefix": PREFIX, "toolsEach": 11,
        "schemasHistoryAndSettingsUnchanged": True, "rawStreamsIndependentlyVerified": True,
        "sourceSha256": SOURCE_SHA, "derivedSha256": digest(derived),
        "verifierSha256": digest(HERE),
        "rows": [read(run / "independent-check.json") for run in (control, treatment)],
        "toolsExecuted": False, "taskCompletionEvaluated": False,
        "limitations": ["Prior control; single sample per arm", "Effect is conditional on V24's 11-tool context", "Timeouts are censored; final usage unknown"],
    }
    write(treatment / "guidance-comparison.json", report)
    print(json.dumps(report))


if __name__ == "__main__":
    if len(sys.argv) != 4 or sys.argv[1] not in ("prepare", "verify"):
        raise SystemExit("Usage: todo-guidance-decision.py prepare source fresh-output | verify control-run treatment-run")
    (prepare if sys.argv[1] == "prepare" else verify)(pathlib.Path(sys.argv[2]), pathlib.Path(sys.argv[3]))
