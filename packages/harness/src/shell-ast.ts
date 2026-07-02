/**
 * Shell 命令 AST（抽象语法树）—— 基于 `unbash` 零依赖 Bash 解析器。
 *
 * ## 功能概述
 * 本模块负责将原始 Shell 命令字符串解析为结构化的 AST（抽象语法树），
 * 供策略引擎（shell-guard）进行精确的规则匹配和风险评估。
 *
 * ## 技术选型：为什么用 `unbash` 而非自己写解析器
 *
 * Shell 语法极其复杂（POSIX + Bash 扩展），自己写完整的解析器是巨大的工程
 * 且容易出错。`unbash` 是一个零依赖的 JavaScript Bash 解析器，覆盖了完整的
 * POSIX/Bash 语法。我们选择在它的基础上做"归约"（normalisation）：
 *
 *   1. 解析阶段：由 `unbash` 处理完整的 Bash 语法树
 *   2. 归约阶段：将复杂的 unbash AST 映射为小型的、意见明确的节点集合
 *
 * 这样策略引擎无需理解 Bash 的全部语法细节，只需要读懂少数几种节点类型。
 *
 * ## 归约后的 AST 节点类型
 *
 * 我们只暴露对编码代理 Harness 有意义的子集：
 *
 *   - `Command`（简单命令）: 命令名 + 参数 + 重定向 + 环境变量
 *   - `Pipeline`（管道）: 通过 `|` 连接的多条命令
 *   - `CommandGroup`（命令组）: 通过 `;` `&&` `||` 连接的复合命令
 *
 * 以下构造被**不透明化处理**（视为未知命令，保守地触发"询问"默认策略）：
 *   - if/for/while 条件循环
 *   - 函数定义
 *   - 进程替换 `<(...)` 作为参数
 *   - 算术展开 `$((...))`
 *
 * ## 关键设计决策
 *
 * 1. **AndOr 链的左结合折叠**：
 *    `a && b || c && d` 被折叠为二叉树：
 *    ```
 *    group(||, group(&&, a, b), group(&&, c, d))
 *    ```
 *    这种折叠方式忠实地保留了 Bash 的求值语义（短路求值）。
 *
 * 2. **多顶层语句的隐式串联**：
 *    当用户输入多条顶层命令时（如粘贴的脚本），用 `;` 操作符串联它们。
 *    这与 Bash 的行为一致：多条语句按顺序执行，失败不中断后续。
 *
 * 3. **命令名的大小写归一化**：
 *    命令名被转为小写（`grep`, `Grep`, `GREP` → 统一为 `grep`），
 *    因为文件系统在大多数平台上不区分大小写，策略匹配不应被大小写绕过。
 *
 * 4. **替换检测（hasSubstitution 标志）**：
 *    参数和重定向目标都带有 `hasSubstitution` 标志，标记是否包含
 *    命令替换 `$(...)` 或进程替换。策略引擎可以利用此标志区分
 *    静态参数和动态参数，对动态参数施加更严格的限制。
 */

import { parse as unbashParse, type Node, type Word, type Redirect } from "unbash";

// ---------------------------------------------------------------------------
// 归约后的 AST 节点类型（为策略引擎保持稳定接口）
// ---------------------------------------------------------------------------

/** 环境变量赋值（如 FOO=bar cmd 中的 FOO=bar） */
export interface EnvVar {
  /** 环境变量名 */
  readonly name: string;
  /** 环境变量值 */
  readonly value: string;
}

/** 重定向操作（如 > /tmp/out 2>&1） */
export interface RedirectNode {
  /** 重定向操作符：>, >>, <, 2>, 2>&1 等 */
  readonly op: string;
  /** 重定向目标（文件路径或文件描述符） */
  readonly target: string;
  /** 目标路径是否包含命令/进程替换 */
  readonly targetHasSubstitution: boolean;
}

/** 命令参数 */
export interface Arg {
  /** 参数值（展开变量和替换后的结果） */
  readonly value: string;
  /** 参数原文（保留原始格式，用于审计和日志） */
  readonly raw: string;
  /** 是否包含命令替换 $(...) 或进程替换 */
  readonly hasSubstitution: boolean;
}

/**
 * 简单命令节点。
 * 表示单个可执行命令及其所有修饰（参数、重定向、环境变量前缀）。
 */
