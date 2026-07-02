/**
 * AgentGroup：管理并行子 Agent，负责事件转发、结果合并、取消和并发限制。
 * ======================================================================
 *
 * 当父 Agent 调用 workspace.run_agent 工具时，可能会同时启动多个子 Agent。
 * AgentGroup 负责：
 *
 * 1. **并发控制**：限制每轮最大子 Agent 数和最大嵌套深度
 * 2. **事件转发**：将子 Agent 的关键事件（started/completed/tool_call 等）
 *    转发到父 Agent 的事件流，用于 TUI 状态树展示
 * 3. **结果合并**：等待所有子 Agent 完成（允许部分失败），收集结果
 * 4. **级联取消**：父 Agent 被中断时，通过 AbortController 级联取消所有子 Agent
 * 5. **文件变更通知**：子 Agent 写文件后通知父 Agent 的文件监听器
 */

import type { RunEvent, RunEventEnvelope } from "@paw/core";
import type { AgentToolCallAction } from "@paw/core";
import type { SubAgentLauncher } from "@paw/harness";
import type { WorkspaceWatcher } from "@paw/workspace";
import { MULTI_AGENT_LIMITS, PARENT_FORWARD_EVENTS } from "./constants.js";
import { parseRunAgentMaxSteps } from "./agent-args.js";
import type {
  AgentRunState,
  ChildAgentState,
  ChildPhase,
  SharedContext,
  SubAgentResult,
} from "./types.js";

/** 子 Agent 的运行时控制器：包含标识、状态快照和 Promise */
interface ChildController {
  readonly agentId: string;
  readonly goal: string;
  readonly maxSteps: number;
  /** 子 Agent 的 Promise：resolve 时得到 SubAgentResult */
  readonly promise: Promise<SubAgentResult>;
  /** 可变的状态快照（用于 TUI 展示） */
  state: ChildAgentState;
}

interface AgentGroupOptions {
  readonly parentRunId: string;
  /** 父 Agent 的事件回调：用于转发子 Agent 事件 */
  readonly parentOnEvent: (envelope: RunEventEnvelope) => void;
  readonly parentWatcher?: WorkspaceWatcher;
  /** 子 Agent 启动器 */
  readonly launcher: SubAgentLauncher;
  /** 当前嵌套深度（0 = 父 Agent，1 = 子 Agent） */
  readonly depth: number;
}

export class AgentGroup {
  private readonly parentRunId: string;
  private readonly parentOnEvent: (envelope: RunEventEnvelope) => void;
  private readonly parentWatcher?: WorkspaceWatcher;
  private readonly launcher: SubAgentLauncher;
  private readonly depth: number;
  /** 本地 AbortController：用于级联取消所有子 Agent */
  private readonly localController = new AbortController();
  /** 当前活跃的子 Agent 映射：agentId → ChildController */
  private children = new Map<string, ChildController>();

  constructor(opts: AgentGroupOptions) {
    this.parentRunId = opts.parentRunId;
    this.parentOnEvent = opts.parentOnEvent;
    this.parentWatcher = opts.parentWatcher;
    this.launcher = opts.launcher;
    this.depth = opts.depth;
  }

