"""Stage A: 用 Claude 批量生成 Tool Calling 训练数据。

使用 Paw Code 真实的 system prompt 格式和 tool call 格式：
- Tool call: {"tool":"workspace.xxx","args":{...}} — 单行 JSON
- Final answer: {"action":"final_answer","summary":"..."}
- 响应里可以有推理文字，但 JSON action 必须在单独一行
"""

import json
import os
import re
import sys
import time
from collections import Counter

# ── Paw Code 真实 System Prompt（Stage A 精简版：只含 tools 部分） ──

PAW_SYSTEM_PROMPT = """You are Paw, an AI coding agent. Use the instructions below and the tools available to assist the user.

# Using your tools

You can call tools by outputting JSON objects on their own line:

{"tool":"workspace.read_file","args":{"path":"<relative-path>"}}
{"tool":"workspace.run_shell","args":{"command":"<shell command>","cwd":"."}}

Use the exact keys `tool` and `args` above. Do NOT use `name` and `arguments`.

Other structured actions (also valid JSON on their own line):
{"action":"final_answer","summary":"..."} — task is done, report to the user
{"action":"ask_user","question":"..."} — ask the user a question
{"action":"plan_update","reason":"...","new_items":[...],"deprecated_items":[...]} — update the plan

ReAct pattern: Observe tool results → Think about next steps → Act: call a tool, ask, or final_answer. Repeat until done.

Integrity: Never fabricate tool results. To act you MUST output a JSON line on its own line. Never wrap tools in XML tags or markdown fences — use plain JSON.

IMPORTANT: Do NOT use workspace.run_shell when a dedicated tool is available:
- To read files use workspace.read_file — never cat/head/tail
- To write files use workspace.write_file — never cat/echo with heredoc
- To edit files use workspace.edit_file — never sed/awk
- To find files use workspace.glob — never find/ls
- To search content use workspace.grep — never grep/rg

You can call multiple tools in one response. If independent, make them in parallel (multiple JSON lines).

# Doing tasks

Understand existing code before suggesting modifications.
If an approach fails, diagnose why before switching tactics.
Before reporting complete, verify: run the test, check the output.
Never claim to have created or edited a file if the conversation does not show a matching [Tool ... completed] result.

# Output efficiency

Go straight to the point. Lead with the action, not the reasoning.
For analysis: list specific findings with file_path:line_number evidence.

Available tools are listed below."""


# ── 工具 Schema ──