export interface Command {
  readonly type: "command";
  /** 命令名（已归一化为小写） */
  readonly name: string;
  /** 命令参数列表（不含命令名本身） */
  readonly args: Arg[];
  /** 重定向列表 */
  readonly redirects: RedirectNode[];
  /** 前置环境变量列表 */
  readonly envVars: EnvVar[];
}

/**
 * 管道节点。
 * 表示通过 `|` 连接的多条命令，stdout → stdin 级联。
 */
export interface Pipeline {
  readonly type: "pipeline";
  /** 管道中的各条命令（从左到右） */
  readonly commands: Command[];
}

/**
 * 命令组节点。
 * 通过短路操作符 (`&&` `||`) 或顺序操作符 (`;`) 连接的两个子 AST。
 * 使用二叉树结构（非展平列表），保留了短路求值的语义。
 */
export interface CommandGroup {
  readonly type: "group";
  /** 连接操作符：;（顺序）&&（前成功后执行）||（前失败后执行） */
  readonly operator: ";" | "&&" | "||";
  /** 左子节点 */
  readonly left: ASTNode;
  /** 右子节点 */
  readonly right: ASTNode;
}

/** AST 节点联合类型 */
export type ASTNode = Command | Pipeline | CommandGroup;

// ---------------------------------------------------------------------------
// 单词分析辅助函数
// ---------------------------------------------------------------------------

/**
 * 检查 unbash Word 节点是否包含替换（命令替换、进程替换、算术展开）。
 * 用于设置 `hasSubstitution` 标志。
 */
function wordHasSubstitution(word: Word): boolean {
  if (!word.parts) return false;
  return word.parts.some(
    (p) =>
      p.type === "CommandExpansion" ||   // $(...) 或 `...`
      p.type === "ProcessSubstitution" || // <(...) 或 >(...)
      p.type === "ArithmeticExpansion",   // $((...))
  );
}

/** 获取单词的展开值（经过变量替换后的结果） */
function wordValue(word: Word): string {
  return word.value;
}

/** 获取单词的原始文本（未展开变量） */
function wordRaw(word: Word): string {
  return word.text;
}

// ---------------------------------------------------------------------------
// 归约核心：unbash AST → 我们的 AST
// ---------------------------------------------------------------------------

/**
 * 归约 unbash Redirect 节点。
 * 提取操作符和目标路径，并检测目标是否包含替换。
 */
function normaliseRedirect(r: Redirect): RedirectNode | null {
  const target = r.target ? wordValue(r.target) : "";
  return {
    op: r.operator,
    target,
    targetHasSubstitution: r.target ? wordHasSubstitution(r.target) : false,
  };
}

/**
 * 归约单个 unbash Command 节点。
 *
 * 处理的三部分结构：
 *   prefix  → 环境变量赋值（KEY=value）
 *   name    → 命令名
 *   suffix  → 参数列表
 *   redirects → 重定向
 *
 * 对于无法识别的节点类型（if/for/while 等），返回空命令名，
 * 策略引擎将其视为未知命令，保守地应用默认策略。
 */
function normaliseCommand(node: Node): Command {
  if (node.type !== "Command") {
    // 不透明构造（if/for/while/函数定义等）
    // 表示为未知命令名，策略引擎回退到保守默认策略（"询问"）
    return {
      type: "command",
      name: "",
      args: [],
      redirects: [],
      envVars: [],
    };
  }

  // 提取环境变量前缀（如 FOO=bar BAR=baz cmd）
  const envVars: EnvVar[] = [];
  for (const p of node.prefix) {
    if (p.type === "Assignment" && p.name) {
      envVars.push({
        name: p.name,
        value: p.value ? wordValue(p.value) : "",
      });
    }
  }

  // 提取命令参数
  const args: Arg[] = [];
  for (const s of node.suffix) {
    args.push({
      value: wordValue(s),
      raw: wordRaw(s),
      hasSubstitution: wordHasSubstitution(s),
    });
  }

  // 提取并归约重定向
  const redirects = node.redirects
    .map(normaliseRedirect)
    .filter((r): r is RedirectNode => r !== null);

  return {
    type: "command",
    name: node.name ? wordValue(node.name).toLowerCase() : "",
    args,
    redirects,
    envVars,
  };
}

/**
 * 递归归约任意 unbash Node 到我们的 AST。
 *
 * 处理三种情况：
 *   1. 简单命令 → Command
 *   2. 管道 → Pipeline（单命令管道简化为 Command）
 *   3. AndOr 链 → CommandGroup 二叉树
 */
