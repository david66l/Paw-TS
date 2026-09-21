/**
 * Training Data Exporter — 训练数据导出器
 * ==========================================
 *
 * 【是什么】
 * 将评测运行记录（EvalRunRecord）转换为 ChatML 格式的对话记录，
 * 并导出为 JSONL 文件，用于微调模型在 paw-ts 工具调用格式上的表现。
 *
 * 【为什么】
 * 评测过程中产生的高分运行记录是高质量的"正确示范"。将其转换为
 * ChatML 格式的训练数据，可以直接用于：
 * - SFT（监督微调）：让模型学习正确的工具调用模式和回复风格
 * - DPO（直接偏好优化）：高分 vs 低分运行记录可构成偏好对
 * - 回归测试数据：确保新模型版本在历史评测中表现一致
 *
 * 【关键设计决策】
 * 1. **ChatML 格式**：采用 industry-standard 的 ChatML 消息格式
 *    （system/user/assistant/tool 角色），兼容 OpenAI/DeepSeek/Qwen 等
 *    主流模型微调框架。
 * 2. **完整对话重建**：从 EvalRunRecord 的轮次追踪中重建完整的
 *    tool-calling 对话流程，而不仅仅是最终的问答对。这确保模型学习
 *    到"用户提问 → 工具调用 → 工具返回 → 继续推理"的完整交互模式。
 * 3. **final_answer 兜底**：如果记录的最后一轮没有包含 final_answer
 *    动作，则手动追加一条 assistant 消息来补全对话结构。
 * 4. **阈值过滤**：默认只导出整体分数 >= passThreshold 的记录，
 *    确保训练数据只包含高质量的正例。CLI 中传入 100 表示仅导出满分。
 * 5. **仅导出 completed 状态**：失败/错误/超时的运行记录不纳入训练数据，
 *    避免引入错误的行为模式。
 */

import type { EvalRunRecord } from "./eval-record.js";
import type { AggregateScoreReport } from "./scorer/types.js";

/** ChatML 格式的单条消息 */
export interface ChatMLMessage {
  readonly role: "system" | "user" | "assistant" | "tool";
  readonly content: string;
}

/** ChatML 格式的完整对话 */
export interface ChatMLConversation {
  readonly messages: readonly ChatMLMessage[];
}

/**
 * 将单条 EvalRunRecord 重建为 ChatML 对话。
 *
 * 重建策略：
 * 1. 从第一轮的 modelInput 中提取 system prompt
 * 2. 以用户 goal 作为 user 消息
 * 3. 逐轮添加 assistant 的模型输出和 tool 的返回结果
 * 4. 如果最后一轮响应中不包含 final_answer，手动追加一条
 *
 * 这样重建出的对话完整反映了 Agent 的工具调用流程，
 * 适合作为微调训练样本。
 */
export function runToChatML(record: EvalRunRecord): ChatMLConversation {
  const messages: ChatMLMessage[] = [];

  // 从第一轮模型输入中提取系统提示词
  if (record.turns.length > 0) {
    const firstTurn = record.turns[0]!;
    if (firstTurn.modelInput.systemPrompt) {
      messages.push({
        role: "system",
        content: firstTurn.modelInput.systemPrompt,
      });
    }
  }

  // 用户目标作为 user 消息
  messages.push({
    role: "user",
    content: record.goal,
  });

  // 逐轮重建工具调用对话
  for (const turn of record.turns) {
    // Assistant 响应：模型输出（包含工具调用指令或最终回答）
    if (turn.modelOutput.rawText) {
      messages.push({
        role: "assistant",
        content: turn.modelOutput.rawText,
      });
    }

    // 工具返回结果：每次工具调用的执行结果
    for (const exec of turn.toolExecutions) {
      const toolContent = `[Tool ${exec.tool} ${exec.ok ? "completed" : "failed"}]\n${exec.result}`;
      messages.push({
        role: "tool",
        content: toolContent,
      });
    }
  }

  // 如果最后一轮不包含 final_answer，手动追加兜底回答
  if (record.finalAnswer) {
    const lastMsg = messages[messages.length - 1];
    const lastContent = lastMsg?.content ?? "";
    if (
      lastMsg?.role !== "assistant" ||
      !lastContent.includes('"action":"final_answer"')
    ) {
      // 检查所有 assistant 消息，确认还没有 final_answer
      const prevAssistant = messages.filter((m) => m.role === "assistant");
      if (
        !prevAssistant.some((m) =>
          m.content.includes('"action":"final_answer"'),
        )
      ) {
        // 手动构造一个 ChatML 兼容的 final_answer 消息
        messages.push({
          role: "assistant",
          content: `{"action":"final_answer","summary":${JSON.stringify(record.finalAnswer)}}`,
        });
      }
    }
  }

  return { messages };
}

/**
 * 从评测结果中导出所有成功的运行记录作为 ChatML 对话。
 *
 * 过滤条件：
 * - 运行状态为 "completed"（非错误/超时/失败）
 * - 聚合报告的 overallScore >= passThreshold
 *
 * @param records 所有评测运行记录
 * @param reports 聚合报告（用于按分数过滤）
 * @param passThreshold 最低分数阈值（默认 70）
 */
export function exportSuccessfulRuns(
  records: readonly EvalRunRecord[],
  reports: readonly AggregateScoreReport[],
  passThreshold = 70,
): ChatMLConversation[] {
  // 构建通过用例 ID 集合（分数达到阈值的用例）
  const passedIds = new Set(
    reports.filter((r) => r.overallScore >= passThreshold).map((r) => r.testCaseId),
  );

  return records
    .filter((r) => r.status === "completed" && passedIds.has(r.testCaseId))
    .map(runToChatML);
}

/**
 * 将对话数组序列化为 JSONL 字符串。
 *
 * JSONL（JSON Lines）格式：每行一个 JSON 对象，以 \n 分隔。
 * 这是大多数 LLM 微调框架（如 LLaMA-Factory、Axolotl）的标准输入格式。
 */
export function toJsonl(conversations: readonly ChatMLConversation[]): string {
  return conversations
    .map((c) => JSON.stringify({ messages: c.messages }))
    .join("\n");
}
