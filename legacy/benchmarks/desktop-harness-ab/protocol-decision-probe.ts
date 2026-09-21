// Isolated paid protocol ablation. Tools are described but NEVER executed.
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import {
  PAW_AGENT_SYSTEM_PROMPT,
  PAW_CODING_EXECUTION_GUIDANCE,
} from "../../apps/desktop/agent-host/agent-system-prompt.js";
import { createDefaultLanguageModel } from "../../packages/models/src/index.js";
import {
  defaultSettingsPath,
  loadPawSettingsLocal,
  resolveApiKey,
} from "../../packages/settings/src/index.js";

process.env.PAW_TELEMETRY_ENABLED = "0";
const [sourceArg, outputArg, arm, waitFlag, ...extra] = process.argv.slice(2);
if (
  !sourceArg ||
  !outputArg ||
  (waitFlag !== undefined && waitFlag !== "--extended") ||
  extra.length > 0 ||
  ![
    "openai",
    "anthropic",
    "anthropic-default-sampling",
    "native-zcode",
    "native-paw-system",
  ].includes(arm ?? "")
)
  throw new Error(
    "Usage: protocol-decision-probe.ts captured-request.json fresh-output openai|anthropic|anthropic-default-sampling|native-zcode|native-paw-system [--extended]",
  );
const repo = path.resolve(import.meta.dir, "../../..");
const source = path.resolve(sourceArg);
const output = path.resolve(outputArg);
if (fs.existsSync(output)) throw new Error("Fresh output required");
const original = JSON.parse(fs.readFileSync(source, "utf8"));
const native = arm === "native-zcode" || arm === "native-paw-system";
const profile = createDefaultLanguageModel(repo).runtimeProfile;
if (
  !profile ||
  new URL(profile.baseUrl).hostname !== "open.bigmodel.cn" ||
  original.model !== "glm-5.3-flash" ||
  (native
    ? original.output_config?.effort !== "max"
    : original.reasoning_effort !== "max") ||
  original.max_tokens !== 128000
)
  throw new Error("Expected the captured BigModel GLM max request");
const settings = loadPawSettingsLocal(defaultSettingsPath(repo));
const key =
  (settings.provider && settings.models?.[settings.provider]?.apiKey?.trim()) ||
  resolveApiKey(settings, "glm");
if (!key) throw new Error("Missing local credential");
const normalized = structuredClone(original);
let removedReasoningChars = 0;
for (const message of native ? [] : normalized.messages) {
  removedReasoningChars += (message.reasoning_content ?? "").length;
  message.reasoning_content = undefined;
}
const isAnthropic = arm !== "openai";
let body = normalized;
if (isAnthropic && !native) {
  const messages: { role: string; content: Record<string, unknown>[] }[] = [];
  for (const message of normalized.messages) {
    if (message.role === "system") continue;
    if (message.role === "tool") {
      const block = {
        type: "tool_result",
        tool_use_id: message.tool_call_id,
        content: message.content,
      };
      const last = messages.at(-1);
      if (
        last?.role === "user" &&
        last.content.every((item) => item.type === "tool_result")
      )
        last.content.push(block);
      else messages.push({ role: "user", content: [block] });
    } else {
      if (typeof message.content !== "string")
        throw new Error("Expected text-only captured history");
      const content: Record<string, unknown>[] = message.content
        ? [{ type: "text", text: message.content }]
        : [];
      for (const call of message.tool_calls ?? [])
        content.push({
          type: "tool_use",
          id: call.id,
          name: call.function.name,
          input: JSON.parse(call.function.arguments),
        });
      if (!content.length)
        throw new Error("Empty assistant turn cannot be migrated");
      messages.push({ role: message.role, content });
    }
  }
  body = {
    model: original.model,
    max_tokens: original.max_tokens,
    system: normalized.messages
      .filter((m: { role: string }) => m.role === "system")
      .map((m: { content: string }) => ({ type: "text", text: m.content })),
    messages,
    tools: normalized.tools.map(
      (t: {
        function: { name: string; description: string; parameters: unknown };
      }) => ({
        name: t.function.name,
        description: t.function.description,
        input_schema: t.function.parameters,
      }),
    ),
    thinking: { type: "enabled", budget_tokens: 32000 },
    output_config: { effort: "max" },
    tool_choice: { type: "auto" },
    stream: true,
    ...(arm === "anthropic"
      ? { temperature: original.temperature, top_p: original.top_p }
      : {}),
  };
}
if (native) {
  if (
    original.thinking?.budget_tokens !== 32000 ||
    original.system?.length !== 3 ||
    original.tools?.length !== 8
  )
    throw new Error("Expected native ZCode max benchmark request");
  if (arm === "native-paw-system") {
    // Preserve the native environment/context-management block and every cache
    // marker. Change only the identity/harness guidance to Paw's actual exports.
    body.system[0] = { ...body.system[0], text: PAW_AGENT_SYSTEM_PROMPT };
    body.system[1] = { ...body.system[1], text: PAW_CODING_EXECUTION_GUIDANCE };
  }
}
const endpoint = isAnthropic
  ? "https://open.bigmodel.cn/api/anthropic/v1/messages"
  : `${profile.baseUrl.replace(/\/$/, "")}/chat/completions`;
