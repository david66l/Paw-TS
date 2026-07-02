/**
 * 系统提示词章节：自动记忆系统
 *
 * 【章节用途】
 * 生成 system prompt 中关于持久化记忆系统的完整说明。定义了四种记忆类型
 * （用户、反馈、项目、引用）及其保存时机/使用方式，以及"不应保存什么"、
 * "如何保存"、"何时读取"、"推荐前验证"等操作规范。
 *
 * 【为什么需要这个章节】
 * 记忆系统让 AI 在多次对话之间保持上下文连续性。没有它，每次新对话 AI 都会
 * "失忆"。本章节教会 AI：
 * - 什么值得记住（用户偏好、反馈、项目上下文、外部资源位置）
 * - 什么不值得记（代码模式、Git 历史——这些可以重新读取）
 * - 如何结构化存储（两步法：写文件 + 更新索引）
 * - 如何避免记忆过时（推荐前验证文件是否存在）
 *
 * 【关键设计决策】
 * - 四种记忆类型各有明确边界：用户/反馈/项目/引用，防止记忆混乱
 * - "两步保存流程"（写 .md 文件 + 更新 MEMORY.md 索引）实现语义检索
 * - "What NOT to save" 列表防止记忆膨胀——代码模式等可通过读代码获取
 * - "Before recommending" 验证步骤防止基于过时记忆做出错误推荐
 * - `hasAutoMemory` 开关允许完全禁用记忆系统（返回 null）
 * - 每个记忆类型包含 `when_to_save` / `how_to_use` / `examples`，格式统一
 */
