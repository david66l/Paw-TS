import type {
  AbortRequestedFactV1,
  DerivedDecisionV1,
  InputFactV1,
  ModelDispatchRecordedFactV1,
  ModelSettledFactV1,
  RuntimeFailedFactV1,
  ToolCallObservedFactV1,
  ToolDispatchRecordedFactV1,
  ToolSettledFactV1,
} from "@paw/protocol";
import type {
  Context,
  ControlReducer,
  LoopInputPort,
  Model,
  Session,
  SessionInputSnapshot,
  StateHasher,
  ToolExecutor,
  VerifiedModelResponseEvidenceV1,
} from "./ports.js";

/** 端口异常在进入事实映射器前使用的最小、可序列化描述。 */
export interface LoopError {
  readonly name: string;
  readonly message: string;
}

/** Agent Loop 唯一理解的工具调用公共字段。 */
export interface LoopToolCall {
  readonly id: string;
  readonly name: string;
  /** 模型适配器已明确判定参数协议无效；Loop 本身不解析供应商参数。 */
  readonly argumentsValid?: boolean;
}

/** 模型回合的进程内结算；持久事件格式由组装层的事实映射器决定。 */
export type ModelSettlement<TAssistantMessage, TToolCall extends LoopToolCall> =
  | Readonly<{
      status: "success";
      message: TAssistantMessage;
      toolCalls: readonly TToolCall[];
    }>
  | Readonly<{
      status: "truncated";
      message: TAssistantMessage;
      /** 仅保留供应商返回的部分响应证据，截断调用绝不进入工具授权。 */
      toolCalls: readonly TToolCall[];
      reason: string;
      finishReason: string;
    }>
  | Readonly<{ status: "failed"; error: LoopError }>
  | Readonly<{ status: "cancelled"; reason: string }>
  | Readonly<{ status: "unknown"; reason: string }>;

/** 每个工具调用都必须得到其中一种进程内结算。 */
export type ToolSettlement<TToolResult> =
  | Readonly<{ status: "success"; callId: string; result: TToolResult }>
  | Readonly<{
      status: "failed";
      callId: string;
      error: LoopError;
      evidence?: TToolResult;
    }>
  | Readonly<{
      status: "denied";
      callId: string;
      reason: string;
      evidence?: TToolResult;
    }>
  | Readonly<{
      status: "cancelled";
      callId: string;
      reason: string;
      evidence?: TToolResult;
    }>
  | Readonly<{
      status: "unknown";
      callId: string;
      reason: string;
      evidence?: TToolResult;
    }>;

/** 只有 ControlReducer 可以产生这些运行控制决定。 */
export type ControlDecision =
  | Readonly<{ kind: "continue" }>
  | Readonly<{ kind: "await_user"; reason: string }>
  | Readonly<{ kind: "await_external"; reason: string }>
  | Readonly<{ kind: "completed"; reason: string }>
  | Readonly<{ kind: "incomplete"; reason: string }>
  | Readonly<{ kind: "failed"; reason: string }>
  | Readonly<{ kind: "aborted"; reason: string }>;

/** ControlReducer 的状态只需公开本次决定；其余字段由具体实现拥有。 */
export interface LoopControlState {
  readonly decision: ControlDecision;
}

/**
 * Context 的最小输入。
 *
 * Context 只能读取 canonical Session 快照。输入端口返回的 ID 不携带正文，
 * 且 Loop 会在调用 Context 前验证它们都已存在于该快照。
 */
export type LoopContextInput = SessionInputSnapshot<InputFactV1>;

/**
 * 把进程内动作映射到 @paw/protocol 的事实类型。
 *
 * 这里故意不定义第二套持久事件。调用方必须提供映射，未来可直接返回
 * `@paw/protocol` 的 InputFact / DerivedDecision。
 */
export interface AgentLoopFactMapper<
  TRunConfig,
  TModelRequest,
  TAssistantMessage,
  TToolCall extends LoopToolCall,
  TToolResult,
  TControlState extends LoopControlState,
> {
  modelRequestIntent(input: {
    readonly turn: number;
    readonly request: TModelRequest;
    readonly runConfig: TRunConfig;
  }): ModelDispatchRecordedFactV1;

  modelSettled(input: {
    readonly turn: number;
    readonly settlement: ModelSettlement<TAssistantMessage, TToolCall>;
  }): ModelSettledFactV1;

  toolCallObserved(input: {
    readonly turn: number;
    readonly sourceIndex: number;
    readonly call: TToolCall;
  }): ToolCallObservedFactV1;

  toolDispatchIntent(input: {
    readonly turn: number;
    readonly sourceIndex: number;
    readonly call: TToolCall;
  }): ToolDispatchRecordedFactV1;

  toolSettled(input: {
    readonly turn: number;
    readonly sourceIndex: number;
    readonly call: TToolCall;
    readonly settlement: ToolSettlement<TToolResult>;
  }): ToolSettledFactV1;

  runAbortObserved(input: { readonly reason: string }): AbortRequestedFactV1;

  runtimeFailed(input: {
    readonly area: RuntimeFailedFactV1["area"];
    readonly error: LoopError;
  }): RuntimeFailedFactV1;

  derivedDecision(input: {
    readonly state: TControlState;
    readonly inputThroughSeq: number;
    readonly stateHash: string;
    readonly reducerVersion: string;
  }): DerivedDecisionV1;
}

/** runAgentLoop 的全部依赖；不存在第二个完成判断回调。 */
export interface AgentLoopDependencies<
  TRunConfig,
  TModelRequest,
  TModelStreamEvent,
  TAssistantMessage,
  TToolCall extends LoopToolCall,
  TToolResult,
  TControlState extends LoopControlState,
> {
  readonly session: Session<InputFactV1, DerivedDecisionV1>;
  readonly context: Context<LoopContextInput, TModelRequest>;
  readonly model: Model<
    TModelRequest,
    TModelStreamEvent,
    ModelSettlement<TAssistantMessage, TToolCall>
  >;
  readonly tools: ToolExecutor<TToolCall, ToolSettlement<TToolResult>>;
  readonly input: LoopInputPort;
  readonly reducer: ControlReducer<InputFactV1, TRunConfig, TControlState>;
  readonly stateHasher: StateHasher<TControlState>;
  readonly reducerVersion: string;
  readonly facts: AgentLoopFactMapper<
    TRunConfig,
    TModelRequest,
    TAssistantMessage,
    TToolCall,
    TToolResult,
    TControlState
  >;
  readonly runConfig: TRunConfig;
  readonly onModelStreamEvent?: (
    event: TModelStreamEvent,
  ) => void | Promise<void>;
}

export interface AgentLoopOptions {
  readonly signal?: AbortSignal;
  /** Reloaded for every continuing startup snapshot, including a CAS retry. */
  readonly loadStartupModelResponseEvidence?: (
    snapshot: SessionInputSnapshot<InputFactV1>,
    signal: AbortSignal,
  ) =>
    | VerifiedModelResponseEvidenceV1
    | Promise<VerifiedModelResponseEvidenceV1>;
}
