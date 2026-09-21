"""Grade settled workspaces through native Node, independently of Bun's runner.

Retain initial verifier output, record artifact hashes and never convert an
infrastructure failure into a functional score of zero.
"""
import hashlib
import json
import pathlib
import shutil
import subprocess
import sys

run = pathlib.Path(sys.argv[1]).resolve()
verifier = pathlib.Path(__file__).with_name("verify.mjs").resolve()
rows = json.loads((run / "summary.json").read_text(encoding="utf-8"))
for row in rows:
    case = run / row["name"]
    manifest = json.loads((case / "manifest.json").read_text(encoding="utf-8"))
    workspace = pathlib.Path(manifest["workspaceRoot"])
    old = case / "verification.json"
    if old.exists() and not (case / "verification.initial.json").exists():
        shutil.copy2(old, case / "verification.initial.json")
    result = subprocess.run(["node", str(verifier), row["kind"], str(workspace)],
                            capture_output=True, text=True, encoding="utf-8", timeout=90)
    if result.returncode != 0:
        raise RuntimeError(f"Verifier infrastructure failure for {row['name']}: {result.stderr}")
    data = json.loads(result.stdout)
    if not data.get("checks") or len(data["checks"]) != data["total"]:
        raise RuntimeError("Verifier did not supply all individual check results")
    artifacts = {}
    for file in workspace.rglob("*"):
        relative = file.relative_to(workspace)
        if any(part in {".git", ".paw", "node_modules"} for part in relative.parts):
            continue
        if file.is_file():
            artifacts[relative.as_posix()] = hashlib.sha256(file.read_bytes()).hexdigest()
    data["artifactHashes"] = artifacts
    data["verifierHash"] = hashlib.sha256(verifier.read_bytes()).hexdigest()
    old.write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8")
    row.update(passed=data["passed"], total=data["total"], allPassed=data["passed"] == data["total"], verificationMeasured=True, verificationSource="native-node-independent-recheck")
    (case / "summary.json").write_text(json.dumps(row, ensure_ascii=False, indent=2), encoding="utf-8")
    print(f"{row['name']}: {data['passed']}/{data['total']}")
(run / "summary.json").write_text(json.dumps(rows, ensure_ascii=False, indent=2), encoding="utf-8")
