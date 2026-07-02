/**
 * 上下文截断 / 驱逐策略（Context Truncation & Eviction Policy）。
 *
 * 【模块职责】
 * 当对话历史超出消息数量、字符数或 token 预算上限时，决定保留哪些消息、驱逐哪些消息。
 * 这是上下文管理（context management）的核心算法模块，直接影响模型在长对话中的表现。
 *
 * 【为什么存在】
 * LLM 的上下文窗口有限（如 128K tokens），且 token 成本随对话长度线性增长。
 * 当对话历史超出预算时，必须智能地决定"丢掉什么"——随便删消息会丢失关键约束信息，
 * 导致模型行为异常。这个模块实现了优先级感知的驱逐策略，确保：
 * - 用户明确禁止的事项（constraint）最不容易被丢弃
 * - 最近的对话回合优先保留
 * - 工具调用结果比普通文本更值得保留
 *
 * 【关键设计决策】
 * - **两阶段截断**：先按消息数量粗筛，再按 token/字符预算精筛。这样避免在消息数
 *   已经超限时还逐条计算 token 成本。
 * - **优先级评分体系**：USER_CONSTRAINT (120) > TOOL_RESULT (95) > USER (80) >
 *   ASSISTANT_WITH_THINKING (60) > ASSISTANT (40)，数值越高越不容易被驱逐。
 * - **工具结果的年龄惩罚**：较旧的工具结果优先级会随时间递减（每个消息位 -2），
 *   但有最低保护值 45（仍高于普通 assistant 消息）。这平衡了"工具结果很重要"
 *   和"过时的工具结果可能不再相关"。
 * - **尾回合保护**：最近的 N 个对话回合（tailTurnCount）总是受保护，
 *   因为当前上下文对模型推理最重要。
 * - **最后的用户消息始终保护**：保证模型至少知道"用户最后问了什么"。
 * - **约束检测使用正则模式匹配**（中英文），能在不依赖 NLP 解析的情况下
 *   快速识别用户指令中的禁止/必须类约束。
 * - 所有函数都是纯函数（无副作用），输入 history 数组不会被修改。
 */

import type { ChatMessage } from "./manager.js";
import { isToolResultMessage } from "../tool-result/format.js";
import type { TokenEstimator } from "../token-estimator.js";

/** Token/字符预算截断的选项 */
export interface TruncateBudgetOptions {
  /** 预算上限（token 数或字符数） */
  readonly budget: number;
  /** true = 按 token 计费，false = 按字符数计费 */
  readonly useTokens: boolean;
  /** 尾部受保护的对话回合数 */
  readonly tailTurnCount: number;
  /** Token 估算器，用于将消息转为 token 数 */
  readonly estimator: TokenEstimator;
}

/** 完整的截断选项：包含消息数量限制和预算限制 */
export interface TruncateOptions {
  /** 最大消息数量 */
  readonly maxMessages: number;
  /** 预算截断选项 */
  readonly budgetOptions: TruncateBudgetOptions;
}

/**
 * 应用消息数量和预算双重截断。
 *
 * 处理流程：
 *   Phase 1: 按消息数量截断 —— 保留最近的 maxMessages 条消息（同时保护约束消息）
 *   Phase 2: 按 token/字符预算截断 —— 低优先级消息优先驱逐
 *
 * @param history  完整的对话历史
 * @param options  截断配置
 * @returns 截断后的对话历史（新数组，不修改原数组）
 */
export function truncateHistory(
  history: ChatMessage[],
  options: TruncateOptions,
): ChatMessage[] {
  // Phase 1: 按消息数量截断
  let next = history;
  if (next.length > options.maxMessages) {
    next = truncateByMessageCount(
      next,
      options.maxMessages,
      getProtectedConstraintIndices(next),  // 受保护的用户约束消息不会被截掉
    );
  }

  // Phase 2: 按 token/字符预算进行优先级感知的驱逐
  next = truncateByBudget(next, options.budgetOptions);
  return next;
}

/**
 * 按消息数量截断历史。
 *
 * 策略：从尾部开始保留，直到达到 maxMessages 条。
 * 如果存在受保护的消息索引，则优先保留它们（可能挤占其他消息的位置）。
 *
 * @param protectedIndices  受保护的消息索引（用户约束、最新消息等）
 */
function truncateByMessageCount(
  history: ChatMessage[],
  maxMessages: number,
  protectedIndices: readonly number[],
): ChatMessage[] {
  // 无保护索引时，直接取最后 maxMessages 条
  if (protectedIndices.length === 0) {
    return history.slice(-maxMessages);
  }

  // 有保护索引时，优先保留受保护的消息，再从尾部向前补充到 maxMessages 条
  const keep = new Set<number>(protectedIndices);
  for (
    let i = history.length - 1;
    i >= 0 && keep.size < maxMessages;
    i--
  ) {
    keep.add(i);
  }
  return history.filter((_, i) => keep.has(i));
}

