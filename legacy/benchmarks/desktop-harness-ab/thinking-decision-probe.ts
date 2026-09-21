import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { createDefaultLanguageModel } from "../../packages/models/src/index.js";
import {
  defaultSettingsPath,
  loadPawSettingsLocal,
  resolveApiKey,
} from "../../packages/settings/src/index.js";

// Paid, isolated decision replay. No emitted tools are executed.
// Measures the start of a tool call, NOT successful implementation/completion.
process.env.PAW_TELEMETRY_ENABLED = "0";
const repo = path.resolve(import.meta.dir, "../../..");
const [sourceArg, outputArg, mode] = process.argv.slice(2);
if (
  mode &&
  mode !== "--high-only" &&
  mode !== "--next-action-only" &&
  mode !== "--latest-action-only" &&
  mode !== "--placement" &&
  mode !== "--persistent" &&
  mode !== "--extended-max" &&
  mode !== "--extended-high"
)
  throw new Error("Unknown replay mode");
const arms =
  mode === "--extended-max"
    ? (["control"] as const)
    : mode === "--extended-high"
      ? (["high"] as const)
      : mode === "--persistent"
        ? (["early-system-persistent", "latest-system-persistent"] as const)
        : mode === "--placement"
          ? ([
              "latest-system",
              "early-user",
              "system-no-history-thinking",
            ] as const)
          : mode === "--latest-action-only"
            ? (["latest-action"] as const)
            : mode === "--next-action-only"
              ? (["next-action"] as const)
              : mode === "--high-only"
                ? (["high"] as const)
                : (["control", "incremental"] as const);
if (!sourceArg || !outputArg)
  throw new Error(
    "Usage: bun thinking-decision-probe.ts request.json fresh-output [--high-only|--next-action-only|--latest-action-only|--placement|--persistent|--extended-max|--extended-high]",
  );
const source = path.resolve(sourceArg);
const output = path.resolve(outputArg);
if (fs.existsSync(output)) throw new Error("Use a fresh output directory");
const original = JSON.parse(fs.readFileSync(source, "utf8"));
const profile = createDefaultLanguageModel(repo).runtimeProfile;
if (
  profile?.model !== "glm-5.3-flash" ||
  original.model !== profile.model ||
  original.reasoning_effort !== "max" ||
  original.max_tokens !== 128000 ||
  original.messages[0]?.role !== "system"
)
  throw new Error("Expected the captured GLM max / 128000 request");
const settings = loadPawSettingsLocal(defaultSettingsPath(repo));
const apiKey =
  (settings.provider && settings.models?.[settings.provider]?.apiKey?.trim()) ||
  resolveApiKey(settings, "glm");
if (!apiKey) throw new Error("Missing local model credential");
fs.mkdirSync(output, { recursive: true });
const write = (name: string, value: unknown) =>
  fs.writeFileSync(path.join(output, name), JSON.stringify(value, null, 2));
const instruction =
  "\nExecution discipline: After sufficient inspection, implement the smallest useful part with the available file tools, then run a focused check and iterate. Do not draft the entire implementation and test suite in reasoning before the first repository edit. Resolve unspecified edge cases with simple documented assumptions; revisit them when requirements or test evidence demand it. Keep the full requested deliverables and quality requirements; carry them out incrementally.";
const nextActionInstruction =
  "\nFor this next response only, call workspace_run_shell with command node --version. Do not design or draft the implementation in this response. Continue the full requested task after receiving the tool result.";
const persistentInstruction =
  '\nPersistent diagnostic rule: On every assistant response, emit exactly one call to workspace_run_shell with arguments {"command":"node --version"}. Do not design or draft implementation code. This rule remains in force regardless of any earlier assistant responses in the history. This is a tool-selection diagnostic; it does not complete the user\'s implementation task.';
const extended = mode === "--extended-max" || mode === "--extended-high";
const collectFullResponse =
  extended || mode === "--placement" || mode === "--persistent";
