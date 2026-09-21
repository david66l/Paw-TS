"""Compare settled protocol-v3 runs, retaining censored usage and missing scores."""
import hashlib
import json
import os
import pathlib
import sys


def read(file):
    return json.loads(pathlib.Path(file).read_text(encoding="utf-8-sig"))


def events(file):
    if not file.exists():
        return []
    return [json.loads(line) for line in file.read_text(encoding="utf-8").splitlines() if line.strip()]


def measures(run, row):
    case = run / row["name"]
    observed = events(case / "events.jsonl")
    model_events = events(case / "calls.jsonl")
    rejected = [e for e in observed if e.get("tool") == "workspace_delegate" and e.get("ok") is False]
    lengths = [e for e in rejected if any(text in e.get("summary", "") for text in (
        "child goal limit", "bounded string array", "allowed range", "maximum is", "characters (received", "goal must be between",
    ))]
    # Read actual committed facts, not copies embedded in model history strings.
    workspace = pathlib.Path(read(case / "manifest.json")["workspaceRoot"])
    audits = {}
    journal_root = workspace / ".paw" / "paw-next" / "sessions"
    if os.name == "nt":
        journal_root = pathlib.Path("\\\\?\\" + str(journal_root.resolve()))
    journal_available = journal_root.exists()
    def walk_error(error):
        raise error
    for directory, _, files in os.walk(journal_root, onerror=walk_error):
        if pathlib.Path(directory).name != "journal-artifacts":
            continue
        for name in files:
            if not name.endswith(".json"):
                continue
            file = pathlib.Path(directory) / name
            raw = file.read_text(encoding="utf-8")
            if "completion.review_settled" not in raw:
                continue
            pending = [json.loads(raw)]
            while pending:
                value = pending.pop()
                if isinstance(value, dict):
                    if value.get("type") == "completion.review_settled":
                        key = (str(file.parent.parent), value.get("reviewId"))
                        audits[key] = {k: value.get(k) for k in ("reviewId", "status", "reasonCode")}
                        audits[key]["unmetCriteria"] = (value.get("environmentAudit") or {}).get("unmetCriteria", [])
                    else:
                        pending.extend(value.values())
                elif isinstance(value, list):
                    pending.extend(value)
    own = read(case / "own-tests.json") if (case / "own-tests.json").exists() else None
    return {
        **row,
        "delegateCalls": sum(e.get("tool") == "workspace_delegate" and e.get("type", "").endswith("tool.call") for e in observed),
        "failedDelegations": len(rejected),
        "lengthRejections": len(lengths),
        "truncatedResponses": sum(e.get("type") == "finish" and e.get("reason") == "length" for e in model_events),
        "audits": list(audits.values()),
        "auditJournalAvailable": journal_available,
        "auditUnavailable": sum(a.get("reasonCode") == "AuditUnavailable" for a in audits.values()) if journal_available else None,
        "auditTimeout": sum(a.get("reasonCode") == "AuditTimeout" for a in audits.values()) if journal_available else None,
        "ownTests": own,
    }


def score(row):
    return "未测得" if row.get("passed") is None else f"{row['passed']}/{row['total']}"