/**
 * 按 token/字符预算进行优先级感知的驱逐。
 *
 * 核心算法：
 * 1. 计算当前总成本
 * 2. 确定受保护级别（从 tailTurnCount → 0 逐级降级）
 * 3. 对可驱逐消息按优先级评分排序，低分优先驱逐
 * 4. 如果仍超预算，降级保护进一步驱逐
 */
function truncateByBudget(
  history: ChatMessage[],
  opts: TruncateBudgetOptions,
): ChatMessage[] {
  // 消息成本计算函数：按 token 或按字符
  const msgCost = (m: ChatMessage): number =>
    opts.useTokens
      ? opts.estimator.countMessages([m])
      : m.content.length + (m.thinking?.length ?? 0);

  // 计算当前总成本
  let current = 0;
  for (const m of history) {
    current += msgCost(m);
  }
  if (current <= opts.budget) return history;

  // 寻找合适的保护级别：从 3 → 2 → 1 → 0 逐级降级
  // 保护级别 = 保留最近 N 个对话回合
  let protectedIndices: number[] = [];
  for (let turns = opts.tailTurnCount; turns >= 0; turns--) {
    protectedIndices = getProtectedIndices(history, turns);
    const protectedCost = protectedIndices.reduce((sum, i) => {
      const msg = history[i];
      return msg ? sum + msgCost(msg) : sum;
    }, 0);
    const lastMsg = history[history.length - 1];
    const lastMsgCost = lastMsg ? msgCost(lastMsg) : 0;
    // 受保护消息 + 最后一条消息不超预算，则接受此保护级别
    if (protectedCost + lastMsgCost <= opts.budget) {
      break;
    }
  }

  const protectedSet = new Set(protectedIndices);
  protectedSet.add(history.length - 1); // 最后一条消息始终受保护

  // 对可驱逐消息（排除受保护的和最后一条）按优先级评分
  const scored: Array<{ idx: number; cost: number; score: number }> = [];
  for (let i = 0; i < history.length - 1; i++) {
    if (protectedSet.has(i)) continue;
    const msg = history[i];
    if (!msg) continue;
    scored.push({
      idx: i,
      cost: msgCost(msg),
      score: messagePriorityScore(msg, i, history.length),
    });
  }

  // 驱逐优先级最低的消息优先；同分则成本高的优先（一次驱逐省更多）
  scored.sort((a, b) => a.score - b.score || b.cost - a.cost);

  const evictSet = new Set<number>();
  for (const s of scored) {
    if (current <= opts.budget) break;
    evictSet.add(s.idx);
    current -= s.cost;
  }

  // 如果仍超预算，进一步降级保护（移除初始目标等受保护消息中优先级较低的）
  if (current > opts.budget) {
    const degradable = protectedIndices
      .filter((i) => i < history.length - 1 && !evictSet.has(i))
      .flatMap((i) => {
        const msg = history[i];
        if (!msg) return [];
        return [
          {
            idx: i,
            cost: msgCost(msg),
            score: messagePriorityScore(msg, i, history.length),
          },
        ];
      })
      .sort((a, b) => a.score - b.score || b.cost - a.cost);

    for (const d of degradable) {
      if (current <= opts.budget) break;
      evictSet.add(d.idx);
      current -= d.cost;
    }
  }

  if (evictSet.size === 0) return history;
  return history.filter((_, i) => !evictSet.has(i));
}

/**
 * 获取受保护的消息索引列表。
 *
 * 保护策略包含三个维度：
 * 1. **头部**：第一条非工具结果的用户消息（用户的初始目标）—— 保证模型知道任务是什么
 * 2. **约束**：包含"不要"/"禁止"/"必须"等关键词的用户消息 —— 保证行为限制不被遗忘
 * 3. **尾部**：最近 N 个对话回合（以 assistant 消息为回合边界）—— 保证当前上下文完整
 */
function getProtectedIndices(
  history: ChatMessage[],
  tailTurnCount: number,
): number[] {
  const result: number[] = [];

  // Head: 找到第一条非工具结果的用户消息（用户初始目标）
  for (let i = 0; i < history.length; i++) {
    const msg = history[i];
    if (!msg) continue;
    if (msg.role === "user" && !isToolResultMessage(msg.content)) {
      result.push(i);
      break;
    }
  }

  // 添加所有包含用户约束的消息索引
  for (const i of getProtectedConstraintIndices(history)) {
    result.push(i);
  }

  // Tail: 保留最近 N 个对话回合（一个回合以 assistant 消息为边界）
  if (tailTurnCount > 0) {
    let turnsFound = 0;
    let tailStart = history.length;

    for (let i = history.length - 1; i >= 0; i--) {
      if (history[i]?.role === "assistant") {
        turnsFound++;
        tailStart = i;
        if (turnsFound >= tailTurnCount) {
          break;
        }
      }
    }

    for (let i = tailStart; i < history.length; i++) {
      result.push(i);
    }
  }

  return [...new Set(result)].sort((a, b) => a - b);
}

