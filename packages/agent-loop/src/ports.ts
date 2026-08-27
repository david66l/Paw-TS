/**
 * Paw Next 内循环的最小端口。
 *
 * 这里故意不定义持久事件的字段。`TInputFact` 和 `TDerivedDecision` 是
 * `@paw/protocol` 后续稳定协议的插槽；在协议迁入前，由组装层传入现有类型。
 * 两个泛型互相独立，避免派生决定被误当作归约器输入。
 */

/** 一次可取消的端口调用所需的共同参数。 */
export interface PortCallOptions {
  readonly signal: AbortSignal;
}

/** 模型流事件的接收函数。流事件只用于实时展示，不代表已经持久结算。 */
export type ModelStreamSink<TModelStreamEvent> = (
  event: TModelStreamEvent,
) => void | Promise<void>;

/** 启动一次模型回合所需的参数。 */
export interface ModelCallOptions<TModelStreamEvent> extends PortCallOptions {
  readonly onStreamEvent: ModelStreamSink<TModelStreamEvent>;
}

/**
 * 模型端口。
 *
 * 实现负责适配具体供应商，并把成功、失败、取消和结果未知转换为
 * `TModelSettlement`。流事件不能替代最终结算。
 */
export interface Model<TModelRequest, TModelStreamEvent, TModelSettlement> {
  execute(
    request: TModelRequest,
    options: ModelCallOptions<TModelStreamEvent>,
  ): Promise<TModelSettlement>;
}

/** 一条带 canonical journal 顺序号的输入事实。 */
export interface SequencedInputFact<TInputFact> {
  readonly seq: number;
  readonly fact: TInputFact;
}

/** 同一次读取获得的输入事实、journal 尾部和最新输入事实游标。 */
export interface SessionInputSnapshot<TInputFact> {
  readonly entries: readonly SequencedInputFact<TInputFact>[];
  readonly tailSeq: number;
  readonly latestInputSeq: number;
}

/**
 * Provider-neutral, invocation-scoped proof for durable model responses.
 *
 * Implementations must bind one exact canonical snapshot. Agent Loop still
 * derives lifecycle, turn and safe-boundary state from canonical facts; this
 * port only supplies the already-verified response DTO for one exact carrier.
 */
export interface VerifiedModelResponseEvidenceV1 {
  assertSnapshot(snapshot: SessionInputSnapshot<InputFactV1>): void;
  requireModelResponse(input: {
    readonly snapshot: SessionInputSnapshot<InputFactV1>;
    readonly carrierSeq: number;
    readonly modelCallId: string;
    readonly payload: DurableJsonPayloadV1;
  }): ModelResponseV1;
}

/**
 * 会话事实端口。
 *
 * Session 是已经发生事实的读写边界。它不负责接纳用户输入、FIFO 排队、
 * 唤醒合并或同会话执行锁；这些职责属于未来的 Runtime 协调层。
 */
export interface Session<TInputFact, TDerivedDecision> {
  readInputSnapshot(): Promise<SessionInputSnapshot<TInputFact>>;
  /** 一个批次必须全部追加或全部失败。 */
  appendInputFacts(facts: readonly TInputFact[]): Promise<void>;
  /** 仅当 journal 尾部未改变时原子追加一个输入事实批次。 */
  commitInputFacts(
    expectedTailSeq: number,
    facts: readonly TInputFact[],
  ): Promise<"committed" | "conflict">;
  /**
   * 只有 journal 尾部仍等于 expectedTailSeq 时才能提交。若当前尾部已经是
   * 完全相同的决定，实现必须幂等返回 committed；若尾部决定不同则失败关闭，
   * 绝不能追加连续 DerivedDecision。
   */
  commitDerivedDecision(
    expectedTailSeq: number,
    decision: TDerivedDecision,
  ): Promise<"committed" | "conflict">;
  /**
   * 原子提交 continue 决定及其授权的输入事实。CAS 冲突或追加失败时两者都
   * 不可见，防止在决定与副作用派发意图之间插入新输入。
   */
  commitDecisionAndInputFacts(
    expectedTailSeq: number,
    decision: TDerivedDecision,
    facts: readonly TInputFact[],
  ): Promise<"committed" | "conflict">;
}

