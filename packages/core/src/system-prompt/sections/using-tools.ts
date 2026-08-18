/**
 * 系统提示词章节：工具使用指南
 *
 * 【章节用途】
 * 生成 system prompt 中最核心的操作章节——教 AI 如何使用工具。内容包括：
 * JSON 工具调用格式、ReAct 模式、工具完整性约束、禁止 shell 替代专用工具、
 * 并行工具调用、子代理使用策略、以及工作模式（计划-执行-验证）。
 *
 * 【为什么需要这个章节】
 * 这是 system prompt 的"用户手册"，没有它 AI 不知道如何与系统交互：
 * - 工具调用的 JSON 格式（`tool`/`args` 而非 `name`/`arguments`）
 * - 专用工具优于通用 shell 命令（read_file 替代 cat，write_file 替代 cat << EOF）
 * - 并行调用的时机和约束（独立调用可并行，有依赖的需串行）
 * - 子代理的使用场景（多文件搜索、并行任务、验证）
 * - 工作模式的区分（复杂任务先计划，简单任务直接改）
 *
 * 【关键设计决策】
 * - `toolCatalog` 从外部传入，使章节与具体工具解耦
 * - `hasTaskTool` 和 `hasSkills` 开关控制子章节的有无，适应不同部署配置
 * - 禁止 shell 创建文件不仅是为了规范性——shell exit code 可能误导（写入错误目录仍返回 0）
 * - 子代理指南明确"何时用"和"何时不用"，防止 AI 在简单场景也 spawn 子代理
 * - 工作模式提供了从"计划→todo→逐步执行→final_answer"的完整闭环
 */
