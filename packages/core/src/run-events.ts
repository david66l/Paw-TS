/**
 * 运行生命周期事件类型定义模块
 * ============================================
 *
 * 【模块目的】
 * 定义 Paw.ts 一次完整运行（run）中所有可能发生的事件的类型体系。
 * 这是 TUI（终端 UI）、日志系统、和运行回放功能的标准化事件流（canonical stream）。
 *
 * 【架构定位】
 * 在事件驱动架构中，本模块是所有事件的"合同"。每个子系统（编排器、压缩器、
 * 记忆模块、模型调用层）通过发出这些事件来报告自己的状态变化。
 * 消费者（TUI、日志、指标收集器）只依赖这个联合类型，不需要知道生产者的实现。
 *
 * 事件覆盖了运行的全生命周期：
 *   1. 启停事件：run.started → [loop ticks] → run.completed / run.failed
 *   2. 阶段事件：phase（plan → model → tool → parse → waiting_children → merging_results）
 *   3. 模型调用事件：request → chunk/thinking → done → truncated → retry → circuit_breaker
 *   4. 工具调用事件：call → approval → result → result.chunk
 *   5. 上下文管理事件：context.budget → context.budget.trimmed
 *   6. 压缩事件：compression.prune / auto_compact / skipped
 *   7. 记忆事件：extracted / rejected / reflected / retrieve.done
 *   8. 成本和计划事件：cost.update / plan.updated
 *   9. 基础设施事件：mcp.connection_failed
 *  10. 指标事件：run.metrics（运行结束时的一次性汇总）
 *
 * 【关键设计决策】
 * 1. 使用判别联合类型（discriminated union）通过 `type` 字段区分事件种类，
 *    消费者可以用 switch/if 做穷举的模式匹配（TypeScript 的类型收窄）。
 * 2. 所有字段用 `readonly` —— 事件是不可变的值对象，发出后不应被修改。
 * 3. RunEventEnvelope 包裹了每条事件的元数据（runId、seq、ts），
 *    确保事件可以在异步和重放场景中正确排序。
 * 4. 事件设计遵循"保守添加"原则：只添加当前阶段确实需要的新字段。
 *
 * 【注意事项】
 * - 添加新事件时，在 RunEvent 联合类型末尾追加新的类型变体
 * - 不要修改已有事件的字段结构（除非确认所有消费者都能兼容）
 * - RunEventEnvelope.seq 是单调递增的（每个 run 从 1 开始），不应出现重复
 */

/**
 * Run lifecycle events — canonical stream for TUI / logs / replay (TS path).
 * Version conservatively; add fields as new phases land.
 */

import type { AgentAction } from "./actions.js";
import type { RunStatus } from "./run.js";
import type { ModelTokenUsage } from "./token-usage.js";

/**
 * 运行生命周期事件联合类型
 *
 * 用 `type` 字段做判别（discriminated union），消费者可按 type 做穷举的模式匹配。
 * 每个事件变体捕捉了运行中某个特定时刻的状态快照。
 */