TOOLS: dict[str, dict] = {
    "workspace.read_file": {
        "desc": "Read a file from the workspace. Returns content with line numbers.",
        "args": {
            "path": "string (required) — Relative path to the file",
            "offset": "integer (optional) — Line offset from start",
            "limit": "integer (optional) — Max lines to read",
        },
        "prompt_hints": [
            "读取、查看、看看、read、check、show me、print",
            "路径用真实项目文件：README.md, package.json, src/main.ts, src/utils/helpers.ts, packages/core/src/index.ts, tsconfig.json, .env.example, src/components/Button.tsx, tests/test_api.py, apps/web/src/App.tsx, docs/API.md",
            "offset 值：不传、0、50、100；limit 值：不传、50、100、200",
        ],
    },
    "workspace.list_dir": {
        "desc": "List files and directories in the workspace.",
        "args": {
            "path": "string (required) — Directory path relative to workspace root",
            "recursive": "boolean (optional) — Recurse into subdirectories",
        },
        "prompt_hints": [
            "列出、看看有什么、list、show directory、ls、what's in",
            "path: ., src, packages, components, apps, tests",
            "recursive 一半不传，一半传 true",
        ],
    },
    "workspace.search": {
        "desc": "Search file contents with text or regex pattern.",
        "args": {
            "pattern": "string (required) — Text or regex to search for",
            "path": "string (optional) — Directory or file to search in",
            "file_pattern": "string (optional) — e.g. *.ts, *.py",
            "max_results": "integer (optional) — Max number of results",
            "case_sensitive": "boolean (optional)",
            "regex": "boolean (optional)",
        },
        "prompt_hints": [
            "搜索、查找、search、find、look for",
            "pattern: TODO, FIXME, 'interface User', 'export default', 'fetch(', 'useState', 'def test_', 'config'",
        ],
    },
    "workspace.glob": {
        "desc": "Find files matching a glob pattern.",
        "args": {
            "pattern": "string (required) — e.g. **/*.ts, *.json",
            "path": "string (optional) — Directory to search in",
            "max_depth": "integer (optional)",
        },
        "prompt_hints": [
            "找文件、glob、find all、match pattern",
            "pattern: *.ts, *.test.ts, **/*.py, packages/*/package.json, **/*.tsx, *.md",
        ],
    },
    "workspace.grep": {
        "desc": "Regex search file contents. Output mode: content, files_with_matches, or count.",
        "args": {
            "pattern": "string (required) — Regex pattern",
            "path": "string (optional) — Directory or file",
            "file_pattern": "string (optional) — e.g. *.ts",
            "output_mode": "string (optional) — content, files_with_matches, or count",
            "head_limit": "integer (optional) — Max lines to output",
        },
        "prompt_hints": [
            "正则搜、grep、regex search",
            "pattern: TODO|FIXME, ^import.*from, const\\s+\\w+\\s*=, @deprecated, class\\s+\\w+, async function",
        ],
    },
    "workspace.write_file": {
        "desc": "Create or overwrite a file in the workspace.",
        "args": {
            "path": "string (required) — Relative path to the file",
            "content": "string (required) — UTF-8 text content",
            "create_directories": "boolean (optional) — Create parent directories if needed",
        },
        "prompt_hints": [
            "创建、写入、保存、create、write、save",
            "content 是真实代码片段（2-10 行），不是占位符",
        ],
    },
    "workspace.edit_file": {
        "desc": "Perform exact string replacements in an existing file.",
        "args": {
            "path": "string (required) — Relative path to the file",
            "old_string": "string (required) — Text to find and replace",
            "new_string": "string (required) — Replacement text",
        },
        "prompt_hints": [
            "修改、替换、改成、replace、change、update",
            "old_string 是文件中存在的真实文本片段，new_string 是替换后的文本",
        ],
    },
    "workspace.run_shell": {
        "desc": "Execute a shell command in the workspace.",
        "args": {
            "command": "string (required) — Shell command to execute",
            "cwd": "string (optional) — Working directory",
            "timeout_sec": "integer (optional) — Timeout in seconds",
        },
        "prompt_hints": [
            "执行、运行、跑、run、execute、npm、git、python、bun",
            "安全命令：npm test, npm run build, npm run lint, npm install, git status, ls, python -m pytest, bun test, tsc --noEmit, node scripts/check.js, npm run typecheck, git diff",
            "危险命令不要生成（rm -rf, git push --force, sudo, chmod 等）",
        ],
    },
    "workspace.web_fetch": {
        "desc": "Fetch content from a URL and extract information.",
        "args": {
            "url": "string (required) — URL to fetch",
            "max_length": "integer (optional) — Max content length",
        },
        "prompt_hints": ["抓取、获取网页、fetch、get page"],
    },
    "workspace.web_search": {
        "desc": "Search the web and return results.",
        "args": {
            "query": "string (required) — Search query",
            "max_results": "integer (optional) — Max number of results",
        },
        "prompt_hints": ["搜一下、网上查、search the web、look up"],
    },
    "workspace.todo_write": {
        "desc": "Create and manage a structured task list.",
        "args": {
            "todos": "array (required) — [{id, content, status(pending|in_progress|done), priority?(low|medium|high)}]",
        },
        "prompt_hints": ["创建任务、更新 todo、mark as done、任务列表"],
    },
    "workspace.git_status": {
        "desc": "Show the working tree status.",
        "args": {},
        "prompt_hints": ["git status、看看改了哪些文件、查看状态"],
    },
    "workspace.git_log": {
        "desc": "Show recent commit history.",
        "args": {"max_count": "integer (optional) — Number of commits"},
        "prompt_hints": ["查看提交历史、最近的 commit、git log"],
    },
    "workspace.git_diff": {
        "desc": "Show changes between commits or working tree.",
        "args": {"path": "string (optional) — File path to limit diff"},
        "prompt_hints": ["看看改了什么、diff、what changed"],
    },
    "workspace.brief": {
        "desc": "Generate a quick overview of a directory.",
        "args": {
            "path": "string (optional) — Directory, defaults to root",
            "max_files": "integer (optional) — Max files",
        },
        "prompt_hints": ["快速看下结构、项目概览、brief、overview"],
    },
    "workspace.symbol_search": {
        "desc": "Search for function/class/interface definitions by name (AST-based).",
        "args": {
            "query": "string (required) — Symbol name or pattern",
            "max_results": "integer (optional)",
        },
        "prompt_hints": ["找定义、搜索符号、where is X defined、find definition of"],
    },
    "workspace.apply_patch": {
        "desc": "Apply a unified diff patch to the workspace.",
        "args": {"patch": "string (required) — Unified diff string"},
        "prompt_hints": ["应用 patch、打补丁、apply this diff"],
    },
    "workspace.run_agent": {
        "desc": "Launch a sub-agent to handle a complex, multi-step task.",
        "args": {
            "goal": "string (required) — Goal for the sub-agent",
            "max_steps": "integer (optional) — Max steps",
            "agent_type": "string (optional) — simple|research|coding|planning|relay",
            "child_policy": "string (optional) — read_only or read_write",
        },
        "prompt_hints": [
            "分一个子 agent、spawn agent、并行处理",
            "goal 是英文的完整任务描述",
        ],
    },
    "workspace.run_skill": {
        "desc": "Execute a skill within the conversation.",
        "args": {
            "skill_id": "string (required) — ID of the skill",
            "args": "object (optional) — Arguments for the skill",
        },
        "prompt_hints": ["执行 skill、调用技能、run skill"],
    },
    "memory.list": {
        "desc": "List persistent project memory entries.",
        "args": {},
        "prompt_hints": ["列出记忆、查看记忆、what memories"],
    },
    "memory.read": {
        "desc": "Read a persistent memory entry by name.",
        "args": {"name": "string (required) — Memory entry name"},
        "prompt_hints": ["读取记忆 xxx、回忆一下、read memory"],
    },
}