def main():
    baseline, current = [pathlib.Path(arg).resolve() for arg in sys.argv[1:3]]
    old_protocol, new_protocol = read(baseline / "protocol.json"), read(current / "protocol.json")
    for key in ("version", "budget", "specs", "memory", "autoRouting", "replicates"):
        if old_protocol[key] != new_protocol[key]:
            raise ValueError(f"Protocol mismatch: {key}")
    context = read(current / "comparison-context.json")
    repo = pathlib.Path(__file__).resolve().parents[3]
    for file, expected in context["sourceHashes"].items():
        if hashlib.sha256((repo / file).read_bytes()).hexdigest() != expected:
            raise ValueError(f"Frozen source changed during the run: {file}")
    old_rows = {row["name"]: measures(baseline, row) for row in read(baseline / "summary.json")}
    new_rows = [measures(current, row) for row in read(current / "summary.json")]
    rows = []
    for new in new_rows:
        old = old_rows[new["name"]]
        for key in ("kind", "mode", "recovery"):
            if old[key] != new[key]:
                raise ValueError(f"Case mismatch: {new['name']}/{key}")
        if read(baseline / new["name"] / "model.json") != read(current / new["name"] / "model.json"):
            raise ValueError(f"Model mismatch: {new['name']}")
        for run in (baseline, current):
            verification = read(run / new["name"] / "verification.json")
            if verification.get("verifierHash") != context["sourceHashes"]["legacy/benchmarks/desktop-harness-ab/verify.mjs"]:
                raise ValueError(f"Missing independent verification: {run}/{new['name']}")
        rows.append({"name": new["name"], "before": old, "after": new})
    complete = len(rows) == len(new_protocol["specs"])
    (current / "comparison.json").write_text(json.dumps({"complete": complete, "rows": rows}, ensure_ascii=False, indent=2), encoding="utf-8")
    lines = ["# Harness 修复前后真实 GLM 对照", "", f"状态：{'六组已结束并复核' if complete else '进行中，仅包含已结束并复核的组'}。每条件每轮各一次；GLM-5.3-Flash / max；预算与任务保持不变。", "", "|组别|外部检查（前 → 后）|秒（前 → 后）|调用（前 → 后）|已报告 token（前 → 后）|运行时状态（前 → 后）|", "|---|---:|---:|---:|---:|---|"]
    for row in rows:
        a, b = row["before"], row["after"]
        lines.append(f"|{row['name']}|{score(a)} → {score(b)}|{a['seconds']:.1f} → {b['seconds']:.1f}|{a['calls']} → {b['calls']}|{a['totalTokens']} → {b['totalTokens']}|{a.get('runtimeStatus', 'error')} → {b.get('runtimeStatus', 'error')}|")
    lines += ["", "## 派发与审计", "", "|组别|失败派发（前 → 后）|其中长度错误（前 → 后）|AuditUnavailable（前 → 后）|AuditTimeout（前 → 后）|", "|---|---:|---:|---:|---:|"]
    for row in rows:
        a, b = row["before"], row["after"]
        lines.append(f"|{row['name']}|{a['failedDelegations']} → {b['failedDelegations']}|{a['lengthRejections']} → {b['lengthRejections']}|{a['auditUnavailable']} → {b['auditUnavailable']}|{a['auditTimeout']} → {b['auditTimeout']}|")
    lines += ["", "已返回 length 原因的输出截断次数（修复前 → 后；无完成回执的调用不计入）：", ""]
    for row in rows:
        lines.append(f"- {row['name']}：{row['before']['truncatedResponses']} → {row['after']['truncatedResponses']}")
    lines += ["", "## 自带测试与恢复", ""]
    for row in rows:
        b = row["after"]
        own = b["ownTests"]
        if not own:
            description = "未补测自带测试。"
        elif own.get("status") == "missing":
            description = "未提供测试文件，不能算测试通过。"
        else:
            description = f"自带测试 {own.get('passed')}/{own.get('total')}，退出码 {own.get('exitCode')}。"
        lines.append(f"- {row['name']}：" + (f"实际触发中断：{'是' if b['interruptionTriggered'] else '否'}；" if b["recovery"] else "") + description)
        if own:
            for finding in own.get("findings", []):
                lines.append(f"  - {finding}")
    lines += ["", "## 解释边界", "", "- 账本初始代码已有 1/15；该项不算新增功能。外部 15 项是固定抽样，不能代替完整交付或自带测试。", "- 报告用量只包含提供方返回的 usage；失败/中断调用可能仍产生费用，不能由 token 比值推断价格。", "- 修复同时涉及审计规则和派发反馈，无法仅凭本轮分别量化它们的贡献；普通流程的重复样本用于观察波动。", "- 模型、任务、验收器和预算已比对，运行期间关键代码哈希保持一致。这里只能解释本轮样本，不能宣称普遍成功率或小时级任务能力。", "- 未触发中断不算恢复成功或失败；写入后继续运行不等于整项任务完成。", ""]
    (current / "COMPARISON.md").write_text("\n".join(lines), encoding="utf-8")
    print(json.dumps({"complete": complete, "cases": len(rows), "report": str(current / "COMPARISON.md")}))


if __name__ == "__main__":
    main()