export type RunEvent =
  /** 运行开始：携带目标描述（用户输入的第一个问题/任务） */
  | { readonly type: "run.started"; readonly goal: string }
  /** 循环心跳：每个 turn 的开始时发出，报告当前 turn 号和上下文 token 数 */
  | {
      readonly type: "loop.tick";
      /** 当前 turn 编号（从 1 开始） */
      readonly turn: number;
      /** 运行允许的最大步数（超过则中止） */
      readonly maxSteps: number;
      /** Estimated total tokens in the current context window. */
      readonly estimatedTokens: number;
    }
  /** 运行成功完成 */
  | {
      readonly type: "run.completed";
      /** 最终运行状态 */
      readonly status: RunStatus;
      /** 完成消息 */
      readonly message: string;
    }
  /** 运行失败 */
  | { readonly type: "run.failed"; readonly message: string }
  /**
   * 运行阶段切换
   *
   * plan：正在制定计划
   * model：正在调用 LLM
   * tool：正在执行工具
   * parse：正在解析模型输出
   * waiting_children：等待子代理返回结果（多代理/子任务场景）
   * merging_results：合并子代理结果
   */
  | {
      readonly type: "phase";
      readonly name:
        | "plan"
        | "model"
        | "tool"
        | "parse"
        | "waiting_children"
        | "merging_results";
    }
  /** 解析出结构化的代理动作（V2 §8.5），编排器据此决定下一步分支 */
  /** Parsed structured outcome (V2 §8.5) before orchestrator branches. */
  | { readonly type: "agent.action"; readonly action: AgentAction }
  /** 开始发送模型请求 */
  | {
      readonly type: "model.request";
      /** 请求标签（如 "think"、"act"），用于区分思考/行动模式 */
      readonly label: string;
      /** 发送的消息数量 */
      readonly messageCount: number;
    }
  /** 模型返回的文本块（流式或单次），累积了当前已收到的所有 assistant 文本 */
  /** Accumulated assistant text so far (streaming or single-shot). */
  | { readonly type: "model.chunk"; readonly text: string }
  /** 模型返回的思考/推理文本块（流式），累积了当前已收到的所有 thinking 文本 */
  /** Accumulated thinking/reasoning text so far (streaming). */
  | { readonly type: "model.thinking"; readonly text: string }
  /** 模型调用完成：携带完整文本、token 用量和可选的 thinking 文本 */
  | {
      readonly type: "model.done";
      /** 完整的模型输出文本（含所有 chunk 的拼接结果） */
      readonly text: string;
      /** token 用量统计 */
      readonly usage?: ModelTokenUsage;
      /** 完整的思考/推理文本 */
      readonly thinking?: string;
    }
  /** 编排器需要等待用户回复（向用户提问），例如请求权限确认或澄清问题 */
  /** Orchestrator will await {@link AgentOrchestratorOptions.resolveAskUser}. */
  | {
      readonly type: "user.reply.required";
      /** 向用户提问的内容 */
      readonly question: string;
      /** 等待超时秒数，null 表示无超时 */
      readonly timeoutSec: number | null;
    }
  /** 发起了工具调用 */
  | {
      readonly type: "tool.call";
      /** 工具名称 */
      readonly tool: string;
      /** 工具调用参数 */
      readonly args: unknown;
    }
  /** 工具执行完成（成功或失败） */
  | {
      readonly type: "tool.result";
      /** 工具名称 */
      readonly tool: string;
      /** 调用是否成功 */
      readonly ok: boolean;
      /** 结果摘要（用于日志和上下文，非完整结果） */
      readonly summary: string;
      /** 详细结果，可选 */
      readonly detail?: string;
    }
  /** 工具输出流式块（例如长时间运行的命令的 stdout/stderr） */
  | {
      readonly type: "tool.result.chunk";
      /** 工具名称 */
      readonly tool: string;
      /** 输出块文本 */
      readonly chunk: string;
      /** 是否为 stderr（错误输出流） */
      readonly isStderr: boolean;
    }
  /** 工具调用需要用户审批（审批模式开启时） */
  | {
      readonly type: "tool.approval.pending";
      /** 待审批的工具名称 */
      readonly tool: string;
      /** 待审批的工具参数 */
      readonly args: unknown;
    }
  /** 工具审批已决议 */
  | {
      readonly type: "tool.approval.resolved";
      /** 工具名称 */
      readonly tool: string;
      /** 是否批准执行 */
      readonly approved: boolean;
    }
  /** Token 成本更新：每次模型调用完成后发出，报告 token 消耗和费用估算 */
  /** Token-cost update after a model turn. */
  | {
      readonly type: "cost.update";
      /** 累计提示 token（输入） */
      readonly promptTokens: number;
      /** 累计完成 token（输出） */
      readonly completionTokens: number;
      /** 累计总 token */
      readonly totalTokens: number;
      /** 累计费用估计（美元） */
      readonly estimatedCostUsd: number;
      /** 费用货币类型：CNY（人民币）或 USD（美元），用于按用户偏好显示 */
      readonly costCurrency?: "CNY" | "USD";
      /** 仅最新一次模型调用的提示 token */
      /** Tokens billed for the latest model call only. */
      readonly turnPromptTokens?: number;
      /** 仅最新一次模型调用的完成 token */
      readonly turnCompletionTokens?: number;
      /** 从提供商前缀缓存命中的提示 token（不计费） */
      /** Prompt tokens served from the provider's prefix cache. */
      readonly cachedPromptTokens?: number;
    }
  /** 任务计划更新：TaskPlanner 应用了一个计划修改动作 */
  /** TaskPlanner applied a {@link AgentPlanUpdateAction} (TS orchestrator). */
  | {
      readonly type: "plan.updated";
      /** 计划修订版本号（单调递增） */
      readonly revision: number;
      /** 计划中的任务项数量 */
      readonly itemCount: number;
      /** 修改原因（如添加了新任务、标记某任务完成等） */
      readonly reason: string;
    }
  /** 第一层压缩：工具结果裁剪完成 */
  /** Layer 1: tool-result pruning completed. */
  | {
      readonly type: "compression.prune.done";
      /** 裁剪释放的 token 数 */
      readonly freedTokens: number;
      /** 裁剪后剩余的 token 数 */
      readonly remainingTokens: number;
    }
  /** 第二/三层压缩：自动压缩开始 */
  /** Layer 2/3: auto-compaction started. */
  | {
      readonly type: "compression.auto_compact.started";
      /** 压缩前的上下文 token 数 */
      readonly beforeTokens: number;
    }
  /** 第二/三层压缩：自动压缩完成 */
  /** Layer 2/3: auto-compaction completed. */
  | {
      readonly type: "compression.auto_compact.done";
      /** 压缩后的上下文 token 数 */
      readonly afterTokens: number;
      /** 新生成的摘要占用的 token 数 */
      readonly summaryTokens: number;
    }
  /** 压缩被跳过（如未达到阈值或处于防抖动期） */
  /** Compression skipped (e.g. threshold not met or anti-thrashing). */
  | {
      readonly type: "compression.skipped";
      /** 跳过的原因（如 "below_threshold"、"anti_thrashing"） */
      readonly reason: string;
    }
  /**
   * 上下文预算快照（按池划分：system / tools / history）
   *
   * 每个池都有独立的已用量和预算上限。
   * budget 事件让 TUI 可以渲染上下文消耗的进度条。
   */
  /** Per-pool context budget snapshot (system / tools / history). */
  | {
      readonly type: "context.budget";
      /** 总上下文窗口大小（token） */
      readonly contextWindow: number;
      /** 系统提示词已用 token */
      readonly systemUsed: number;
      /** 系统提示词预算上限 */
      readonly systemBudget: number;
      /** 工具定义已用 token */
      readonly toolsUsed: number;
      /** 工具定义预算上限 */
      readonly toolsBudget: number;
      /** 历史消息已用 token */
      readonly historyUsed: number;
      /** 历史消息预算上限 */
      readonly historyBudget: number;
      /** 历史消息池是否超出预算 */
      readonly historyOverBudget: boolean;
      /** 系统提示词池是否超出预算 */
      readonly systemOverBudget: boolean;
      /** 触发自动压缩的阈值（历史池使用率超过此比例触发） */
      readonly compactThreshold: number;
    }
  /** 系统提示词被裁剪以适配 token 预算（记录裁剪了哪些段） */
  /** System prompt was trimmed to fit the system token budget. */
  | {
      readonly type: "context.budget.trimmed";
      /** 被裁剪的段名列表 */
      readonly sections: readonly string[];
      /** 裁剪释放的 token 总数 */
      readonly freedTokens: number;
    }
  /** 记忆提取代理保存了新的记忆条目 */
  /** Memory extraction agent saved new entries. */
  | {
      readonly type: "memory.extracted";
      /** 新提取的条目数 */
      readonly entries: number;
      /** 被拒绝的条目数 */
      readonly rejected: number;
      /** 运行 ID */
      readonly runId: string;
    }
  /** 记忆条目被敏感信息扫描器拒绝 */
  /** Memory entry was rejected by the sensitive-info scanner. */
  | {
      readonly type: "memory.rejected";
      /** 被拒绝的条目内容 */
      readonly entry: string;
      /** 拒绝原因 */
      readonly reason: string;
      /** 运行 ID */
      readonly runId: string;
    }
  /** 记忆反思（B.2 阶段）完成——包含合并、归档、冲突处理 */
  /** Memory reflection (B.2) completed — merges, archives, conflicts. */
  | {
      readonly type: "memory.reflected";
      /** 修改的记忆条目数 */
      readonly modified: number;
      /** 合并的记忆条目数 */
      readonly merges: number;
      /** 归档的记忆条目数 */
      readonly archived: number;
      /** 冲突的记忆条目数 */
      readonly conflicts: number;
      /** 运行 ID */
      readonly runId: string;
    }
  /**
   * 记忆检索完成（在构建系统提示词之前）
   *
   * 报告了从记忆库中检索到的最相关记忆片段，
   * 以及检索过程中使用的技术手段（关键词/级联、embedding 缓存命中率等）
   */
  /** Memory retrieval completed before system prompt construction. */
  | {
      readonly type: "memory.retrieve.done";
      /** 检索查询文本 */
      readonly query: string;
      /** 粗筛候选总数 */
      readonly totalCandidates: number;
      /** 最终选中的记忆条数 */
      readonly selectedCount: number;
      /** 各条记忆的相关性得分 */
      readonly scores: readonly number[];
      /** 注入到系统提示词的记忆块总 token 数 */
      readonly injectedTokens: number;
      /** 检索模式：keyword（纯关键词）或 cascade（级联：关键词+embedding+LLM重排） */
      readonly retrievalMode?: "keyword" | "cascade";
      /** embedding 缓存命中次数 */
      readonly embeddingCacheHits?: number;
      /** embedding 缓存未命中次数 */
      readonly embeddingCacheMisses?: number;
      /** 是否使用了 LLM 回退（当 embedding 不可用时） */
      readonly usedLlmFallback?: boolean;
      /** 最终选中的记忆条目详情列表 */
      readonly selectedMemories: readonly {
        /** 记忆条目 ID */
        readonly id: string;
        /** 记忆标题 */
        readonly title: string;
        /** 记忆来源（如 "session"、"project"、"global"） */
        readonly source: string;
        /** 记忆摘要 */
        readonly summary: string;
        /** 关联的文件列表 */
        readonly relatedFiles: readonly string[];
      }[];
    }
  /** 模型输出被截断（finish_reason = "length" 或 "max_tokens"） */
  /** Model output was truncated (finish_reason = length/max_tokens). */
  | {
      readonly type: "model.truncated";
      /** API 返回的 finish_reason（"length" 表示 token 数达到 max_tokens 被截断） */
      readonly finishReason: string;
    }
  /** 编排器正在重试一次瞬时 LLM API 失败（指数退避） */
  /** Orchestrator is retrying a transient LLM API failure. */
  | {
      readonly type: "model.retry.waiting";
      /** 重试次数 */
      readonly attempt: number;
      /** 距下次重试的延迟毫秒数 */
      readonly delayMs: number;
      /** 错误描述 */
      readonly error: string;
      /** 错误类型（如 "rate_limit"、"server_error"） */
      readonly errorType?: string;
    }
  /** 熔断器打开（断路）：连续模型调用失败后，停止尝试以避免雪崩 */
  /** Circuit breaker opened after repeated model failures. */
  | {
      readonly type: "model.circuit_breaker.open";
      /** 熔断器标签（通常是模型名） */
      readonly label: string;
      /** 触发熔断的失败次数 */
      readonly failures: number;
    }
  /** 熔断器进入半开状态（试探性恢复）：允许少量请求通过以检测服务是否恢复 */
  /** Circuit breaker moved to half-open (probing). */
  | {
      readonly type: "model.circuit_breaker.half_open";
      /** 熔断器标签 */
      readonly label: string;
    }
  /** 熔断器关闭（恢复）：试探请求成功后，恢复正常调用 */
  /** Circuit breaker closed after a successful probe. */
  | {
      readonly type: "model.circuit_breaker.closed";
      /** 熔断器标签 */
      readonly label: string;
    }
  /** MCP 服务器连接失败：运行继续，但不使用该服务器提供的工具 */
  /** MCP server connection failed; run continues without it. */
  | {
      readonly type: "mcp.connection_failed";
      /** 失败的 MCP 服务器名称 */
      readonly server: string;
      /** 错误详情 */
      readonly error: string;
    }
  /**
   * 运行效率和质量的汇总指标（运行完成时一次性发出）
   *
   * 消费者（如 TUI 的状态栏、日志系统）可以用这些指标
   * 展示本次运行的效率（延迟、调用次数、成功率等）
   */
  /** Run efficiency and quality metrics emitted at completion. */
  | {
      readonly type: "run.metrics";
      /** 运行总耗时（毫秒） */
      readonly durationMs: number;
      /** 所有模型调用的累计延迟（毫秒） */
      readonly modelLatencyMs: number;
      /** 模型调用总次数 */
      readonly modelCalls: number;
      /** 工具调用总次数 */
      readonly toolCalls: number;
      /** 工具调用成功次数 */
      readonly toolSuccesses: number;
      /** 消耗的总 token 数 */
      readonly totalTokens: number;
      /** 总费用估算（美元） */
      readonly estimatedCost: number;
      /** 费用货币类型 */
      readonly costCurrency: "CNY" | "USD";
      /** 总步数（turn 数） */
      readonly steps: number;
      /** 模型输出被截断的次数 */
      readonly truncationCount: number;
    };

/**
 * 事件信封：包裹每条运行事件及其元数据
 *
 * 确保事件可以在异步、重放和跨进程场景中按正确的顺序处理。
 * seq 是单调递增的序列号（每个 run 从 1 开始），
 * ts 是 Unix 毫秒时间戳，runId 将事件绑定到特定的运行实例。
 */
export interface RunEventEnvelope {
  /** 运行实例 ID，将事件绑定到特定运行 */
  readonly runId: string;
  /** 序列号：在同一个 run 中单调递增，从 1 开始，用于确保事件顺序和去重 */
  /** Monotonic per run, starting at 1. */
  readonly seq: number;
  /** Unix 毫秒时间戳 */
  readonly ts: number;
  /** 包裹的事件负载 */
  readonly event: RunEvent;
}