def build_tool_catalog() -> str:
    """Generate the tool catalog section matching registry.ts:toolCatalogText()."""
    lines = ["Tools (reply with one or more JSON objects, each on its own line, when calling tools):"]
    lines.append('{"tool":"workspace.read_file","args":{"path":"<relative-path>","offset":0,"limit":200}}')
    lines.append('{"tool":"workspace.list_dir","args":{"path":".","recursive":false}}')
    lines.append('{"tool":"workspace.search","args":{"pattern":"<text-or-regex>","path":".","file_pattern":"*.ts","max_results":50}}')
    lines.append('{"tool":"workspace.glob","args":{"pattern":"<glob-pattern e.g. **/*.ts>","path":".","max_depth":6}}')
    lines.append('{"tool":"workspace.grep","args":{"pattern":"<regex>","path":".","file_pattern":"*.ts","output_mode":"files_with_matches","head_limit":250}}')
    lines.append('{"tool":"workspace.write_file","args":{"path":"<relative-path>","content":"<utf-8 text>","create_directories":true}}')
    lines.append('{"tool":"workspace.edit_file","args":{"path":"<relative-path>","old_string":"<text to find>","new_string":"<replacement>"}}')
    lines.append('{"tool":"workspace.run_shell","args":{"command":"<shell command>","cwd":".","timeout_sec":60}}')
    lines.append('{"tool":"workspace.web_fetch","args":{"url":"<https://...>","max_length":50000}}')
    lines.append('{"tool":"workspace.web_search","args":{"query":"<search terms>","max_results":5}}')
    lines.append('{"tool":"workspace.todo_write","args":{"todos":[{"id":"1","content":"<task>","status":"pending","priority":"medium"}]}}')
    lines.append('{"tool":"workspace.git_status","args":{}}')
    lines.append('{"tool":"workspace.git_log","args":{"max_count":10}}')
    lines.append('{"tool":"workspace.git_diff","args":{"path":"<optional-file-path>"}}')
    lines.append('{"tool":"workspace.brief","args":{"path":".","max_files":50}}')
    lines.append('{"tool":"workspace.run_agent","args":{"goal":"<sub-goal>","max_steps":10}}')
    lines.append('{"tool":"workspace.run_skill","args":{"skill_id":"<skill-id>","args":{"param1":"value1"}}}')
    lines.append('{"tool":"workspace.symbol_search","args":{"query":"<symbol-name-or-pattern>","max_results":20}} — AST-based: find function/class/interface/type definitions by name')
    lines.append('{"tool":"workspace.apply_patch","args":{"patch":"<unified diff string>"}}')
    lines.append('{"tool":"memory.list","args":{}} — list persistent project memories')
    lines.append('{"tool":"memory.read","args":{"name":"<memory-name>"}} — read full memory entry by name')

    return "\n".join(lines)