fs.mkdirSync(output, { recursive: true });
const write = (name: string, value: unknown) =>
  fs.writeFileSync(path.join(output, name), JSON.stringify(value, null, 2));
const sha = (s: string | Buffer) =>
  createHash("sha256").update(s).digest("hex");
const wallMs = native || waitFlag === "--extended" ? 360000 : 240000;
const promptSource = path.join(
  repo,
  "apps/desktop/agent-host/agent-system-prompt.ts",
);
write("protocol.json", {
  arm,
  source,
  sourceSha256: sha(fs.readFileSync(source)),
  scriptSha256: sha(fs.readFileSync(import.meta.path)),
  endpoint,
  wallMs,
  waitPolicy: native
    ? "native-360s"
    : waitFlag === "--extended"
      ? "extended-360s"
      : "default-240s",
  removedReasoningChars,
  ...(native ? { promptSourceSha256: sha(fs.readFileSync(promptSource)) } : {}),
  notes: native
    ? [
        "Native benchmark request replay; preserve all signed thinking, tool history, tools, metadata, max effort, budget, sampling omissions and cache markers",
        "native-zcode preserves the entire JSON body; native-paw-system replaces only system[0].text and system[1].text using Paw production exports",
        "The native environment/context-management block stays identical, so this tests identity/harness guidance, not every possible system difference",
        "360-second full-response collection; no tools executed, no automatic retry, no Docker or user ZCode process started",
        "Initial usage is provisional; only a provider terminal event supplies a settled result",
      ]
    : [
        "No historical ZCode user data is sent; only the frozen Paw task, system and tool contract participate",
        "Historical reasoning removed symmetrically; no Anthropic signatures fabricated",
        "Native call IDs/names, parsed arguments, tool results, system and user texts preserved across format conversion",
        "Protocol and provider-specific thinking settings necessarily change together; budget_tokens enforcement is not assumed",
        "OpenAI auto is omitted as captured; Anthropic auto is explicit",
        "Raw streams local and ignored; no tools executed, no retry; timeout usage unknown",
      ],
});
write("request.json", body);
fs.copyFileSync(import.meta.path, path.join(output, "source-snapshot.ts"));
if (native)
  fs.copyFileSync(promptSource, path.join(output, "prompt-source-snapshot.ts"));
const controller = new AbortController();
const started = Date.now();
const timer = setTimeout(() => controller.abort(), wallMs);
const slots = new Map<
  number,
  { index: number; id: string; name: string; arguments: string }
