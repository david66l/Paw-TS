/**
 * Paw.ts 统一错误处理模块
 * ============================================
 *
 * 【模块目的】
 * 定义 Paw.ts 框架中所有可抛出的错误类型、错误码枚举和错误构造工具函数。
 * 提供从框架级错误（PawError）到工具调用级错误（ToolErrorPayload）的完整分类体系。
 *
 * 【架构定位】
 * 本模块是 Paw.ts 的错误模型中枢（v2 规范 §14 的最小化 TS 实现）：
 * - PawError：框架内部错误，区分配置/校验/工作区/策略/模型/内部六类场景
 * - ToolErrorPayload：返回到 LLM 的工具执行错误，遵循工具调用的 error 协议
 *
 * 错误码分为两个维度：
 * - PawErrorCode：按照错误的"来源"分类（哪一层出了什么问题）
 * - ToolErrorCode：按照错误的"可恢复性"分类（能否重试、致命还是可忽略）
 *
 * 【关键设计决策】
 * 1. 错误码用字符串联合类型而非数字枚举——在日志和调试中直接看到有意义的名称。
 * 2. ToolErrorPayload 的 error_code 用 E_ 前缀的语义码（E_SCHEMA_INVALID 等），
 *    而不是 HTTP 状态码——因为工具错误上下文下 HTTP 码没有意义。
 * 3. PawError 携带 causeDetail（unknown 类型）作为原始错误引用，
 *    避免丢失调用链，同时不强制要求调用方提供类型化的原始错误。
 * 4. makeToolError 用 Omit 排除 error_code/error/message 三个必填字段，
 *    调用方只需传入额外的上下文字段即可，API 更干净。
 */

 /** Cross-cutting error envelope (v2 §14 taxonomy — minimal subset for TS bootstrap). */

/**
 * 框架级错误码：按错误的来源层分类
 *
 * - CONFIG：配置错误（文件格式错误、缺少必需字段等）
 * - VALIDATION：输入校验失败（参数类型不对、范围越界等）
 * - WORKSPACE：工作区相关错误（目录不存在、权限不足等）
 * - POLICY：策略拒绝（工具调用被安全策略拦截等）
 * - MODEL：模型调用失败（API 错误、超时、限流等）
 * - INTERNAL：框架内部错误（不可预期的 bug 或断言失败）
 */
export type PawErrorCode =
  | "CONFIG"
  | "VALIDATION"
  | "WORKSPACE"
  | "POLICY"
  | "MODEL"
  | "INTERNAL";

/**
 * 工具级错误码：按错误的可恢复性分类
 *
 * - E_SCHEMA_INVALID：工具参数 schema 校验不通过（传入参数不符合工具定义）
 * - E_RETRY：可重试的临时错误（网络抖动、暂时不可用等）
 * - E_USER：用户侧错误（不可重试，需用户修正输入）
 * - E_FATAL：致命系统错误（不可重试，需人工干预）
 * - E_POLICY_DENIED：安全策略拒绝执行（如尝试执行被禁止的操作）
 *
 * 命名空间 E_ 前缀用于区分工具错误码和框架级错误码，
 * 因为工具错误是在 LLM ↔ tool 之间传递的，有自己的语义约定。
 */
export type ToolErrorCode =
  | "E_SCHEMA_INVALID"
  | "E_RETRY"
  | "E_USER"
  | "E_FATAL"
  | "E_POLICY_DENIED";

/**
 * 返回给 LLM 的工具错误载荷
 *
 * 遵循工具调用 error 协议：模型收到此对象后可以根据 error_code
 * 决定下一步行为（重试、向用户报告、修改参数等）。
 */
export interface ToolErrorPayload {
  /** 工具错误码 */
  readonly error_code: ToolErrorCode;
  /** 错误简短描述（与 message 相同，用于兼容不同协议版本） */
  readonly error: string;
  /** 错误详细消息 */
  readonly message: string;
  /** 出错的字段名（参数校验失败时） */
  readonly field?: string;
  /** 期望的值（参数校验失败时） */
  readonly expected?: string;
  /** 出错的文件/资源路径 */
  readonly path?: string;
  /** 拒绝执行的策略名称 */
  readonly policy?: string;
}

/**
 * Paw.ts 框架的顶级错误类
 *
 * 继承自标准 Error，额外携带：
 * - code：便于程序化判断错误类别（不用 instanceof 检查或 message 匹配）
 * - causeDetail：原始错误的引用，保留完整的调用链上下文
 */
export class PawError extends Error {
  /** 框架级错误码 */
  readonly code: PawErrorCode;
  /** 原始错误的详情（如捕获的异常对象），用于调试追踪 */
  readonly causeDetail: unknown;

  constructor(code: PawErrorCode, message: string, causeDetail?: unknown) {
    super(message);
    this.name = "PawError";
    this.code = code;
    this.causeDetail = causeDetail;
  }
}

/**
 * 类型守卫：判断一个未知值是否为 PawError 实例
 *
 * 在 try-catch 块中用于区分 PawError 和其他 Error/非 Error 值，
 * 避免用 instanceof 的冗长写法。
 */
export function isPawError(e: unknown): e is PawError {
  return e instanceof PawError;
}

/**
 * 构造返回给 LLM 的工具错误载荷
 *
 * @param code - 工具错误码
 * @param message - 错误消息（同时填充 error 和 message 字段）
 * @param detail - 可选的附加上下文字段（field、path 等），排除已由前两个参数填充的字段
 * @returns 完整的工具错误载荷对象
 */
export function makeToolError(
  code: ToolErrorCode,
  message: string,
  // 排除 error_code、error、message —— 这三个已由前两个参数覆盖
  detail?: Omit<ToolErrorPayload, "error_code" | "error" | "message">,
): ToolErrorPayload {
  return {
    error_code: code,
    error: message,
    message,
    // spread 可选的附加上下文字段（field、expected、path、policy 等）
    ...(detail ?? {}),
  };
}