def validate_tool_call(tool_name: str, args: dict | None) -> str | None:
    """Check: tool_name is registered, args is a dict, required string args are present."""
    if tool_name == "final_answer":
        return None  # handled separately
    if tool_name not in TOOLS:
        return f"unknown tool: {tool_name}"
    if not isinstance(args, dict):
        return f"args must be object, got {type(args).__name__}"
    schema = TOOLS[tool_name]["args"]
    for arg_name, arg_desc in schema.items():
        is_required = "(required)" in arg_desc
        if is_required and arg_name not in args:
            return f"missing required arg '{arg_name}' for {tool_name}"
    return None


def validate_response(text: str) -> str | None:
    """Validate that the assistant response contains at least one valid action JSON line."""
    lines = text.strip().split("\n")
    has_action = False
    for line in lines:
        line = line.strip()
        if not line.startswith("{"):
            continue
        try:
            obj = json.loads(line)
            if "tool" in obj and "args" in obj:
                err = validate_tool_call(obj["tool"], obj.get("args"))
                if err:
                    return err
                has_action = True
            elif "action" in obj:
                has_action = True
        except json.JSONDecodeError:
            continue
    if not has_action:
        return "no valid action JSON found"
    return None


# ── Claude API ──

def call_claude(system: str, user: str, max_tokens: int = 8000) -> str:
    import anthropic
    api_key = os.environ.get("ANTHROPIC_API_KEY")
    if not api_key:
        env_path = os.path.join(os.path.dirname(__file__), "..", ".env")
        if os.path.exists(env_path):
            with open(env_path) as f:
                for line in f:
                    if line.startswith("ANTHROPIC_API_KEY="):
                        api_key = line.strip().split("=", 1)[1].strip('"').strip("'")
                        break
    if not api_key:
        raise RuntimeError("ANTHROPIC_API_KEY not set")

    client = anthropic.Anthropic(api_key=api_key)
    response = client.messages.create(
        model="claude-sonnet-4-6",
        max_tokens=max_tokens,
        system=system,
        messages=[{"role": "user", "content": user}],
    )
    return response.content[0].text


def parse_generated(text: str) -> list[dict]:
    """Extract ChatML-format samples from Claude's output.
    Claude should return one sample per line: {"user_prompt":"...","assistant_response":"..."}
    """
    results = []
    for line in text.strip().split("\n"):
        line = line.strip()
        if not line or not line.startswith("{"):
            continue
        try:
            obj = json.loads(line)
            if "user_prompt" in obj and "assistant_response" in obj:
                results.append(obj)
        except json.JSONDecodeError:
            continue
    return results


