"""Grade a completed queue wire probe with native Node, outside Bun's process bridge."""
import hashlib
import json
import pathlib
import shutil
import subprocess
import sys

run = pathlib.Path(sys.argv[1]).resolve()
if not (run / "result.json").exists():
    raise RuntimeError("Wait for the probe to settle before grading")
protocol = json.loads((run / "protocol.json").read_text(encoding="utf-8"))
verifier = pathlib.Path(__file__).with_name("verify.mjs").resolve()
expected = protocol["sourceHashes"]["legacy/benchmarks/desktop-harness-ab/verify.mjs"]
if hashlib.sha256(verifier.read_bytes()).hexdigest() != expected:
    raise RuntimeError("Verifier differs from the frozen experiment protocol")
target = run / "functional-verification.json"
backup = run / "functional-verification.initial.json"
if target.exists() and not backup.exists():
    shutil.copy2(target, backup)
result = subprocess.run(
    ["node", str(verifier), "queue", protocol["workspaceRoot"]],
    capture_output=True, text=True, encoding="utf-8", timeout=90,
    creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
)
report = {
    "exitCode": result.returncode, "verifierSha256": expected,
    "runner": "native Node launched by Python",
    "result": json.loads(result.stdout) if result.returncode == 0 else None,
    "error": result.stderr,
}
target.write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")
if result.returncode:
    raise RuntimeError("Verifier infrastructure failed; no functional score assigned")
print(json.dumps({key: report["result"][key] for key in ("passed", "total")}))
