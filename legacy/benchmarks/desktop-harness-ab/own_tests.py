"""Run generated Node tests only after the model case has settled; never repair artifacts."""
import json
import os
import pathlib
import re
import shlex
import subprocess
import sys


def read(file):
    return json.loads(file.read_text(encoding="utf-8-sig"))


def execute(command, workspace, case, label):
    try:
        result = subprocess.run(command, cwd=workspace, capture_output=True, text=True, encoding="utf-8", errors="replace", timeout=90)
        stdout, stderr, code, timed_out = result.stdout, result.stderr, result.returncode, False
    except subprocess.TimeoutExpired as error:
        stdout = error.stdout or b""
        stderr = error.stderr or b""
        stdout = stdout.decode("utf-8", "replace") if isinstance(stdout, bytes) else stdout
        stderr = stderr.decode("utf-8", "replace") if isinstance(stderr, bytes) else stderr
        code, timed_out = None, True
    (case / f"own-tests.{label}.stdout.log").write_text(stdout, encoding="utf-8")
    (case / f"own-tests.{label}.stderr.log").write_text(stderr, encoding="utf-8")
    counts = dict(re.findall(r"^(?:# |ℹ )(tests|pass|fail) (\d+)\s*$", stdout, flags=re.MULTILINE))
    return {"command": command, "exitCode": code, "timedOut": timed_out,
            "passed": int(counts["pass"]) if "pass" in counts else None,
            "total": int(counts["tests"]) if "tests" in counts else None,
            "failed": int(counts["fail"]) if "fail" in counts else None}


def main():
    run = pathlib.Path(sys.argv[1]).resolve()
    for row in read(run / "summary.json"):
        case = run / row["name"]
        output = case / "own-tests.json"
        if output.exists():
            continue
        workspace = pathlib.Path(read(case / "manifest.json")["workspaceRoot"])
        files = []
        for directory, dirs, names in os.walk(workspace):
            dirs[:] = [d for d in dirs if d not in {".git", ".paw", "node_modules"}]
            files.extend(str((pathlib.Path(directory) / name).relative_to(workspace)) for name in names if name.endswith((".test.js", ".test.mjs", ".test.cjs", ".spec.js")))
        findings = []
        configured = None
        if not files:
            result = {"passed": 0, "total": 0, "exitCode": None, "status": "missing"}
            findings.append("未发现产物自带的 Node 测试文件；不能算测试通过。")
        else:
            package = workspace / "package.json"
            script = read(package).get("scripts", {}).get("test", "") if package.exists() else ""
            argv = shlex.split(script)
            if argv[:2] == ["node", "--test"] and not any(token in argv for token in ("&&", ";", "|", "||")):
                configured = execute(["node", "--test", "--test-reporter=tap", *argv[2:]], workspace, case, "configured")
            if configured and configured["exitCode"] == 0 and configured["total"]:
                result = dict(configured)
            else:
                findings.append("配置的测试命令失败、没有收集测试或不属于直接 Node 测试命令；下列计数来自显式测试文件补测，不代表配置命令通过。")
                result = execute(["node", "--test", "--test-reporter=tap", *sorted(files)], workspace, case, "explicit")
            if result["exitCode"] != 0:
                findings.append("自带测试未全部通过；具体失败和堆栈保留在 own-tests.*.stdout.log / stderr.log。")
        result.update(workspace=str(workspace), testFiles=sorted(files), configured=configured,
                      findings=findings, source="native Node on settled artifacts; no model calls or product edits")
        output.write_text(json.dumps(result, ensure_ascii=False, indent=2), encoding="utf-8")
        print(f"{row['name']}: own tests {result.get('passed')}/{result.get('total')}, exit={result.get('exitCode')}")


if __name__ == "__main__":
    main()