function normaliseNode(node: Node): ASTNode {
  if (node.type === "Command") {
    return normaliseCommand(node);
  }

  if (node.type === "Pipeline") {
    const commands: Command[] = [];
    for (const c of node.commands) {
      commands.push(normaliseCommand(c));
    }
    // 优化：单命令管道直接退化为 Command（避免不必要的嵌套）
    if (commands.length === 1) return commands[0]!;
    return { type: "pipeline", commands };
  }

  if (node.type === "AndOr") {
    // AndOr 链如 a && b || c && d
    // 左结合折叠为二叉树，保留短路求值语义：
    //   ((a && b) || c) && d
    const cmds = node.commands.map(normaliseNode);
    const ops = node.operators;
    if (cmds.length === 0) {
      return { type: "command", name: "", args: [], redirects: [], envVars: [] };
    }
    let left = cmds[0]!;
    for (let i = 0; i < ops.length; i++) {
      // 归一化操作符：unbash 可能返回 "AND_IF" / "OR_IF"，统一映射
      const op = ops[i] === "&&" ? "&&" : "||";
      const right = cmds[i + 1]!;
      left = { type: "group", operator: op, left, right };
    }
    return left;
  }

  // 所有其他构造（如 if/for/while 等复合语句）→ 不透明化处理
  return { type: "command", name: "", args: [], redirects: [], envVars: [] };
}

/**
 * 解析 Shell 命令字符串为归约后的 AST。
 *
 * 这是本模块的主入口函数。处理流程：
 *   1. 调用 unbash 解析原始命令字符串
 *   2. 如果无有效命令，返回空 Command 占位节点
 *   3. 如果是单条语句，直接归约
 *   4. 如果是多条顶层语句（如粘贴的脚本），用 `;` 操作符串联
 *
 * @param command - 原始 Shell 命令字符串
 * @returns 归约后的 AST 根节点
 */
export function parse(command: string): ASTNode {
  const script = unbashParse(command);
  if (script.commands.length === 0) {
    return { type: "command", name: "", args: [], redirects: [], envVars: [] };
  }
  if (script.commands.length === 1) {
    return normaliseNode(script.commands[0]!.command);
  }

  // 多条顶层语句 → 用 ";" 操作符串联（Bash 默认行为：顺序执行，失败不中断后续）
  let left = normaliseNode(script.commands[0]!.command);
  for (let i = 1; i < script.commands.length; i++) {
    const right = normaliseNode(script.commands[i]!.command);
    left = { type: "group", operator: ";", left, right };
  }
  return left;
}

// ---------------------------------------------------------------------------
// AST 遍历辅助函数
// ---------------------------------------------------------------------------

/**
 * 遍历 AST 中的所有 Command 节点（跳过 Pipeline 和 Group 结构层级）。
 * 生成器函数，便于在 for...of 循环中使用。
 *
 * @param node - AST 根节点
 * @yields 每个 Command 节点
 */
export function* walkCommands(node: ASTNode): Generator<Command> {
  if (node.type === "command") {
    yield node;
  } else if (node.type === "pipeline") {
    for (const c of node.commands) yield c;
  } else if (node.type === "group") {
    // 递归遍历左右子树
    yield* walkCommands(node.left);
    yield* walkCommands(node.right);
  }
}

/**
 * 遍历 AST 中的所有 Pipeline 节点。
 *
 * @param node - AST 根节点
 * @yields 每个 Pipeline 节点
 */
export function* walkPipelines(node: ASTNode): Generator<Pipeline> {
  if (node.type === "pipeline") {
    yield node;
  } else if (node.type === "group") {
    yield* walkPipelines(node.left);
    yield* walkPipelines(node.right);
  }
}

/**
 * 将嵌套的 Group 节点展平为顺序列表。
 *
 * 用途：策略引擎按顺序分析命令链时，需要展平嵌套的二叉树结构。
 * 例如 `a && b || c` 展平为 `[a, b, c]`（丢失了操作符信息，仅保留命令序列）。
 *
 * @param node - AST 根节点
 * @returns 展平后的 AST 节点列表
 */
export function flattenGroups(node: ASTNode): ASTNode[] {
  const out: ASTNode[] = [];
  function flatten(n: ASTNode) {
    if (n.type === "group") {
      flatten(n.left);
      flatten(n.right);
    } else {
      out.push(n);
    }
  }
  flatten(node);
  return out;
}