>();
const result = {
  arm,
  status: "pending",
  httpStatus: 0,
  firstThinkingMs: null as number | null,
  firstToolMs: null as number | null,
  durationMs: 0,
  thinkingChars: 0,
  textChars: 0,
  usage: null as unknown,
  finishReason: null as unknown,
  tools: [] as unknown[],
  errorType: null as string | null,
};
const progress = setInterval(
  () =>
    console.log(
      JSON.stringify({
        event: "protocol.progress",
        arm,
        elapsedMs: Date.now() - started,
        thinkingChars: result.thinkingChars,
        textChars: result.textChars,
        firstToolMs: result.firstToolMs,
      }),
    ),
  30000,
);
const fd = fs.openSync(path.join(output, "response.sse"), "wx");
console.log(
  JSON.stringify({
    event: "protocol.start",
    arm,
    wallMs,
    removedReasoningChars,
  }),
);
try {
  const response = await fetch(endpoint, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(isAnthropic
        ? { "x-api-key": key, "anthropic-version": "2023-06-01" }
        : { Authorization: `Bearer ${key}` }),
    },
    body: JSON.stringify(body),
    signal: controller.signal,
  });
  result.httpStatus = response.status;
  if (!response.ok || !response.body) {
    result.status = "http_error";
    // Body retained privately, never headers/credentials or raw errors in stdout.
    fs.writeFileSync(
      path.join(output, "http-error.txt"),
      await response.text(),
    );
  } else {
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    read: while (true) {
      const { done, value } = await reader.read();
      if (done) {
        result.status = "eof_without_terminal";
        break;
      }
      fs.writeSync(fd, value);
      buffer += decoder.decode(value, { stream: true });
      while (buffer.includes("\n")) {
        const newline = buffer.indexOf("\n");
        const line = buffer.slice(0, newline).trim();
        buffer = buffer.slice(newline + 1);
        if (!line.startsWith("data:")) continue;
        const data = line.slice(5).trim();
        if (data === "[DONE]") {
          result.status = "provider_done";
          break read;
        }
        const event = JSON.parse(data);
        if (event.type === "error" || event.error) {
          result.status = "provider_error";
          result.errorType = event.error?.type ?? "unknown";
          break read;
        }
        if (isAnthropic) {
          if (event.type === "message_start")
            result.usage = event.message?.usage ?? null;
          if (event.usage)
            result.usage = {
              ...((result.usage as object) ?? {}),
              ...event.usage,
            };
          if (event.type === "message_delta")
            result.finishReason =
              event.delta?.stop_reason ?? result.finishReason;
          if (event.type === "message_stop") {
            result.status = "provider_done";
            break read;
          }
          if (event.type === "content_block_start") {
            const b = event.content_block;
            if (b?.type === "tool_use") {
              result.firstToolMs ??= Date.now() - started;
              slots.set(event.index, {
                index: event.index,
                id: b.id,
                name: b.name,
                arguments:
                  b.input && Object.keys(b.input).length
                    ? JSON.stringify(b.input)
                    : "",
              });
            }
            if (b?.thinking) {
              result.firstThinkingMs ??= Date.now() - started;
              result.thinkingChars += b.thinking.length;
            }
            if (b?.text) result.textChars += b.text.length;
          }
          if (event.type === "content_block_delta") {
            const d = event.delta;
            if (d?.thinking) {
              result.firstThinkingMs ??= Date.now() - started;
              result.thinkingChars += d.thinking.length;
            }
            if (d?.text) result.textChars += d.text.length;
            if (d?.partial_json) {
              const slot = slots.get(event.index);
              if (!slot) throw new Error("Unpaired tool fragment");
              slot.arguments += d.partial_json;
            }
          }
        } else {
          if (event.usage) result.usage = event.usage;
          for (const choice of event.choices ?? []) {
            result.finishReason = choice.finish_reason ?? result.finishReason;
            const d = choice.delta ?? {};
            if (d.reasoning_content) {
              result.firstThinkingMs ??= Date.now() - started;
              result.thinkingChars += d.reasoning_content.length;
            }
            result.textChars += (d.content ?? "").length;
            for (const part of d.tool_calls ?? []) {
              result.firstToolMs ??= Date.now() - started;
              let slot = slots.get(part.index);
              if (!slot) {
                slot = { index: part.index, id: "", name: "", arguments: "" };
                slots.set(part.index, slot);
              }
              if (part.id) slot.id = part.id;
              slot.name += part.function?.name ?? "";
              slot.arguments += part.function?.arguments ?? "";
            }
          }
        }
      }
    }
    reader.releaseLock();
  }
} catch (error) {
  result.status = controller.signal.aborted
    ? "wall_timeout"
    : "transport_or_parse_error";
  result.errorType = error instanceof Error ? error.name : "unknown";
} finally {
  clearTimeout(timer);
  clearInterval(progress);
  controller.abort();
  fs.closeSync(fd);
  result.durationMs = Date.now() - started;
  result.tools = [...slots.values()];
  write("result.json", result);
  console.log(
    JSON.stringify({
      ...result,
      tools: [...slots.values()].map(({ name, arguments: args }) => ({
        name,
        argumentChars: args.length,
      })),
    }),
  );
}
