"""Check a sampling-omission pair and its raw streams without executing tools."""
import contextlib
import hashlib
import importlib.util
import io
import json
import pathlib
import sys


HERE = pathlib.Path(__file__).resolve()
spec = importlib.util.spec_from_file_location(
    "protocol_check", HERE.with_name("verify-protocol-decision.py")
)
protocol_check = importlib.util.module_from_spec(spec)
spec.loader.exec_module(protocol_check)


def read(file):
    return json.loads(file.read_text(encoding="utf-8"))


def verify(control, treatment):
    control, treatment = control.resolve(), treatment.resolve()
    assert control != treatment
    protocols = [read(run / "protocol.json") for run in (control, treatment)]
    assert protocols[0]["arm"] == "anthropic"
    assert protocols[1]["arm"] == "anthropic-default-sampling"
    for key in ("sourceSha256", "scriptSha256", "endpoint", "wallMs", "waitPolicy", "removedReasoningChars"):
        assert protocols[0][key] == protocols[1][key], f"Unmatched control: {key}"
    assert protocols[0]["wallMs"] == 360000
    requests = [read(run / "request.json") for run in (control, treatment)]
    expected = dict(requests[0])
    assert expected.pop("temperature") == 1
    assert expected.pop("top_p") == 0.95
    assert requests[1] == expected, "Differences beyond sampling-field omissions"
    for run in (control, treatment):
        with contextlib.redirect_stdout(io.StringIO()):
            protocol_check.verify(run)
    checks = [read(run / "independent-check.json") for run in (control, treatment)]
    report = {
        "control": str(control),
        "treatment": str(treatment),
        "onlyRequestDifferences": ["temperature omitted", "top_p omitted"],
        "sameProbeAndFrozenInput": True,
        "rawStreamsIndependentlyVerified": True,
        "sourceSha256": protocols[0]["sourceSha256"],
        "verifierSha256": hashlib.sha256(HERE.read_bytes()).hexdigest(),
        "responseVerifierSha256": checks[0]["verifierSha256"],
        "rows": checks,
        "toolsExecuted": False,
        "taskCompletionEvaluated": False,
        "limitations": [
            "One sample per arm; requests need not be contemporaneous",
            "Provider defaults, load and cache state are not measured",
            "Omitting two fields is one bundled intervention, not two independent tests",
            "Timeouts are censored and do not supply final token usage",
        ],
    }
    (treatment / "sampling-comparison.json").write_text(
        json.dumps(report, indent=2), encoding="utf-8"
    )
    print(json.dumps(report))


if __name__ == "__main__":
    if len(sys.argv) != 3:
        raise SystemExit("Usage: verify-sampling-decision.py control-run treatment-run")
    verify(pathlib.Path(sys.argv[1]), pathlib.Path(sys.argv[2]))
