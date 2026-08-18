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

import type { TokenEstimator } from "../token-estimator.js";
import { isToolResultMessage } from "../tool-result/format.js";
import type { ChatMessage } from "./manager.js";

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
      getProtectedConstraintIndices(next), // 受保护的用户约束消息不会被截掉
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
  for (let i = history.length - 1; i >= 0 && keep.size < maxMessages; i--) {
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
      : m.content.length +
        (m.thinking?.length ?? 0) +
        (m.nativeToolTurn?.reasoningPassback?.length ?? 0);

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

  // P4.2 生命周期驱逐：段状态（active/completed/evictable）+ 残差效用门控。
  // completed ≠ 可删：文件路径仍被最近 tool call 引用 → 保留（残差效用）。
  const segments = computeSegments(history, {
    tailTurnCount: opts.tailTurnCount,
  });
  const residualPaths = extractRecentToolCallPaths(history);
  const stateFor = (i: number): SegmentState =>
    segments.find((s) => i >= s.start && i <= s.end)?.state ?? "active";
  const residualHitFor = (i: number): boolean => {
    const c = history[i]?.content ?? "";
    for (const p of residualPaths) {
      if (p.length > 0 && c.includes(p)) return true;
    }
    return false;
  };

  // 对可驱逐消息（排除受保护的和最后一条）按优先级评分
  const scored: Array<{ idx: number; cost: number; score: number }> = [];
  for (let i = 0; i < history.length - 1; i++) {
    if (protectedSet.has(i)) continue;
    const msg = history[i];
    if (!msg) continue;
    scored.push({
      idx: i,
      cost: msgCost(msg),
      score: messagePriorityScore(msg, i, history.length, {
        lifecycle: stateFor(i),
        residualHit: residualHitFor(i),
      }),
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
            score: messagePriorityScore(msg, i, history.length, {
              lifecycle: stateFor(i),
              residualHit: residualHitFor(i),
            }),
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
 * @param lifecycleOpts  P4.2 生命周期修正：completed −10、evictable −25；
 *                       残差效用命中（文件仍被最近 tool call 引用）+25
 * @returns 优先级评分
 */
function messagePriorityScore(
  msg: ChatMessage,
  index?: number,
  total?: number,
  lifecycleOpts?: {
    readonly lifecycle: SegmentState;
    readonly residualHit: boolean;
  },
): number {
  // 用户约束消息获得最高优先级
  if (isProtectedUserConstraint(msg)) {
    return MSG_PRIORITY.USER_CONSTRAINT;
  }
  // 工具结果消息：基础分 95，但随时间衰减，最低到 45
  if (msg.role === "user" && isToolResultMessage(msg.content)) {
    const age =
      index !== undefined && total !== undefined ? total - 1 - index : 0;
    let score = Math.max(
      TOOL_RESULT_AGE_FLOOR,
      MSG_PRIORITY.TOOL_RESULT - age * TOOL_RESULT_AGE_PENALTY,
    );
    return applyLifecycle(score, lifecycleOpts);
  }
  if (msg.role === "user") {
    return applyLifecycle(MSG_PRIORITY.USER, lifecycleOpts);
  }
  if (msg.role === "assistant" && msg.thinking) {
    return applyLifecycle(MSG_PRIORITY.ASSISTANT_WITH_THINKING, lifecycleOpts);
  }
  if (msg.role === "assistant") {
    return applyLifecycle(MSG_PRIORITY.ASSISTANT, lifecycleOpts);
  }
  return MSG_PRIORITY.SYSTEM;
}

/**
 * P4.2 生命周期 + 残差效用修正：completed ≠ 可删。
 * 残差效用命中（文件仍被最近 tool call 引用）→ 完全取消生命周期扣分
 * （效用门控优先于段状态，与 TokenPilot 的 completed≠可删 语义一致）。
 */
function applyLifecycle(
  base: number,
  opts?: { readonly lifecycle: SegmentState; readonly residualHit: boolean },
): number {
  if (!opts) return base;
  if (opts.residualHit) return base;
  if (opts.lifecycle === "evictable") return base - LIFECYCLE_EVICTABLE_PENALTY;
  if (opts.lifecycle === "completed") return base - LIFECYCLE_COMPLETED_PENALTY;
  return base;
}

/** evictable 段消息的优先级扣分（低于普通 assistant，优先被驱逐） */
const LIFECYCLE_EVICTABLE_PENALTY = 25;
/** completed 段消息的优先级扣分（有完成证据，稍低但仍高于 evictable） */
const LIFECYCLE_COMPLETED_PENALTY = 10;

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
 *
 * 系统注入的 user 消息（context package / 摘要 / nudge / 警告等，
 * 以 [ 前缀开头）同样排除——它们的内容来自系统而非用户，
 * 若被误判为约束，压缩门控会要求摘要逐字包含系统注入文本导致永远拒绝。
 */
const SYSTEM_INJECTED_PREFIXES = [
  "[Context Package]",
  "[Context Summary]",
  "[Previous session context]",
  "[You stopped",
  "[Max steps",
  "[MAX_STEPS",
  "[model produced only reasoning]",
  "[Task]",
];

export function isProtectedUserConstraint(msg: ChatMessage): boolean {
  if (msg.role !== "user" || isToolResultMessage(msg.content)) {
    return false;
  }
  if (SYSTEM_INJECTED_PREFIXES.some((p) => msg.content.startsWith(p))) {
    return false;
  }
  return USER_CONSTRAINT_PATTERNS.some((p) => p.test(msg.content));
}

// ═════════════════════════════════════════════════════════════
// P4.2 生命周期驱逐（TokenPilot active/completed/evictable 状态机）
// ═════════════════════════════════════════════════════════════

/**
 * 上下文段生命周期状态：
 * - active：最近回合 + 首条目标（当前工作上下文，不可驱逐）
 * - completed：已完成子任务段（有完成证据），可驱逐但需残差效用门控
 * - evictable：无完成证据的陈旧段 / 已转向新任务后的旧段
 */
export type SegmentState = "active" | "completed" | "evictable";

/** 完成证据信号：段内出现任务完成类内容 → completed */
const COMPLETION_EVIDENCE =
  /final_answer|final answer|all tests? (?:pass|passed)|测试(?:全部|都)?通过|✅ done|completed|sub-?agent.*(?:completed|done|返回)/i;

/** 新任务转向信号：段首为新任务指令 → 其前已完成段升格 evictable */
const TASK_PIVOT =
  /^(?:new task|next task|now (?:do|work on|handle|fix)|新任务|接下来(?:做|处理|修复)|下一步(?:做|处理|修复))/i;

export interface SegmentInfo {
  /** 段起始消息索引（含） */
  readonly start: number;
  /** 段结束消息索引（含） */
  readonly end: number;
  readonly state: SegmentState;
}
/**
 * 按 assistant 回合边界切分消息为段，并标注生命周期状态。
 *
 * 规则：
 * 1. 首条非工具结果 user 消息（初始目标）单独一段 → active
 * 2. 尾部最近 tailTurnCount 个回合 → active
 * 3. 中间段：含完成证据 → completed；否则 evictable
 * 4. 新任务转向段（TASK_PIVOT）之后，其前面的 completed 段升格 evictable
 *    （会话已转向，残差效用门控另行保护仍被引用的文件）
 */
export function computeSegments(
  messages: readonly ChatMessage[],
  opts?: { readonly tailTurnCount?: number },
): SegmentInfo[] {
  const tail = opts?.tailTurnCount ?? 3;
  if (messages.length === 0) return [];

  // 回合边界：assistant 消息
  const turnStarts: number[] = [];
  for (let i = 0; i < messages.length; i++) {
    if (messages[i]?.role === "assistant") turnStarts.push(i);
  }

  // 段 = [turnStart .. 下一个 turnStart-1]
  const segments: SegmentInfo[] = [];
  const firstUserIdx = messages.findIndex(
    (m) => m.role === "user" && !isToolResultMessage(m.content),
  );

  // 首条目标段（到第一个 assistant 之前）
  const goalEnd =
    turnStarts.length > 0
      ? Math.min(firstUserIdx >= 0 ? firstUserIdx : 0, turnStarts[0]!)
      : messages.length - 1;
  segments.push({ start: 0, end: goalEnd, state: "active" });

  for (let t = 0; t < turnStarts.length; t++) {
    const start = turnStarts[t]!;
    const end =
      t + 1 < turnStarts.length ? turnStarts[t + 1]! - 1 : messages.length - 1;
    // 尾部最近 tail 个回合 → active
    const isTail = t >= turnStarts.length - tail;
    segments.push({ start, end, state: isTail ? "active" : "evictable" });
  }

  // 完成证据 → completed；TASK_PIVOT 之后的旧 completed → evictable
  let pivoted = false;
  const finalized: SegmentInfo[] = segments.map((seg) => {
    if (seg.state !== "evictable") return seg;
    const hasEvidence = (() => {
      for (let i = seg.start; i <= seg.end; i++) {
        const c = messages[i]?.content ?? "";
        if (COMPLETION_EVIDENCE.test(c)) return true;
      }
      return false;
    })();
    let state: SegmentState = hasEvidence ? "completed" : "evictable";
    // 段首是 TASK_PIVOT → 前面的 completed 段全部升格 evictable
    const segHead = messages[seg.start]?.content ?? "";
    if (TASK_PIVOT.test(segHead.trim())) pivoted = true;
    if (pivoted && state === "completed") state = "evictable";
    return { ...seg, state };
  });
  return finalized;
}

/** 工具结果消息中的路径引用模式（残差效用门控用） */
const PATH_REF_PATTERN = /"(?:path|file|file_path)"\s*:\s*"([^"]+)"/g;

/**
 * 残差效用门控：从最近 window 条 assistant 消息（工具调用）中提取被引用的
 * 文件路径。completed ≠ 可删——仍被最近 tool call 引用的文件所在消息保留。
 */
export function extractRecentToolCallPaths(
  messages: readonly ChatMessage[],
  window = 6,
): Set<string> {
  const paths = new Set<string>();
  let scanned = 0;
  for (let i = messages.length - 1; i >= 0 && scanned < window; i--) {
    const msg = messages[i];
    if (!msg || msg.role !== "assistant") continue;
    scanned++;
    let m: RegExpExecArray | null;
    PATH_REF_PATTERN.lastIndex = 0;
    while ((m = PATH_REF_PATTERN.exec(msg.content)) !== null) {
      const p = m[1]!.replace(/^\/+/, "").trim();
      if (p && !p.includes("\\") && p.length < 300) paths.add(p);
    }
  }
  return paths;
}