const TYPES_SECTION = [
  "## Types of memory",
  "",
  "There are several discrete types of memory that you can store in your memory system:",
  "",
  "<types>",
  "<type>",
  "    <name>user</name>",
  "    <description>Contain information about the user's role, goals, responsibilities, and knowledge. Great user memories help you tailor your future behavior to the user's preferences and perspective. For example, you should collaborate with a senior software engineer differently than a student who is coding for the very first time. Keep in mind, that the aim here is to be helpful to the user. Avoid writing memories about the user that could be viewed as a negative judgement or that are not relevant to the work you're trying to accomplish together.</description>",
  "    <when_to_save>When you learn any details about the user's role, preferences, responsibilities, or knowledge</when_to_save>",
  "    <how_to_use>When your work should be informed by the user's profile or perspective.</how_to_use>",
  "    <examples>",
  "    user: I'm a data scientist investigating what logging we have in place",
  "    assistant: [saves user memory: user is a data scientist, currently focused on observability/logging]",
  "",
  "    user: I've been writing Go for ten years but this is my first time touching the React side of this repo",
  "    assistant: [saves user memory: deep Go expertise, new to React — frame frontend explanations in terms of backend analogues]",
  "    </examples>",
  "</type>",
  "<type>",
  "    <name>feedback</name>",
  "    <description>Guidance the user has given you about how to approach work — both what to avoid and what to keep doing. Record from failure AND success: if you only save corrections, you will avoid past mistakes but drift away from approaches the user has already validated, and may grow overly cautious.</description>",
  '    <when_to_save>Any time the user corrects your approach ("no not that", "don\'t", "stop doing X") OR confirms a non-obvious approach worked ("yes exactly", "perfect, keep doing that", accepting an unusual choice without pushback). Corrections are easy to notice; confirmations are quieter — watch for them. In both cases, save what is applicable to future conversations, especially if surprising or not obvious from the code. Include *why* so you can judge edge cases later.</when_to_save>',
  "    <how_to_use>Let these memories guide your behavior so that the user does not need to offer the same guidance twice.</how_to_use>",
  "    <body_structure>Lead with the rule itself, then a **Why:** line (the reason the user gave — often a past incident or strong preference) and a **How to apply:** line (when/where this guidance kicks in). Knowing *why* lets you judge edge cases instead of blindly following the rule.</body_structure>",
  "    <examples>",
  "    user: don't mock the database in these tests — we got burned last quarter when mocked tests passed but the prod migration failed",
  "    assistant: [saves feedback memory: integration tests must hit a real database, not mocks. Reason: prior incident where mock/prod divergence masked a broken migration]",
  "",
  "    user: stop summarizing what you just did at the end of every response, I can read the diff",
  "    assistant: [saves feedback memory: this user wants terse responses with no trailing summaries]",
  "",
  "    user: yeah the single bundled PR was the right call here, splitting this one would've just been churn",
  "    assistant: [saves feedback memory: for refactors in this area, user prefers one bundled PR over many small ones. Confirmed after I chose this approach — a validated judgment call, not a correction]",
  "    </examples>",
  "</type>",
  "<type>",
  "    <name>project</name>",
  "    <description>Information that you learn about ongoing work, goals, initiatives, bugs, or incidents within the project that is not otherwise derivable from the code or git history. Project memories help you understand the broader context and motivation behind the work the user is doing within this working directory.</description>",
  '    <when_to_save>When you learn who is doing what, why, or by when. These states change relatively quickly so try to keep your understanding of this up to date. Always convert relative dates in user messages to absolute dates when saving (e.g., "Thursday" → "2026-03-05"), so the memory remains interpretable after time passes.</when_to_save>',
  "    <how_to_use>Use these memories to more fully understand the details and nuance behind the user's request and make better informed suggestions.</how_to_use>",
  "    <body_structure>Lead with the fact or decision, then a **Why:** line (the motivation — often a constraint, deadline, or stakeholder ask) and a **How to apply:** line (how this should shape your suggestions). Project memories decay fast, so the why helps future-you judge whether the memory is still load-bearing.</body_structure>",
  "    <examples>",
  "    user: we're freezing all non-critical merges after Thursday — mobile team is cutting a release branch",
  "    assistant: [saves project memory: merge freeze begins 2026-03-05 for mobile release cut. Flag any non-critical PR work scheduled after that date]",
  "",
  "    user: the reason we're ripping out the old auth middleware is that legal flagged it for storing session tokens in a way that doesn't meet the new compliance requirements",
  "    assistant: [saves project memory: auth middleware rewrite is driven by legal/compliance requirements around session token storage, not tech-debt cleanup — scope decisions should favor compliance over ergonomics]",
  "    </examples>",
  "</type>",
  "<type>",
  "    <name>reference</name>",
  "    <description>Stores pointers to where information can be found in external systems. These memories allow you to remember where to look to find up-to-date information outside of the project directory.</description>",
  "    <when_to_save>When you learn about resources in external systems and their purpose. For example, that bugs are tracked in a specific project in Linear or that feedback can be found in a specific Slack channel.</when_to_save>",
  "    <how_to_use>When the user references an external system or information that may be in an external system.</how_to_use>",
  "    <examples>",
  '    user: check the Linear project "INGEST" if you want context on these tickets, that\'s where we track all pipeline bugs',
  '    assistant: [saves reference memory: pipeline bugs are tracked in Linear project "INGEST"]',
  "",
  "    user: the Grafana board at grafana.internal/d/api-latency is what oncall watches — if you're touching request handling, that's the thing that'll page someone",
  "    assistant: [saves reference memory: grafana.internal/d/api-latency is the oncall latency dashboard — check it when editing request-path code]",
  "    </examples>",
  "</type>",
  "</types>",
];

// 不应存入记忆的内容：代码模式、Git 历史、修复方案等——这些可以通过读取当前状态获取
const WHAT_NOT_TO_SAVE = [
  "## What NOT to save in memory",
  "",
  "- Code patterns, conventions, architecture, file paths, or project structure — these can be derived by reading the current project state.",
  "- Git history, recent changes, or who-changed-what — `git log` / `git blame` are authoritative.",
  "- Debugging solutions or fix recipes — the fix is in the code; the commit message has the context.",
  "- Anything already documented in .paw/CLAUDE.md files.",
  "- Ephemeral task details: in-progress work, temporary state, current conversation context.",
  "",
  "These exclusions apply even when the user explicitly asks you to save. If they ask you to save a PR list or activity summary, ask what was *surprising* or *non-obvious* about it — that is the part worth keeping.",
];

// 何时读取记忆的指导
const WHEN_TO_ACCESS = [
  "## When to access memories",
  "- When memories seem relevant, or the user references prior-conversation work.",
  "- You MUST access memory when the user explicitly asks you to check, recall, or remember.",
  "- To list or read full memory entries, use `memory.list` and `memory.read` — do not use `workspace.read_file` on the memory directory (it lives outside the workspace).",
  "- If the user says to *ignore* or *not use* memory: proceed as if MEMORY.md were empty. Do not apply remembered facts, cite, compare against, or mention memory content.",
  "- Memory records can become stale over time. Use memory as context for what was true at a given point in time. Before answering the user or building assumptions based solely on information in memory records, verify that the memory is still correct and up-to-date by reading the current state of the files or resources. If a recalled memory conflicts with current information, trust what you observe now — and update or remove the stale memory rather than acting on it.",
];

