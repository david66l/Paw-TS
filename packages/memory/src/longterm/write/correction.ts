/**
 * 用户纠正检测（spec v2 §5.1）—— 轻量规则，纯函数
 *
 * 命中规则模式 → 候选为用户纠正，后续交 LLM 确认（§5.1；确认环节由调用方
 * 注入，本模块只做规则初筛）。确认即直写（source=user_statement, confidence=1.0）。
 *
 * 注意：规则命中 ≠ 持久偏好。"不要再用 X"常是当次任务的情境指令，
 * 直写后必须给用户可撤销确认（CLI: memory forget <id>）。
 */

export interface CorrectionMatch {
  isCorrection: boolean;
  /** 命中的规则模式（诊断/日志用） */
  pattern?: string;
}

/** 中文/英文纠正指令模式（§5.1 示例 + 常见变体） */
const CORRECTION_PATTERNS: { name: string; re: RegExp }[] = [
  { name: "zh:记住", re: /记住/ },
  { name: "zh:不要", re: /不要(?:再)?用?/ },
  { name: "zh:以后", re: /以后(?:都|别|不要)/ },
  { name: "zh:别", re: /别再/ },
  { name: "zh:牢记", re: /牢记/ },
  { name: "en:remember", re: /\bremember\b/i },
  { name: "en:prefer", re: /\b(?:i\s+)?prefer\b/i },
  { name: "en:don't-use", re: /\b(?:don'?t|do\s+not|stop)\s+(?:use|using)\b/i },
  { name: "en:always-never", re: /\b(?:always|never)\s+(?:use|do|run|write)\b/i },
];

export function detectUserCorrection(text: string): CorrectionMatch {
  for (const { name, re } of CORRECTION_PATTERNS) {
    if (re.test(text)) return { isCorrection: true, pattern: name };
  }
  return { isCorrection: false };
}
