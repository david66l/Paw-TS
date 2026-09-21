/** Replay a settled workflow's root decisions through the real desktop/tools,
 * then permit network only for its independent auditor. Not a coding benchmark. */
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

const [sourceArg, outputArg] = process.argv.slice(2);
if (!sourceArg || !outputArg) throw new Error("Usage: audit-live-probe.ts <settled-workflow-continuation> <fresh-output>");
const source = fs.realpathSync(path.resolve(sourceArg));
const output = path.resolve(outputArg);
if (fs.existsSync(output)) throw new Error("Use a fresh output directory");
const read = (name: string) => JSON.parse(fs.readFileSync(path.join(source, name), "utf8"));
const protocol = read("protocol.json");
if (!fs.existsSync(path.join(source, "result.json")) || protocol.taskVariant !== "workflow" || !protocol.seedFrom ||
    !protocol.environmentAudit || !protocol.singleAgent || protocol.tokenThresholdEnforced !== false)
  throw new Error("Expected a settled single-agent audited workflow artifact continuation");
const rootRequests = read("phase-cost-report.json").requests.filter((item: { phase: string }) => item.phase === "agent_loop:root");
const responses = rootRequests.map((item: { id: number }, index: number) => {
  if (item.id !== index + 1) throw new Error("Root decisions must be a contiguous prefix before audit");
  const request = read(`request-${item.id}.json`);
  const content = fs.readFileSync(path.join(source, `response-${item.id}.sse`), "utf8");
  if (request.model !== "glm-5.3-flash" || request.reasoning_effort !== "high" || !request.stream || !content.includes("data: [DONE]"))
    throw new Error("Expected complete high streaming root responses");
  if (content.includes(protocol.workspaceRoot) || content.includes(JSON.stringify(protocol.workspaceRoot).slice(1, -1)))
    throw new Error("Cannot replay absolute references to the source workspace");
  return { id: item.id, request, content, sha256: createHash("sha256").update(content).digest("hex") };
});
if (!responses.length) throw new Error("No recorded root decisions");
const nativeFetch = globalThis.fetch;
let replayed = 0;
let liveRequests = 0;
let requestNumber = 0;
const liveAuditRequestIds: number[] = [];
const rejectedRequestIds: number[] = [];
globalThis.fetch = Object.assign(async (input: string | URL | Request, init?: RequestInit) => {
  const requestId = ++requestNumber;
  const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
  if (!url.endsWith("/chat/completions") || typeof init?.body !== "string") throw new Error("Unexpected network operation");
  const body = JSON.parse(init.body);
  if (replayed < responses.length) {
    const expected = responses[replayed]!;
    for (const key of ["model", "max_tokens", "reasoning_effort", "tools", "stream"])
      if (JSON.stringify(body[key]) !== JSON.stringify(expected.request[key])) throw new Error(`Root replay ${expected.id} changed ${key}`);
    replayed++;
    return new Response(expected.content, { headers: { "content-type": "text/event-stream" } });
  }
  const content = JSON.stringify(body.messages);
  if (!content.includes("Paw environment auditor") || !content.includes("at most 240 seconds total wall time") ||
      body.model !== "glm-5.3-flash" || body.reasoning_effort !== "high") {
    rejectedRequestIds.push(requestId);
    throw new Error("Live network is restricted to the new independent audit; root replay cannot be extended");
  }
  if (++liveRequests > 12) throw new Error("Audit live request cap exceeded");
  liveAuditRequestIds.push(requestId);
  return nativeFetch(input, init);
}, { preconnect() { throw new Error("Unexpected network preconnect"); } }) as typeof fetch;

process.argv = [process.execPath, path.join(import.meta.dir, "tool-wire-probe.ts"), output,
  "--workflow", "--docker", "--single-agent", "--configured-profile", "--environment-audit", "--wall-and-call-budget",
  `--seed-from=${protocol.seedFrom}`];
try {
  await import("./tool-wire-probe.js");
} finally {
  globalThis.fetch = nativeFetch;
  if (fs.existsSync(output)) {
    const metadata = { experimentKind: "recorded_root_live_audit", source,
      rootReplayedRequests: replayed, liveAuditRequests: liveRequests,
      liveAuditRequestIds, rejectedRequestIds,
      responseHashes: Object.fromEntries(responses.map(item => [item.id, item.sha256])),
      limitations: "Root decisions and their reported usage are replayed, not new model consumption. Only live auditor requests have new usage. Prompts are not asserted identical; model settings and tool definitions are checked. This is not a live coding completion or speed comparison." };
    fs.writeFileSync(path.join(output, "audit-live.json"), JSON.stringify(metadata, null, 2));
    const ownSource = fs.readFileSync(import.meta.filename);
    fs.writeFileSync(path.join(output, "audit-live-probe.source.ts"), ownSource);
    const p = JSON.parse(fs.readFileSync(path.join(output, "protocol.json"), "utf8"));
    fs.writeFileSync(path.join(output, "protocol.json"), JSON.stringify({ ...p, experimentKind: metadata.experimentKind,
      auditProbeSourceHash: createHash("sha256").update(ownSource).digest("hex") }, null, 2));
  }
}
if (replayed !== responses.length) throw new Error(`Incomplete root replay: ${replayed}/${responses.length}`);