  /**
   * 批量启动多个子 Agent（并行），带并发守卫。
   *
   * 步骤：
   * 1. 检查并发限制（每轮最大数 + 最大深度）
   * 2. 合并父信号和本地控制器（级联取消）
   * 3. 为每个调用构建 ChildController
   * 4. 通过 launcher.launchStreaming() 并行启动所有子 Agent
   * 5. 用 Promise.allSettled 等待（允许部分失败）
   * 6. 清理已完成的子 Agent（防止跨轮内存泄漏）
   *
   * 为什么用 allSettled 而非 all？
   * 部分子 Agent 失败不应阻止其他子 Agent 的结果被使用。
   */
  async launchAll(
    calls: readonly AgentToolCallAction[],
    sharedCtxForCall: (call: AgentToolCallAction) => SharedContext,
    parentSignal?: AbortSignal,
  ): Promise<SubAgentResult[]> {
    // 守卫：每轮最大子 Agent 数
    if (calls.length > MULTI_AGENT_LIMITS.maxChildrenPerTurn) {
      throw new Error(
        `Cannot launch ${calls.length} child agents; max is ${MULTI_AGENT_LIMITS.maxChildrenPerTurn}`,
      );
    }

    // 守卫：最大嵌套深度（防止无限递归）
    if (this.depth >= MULTI_AGENT_LIMITS.maxChildDepth) {
      throw new Error(
        `Child agent depth ${this.depth} exceeds max ${MULTI_AGENT_LIMITS.maxChildDepth}`,
      );
    }

    // 合并父信号 + 本地控制器 → 任一中止都会触发级联取消
    const childSignal = parentSignal
      ? AbortSignal.any([parentSignal, this.localController.signal])
      : this.localController.signal;

    // 构建 ChildController 列表
    const controllers: ChildController[] = calls.map((call, idx) => {
      const agentId = `child-${this.parentRunId}-${idx}`;
      const goal =
        typeof call.args?.goal === "string"
          ? call.args.goal
          : String(call.args?.goal ?? "");
      const sharedContext = sharedCtxForCall(call);
      const callArgs =
        call.args && typeof call.args === "object"
          ? (call.args as Record<string, unknown>)
          : undefined;
      const maxSteps =
        parseRunAgentMaxSteps(callArgs) ?? MULTI_AGENT_LIMITS.maxChildSteps;

      const state: ChildAgentState = {
        agentId,
        goal,
        phase: "queued",
        progress: 0,
      };

      // 启动子 Agent（流式），通过 onEvent 回调接收实时事件
      const promise = this.launcher
        .launchStreaming({
          goal,
          maxSteps,
          signal: childSignal,
          parentRunId: this.parentRunId,
          agentId,
          onEvent: (envelope) => this.onChildEvent(agentId, envelope),
          sharedContext,
        })
        .then((result) => {
          this.updateChildState(agentId, "completed", 100, result);
          return result;
        })
        .catch((err) => {
          const errorMsg = err instanceof Error ? err.message : String(err);
          this.updateChildState(agentId, "failed", 0, undefined, errorMsg);
          return {
            status: "failed" as const,
            summary: `Child agent failed: ${errorMsg}`,
            errors: [errorMsg],
          };
        });

      const controller: ChildController = {
        agentId,
        goal,
        maxSteps,
        promise,
        state,
      };
      this.children.set(agentId, controller);
      return controller;
    });

    // 等待所有子 Agent 完成（允许部分失败）
    const results = await Promise.allSettled(controllers.map((c) => c.promise));

    // 清理已完成的子 Agent（防止跨轮内存泄漏）
    for (const c of controllers) {
      this.children.delete(c.agentId);
    }

    // 将 SettledResult[] 转为 SubAgentResult[]
    return results.map((r, idx) => {
      if (r.status === "fulfilled") {
        return r.value;
      }
      const agentId = controllers[idx]?.agentId;
      return {
        status: "failed" as const,
        summary: `Child agent ${agentId} rejected: ${String(r.reason)}`,
        errors: [String(r.reason)],
      };
    });
  }

  /** 取消所有正在运行的子 Agent（级联） */
  async cancelAll(): Promise<void> {
    this.localController.abort();
    // 等待所有子 Agent 退出（abort 后它们会 reject 或 resolve）
    await Promise.allSettled(
      [...this.children.values()].map((c) =>
        c.promise.catch(() => {
          /* abort 后的异常是预期的，忽略 */
        }),
      ),
    );
  }

