import { createHash } from "node:crypto";
/** Replays recorded responses through the real desktop host; no model network access. */
import fs from "node:fs";
import path from "node:path";

const [sourceArg, outputArg] = process.argv.slice(2);
if (!sourceArg || !outputArg)
  throw new Error(
    "Usage: desktop-replay-profile.ts <recorded-queue-high-dir> <fresh-output-dir>",
  );
const source = path.resolve(sourceArg);
const output = path.resolve(outputArg);
if (fs.existsSync(output)) throw new Error("Use a fresh output directory");
const repo = path.resolve(import.meta.dir, "../../..");
const profiledSources = [
  "packages/core/src/token-estimator.ts",
  "packages/core/src/token-count-cache.ts",
  "packages/runtime/src/session/file-run-session.ts",
  "packages/runtime/src/session/session-execution-lease.ts",
  "packages/runtime/src/payload/file-durable-json-payload-store.ts",
  "legacy/benchmarks/desktop-harness-ab/desktop-replay-profile.ts",
].map((file) => {
  const content = fs.readFileSync(path.join(repo, file));
  return {
    file,
    content,
    sha256: createHash("sha256").update(content).digest("hex"),
  };
});
const protocol = JSON.parse(
  fs.readFileSync(path.join(source, "protocol.json"), "utf8"),
);
const first = JSON.parse(
  fs.readFileSync(path.join(source, "request-1.json"), "utf8"),
);
if (
  first.model !== "glm-5.3-flash" ||
  first.reasoning_effort !== "high" ||
  protocol.tokenThresholdEnforced !== false
) {
  throw new Error(
    "This profiler requires the recorded queue high wall/call-budget control",
  );
}
const responses = fs
  .readdirSync(source)
  .filter((name) => /^response-\d+\.sse$/.test(name))
  .sort((a, b) => Number(a.slice(9, -4)) - Number(b.slice(9, -4)))
  .map((name, index) => {
    if (name !== `response-${index + 1}.sse`)
      throw new Error("Non-contiguous response recording");
    const content = fs.readFileSync(path.join(source, name), "utf8");
    const request = JSON.parse(
      fs.readFileSync(path.join(source, `request-${index + 1}.json`), "utf8"),
    );
    if (request.stream && !content.includes("data: [DONE]"))
      throw new Error(`Incomplete recording: ${name}`);
    if (!request.stream) JSON.parse(content);
    if (
      content.includes(protocol.workspaceRoot) ||
      content.includes(JSON.stringify(protocol.workspaceRoot).slice(1, -1))
    ) {
      throw new Error("Recorded response references its original workspace");
    }
    return {
      name,
      content,
      stream: request.stream === true,
      sha256: createHash("sha256").update(content).digest("hex"),
    };
  });
let replayed = 0;
const nativeFetch = globalThis.fetch;
globalThis.fetch = Object.assign(
  async (input: string | URL | Request, init?: RequestInit) => {
    const url =
      typeof input === "string"
        ? input
        : input instanceof URL
          ? input.href
          : input.url;
    if (!url.endsWith("/chat/completions") || typeof init?.body !== "string")
      throw new Error("Offline replay rejected network access");
    const body = JSON.parse(init.body);
    const expected = JSON.parse(
      fs.readFileSync(
        path.join(source, `request-${replayed + 1}.json`),
        "utf8",
      ),
    );
    // Role/schema mismatches must not silently consume a different recorded call.
    for (const key of [
      "model",
      "max_tokens",
      "reasoning_effort",
      "tools",
      "stream",
    ]) {
      if (JSON.stringify(body[key]) !== JSON.stringify(expected[key]))
        throw new Error(`Replay request ${replayed + 1} differs in ${key}`);
    }
    const recorded = responses[replayed++];
    if (!recorded) throw new Error("Recorded responses exhausted");
    return new Response(recorded.content, {
      headers: {
        "content-type": recorded.stream
          ? "text/event-stream"
          : "application/json",
      },
    });
  },
  {
    preconnect: () => {
      throw new Error("Offline replay rejected network preconnect");
    },
  },
) as typeof fetch;

process.argv = [
  process.execPath,
  path.join(import.meta.dir, "tool-wire-probe.ts"),
  output,
  "--queue",
  "--single-agent",
  "--wall-and-call-budget",
  "--docker",
  "--high",
];
try {
  await import("./tool-wire-probe.js");
} finally {
  globalThis.fetch = nativeFetch;
  if (fs.existsSync(output)) {
    const metadata = {
      kind: "offline_recorded_model_replay",
      source,
      replayed,
      available: responses.length,
      profiledSources: Object.fromEntries(
        profiledSources.map(({ file, sha256 }) => [file, sha256]),
      ),
      sourceResponses: responses.map(({ name, sha256 }) => ({ name, sha256 })),
      limitations:
        "Recorded decisions, immediate SSE delivery, real Docker tools. Not a live quality or token-cost benchmark. Current prompts may differ; only model settings and tool schemas are checked.",
    };
    for (const { file, content } of profiledSources) {
      const destination = path.join(output, "replay-source-snapshot", file);
      fs.mkdirSync(path.dirname(destination), { recursive: true });
      fs.writeFileSync(destination, content);
    }
    fs.writeFileSync(
      path.join(output, "replay.json"),
      `${JSON.stringify(metadata, null, 2)}\n`,
    );
    const currentProtocol = JSON.parse(
      fs.readFileSync(path.join(output, "protocol.json"), "utf8"),
    );
    fs.writeFileSync(
      path.join(output, "protocol.json"),
      `${JSON.stringify({ ...currentProtocol, experimentKind: metadata.kind }, null, 2)}\n`,
    );
  }
}
if (replayed !== responses.length)
  throw new Error(`Replay consumed ${replayed}/${responses.length} responses`);
