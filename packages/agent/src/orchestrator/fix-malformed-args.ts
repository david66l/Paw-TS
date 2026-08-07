/**
 * 畸形工具参数修复（fix malformed tool arguments）。
 * ==================================================
 *
 * 部分模型在原生 function calling 下会输出参数类型错误，常见两类：
 *
 * 1. **list/dict 参数被编码成 JSON 字符串**（如 GLM 4.6 把 view_range 输出为
 *    "[1, 5]" 而非 [1, 5]）——按工具 schema 声明的字段类型解码回原生数组/对象。
 * 2. **字符串参数被切成数组块**（部分模型对长字符串做 chunking，
 *    把 old_str/new_str 输出为字符串数组）——拼回单个字符串。
 *
 * 修复依据是工具定义的 JSON Schema（ToolDefinition.function.parameters），
 * 与模型无关，任何 provider 的输出都会先经过这一层再执行。
 */

import type { ToolDefinition } from "@paw/models";

type JsonSchema = Record<string, unknown>;

/**
 * 按工具 schema 修复畸形参数。未声明 schema 的工具原样返回。
 */
export function fixMalformedToolArguments(
  args: Record<string, unknown>,
  toolName: string,
  toolDefs: readonly ToolDefinition[],
): Record<string, unknown> {
  const def = toolDefs.find((d) => d.function.name === toolName);
  const parameters = def?.function.parameters;
  const properties = asRecord(parameters)?.properties;
  if (!properties || typeof properties !== "object") {
    return args;
  }
  return fixRecord(args, properties as Record<string, JsonSchema>);
}

/** 递归修复一个对象的所有字段。 */
function fixRecord(
  args: Record<string, unknown>,
  props: Record<string, JsonSchema>,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(args)) {
    const schema = props[key];
    out[key] = schema ? fixValue(value, schema) : value;
  }
  return out;
}

/** 按单个字段的 schema 修复值。 */
function fixValue(value: unknown, schema: JsonSchema): unknown {
  const type = schema.type;
  // 1. JSON 字符串编码的数组 → 解码（GLM 4.6 等）
  if (type === "array" && typeof value === "string") {
    try {
      const parsed = JSON.parse(value);
      if (Array.isArray(parsed)) return parsed;
    } catch {
      /* 保留原字符串 */
    }
  }
  // 2. JSON 字符串编码的对象 → 解码
  if (type === "object" && typeof value === "string") {
    try {
      const parsed = JSON.parse(value);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        return parsed;
      }
    } catch {
      /* 保留原字符串 */
    }
  }
  // 3. 字符串被切成字符串数组块 → 拼回
  if (
    type === "string" &&
    Array.isArray(value) &&
    value.length > 0 &&
    value.every((v) => typeof v === "string")
  ) {
    return value.join("");
  }
  // 4. 嵌套对象 → 递归修复
  if (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    typeof schema.properties === "object" &&
    schema.properties !== null
  ) {
    return fixRecord(
      value as Record<string, unknown>,
      schema.properties as Record<string, JsonSchema>,
    );
  }
  return value;
}

function asRecord(v: unknown): Record<string, unknown> | null {
  if (v && typeof v === "object" && !Array.isArray(v)) {
    return v as Record<string, unknown>;
  }
  return null;
}
