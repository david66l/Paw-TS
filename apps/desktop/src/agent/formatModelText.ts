/**
 * 把模型原始输出转成界面可读结构。
 * - 剥离 / 分离 thinking
 * - 纯工具调用 JSON → content null（由 tool.call 芯片表达）
 * - final_answer JSON → 只展示 summary
 * - 流式未闭合 JSON → 不把半截 JSON 刷上屏（避免闪一大坨）
 */

export type FormatModelOutput = {
  /** 展示给用户的正文；null 表示不展示正文（工具调用或尚无可展示内容） */
  readonly content: string | null;
  /** 从正文里拆出的思考（标签内） */
  readonly thinking: string;
};

/**
 * 从文本中拆出 thinking / think 标签内容。
 * 未闭合标签在 streaming 时也尽量拆出已输出部分。
 */
export function extractEmbeddedThinking(
  raw: string,
  options?: { readonly streaming?: boolean },
): { text: string; thinking: string } {
  const streaming = options?.streaming === true;
  const thinks: string[] = [];
  let text = raw;

  // 闭合标签
  text = text.replace(
    /<\s*(thinking|think)\s*>([\s\S]*?)<\s*\/\s*\1\s*>/gi,
    (_m, _tag: string, body: string) => {
      const t = body.trim();
      if (t) thinks.push(t);
      return "";
    },
  );

  // 流式：未闭合的开标签，后续都当 thinking
  if (streaming) {
    const open = /<\s*(thinking|think)\s*>/i.exec(text);
    if (open && open.index !== undefined) {
      const after = text.slice(open.index + open[0].length);
      // 若还没出现闭合，整段归 thinking
      if (!/<\s*\/\s*(thinking|think)\s*>/i.test(after)) {
        const t = after.trim();
        if (t) thinks.push(t);
        text = text.slice(0, open.index);
      }
    }
  }

  return {
    text: text.replace(/\n{3,}/g, "\n\n").trim(),
    thinking: thinks.join("\n\n").trim(),
  };
}

function extractJsonObject(text: string): string | null {
  try {
    JSON.parse(text);
    return text;
  } catch {
    /* 前面可能有自然语言 */
  }
  const start = text.indexOf("{");
  if (start < 0) return null;
  let depth = 0;
  let inString = false;
  let escape = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i]!;
    if (inString) {
      if (escape) escape = false;
      else if (ch === "\\") escape = true;
      else if (ch === "\"") inString = false;
      continue;
    }
    if (ch === "\"") {
      inString = true;
      continue;
    }
    if (ch === "{") depth++;
    else if (ch === "}") {
      depth--;
      if (depth === 0) return text.slice(start, i + 1);
    }
  }
  return null;
}

/**
 * 模型常把换行直接写进 JSON 字符串（非法），导致 JSON.parse 失败。
 * 在字符串内部把裸 \n/\r/\t 转义，便于二次解析。
 */
function repairJsonStringControlChars(input: string): string {
  let out = "";
  let inString = false;
  let escape = false;
  for (let i = 0; i < input.length; i++) {
    const ch = input[i]!;
    if (inString) {
      if (escape) {
        out += ch;
        escape = false;
        continue;
      }
      if (ch === "\\") {
        out += ch;
        escape = true;
        continue;
      }
      if (ch === "\"") {
        inString = false;
        out += ch;
        continue;
      }
      if (ch === "\n") {
        out += "\\n";
        continue;
      }
      if (ch === "\r") {
        out += "\\r";
        continue;
      }
      if (ch === "\t") {
        out += "\\t";
        continue;
      }
      out += ch;
      continue;
    }
    if (ch === "\"") {
      inString = true;
      out += ch;
      continue;
    }
    out += ch;
  }
  return out;
}

/**
 * 从可能非法的 JSON 里抠 `"summary":"..."`（允许字符串内裸换行）。
 */
function extractJsonStringField(blob: string, field: string): string | null {
  const re = new RegExp(`"${field}"\\s*:\\s*"`);
  const m = re.exec(blob);
  if (!m || m.index === undefined) return null;
  let i = m.index + m[0].length;
  let out = "";
  while (i < blob.length) {
    const ch = blob[i]!;
    if (ch === "\\") {
      const next = blob[i + 1];
      if (next === undefined) break;
      if (next === "n") out += "\n";
      else if (next === "r") out += "\r";
      else if (next === "t") out += "\t";
      else if (next === '"' || next === "\\") out += next;
      else out += next;
      i += 2;
      continue;
    }
    if (ch === "\"") {
      // 像字段结束：引号后空白 + , 或 }
      const rest = blob.slice(i + 1).match(/^\s*([,}])/);
      if (rest) return out;
      // 否则当作正文里的引号
      out += ch;
      i += 1;
      continue;
    }
    out += ch;
    i += 1;
  }
  return out.length > 0 ? out : null;
}

/** 宽松解析 action/tool JSON（含非法裸换行） */
function parseActionLikeObject(blob: string): Record<string, unknown> | null {
  try {
    return JSON.parse(blob) as Record<string, unknown>;
  } catch {
    /* repair then retry */
  }
  try {
    return JSON.parse(repairJsonStringControlChars(blob)) as Record<
      string,
      unknown
    >;
  } catch {
    /* field-level fallback */
  }

  const action = extractJsonStringField(blob, "action");
  if (action === "final_answer") {
    const summary = extractJsonStringField(blob, "summary");
    if (typeof summary === "string") {
      return { action: "final_answer", summary };
    }
    return { action: "final_answer", summary: "" };
  }
  if (action) {
    return { action };
  }
  const tool = extractJsonStringField(blob, "tool");
  if (tool) {
    return { tool };
  }
  return null;
}