/**
 * 上下文构建端口。
 *
 * Agent Loop 只提供同一次读取获得的 canonical、只读 Session snapshot；
 * chronological 对话投影、原生工具参数交叉校验和模型请求序列化属于
 * runtime/context 实现。Context 不拥有 Session 写端口，工具结果必须作为不可信
 * 结果证据处理，权限、控制和运行审计不能伪装成对话正文。
 * 压缩、提示缓存和 token 预算同样属于实现，不进入 Agent Loop。
 */
export interface Context<TContextInput, TModelRequest> {
  build(input: TContextInput, options: PortCallOptions): Promise<TModelRequest>;
}

/** 工具批次执行所需的共同参数。turn 用于绑定权限与结算事实。 */
export interface ToolBatchOptions extends PortCallOptions {
  readonly turn: number;
}

/**
 * 工具执行端口。
 *
 * 实现必须给每个调用返回一个结算结果；即使批次内部发生故障，也应把无法
 * 证明结果的调用结算为 unknown。返回顺序必须与模型给出的调用顺序一致。
 */
export interface ToolExecutor<TToolCall, TToolSettlement> {
  executeSettled(
    callsInModelOrder: readonly TToolCall[],
    options: ToolBatchOptions,
  ): Promise<readonly TToolSettlement[]>;
}

/** 策略观察一次新增事实时所需的参数。 */
export interface PolicyCallOptions<TRunConfig> extends PortCallOptions {
  readonly runConfig: TRunConfig;
}

/**
 * 外层循环策略端口。
 *
 * 策略可以根据新增事实提出请求事实，但不能直接产生终局，也不能绕过
 * ControlReducer 修改运行状态。返回值仍使用同一个 `TInputFact` 协议类型。
 */
export interface LoopPolicy<TInputFact, TRunConfig> {
  observe(
    newFacts: readonly TInputFact[],
    options: PolicyCallOptions<TRunConfig>,
  ): Promise<readonly TInputFact[]>;
}

/**
 * 唯一运行控制归约器。
 *
 * `reduce` 必须是纯函数：相同的输入事实和冻结配置产生相同状态，不读取
 * 时间、数据库或进程全局变量。派生决定由调用方写入 Session，但永远不会
 * 作为这里的输入。
 */
export interface ControlReducer<TInputFact, TRunConfig, TControlState> {
  reduce(
    inputFacts: readonly TInputFact[],
    runConfig: TRunConfig,
  ): TControlState;
}

/**
 * 为归约器的完整 canonical 状态生成稳定摘要。
 *
 * 实现必须覆盖会影响控制决定的全部状态字段；相同状态必须跨进程、跨重放
 * 得到相同非空字符串。具体序列化与摘要算法由组装层冻结，Agent Loop 不依赖
 * Node.js crypto，也不偷偷维护第二份状态格式。
 */
export interface StateHasher<TControlState> {
  hash(state: TControlState): string;
}

/**
 * Agent Loop 可以报告的安全边界。
 *
 * 这些值是进程内协作信号，不是持久 wire schema。Loop 只能在没有半条
 * 模型或工具事务时报告它们。
 */
export type LoopSafeBoundary =
  | "before_first_model_request"
  | "after_model_turn_without_tool_calls"
  | "after_tool_batch_settled";

/** 只向 Runtime 报告安全边界，不拥有输入提升权。 */
export interface SafeBoundaryReporter {
  reportSafeBoundary(boundary: LoopSafeBoundary): Promise<void>;
}

/** 只读取 Runtime 已持久化并提升的稳定 inputId，不返回正文。 */
export interface PromotedInputSource {
  consumePromotedInputIds(): Promise<readonly string[]>;
}

/** Agent Loop 与输入协调层之间唯一需要的窄端口。 */
export type LoopInputPort = SafeBoundaryReporter & PromotedInputSource;
import type {
  DurableJsonPayloadV1,
  InputFactV1,
  ModelResponseV1,
} from "@paw/protocol";