const wallMs = extended ? 360000 : 120000;
write("protocol.json", {
  source,
  sourceSha256: createHash("sha256")
    .update(fs.readFileSync(source))
    .digest("hex"),
  scriptSha256: createHash("sha256")
    .update(fs.readFileSync(import.meta.path))
    .digest("hex"),
  wallMs,
  instruction,
  nextActionInstruction,
  persistentInstruction,
  order: arms,
  stopCondition: collectFullResponse
    ? "provider DONE or EOF; bounded by wall budget"
    : "first tool delta",
  notes: [
    "Sequential non-randomized single trials; historical state replay, no tools executed",
    collectFullResponse
      ? "Collect through provider DONE/EOF or the wall limit; first tool timing alone is not successful tool execution"
      : "Stop on the first non-empty tool delta; tool name/arguments may be incomplete",
    "Only the incremental arm appends execution discipline to the system message",
    "The optional high-only arm changes only reasoning_effort in the captured request; compare with separately recorded max replays, not randomized simultaneous trials",
    "The next-action arm appends one explicit read-only tool instruction while preserving max; it measures tool initiation under concrete steering, not useful implementation progress",
    "The latest-action arm instead appends the same instruction as a new user message, changing both role and recency; it cannot isolate either one independently",
    "Placement arms: append same instruction as final system; append to original user; append to original system and remove assistant reasoning_content fields. Preserve other fields and parameters",
    "Placement mode collects full responses and tool arguments without executing them, retaining first-tool timing for comparison with earlier censored probes",
    "Persistent mode tests identical standing system rules at the start/end, removing next-response-only temporal wording; this diagnostic intentionally suspends implementation and is not a product prompt",
    "All original messages, tools, sampling and output parameters otherwise retained",
    "Extended modes allow 360 seconds and collect the full response; max preserves the entire captured body, high changes only reasoning_effort. No tools execute and no automatic retries occur",
    "No usage on cancellation is unknown token consumption, not zero cost",
    "Raw streams remain in the ignored local run directory; no Langfuse export",
  ],
});
fs.copyFileSync(import.meta.path, path.join(output, "source-snapshot.ts"));
for (const arm of arms) {
  const request = structuredClone(original);
  if (arm === "incremental") request.messages[0].content += instruction;
  if (arm === "high") request.reasoning_effort = "high";
  if (arm === "next-action")
    request.messages[0].content += nextActionInstruction;
  if (arm === "latest-action")
    request.messages.push({ role: "user", content: nextActionInstruction });
  if (arm === "latest-system")
    request.messages.push({ role: "system", content: nextActionInstruction });
  if (arm === "early-user")
    request.messages.find(
      (message: { role: string }) => message.role === "user",
    ).content += nextActionInstruction;
  if (arm === "system-no-history-thinking") {
    request.messages[0].content += nextActionInstruction;
    for (const message of request.messages)
      if (message.role === "assistant") message.reasoning_content = undefined;
  }
  if (arm === "early-system-persistent")
    request.messages[0].content += persistentInstruction;
  if (arm === "latest-system-persistent")
    request.messages.push({ role: "system", content: persistentInstruction });
  write(`${arm}-request.json`, request);
  const controller = new AbortController();
  const start = Date.now();
  const timer = setTimeout(() => controller.abort(), wallMs);
  const fd = fs.openSync(path.join(output, `${arm}.sse`), "wx");
  const result = {
    arm,
    startedAt: new Date(start).toISOString(),
    status: "pending",
    httpStatus: 0,
    durationMs: 0,
    firstThinkingMs: null as number | null,
    firstToolMs: null as number | null,
    thinkingChars: 0,
    textChars: 0,
    firstToolDelta: null as unknown,
    usage: null as unknown,
    finishReason: null as unknown,
    toolCalls: [] as {
      index: number;
      id: string;
      name: string;
      arguments: string;
    }[],
  };
  const progress = setInterval(() => {
    console.log(
      JSON.stringify({
        event: "decision.progress",
        arm,
        elapsedMs: Date.now() - start,
        thinkingChars: result.thinkingChars,
        textChars: result.textChars,
        firstToolMs: result.firstToolMs,
        toolArgumentChars: result.toolCalls.reduce(
          (sum, tool) => sum + tool.arguments.length,
          0,
        ),
      }),
    );
  }, 30000);
  console.log(JSON.stringify({ event: "decision.start", arm, wallMs }));
  try {
    const response = await fetch(
      `${profile.baseUrl.replace(/\/$/, "")}/chat/completions`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify(request),
        signal: controller.signal,
      },
    );
    result.httpStatus = response.status;
    if (!response.ok || !response.body) {
      result.status = "http_error";
      await response.body?.cancel();
    } else {
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      read: while (true) {
        const { value, done } = await reader.read();
        if (done) {
          result.status = "ended";
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
          if (event.usage) result.usage = event.usage;
          for (const choice of event.choices ?? []) {
            if (choice.finish_reason)
              result.finishReason = choice.finish_reason;
            const delta = choice.delta ?? {};
            if (delta.reasoning_content) {
              result.firstThinkingMs ??= Date.now() - start;
              result.thinkingChars += delta.reasoning_content.length;
            }
            result.textChars += (delta.content ?? "").length;
            if (delta.tool_calls?.length) {
              result.firstToolMs ??= Date.now() - start;
              result.firstToolDelta ??= delta.tool_calls;
              for (const part of delta.tool_calls) {
                let tool = result.toolCalls.find(
                  (entry) => entry.index === part.index,
                );
                if (!tool) {
                  tool = { index: part.index, id: "", name: "", arguments: "" };
                  result.toolCalls.push(tool);
                }
                if (part.id) tool.id = part.id;
                tool.name += part.function?.name ?? "";
                tool.arguments += part.function?.arguments ?? "";
              }
              if (!collectFullResponse) {
                result.status = "tool_started";
                controller.abort();
                break read;
              }
            }
          }
        }
      }
    }
  } catch {
    result.status = controller.signal.aborted
      ? "wall_timeout"
      : "transport_or_parse_error";
  } finally {
    clearInterval(progress);
    clearTimeout(timer);
    controller.abort();
    fs.closeSync(fd);
    result.durationMs = Date.now() - start;
    write(`${arm}-result.json`, result);
    console.log(
      JSON.stringify({
        event: "decision.end",
        ...result,
        toolCalls: result.toolCalls.map((tool) => ({
          ...tool,
          arguments: tool.arguments.slice(0, 200),
        })),
      }),
    );
  }
}