/** 看起来像在吐 JSON，但尚未闭合 */
function hasIncompleteJsonPayload(text: string): boolean {
  const trimmed = text.trim();
  if (!trimmed.includes("{")) return false;
  // 已有完整可解析 JSON 对象则不算 incomplete
  if (extractJsonObject(trimmed)) return false;
  // 以 { 开头，或自然语言后接 { 且像 action/tool 结构
  if (trimmed.startsWith("{")) return true;
  const start = trimmed.indexOf("{");
  if (start < 0) return false;
  const tail = trimmed.slice(start);
  return (
    /"action"\s*:/.test(tail) ||
    /"tool"\s*:/.test(tail) ||
    /"summary"\s*:/.test(tail) ||
    /"args"\s*:/.test(tail)
  );
}

/**
 * 正文展示格式化。
 * @param streaming 流式阶段：抑制未闭合 JSON，避免闪屏
 */
export function formatModelOutputForUi(
  raw: string,
  options?: { readonly streaming?: boolean },
): FormatModelOutput {
  const streaming = options?.streaming === true;
  const embedded = extractEmbeddedThinking(raw, { streaming });
  let text = embedded.text;
  const thinking = embedded.thinking;

  if (!text) {
    return { content: null, thinking };
  }

  // 流式：半截 JSON 不上屏，只保留 JSON 前的自然语言前缀
  if (streaming && hasIncompleteJsonPayload(text)) {
    const idx = text.indexOf("{");
    const preface = idx >= 0 ? text.slice(0, idx).trim() : "";
    return { content: preface.length > 0 ? preface : null, thinking };
  }

  const jsonBlob = extractJsonObject(text);
  if (jsonBlob) {
    const obj = parseActionLikeObject(jsonBlob);
    if (obj) {
      if (obj.action === "final_answer" && typeof obj.summary === "string") {
        const preface = text.slice(0, text.indexOf(jsonBlob)).trim();
        const summary = obj.summary.trim();
        if (!summary && !preface) {
          return { content: null, thinking };
        }
        const content = preface
          ? summary
            ? `${preface}\n\n${summary}`
            : preface
          : summary;
        return { content, thinking };
      }
      if (typeof obj.tool === "string") {
        const preface = text.slice(0, text.indexOf(jsonBlob)).trim();
        return {
          content: preface.length > 0 ? preface : null,
          thinking,
        };
      }
      // 其它 action JSON（plan_update / abort 等）不进正文
      if (typeof obj.action === "string") {
        const preface = text.slice(0, text.indexOf(jsonBlob)).trim();
        return {
          content: preface.length > 0 ? preface : null,
          thinking,
        };
      }
    }
  }

  // 兜底：整段看起来像泄漏的 write_file 载荷（格式化失败时）
  if (
    /"tool"\s*:\s*"workspace\.(write_file|edit_file)"/.test(text) &&
    /"content"\s*:/.test(text)
  ) {
    const idx = text.indexOf("{");
    const preface = idx >= 0 ? text.slice(0, idx).trim() : "";
    return { content: preface.length > 0 ? preface : null, thinking };
  }

  // 兜底：全文即 final_answer，但 extractJsonObject 失败（极少）
  if (/"action"\s*:\s*"final_answer"/.test(text)) {
    const summary = extractJsonStringField(text, "summary");
    if (summary?.trim()) {
      return { content: summary.trim(), thinking };
    }
  }

  return { content: text, thinking };
}

/** 兼容旧调用：只要 content 字符串 */
export function formatModelTextForUi(raw: string): string | null {
  return formatModelOutputForUi(raw).content;
}

/**
 * chunk 流：部分模型发「累积快照」，部分发「增量」。
 * - 新文本以旧文本为前缀 → 当作快照，整段替换
 * - 否则当作增量，拼接
 */
export function mergeStreamText(previous: string, incoming: string): string {
  if (!previous) return incoming;
  if (!incoming) return previous;
  if (incoming.startsWith(previous)) return incoming;
  if (previous.startsWith(incoming)) return previous;
  return previous + incoming;
}

/**
 * 合并两路 thinking（通道事件 + 正文内嵌），避免重复。
 * 若一方像是另一方的「乱序拼接」或高度重叠，取更干净的一侧。
 */
export function mergeThinking(channel: string, embedded: string): string {
  const a = channel.trim();
  const b = embedded.trim();
  if (!a) return b;
  if (!b) return a;
  if (a.includes(b)) return a;
  if (b.includes(a)) return b;
  // 检测明显重复拼接：同一短句出现 3 次以上 → 取较短/较干净的
  const repeatScore = (s: string) => {
    const head = s.slice(0, 40);
    if (head.length < 12) return 0;
    return s.split(head).length - 1;
  };
  const ra = repeatScore(a);
  const rb = repeatScore(b);
  if (ra >= 3 && rb < ra) return b;
  if (rb >= 3 && ra < rb) return a;
  if (ra >= 3 && rb >= 3) return a.length <= b.length ? a : b;
  return `${a}\n\n${b}`;
}