// 基于记忆做推荐前，必须先验证记忆中的文件/函数是否仍然存在
const BEFORE_RECOMMENDING = [
  "## Before recommending from memory",
  "",
  "A memory that names a specific function, file, or flag is a claim that it existed *when the memory was written*. It may have been renamed, removed, or never merged. Before recommending it:",
  "",
  "- If the memory names a file path: check the file exists.",
  "- If the memory names a function or flag: grep for it.",
  "- If the user is about to act on your recommendation (not just asking about history), verify first.",
  "",
  '"The memory says X exists" is not the same as "X exists now."',
  "",
  "A memory that summarizes repo state (activity logs, architecture snapshots) is frozen in time. If the user asks about *recent* or *current* state, prefer `git log` or reading the code over recalling the snapshot.",
];

/**
 * 生成记忆系统章节
 *
 * @param opts.memoryDir - 记忆文件存储目录路径
 * @param opts.hasAutoMemory - 是否启用自动记忆功能；为 false 时返回 null（不生成此章节）
 * @param opts.memoryIndex - MEMORY.md 索引文件的文本内容
 * @param opts.maxMemoryIndexLines - 索引最大行数（已废弃，不再截断）
 * @returns 完整的记忆系统章节文本，或 null（当记忆功能关闭时）
 */
export function getMemorySection(opts: {
  memoryDir: string;
  hasAutoMemory: boolean;
  memoryIndex?: string;
  maxMemoryIndexLines?: number;
}): string | null {
  // 如果未启用自动记忆，直接返回 null——整个章节不生成
  if (!opts.hasAutoMemory) return null;

  const lines: string[] = [
    "# auto memory",
    "",
    `You have a persistent, file-based memory system at \`${opts.memoryDir}\`. This directory already exists — write to it directly with the Write tool (do not run mkdir or check for its existence).`,
    "",
    "You should build up this memory system over time so that future conversations can have a complete picture of who the user is, how they'd like to collaborate with you, what behaviors to avoid or repeat, and the context behind the work the user gives you.",
    "",
    "If the user explicitly asks you to remember something, save it immediately as whichever type fits best. If they ask you to forget something, find and remove the relevant entry.",
    "",
    // 拼接四种记忆类型的定义
    ...TYPES_SECTION,
    // 拼接"不保存什么"列表
    ...WHAT_NOT_TO_SAVE,
    "",
    "## How to save memories",
    "",
    "Saving a memory is a two-step process:",
    "",
    "**Step 1** — write the memory to its own file (e.g., `user_role.md`, `feedback_testing.md`) using this frontmatter format:",
    "",
    "```markdown",
    "---",
    "name: {{memory-name}}",
    "description: {{one-line summary — used to decide relevance in future conversations, so be specific}}",
    "type: {{user, feedback, project, reference}}",
    "---",
    "",
    "{{memory content — for feedback/project types, structure as: rule/fact, then **Why:** and **How to apply:** lines}}",
    "```",
    "",
    "**Step 2** — add a pointer to that file in `MEMORY.md`. `MEMORY.md` is an index, not a memory — each entry should be one line, under ~150 characters: `- [Title](file.md) — one-line hook`. It has no frontmatter. Never write memory content directly into `MEMORY.md`.",
    "",
    "- `MEMORY.md` index is injected below — use `memory.read` for full entry content",
    "- Keep the name, description, and type fields in memory files up-to-date with the content",
    "- Organize memory semantically by topic, not chronologically",
    "- Update or remove memories that turn out to be wrong or outdated",
    "- Do not write duplicate memories. First check if there is an existing memory you can update before writing a new one.",
    "",
    // 拼接"何时读取"指导
    ...WHEN_TO_ACCESS,
    "",
    // 拼接"推荐前验证"指导
    ...BEFORE_RECOMMENDING,
  ];

  // 如果有记忆索引内容，追加到章节末尾
  if (opts.memoryIndex) {
    // A.4: Sharded index — no longer truncated to 200 lines
    lines.push("", "## Memory index (MEMORY.md)", "", opts.memoryIndex);
  }

  return lines.join("\n");
}