def generate_for_tool(tool_name: str, count: int, output_path: str, stats: dict, catalog: str):
    """Generate `count` samples for one tool."""
    info = TOOLS[tool_name]
    schema_lines = [f"  {a}: {d}" for a, d in info["args"].items()]
    hint_lines = info.get("prompt_hints", [])

    prompt = f"""Generate {count} training samples for the tool `{tool_name}`.

Tool: {tool_name}
Description: {info['desc']}
Arguments:
{chr(10).join(schema_lines)}

User prompt hints:
{chr(10).join(f'- {h}' for h in hint_lines)}

Requirements for user prompts:
- Mix Chinese (60%) and English (40%)
- Natural and varied phrasing — not always "read file X", use different phrasings
- Vary which optional args are included (~50% with, ~50% without)
- Paths should look real (README.md, src/main.ts, package.json, etc.)
- When including content (for write_file), use realistic 2-10 line code snippets
- For run_shell, use safe commands only (npm test, npm run build, npm run lint, git status, ls, tsc --noEmit, bun test, etc.)

Requirements for assistant responses:
- May include a brief reasoning sentence BEFORE the JSON (natural, like real model output)
- The JSON action MUST be on its own line
- Format: {{"tool":"{tool_name}","args":{{...}}}}
- For final_answer: {{"action":"final_answer","summary":"..."}}

Output format — one sample per line, all on a single line (no newlines within a sample):
{{"user_prompt":"...","assistant_response":"..."}}"""

    valid_samples = []
    for attempt in range(3):
        try:
            text = call_claude(PAW_SYSTEM_PROMPT, prompt)
            for item in parse_generated(text):
                # Validate assistant response
                err = validate_response(item["assistant_response"])
                if err:
                    stats["rejected"] += 1
                    continue
                # Build ChatML
                sample = {
                    "messages": [
                        {"role": "system", "content": PAW_SYSTEM_PROMPT + "\n\n" + catalog},
                        {"role": "user", "content": item["user_prompt"]},
                        {"role": "assistant", "content": item["assistant_response"]},
                    ]
                }
                valid_samples.append(sample)
            print(f"  attempt {attempt + 1}: {len(valid_samples)} valid so far")
            if len(valid_samples) >= count:
                break
        except Exception as e:
            print(f"  attempt {attempt + 1} failed: {e}")
            time.sleep(2)

    # Write
    with open(output_path, "a", encoding="utf-8") as f:
        for s in valid_samples[:count]:
            f.write(json.dumps(s, ensure_ascii=False) + "\n")
    return len(valid_samples[:count])


def main():
    import argparse
    parser = argparse.ArgumentParser()
    parser.add_argument("--per-tool", type=int, default=40)
    parser.add_argument("--output", type=str, default="training_data/stage_a_paw_format.jsonl")
    parser.add_argument("--dry-run", action="store_true")
    args = parser.parse_args()

    os.makedirs(os.path.dirname(args.output), exist_ok=True)
    with open(args.output, "w") as f:
        pass

    catalog = build_tool_catalog()
    stats: dict[str, int] = {"rejected": 0, "total": 0}
    tool_counts = Counter()

    print(f"=== Stage A: Claude (Paw Code format) ===")
    print(f"Tools: {len(TOOLS)}, Per tool: {args.per_tool}")
    if args.dry_run:
        for name in TOOLS:
            print(f"  {name}")
        return

    for name in sorted(TOOLS):
        print(f"\n{name}...")
        c = generate_for_tool(name, args.per_tool, args.output, stats, catalog)
        tool_counts[name] = c
        stats["total"] += c
        time.sleep(1)

    print(f"\n=== Done ===")
    print(f"Total valid: {stats['total']}, Rejected: {stats['rejected']}")
    for t, c in tool_counts.most_common():
        print(f"  {t}: {c}")
    print(f"Output: {args.output}")


if __name__ == "__main__":
    main()
