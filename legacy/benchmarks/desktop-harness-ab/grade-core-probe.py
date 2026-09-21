"""Grade a settled core milestone exclusively inside its frozen Docker image."""
import hashlib
import json
import pathlib
import subprocess
import sys
import uuid


def grade(directory):
    run = pathlib.Path(directory).resolve()
    protocol = json.loads((run / "protocol.json").read_text(encoding="utf-8"))
    result = json.loads((run / "result.json").read_text(encoding="utf-8"))
    assert protocol["taskVariant"] == "queue-core-stage"
    assert protocol["isolation"]["ok"]
    relative = "legacy/benchmarks/desktop-harness-ab/verify-queue-core.mjs"
    verifier = run / "source-snapshot" / relative
    assert hashlib.sha256(verifier.read_bytes()).hexdigest() == protocol["sourceHashes"][relative]
    workspace = pathlib.Path(protocol["workspaceRoot"]).resolve()

    def execute(command, independent=False):
        name = "paw-grade-" + uuid.uuid4().hex[:16]
        args = ["docker", "run", "--rm", "--name", name, "--pull", "never",
                "--network", "none", "--read-only", "--cap-drop", "ALL",
                "--security-opt", "no-new-privileges", "--memory", "1024m",
                "--cpus", "2", "--pids-limit", "128", "--tmpfs", "/tmp:exec,nosuid,size=256m",
                "-w", "/workspace", "--mount",
                f"type=bind,source={workspace},target=/workspace" + (",readonly" if independent else "")]
        if independent:
            args += ["--mount", f"type=bind,source={verifier},target=/verifier.mjs,readonly"]
        args += [protocol["isolation"]["imageId"], *command]
        try:
            completed = subprocess.run(args, capture_output=True, text=True, encoding="utf-8",
                                       errors="replace", timeout=90,
                                       creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0))
            return {"exitCode": completed.returncode, "stdout": completed.stdout, "stderr": completed.stderr}
        finally:
            subprocess.run(["docker", "rm", "-f", name], capture_output=True, timeout=15,
                           creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0))

    independent = execute(["node", "/verifier.mjs", "/workspace"], independent=True)
    own = execute(["npm", "test"])
    functional = json.loads(independent["stdout"]) if independent["stdout"].strip() else None
    terminal = json.loads(result.get("text", "{}"))
    output = {"runtime": terminal, "functional": functional, "independent": independent, "ownTests": own,
              "completedAndVerified": result.get("ok") is True and terminal.get("status") == "completed"
              and terminal.get("acceptance") == "verified" and independent["exitCode"] == 0 and own["exitCode"] == 0}
    (run / "core-grade.json").write_text(json.dumps(output, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    return {"completedAndVerified": output["completedAndVerified"], "functional": functional,
            "ownTestsExitCode": own["exitCode"]}


if __name__ == "__main__":
    print(json.dumps(grade(sys.argv[1])))