  /**
   * 接收子 Agent 的事件，更新内部状态并转发到父 Agent。
   *
   * 事件处理：
   * - run.started → 状态更新为 model_calling
   * - loop.tick → 计算进度（turn/maxSteps，上限 50%）
   * - phase(tool) → 状态更新为 tool_executing
   * - tool.result → 进度更新为 85%
   * - run.completed / run.failed → 最终状态
   *
   * 文件变更通知：
   * 子 Agent 写文件成功后，通知父 Agent 的文件监听器清除缓存，
   * 这样父 Agent 在下一轮能感知到文件变更。
   */
  onChildEvent(agentId: string, envelope: RunEventEnvelope): void {
    const controller = this.children.get(agentId);
    if (!controller) return;

    const event = envelope.event;

    // 根据事件类型更新子 Agent 的内部状态
    switch (event.type) {
      case "run.started":
        this.updateChildState(agentId, "model_calling", 0);
        break;
      case "loop.tick": {
        const maxSteps = controller.maxSteps;
        const progress =
          maxSteps > 0
            ? Math.min(50, (event.turn / maxSteps) * 50)
            : 0;
        this.updateChildState(agentId, "model_calling", progress);
        break;
      }
      case "phase":
        if (event.name === "tool") {
          this.updateChildState(agentId, "tool_executing", 75);
        }
        break;
      case "tool.result":
        this.updateChildState(agentId, "tool_executing", 85);
        break;
      case "run.completed":
        this.updateChildState(agentId, "completed", 100);
        break;
      case "run.failed":
        this.updateChildState(agentId, "failed", 0, undefined, event.message);
        break;
    }

    // 将白名单事件转发到父 Agent 事件流
    // 高频事件（model.chunk、loop.tick）被过滤，避免刷屏
    const childEventType = `child.${mapToChildEventType(event.type)}`;
    if (PARENT_FORWARD_EVENTS.has(childEventType)) {
      this.parentOnEvent({
        runId: this.parentRunId,
        seq: envelope.seq,
        ts: envelope.ts,
        event: {
          type: childEventType as RunEvent["type"],
          agentId,
          originalEvent: event,
        } as unknown as RunEvent,
      });
    }

    // 子 Agent 写文件后通知父 Agent 的文件监听器
    if (
      event.type === "tool.result" &&
      (event.tool === "workspace.write_file" ||
        event.tool === "workspace.edit_file") &&
      event.ok
    ) {
      const detail = event.detail;
      const filePath =
        detail && typeof detail === "object" && "path" in detail
          ? String((detail as Record<string, unknown>).path)
          : undefined;
      if (filePath && this.parentWatcher) {
        this.parentWatcher.takeExternallyModified();
      }
    }
  }

  /** 获取层级状态树（递归结构，用于 TUI 展示嵌套的子 Agent） */
  getStateTree(): AgentRunState {
    return {
      runId: this.parentRunId,
      phase: "waiting_children",
      progress: this.computeOverallProgress(),
      children: [...this.children.values()].map((c) => ({
        runId: c.agentId,
        phase: c.state.phase,
        progress: c.state.progress,
      })),
    };
  }

  /** 更新指定子 Agent 的状态快照 */
  private updateChildState(
    agentId: string,
    phase: ChildPhase,
    progress: number,
    result?: SubAgentResult,
    error?: string,
  ): void {
    const controller = this.children.get(agentId);
    if (!controller) return;
    controller.state = {
      ...controller.state,
      phase,
      progress,
      ...(result ? { result } : {}),
      ...(error ? { error } : {}),
    };
  }

  /** 计算所有子 Agent 的平均进度 */
  private computeOverallProgress(): number {
    if (this.children.size === 0) return 0;
    let total = 0;
    for (const c of this.children.values()) {
      total += c.state.progress;
    }
    return Math.round(total / this.children.size);
  }
}

/** 将内部 RunEvent 类型映射为子事件类型前缀 */
function mapToChildEventType(eventType: string): string {
  switch (eventType) {
    case "run.started":
      return "started";
    case "run.completed":
      return "completed";
    case "run.failed":
      return "failed";
    case "tool.call":
      return "tool_call";
    case "tool.result":
      return "tool_result";
    default:
      return "phase_changed";
  }
}
