"""Report a settled GLM parameter probe; refuses incomplete/unverified evidence."""
import hashlib
import json
import pathlib
import sys


def read(file):
    return json.loads(file.read_text(encoding="utf-8-sig"))


def lines(file):
    return [json.loads(line) for line in file.read_text(encoding="utf-8").splitlines() if line.strip()]


def main():
    run = pathlib.Path(sys.argv[1]).resolve()
    repo = pathlib.Path(__file__).resolve().parents[3]
    protocol = read(run / "protocol.json")
    rows = read(run / "summary.json")
    variants = protocol["variants"]
    if len(rows) != len(variants) or {row["variant"] for row in rows} != set(variants):
        raise RuntimeError("All planned variants must settle before final reporting")
    if not read(run / "integrity.json")["unchanged"]:
        raise RuntimeError("Frozen source changed during experiment")
    for file, expected in protocol["sourceHashes"].items():
        if hashlib.sha256((repo / file).read_bytes()).hexdigest() != expected:
            raise RuntimeError(f"Source no longer matches frozen experiment: {file}")
    report = ["# GLM 思考强度与输出额度：桌面普通任务对照", "",
              "同一队列任务、桌面宿主与调度逻辑，每组最多 12 分钟、40 次调用、160000 已报告 token。每条件一次，顺序固定，不能据此宣称统计显著或普遍稳定。", "",
              "|配置|外部抽查|首次业务文件(s)|总耗时(s)|调用/用量回执|已报告输入/输出 token|截断次数|运行时状态|自带测试|",
              "|---|---:|---:|---:|---:|---:|---:|---|---|"]
    diagnostics = []
    baseline_profile = None
    for row in rows:
        case = run / row["name"]
        if not row["verificationMeasured"] or row["passed"] is None:
            raise RuntimeError("Run grade.py first; missing evidence is not a zero score")
        if not row["goalUnchanged"]:
            raise RuntimeError("Task requirements were changed")
        model = read(case / "model.json")
        if baseline_profile is None:
            baseline_profile = model["baselineProfile"]
        elif model["baselineProfile"] != baseline_profile:
            raise RuntimeError("Baseline model profile changed between variants")
        verification = read(case / "verification.json")
        if verification["verifierHash"] != protocol["sourceHashes"]["legacy/benchmarks/desktop-harness-ab/verify.mjs"]:
            raise RuntimeError("External verifier changed")
        own = read(case / "own-tests.json")
        own_label = "未提供" if own.get("status") == "missing" else f"{own['passed']}/{own['total']}, exit={own['exitCode']}"
        first = "未出现" if row["firstProductWriteMs"] is None else f"{row['firstProductWriteMs']/1000:.1f}"
        report.append(f"|{row['variant']}|{row['passed']}/{row['total']}|{first}|{row['seconds']:.1f}|{row['calls']}/{row['usageReports']}|{row['promptTokens']}/{row['completionTokens']}|{row['truncatedResponses']}|{row.get('runtimeStatus', 'error')}|{own_label}|")
        wire = lines(case / "wire.jsonl")
        for request in wire:
            original = request.get("originalMaxTokens")
            if isinstance(original, int) and original < 8192:
                if request["maxTokens"] != original or request["effort"] != request["originalEffort"]:
                    raise RuntimeError("Auxiliary request changed unexpectedly")
            else:
                if request["effort"] != variants[row["variant"]]["effort"]:
                    raise RuntimeError("Wire effort did not match planned condition")
                floor = variants[row["variant"]]["outputFloor"]
                expected = max(original, floor) if floor is not None and isinstance(original, int) and original >= 8192 else original
                if request.get("maxTokens") != expected:
                    raise RuntimeError("Wire output limit did not match planned condition")
        calls = lines(case / "calls.jsonl")
        starts = {r["id"]: r["at"] for r in calls if r["type"] == "start"}
        counts = {r["id"]: r for r in calls if r["type"] == "output_counts"}
        diagnostics.extend(["", f"## {row['name']}", "", f"实际请求记录 {len(wire)} 条，参数检查通过。", "",
                            "|调用|耗时(s)|结束原因|思考字符|正文字符|工具调用数|", "|---:|---:|---|---:|---:|---:|"])
        for record in calls:
            if record["type"] not in {"finish", "error"}:
                continue
            count = counts.get(record["id"], {})
            diagnostics.append(f"|{record['id']}|{(record['at']-starts[record['id']])/1000:.1f}|{record.get('reason', 'error/abort')}|{count.get('thinkingChars', '—')}|{count.get('textChars', '—')}|{count.get('toolCalls', '—')}|")
        diagnostics.append("")
        for finding in own["findings"]:
            diagnostics.append(f"- {finding}")
        for check in verification["checks"]:
            if not check["pass"]:
                diagnostics.append(f"- 外部未通过：{check['name']}")
    report.extend(["", "## 解释边界", "",
                   "- max-native 保留原始请求；high-native 只把非小额辅助调用的思考强度设为 high；max-32768 只把原本 >=8192 的请求额度提高到至少 32768，保留更高的原生恢复额度。小额辅助调用保持原参数。",
                   "- 参数在独立评测进程的模型请求层调整，用户配置和产品运行时代码未修改。上下文规划器仍保留原预留值，本轮短输入仅用于诊断；不能直接把请求层覆盖作为正式适配。",
                   "- 首次业务文件是按 250ms 间隔检查 src/queue.js、src/store.js、src/cli.js 的首次观察时间；事件循环阻塞会增加采样延迟，也不代表代码完整或正确。",
                   "- 截断次数仅计算取得 finishReason=length 的响应。思考/正文仅保存字符计数，不等同 token。缺失用量回执不等于没有费用。",
                   "- 外部 15 项为固定功能抽查；必须同时检查自带测试、文档和运行时完成状态。未触发任何强制中断，不是恢复能力测试。",
                   "- 思考强度的依据：[官方模型说明](https://huggingface.co/zai-org/GLM-5.3-Flash/blob/main/README.md)。", ""])
    report.extend(diagnostics)
    (run / "MODEL-PROBE.md").write_text("\n".join(report) + "\n", encoding="utf-8")
    print(json.dumps({"complete": True, "cases": len(rows), "wireParametersVerified": True, "report": str(run / "MODEL-PROBE.md")}))


if __name__ == "__main__":
    main()
