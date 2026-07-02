/**
 * 系统提示词章节：语气与风格
 *
 * 【章节用途】
 * 生成 system prompt 中关于输出风格规范的章节。定义 AI 的沟通方式：
 * 不使用 emoji（除非用户要求）、代码引用格式、GitHub 链接格式、
 * 以及工具调用前的文本写法（句号而非冒号）。
 *
 * 【为什么需要这个章节】
 * 一致的输出风格提升用户体验和可读性：
 * - 禁止 emoji 保持专业感，避免在编码场景中分散注意力
 * - `file_path:line_number` 格式让 IDE 可以生成可点击的跳转链接
 * - `owner/repo#123` 格式让 GitHub 自动渲染为链接
 * - 冒号规则并非审美偏好，而是工具调用前后的断句方式会影响输出可读性
 *
 * 【关键设计决策】
 * - 全都是具体的格式规则，不涉及抽象的风格指导（如"保持友好"）
 * - 每条规则都给出了"正确"和"错误"的具体示例或说明
 * - 使用 `sectionBullets` 格式保持章节一致性
 */
import { sectionBullets } from "../format.js";

export function getToneAndStyleSection(): string {
  return sectionBullets("Tone and style", [
    "Only use emojis if the user explicitly requests it. Avoid using emojis in all communication unless asked.",
    // file_path:line_number 格式——IDE 可解析为可点击链接
    "When referencing specific functions or pieces of code include the pattern file_path:line_number to allow the user to easily navigate to the source code location.",
    // owner/repo#123 格式——GitHub 自动渲染为链接
    "When referencing GitHub issues or pull requests, use the owner/repo#123 format (e.g. myorg/myrepo#100) so they render as clickable links.",
    // 工具调用前用句号而非冒号，因为工具调用的 JSON 会另起一行显示
    'Do not use a colon before tool calls. Your tool calls may not be shown directly in the output, so text like "Let me read the file:" followed by a tool call should just be "Let me read the file." with a period.',
  ]);
}