export function getUsingToolsSection(opts: {
  /** 是否有任务管理工具（todo_write） */
  hasTaskTool: boolean;
  /** 是否支持 Skill 系统 */
  hasSkills: boolean;
  /** 工具目录文本（所有可用工具的描述） */
  toolCatalog: string;
  /** Authoritative model-visible tool names. Undefined preserves legacy behavior. */
  toolNames?: readonly string[];
  /** Authoritative structured actions. Undefined preserves legacy behavior. */
  modelActions?: readonly string[];
}): string {
  const lines: string[] = [];
  const toolNames = opts.toolNames ? new Set(opts.toolNames) : null;
  const modelActions = opts.modelActions ? new Set(opts.modelActions) : null;
  const hasTool = (name: string): boolean => toolNames?.has(name) ?? true;
  const hasAction = (name: string): boolean => modelActions?.has(name) ?? true;

  const examples: string[] = [];
  if (hasTool("workspace.read_file")) {
    examples.push(
      `{"tool":"workspace.read_file","args":{"path":"<relative-path>"}}`,
    );
  }
  if (hasTool("workspace.run_shell")) {
    examples.push(
      `{"tool":"workspace.run_shell","args":{"command":"<shell command>","cwd":"."}}`,
    );
  }

  const actions: string[] = [];
  if (hasAction("action.final_answer")) {
    actions.push(
      `{"action":"final_answer","summary":"..."} — task is done, report to the user`,
    );
  }
  if (hasAction("action.ask_user")) {
    actions.push(
      `{"action":"ask_user","question":"..."} — ask the user a question`,
    );
  }
  if (hasAction("action.plan_update")) {
    actions.push(
      `{"action":"plan_update","reason":"...","new_items":[...],"deprecated_items":[...]} — add plan items or update existing items by id`,
    );
  }
  if (hasAction("action.acceptance_update")) {
    actions.push(
      `{"action":"acceptance_update","add":[...],"updates":[...],"reason":"..."} — update the durable acceptance ledger`,
    );
  }
  if (hasAction("action.abort")) {
    actions.push(`{"action":"abort","reason":"..."} — abort the task`);
  }

  // 基础工具调用格式说明
  lines.push(
    "# Using your tools",
    "",
    "You can call tools by outputting one or more JSON objects, each on its own line:",
    "",
    ...(examples.length > 0
      ? examples
      : ["No model-callable workspace tools are enabled for this run."]),
    "",
    // 关键：使用 tool/args 而非 name/arguments——错误的格式不会被识别
    "Use the exact keys `tool` and `args` above. Do NOT use `name` and `arguments` — those are a different format and will not be recognized.",
    "",
    // 其他结构化动作（非工具调用，而是流程控制）
    "Other structured actions (also valid JSON on their own line):",
    ...actions,
    ...(hasAction("action.acceptance_update")
      ? [
          "When tests or investigation reveal new regression conditions, register them with acceptance_update. Before final_answer, resolve every active acceptance item against the current code revision.",
        ]
      : []),
    "",
    // ReAct 模式：观察→思考→行动，循环直到完成
    "ReAct pattern: (1) Observe tool results. (2) Think about next steps. (3) Act: call a tool, ask the user, or final_answer. Repeat until done. Do NOT stop after just reading or searching — take action on what you learn.",
    "",
    // 完整性约束：必须实际输出 JSON 才能操作，不能只在文字中声称完成
    "Integrity: Do not claim you created, edited, or deleted files unless this conversation already contains a matching [Tool ... completed] result. To act you MUST output a JSON line. Never wrap tools in XML tags or markdown fences — use plain JSON on its own line.",
    "",
    // 注入外部工具目录
    opts.toolCatalog,
  );

  // 专用工具优于通用 shell；只有实际可见的专用工具才进入说明。
  const dedicatedGuidance: string[] = [];
  if (hasTool("workspace.read_file")) {
    dedicatedGuidance.push(
      "- To read files use workspace.read_file — never use cat, head, or tail",
    );
  }
  if (hasTool("workspace.write_file")) {
    dedicatedGuidance.push(
      "- To create files use workspace.write_file — never use shell redirection",
    );
  }
  if (hasTool("workspace.edit_file")) {
    dedicatedGuidance.push(
      "- Use workspace.edit_file for exact edits; to create a missing file, pass old_string as an empty string and new_string as its complete content",
    );
  }
  if (hasTool("workspace.glob")) {
    dedicatedGuidance.push(
      "- To search for files use workspace.glob — never use find or ls",
    );
  }
  if (hasTool("workspace.grep")) {
    dedicatedGuidance.push(
      "- To search content use workspace.grep — never use grep or rg",
    );
  }
  if (dedicatedGuidance.length > 0) {
    lines.push(
      "",
      "IMPORTANT: Prefer an available dedicated tool over workspace.run_shell:",
      ...dedicatedGuidance,
    );
  }

  // 任务管理工具（可选）：让 AI 使用 todo_write 拆分和追踪任务
  if (opts.hasTaskTool && hasTool("workspace.todo_write")) {
    lines.push(
      "",
      "Break down and manage your work with workspace.todo_write. Mark each task as completed as soon as you are done with it. Do not batch up multiple tasks before marking them as completed.",
    );
  }

  // Skill 系统（可选）：教 AI 如何通过 /skill-name 调用技能
  if (opts.hasSkills && hasTool("workspace.run_skill")) {
    lines.push(
      "",
      "When the user types /<skill-name> (e.g., /review), invoke it via workspace.run_skill. Use only skills listed in the available skills section — don't guess or invent names.",
    );
  }

  // 并行工具调用指导：独立的调用应并行发送以提升效率
  lines.push(
    "",
    "You can call multiple tools in a single response. If you intend to call multiple tools and there are no dependencies between them, make all independent tool calls in parallel. Maximize use of parallel tool calls where possible to increase efficiency. However, if some tool calls depend on previous calls to inform dependent values, do NOT call these tools in parallel and instead call them sequentially.",
  );

  // 子代理（sub-agent）使用指南只在该工具实际暴露时出现。
  if (hasTool("workspace.run_agent")) {
    lines.push(
      "",
      "## When to use workspace.run_agent",
      "",
      "Use sub-agents for tasks that would otherwise fill your context with raw output you won't need again. The sub-agent absorbs the noise and returns only the conclusion.",
      "Use them for broad independent investigation or independent review; avoid them for a single direct tool call.",
    );
  }

  // 工作模式：复杂任务按"计划→执行→验证"流程，简单任务直接修改
  const workModeSteps: string[] = [];
  if (hasAction("action.plan_update")) {
    workModeSteps.push(
      "- Start with plan_update when a complex task needs explicit stages.",
    );
  }
  if (hasTool("workspace.todo_write")) {
    workModeSteps.push(
      "- Use workspace.todo_write to track actionable tasks and update them as work progresses.",
    );
  }
  workModeSteps.push(
    "- Read only what is needed, implement the next clear change, and verify it.",
  );
  if (hasAction("action.final_answer")) {
    workModeSteps.push(
      "- Call final_answer only when the work is done or cannot proceed honestly.",
    );
  }
  lines.push(
    "",
    "Work mode for complex tasks (building, designing, refactoring):",
    ...workModeSteps,
  );

  return lines.join("\n");
}
