import fs from "node:fs";
import path from "node:path";

const dir = path.resolve(process.argv[2]);
const rows = JSON.parse(
  fs.readFileSync(path.join(dir, "summary.json"), "utf8"),
);
const protocol = JSON.parse(
  fs.readFileSync(path.join(dir, "protocol.json"), "utf8"),
);
const model = JSON.parse(
  fs.readFileSync(path.join(dir, rows[0].name, "model.json"), "utf8"),
);
const lines = [
  "# Paw 桌面长任务 Harness：真实模型 A/B 初测",
  "",
  `模型：${model.label}；思考强度：${model.runtimeProfile.reasoningEffort}。同一当前桌面运行时，standard 与 long 对照；不是历史版本回放。`,
  "",
  `每组墙钟上限 ${protocol.budget.wallMs / 60000} 分钟，最多 ${protocol.budget.calls} 次调用，累计已报告 token 停止阈值 ${protocol.budget.reportedTokens}，输出采用 ${protocol.budget.outputPolicy ?? protocol.budget.outputPerCall}。主模型、子执行者、审计与辅助调用共用计量与阈值。`,
  "",
  "|任务|流程|外部验收|耗时(s)|模型调用|输入 token|输出 token|有用量回执的调用|运行时状态 / 验收|",
  "|---|---|---:|---:|---:|---:|---:|---:|---|",
];
for (const r of rows)
  lines.push(
    `|${r.kind}${r.recovery ? "（中断恢复）" : ""}|${r.mode}|${r.passed == null ? "未测得" : `${r.passed}/${r.total}`}|${r.seconds.toFixed(1)}|${r.calls}|${r.promptTokens}|${r.completionTokens}|${r.usageReports}/${r.calls}|${r.runtimeStatus ?? "error"} / ${r.acceptance ?? "—"}|`,
  );
lines.push("", "## 逐组结果（初始基线：队列 0/15，账目迁移 1/15）", "");
for (const r of rows) {
  const verification = JSON.parse(
    fs.readFileSync(path.join(dir, r.name, "verification.json"), "utf8"),
  );
  lines.push(
    `### ${r.name}`,
    "",
    `全部外部抽样检查通过：${r.allPassed ? "是" : "否"}；需求文件未变：${r.goalUnchanged ? "是" : "否"}。`,
  );
  if (r.recovery)
    lines.push(
      `实际触发中断：${r.interruptionTriggered ? "是" : "否"}。恢复等待租约的 95 秒计入墙钟预算；没有实际触发的组不算恢复成功样本。`,
    );
  if (r.error)
    lines.push(`运行错误：\`${String(r.error).replaceAll("`", "'")}\``);
  if (verification.error)
    lines.push(`评测基础设施错误：${verification.error}；不能记为功能零分。`);
  const ownTestsPath = path.join(dir, r.name, "own-tests.json");
  if (fs.existsSync(ownTestsPath)) {
    const own = JSON.parse(fs.readFileSync(ownTestsPath, "utf8"));
    lines.push(
      own.status === "missing"
        ? "产物未提供测试文件，不能算自带测试通过。"
        : `产物自带测试补充复核：${own.passed}/${own.total} 通过，退出码 ${own.exitCode}。外部 15 项通过不代表完整交付通过。`,
    );
    for (const finding of own.findings) lines.push(`- ${finding}`);
  }
  for (const c of verification.checks ?? [])
    if (!c.pass)
      lines.push(`- ${c.name}：${c.error?.replaceAll("\n", " ") ?? "失败"}`);
  lines.push("");
}
lines.push(
  "## 解释边界",
  "",
  "- 输出策略按桌面真实请求传递：上下文规划器当前通常先请求 8192；通用恢复策略的 32000 默认值仅在没有显式请求上限时生效。评测器不再覆盖模型能力或请求输出限制。",
  "- 每种条件仅一次；这是排错和可行性初测，不能据此宣称统计显著或普遍成功率提升。",
  "- 外部验收是预先固定的 15 项功能抽样，不能证明合同的所有边界均正确；Paw 自身的 verified 也不替代外部验收。产物自带测试若失败，仍不能称完整交付。未逐像素评估 UI。",
  "- 保留普通流程的现有最终环境审计；长任务增加 Manager、独立阶段与阶段验收。关闭记忆、MCP 与自动路由，避免外部条件混杂。",
  "- token 是提供方回执，不是本地字符估算。被中断、失败或未返回 usage 的调用可能产生未统计费用；预算阈值在调用之间检查，可能因在途请求超出。缓存命中见各组 summary.json，不把 token 总数直接当人民币成本。",
  "- first committed product write 后强制退出进程，再使用同一会话 recover。两种流程写文件的时机可能不同，因此恢复场景的难度并非完全等价。",
  "- 全部失败、超时和缺失回执均保留。原始 calls.jsonl、events.jsonl、运行时 journal 与独立 verification.json 位于对应组目录。",
  "",
);
fs.writeFileSync(path.join(dir, "REPORT.md"), lines.join("\n"));
console.log(path.join(dir, "REPORT.md"));
