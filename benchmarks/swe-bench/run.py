#!/usr/bin/env python3
"""
SWE-bench Lite adapter for paw-ts.

Runs paw-ts against SWE-bench instances and produces predictions in the
official SWE-bench format.

Usage:
    python benchmarks/swe-bench/run.py \
        --input swe-bench-lite.jsonl \
        --max-instances 5 \
        --output results.jsonl
"""

import argparse
import json
import os
import subprocess
import tempfile
from pathlib import Path


def clone_repo(repo: str, commit: str, dest: Path) -> None:
    """Clone a repo and checkout the base commit."""
    if dest.exists():
        subprocess.run(["rm", "-rf", str(dest)], check=True)
    subprocess.run(
        ["git", "clone", f"https://github.com/{repo}.git", str(dest)],
        check=True,
        capture_output=True,
    )
    subprocess.run(
        ["git", "-C", str(dest), "checkout", commit],
        check=True,
        capture_output=True,
    )


def write_memory_config(workspace: Path, memory_on: bool) -> None:
    """Toggle paw-ts memory via .paw/memory-config.json (orchestrator zero-call when off)."""
    paw = workspace / ".paw"
    paw.mkdir(parents=True, exist_ok=True)
    (paw / "memory-config.json").write_text(
        json.dumps(
            {"enable": memory_on, "readonly": False, "shadow": False},
            indent=2,
        )
        + "\n",
        encoding="utf-8",
    )


def run_paw_ts(workspace: Path, goal: str, run_id: str, memory_on: bool) -> dict:
    """Invoke paw-ts CLI on the given workspace with the bug description as goal."""
    write_memory_config(workspace, memory_on)
    # This assumes paw-ts has a headless mode that accepts --goal and --workspace-root.
    # Adjust the invocation to match your actual CLI interface.
    cmd = [
        "bun", "run", "apps/cli/src/main.ts",
        "stub-run",
        "--workspace-root", str(workspace),
        "--goal", goal,
        "--max-steps", "20",
    ]
    result = subprocess.run(cmd, capture_output=True, text=True, cwd=workspace.parent)
    return {
        "stdout": result.stdout,
        "stderr": result.stderr,
        "returncode": result.returncode,
        "memory_on": memory_on,
        "run_id": run_id,
    }


def extract_patch(workspace: Path) -> str:
    """Get the git diff from the workspace after the agent ran."""
    result = subprocess.run(
        ["git", "-C", str(workspace), "diff"],
        capture_output=True,
        text=True,
    )
    return result.stdout


def main():
    parser = argparse.ArgumentParser(description="Run paw-ts on SWE-bench Lite")
    parser.add_argument("--input", required=True, help="Path to SWE-bench instances JSONL")
    parser.add_argument("--output", required=True, help="Path to write predictions JSONL")
    parser.add_argument("--max-instances", type=int, default=None, help="Max instances to run")
    parser.add_argument("--workers", type=int, default=1, help="Parallel workers (not yet implemented)")
    parser.add_argument(
        "--memory",
        choices=("on", "off"),
        default="off",
        help="memory on/off via .paw/memory-config.json (for SWE-Exp pairing)",
    )
    args = parser.parse_args()
    memory_on = args.memory == "on"

    predictions = []
    with open(args.input, "r", encoding="utf-8") as f:
        for i, line in enumerate(f):
            if args.max_instances is not None and i >= args.max_instances:
                break
            instance = json.loads(line)
            instance_id = instance["instance_id"]
            repo = instance["repo"]
            commit = instance["base_commit"]
            problem = instance["problem_statement"]

            print(f"[{i + 1}] {instance_id}: {repo} @ {commit[:8]}")

            with tempfile.TemporaryDirectory() as tmpdir:
                workspace = Path(tmpdir) / "repo"
                try:
                    clone_repo(repo, commit, workspace)
                except subprocess.CalledProcessError as e:
                    print(f"  Failed to clone: {e}")
                    predictions.append({
                        "model": "paw-ts",
                        "instance_id": instance_id,
                        "patch": "",
                    })
                    continue

                run_result = run_paw_ts(workspace, problem, instance_id, memory_on)
                patch = extract_patch(workspace)

                if patch.strip():
                    print(f"  Generated patch ({len(patch)} chars) memory={'on' if memory_on else 'off'}")
                else:
                    print(f"  No patch generated (memory={'on' if memory_on else 'off'})")

                predictions.append({
                    "model": f"paw-ts-memory-{'on' if memory_on else 'off'}",
                    "instance_id": instance_id,
                    "patch": patch,
                    "memory_on": memory_on,
                    "returncode": run_result.get("returncode"),
                })

    with open(args.output, "w", encoding="utf-8") as f:
        for p in predictions:
            f.write(json.dumps(p) + "\n")

    print(f"\nWrote {len(predictions)} predictions to {args.output}")
    print("Evaluate with:")
    print(f"  python -m swebench.harness.run_evaluation \\")
    print(f"    --dataset_name princeton-nlp/SWE-bench_Lite \\")
    print(f"    --predictions_path {args.output}")


if __name__ == "__main__":
    main()