/**
 * 获取包含用户约束（禁止/必须类指令）的消息索引。
 *
 * 约束消息在整个对话中具有最高保护优先级，因为如果模型
 * "忘记"了用户明确禁止的事项，后果可能很严重。
 */
function getProtectedConstraintIndices(history: ChatMessage[]): number[] {
  const result: number[] = [];
  for (let i = 0; i < history.length; i++) {
    const msg = history[i];
    if (msg && isProtectedUserConstraint(msg)) {
      result.push(i);
    }
  }
  return result;
}

/**
 * 消息优先级评分常量。
 *
 * 评分越高，越不容易被驱逐。评分体系：
 * - USER_CONSTRAINT (120)：用户明确约束（最高保护，因为遗忘后果严重）
 * - TOOL_RESULT (95)：工具调用结果（模型决策的关键依据）
 * - SYSTEM (90)：系统级消息（罕见但重要）
 * - USER (80)：普通用户消息
 * - ASSISTANT_WITH_THINKING (60)：包含推理过程的助手消息
 * - ASSISTANT (40)：普通助手消息（最低保护，最容易被驱逐）
 */
const MSG_PRIORITY = {
  /** 显式用户约束（如"不要修改..."）。应存活最久。 */
  USER_CONSTRAINT: 120,
  /** 工具结果：模型需要据此行动的具体观察。 */
  TOOL_RESULT: 95,
  /** 普通用户消息。 */
  USER: 80,
  /** 包含推理/思考内容的助手消息。 */
  ASSISTANT_WITH_THINKING: 60,
  /** 普通助手消息。 */
  ASSISTANT: 40,
  /** 系统级消息（在 ChatMessage 历史中罕见）。 */
  SYSTEM: 90,
} as const;

/** 工具结果消息的年龄惩罚值：每个消息位的年龄扣 2 分 */
const TOOL_RESULT_AGE_PENALTY = 2;

/** 工具结果老化后的优先级底线（45），确保旧工具结果仍高于普通助手消息 */
const TOOL_RESULT_AGE_FLOOR = 45;

/**
 * 计算单条消息的优先级评分。
 *
 * 评分越高 = 越不容易被驱逐。
 *
 * @param msg    消息对象
 * @param index  消息在历史中的索引（用于计算年龄）
 * @param total  历史总长度（用于计算年龄）
 * @returns 优先级评分
 */
function messagePriorityScore(
  msg: ChatMessage,
  index?: number,
  total?: number,
): number {
  // 用户约束消息获得最高优先级
  if (isProtectedUserConstraint(msg)) {
    return MSG_PRIORITY.USER_CONSTRAINT;
  }
  // 工具结果消息：基础分 95，但随时间衰减，最低到 45
  if (msg.role === "user" && isToolResultMessage(msg.content)) {
    const age =
      index !== undefined && total !== undefined ? total - 1 - index : 0;
    return Math.max(
      TOOL_RESULT_AGE_FLOOR,
      MSG_PRIORITY.TOOL_RESULT - age * TOOL_RESULT_AGE_PENALTY,
    );
  }
  if (msg.role === "user") {
    return MSG_PRIORITY.USER;
  }
  if (msg.role === "assistant" && msg.thinking) {
    return MSG_PRIORITY.ASSISTANT_WITH_THINKING;
  }
  if (msg.role === "assistant") {
    return MSG_PRIORITY.ASSISTANT;
  }
  return MSG_PRIORITY.SYSTEM;
}

/**
 * 用户约束检测的匹配模式。
 *
 * 中文模式：不要、不能、禁止、只能、必须、不要动、不要修改、
 *   不要删除、不要联网、不要访问、不要执行、只修改、当前目录、工作区外
 *
 * 英文模式：do not、must not、only、never、forbid/forbidden
 *
 * 这些模式涵盖了常见的用户行为约束表达方式。
 */
const USER_CONSTRAINT_PATTERNS = [
  /不要/,
  /不能/,
  /禁止/,
  /只能/,
  /必须/,
  /不要动/,
  /不要修改/,
  /不要删除/,
  /不要联网/,
  /不要访问/,
  /不要执行/,
  /只修改/,
  /当前目录/,
  /工作区外/,
  /\bdo not\b/i,
  /\bmust not\b/i,
  /\bonly\b/i,
  /\bnever\b/i,
  /\bforbid(?:den)?\b/i,
];

/**
 * 判断一条消息是否包含受保护的用户约束。
 *
 * 只有 role==="user" 且非工具结果的消息才会被检测。
 * 工具结果消息虽然 role 也可能是 "user"（取决于序列化方式），
 * 但它们的内容是工具输出而非用户约束，应被排除。
 */
export function isProtectedUserConstraint(msg: ChatMessage): boolean {
  if (msg.role !== "user" || isToolResultMessage(msg.content)) {
    return false;
  }
  return USER_CONSTRAINT_PATTERNS.some((p) => p.test(msg.content));
}
