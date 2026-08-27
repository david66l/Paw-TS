import { describe, expect, test } from "bun:test";

import type { ToolSettlement } from "@paw/agent-loop";
import type { ToolRunResult } from "@paw/harness";
import type { MemoryCardV1 } from "@paw/protocol";
import type { RuntimeToolCallV1 } from "@paw/runtime";

import {
  type MemoryProviderQueryV1,
  type MemoryProviderV1,
  type MemoryToolEventV1,
  PAW_MEMORY_CONTEXT_RESOLVER_VERSION_V1,
  PAW_NEXT_MEMORY_PLUGIN_POLICY_VERSION_V1,
  PAW_NEXT_MEMORY_V2_PROVIDER_VERSION_V1,
  type PawNextMemoryPluginProfileV1,
  buildMemoryAtomExtractionRequestV1,
  createMemoryEvidenceLedgerV1,
  createPawNextMemoryToolExecutorV1,
  createPawNextMemoryToolPluginV1,
  resolveMemoryTopicIdV1,
} from "../src/index.js";

const profile: PawNextMemoryPluginProfileV1 = Object.freeze({
  policyVersion: PAW_NEXT_MEMORY_PLUGIN_POLICY_VERSION_V1,
  mode: "read_only",
  providerVersion: PAW_NEXT_MEMORY_V2_PROVIDER_VERSION_V1,
  scope: Object.freeze({
    tenantId: "tenant-a",
    userId: "user-a",
    workspaceId: "workspace-a",
    repositoryId: "repo-a",
  }),
  maxCards: 8,
  maxInjectedTokens: 2_048,
});

describe("progressive read-only memory tools", () => {
  test("exposes navigation and drill-down without model-controlled scope", () => {
    const plugin = createPawNextMemoryToolPluginV1(profile);
    expect(plugin.entries.map((entry) => entry.providerName)).toEqual([
      "memory_resolve_context",
      "memory_search_atoms",
      "memory_list_topics",
      "memory_read_topic",
      "memory_search_conversation",
      "memory_read_evidence",
    ]);
    for (const entry of plugin.entries) {
      const schema = JSON.stringify(entry.definition.function.parameters);
      expect(schema).not.toContain("tenantId");
      expect(schema).not.toContain("userId");
      expect(schema).not.toContain("workspaceId");
      expect(schema).not.toContain("repositoryId");
      expect(entry.classify({}, "C:/repo").effectClass).toBe("read");
    }
  });

  test("caches results, journals cache telemetry, and enforces a combined call budget", async () => {
    let retrievals = 0;
    const events: MemoryToolEventV1[] = [];
    const provider: MemoryProviderV1 = Object.freeze({
      providerVersion: PAW_NEXT_MEMORY_V2_PROVIDER_VERSION_V1,
      async retrieve(query: MemoryProviderQueryV1) {
        retrievals += 1;
        expect(query.scope).toEqual(profile.scope);
        return Object.freeze({
          status: "completed" as const,
          cards: Object.freeze([card(query.scope.repositoryId)]),
        });
      },
    });
    const delegate = Object.freeze({
      async executeSettled(calls: readonly RuntimeToolCallV1[]) {
        return calls.map((call) => success(call.id, "delegated"));
      },
    });
    const executor = createPawNextMemoryToolExecutorV1({
      delegate,
      profile,
      provider,
      maxCalls: 2,
      evidenceLedger: createMemoryEvidenceLedgerV1(),
      onEvent: (event) => events.push(event),
    });
    const first = await executor.executeSettled(
      [
        call("m1", "memory_search_atoms", {
          query: "why deploy",
          max_results: 3,
        }),
      ],
      batch(),
    );
    const second = await executor.executeSettled(
      [
        call("m2", "memory_search_atoms", {
          query: "why deploy",
          max_results: 3,
        }),
      ],
      batch(),
    );
    const limited = await executor.executeSettled(
      [call("m3", "memory_search_atoms", { query: "another", max_results: 3 })],
      batch(),
    );

    expect(first[0]?.status).toBe("success");
    expect(second[0]?.status).toBe("success");
    expect(limited[0]?.status).toBe("failed");
    if (second[0]?.status !== "success") {
      throw new Error("expected cached memory tool success");
    }
    expect(
      (second[0].result.payload as Record<string, unknown>).evidence,
    ).toEqual([]);
    expect(
      (second[0].result.payload as Record<string, unknown>).evidenceLedger,
    ).toEqual({
      schemaVersion: "paw.memory-evidence-ledger.v1",
      newItems: 0,
      repeatedItems: 1,
      totalDistinctItems: 1,
      guidance:
        "No new evidence was returned; use prior evidence or choose a materially different read.",
    });
    expect(retrievals).toBe(1);
    expect(events.map((event) => [event.status, event.cacheHit])).toEqual([
      ["completed", false],
      ["completed", true],
      ["limited", false],
    ]);
  });

  test("executes one unified resolver packet before lower-level drill-down", async () => {
    const executor = createPawNextMemoryToolExecutorV1({
      delegate: {
        async executeSettled(calls: readonly RuntimeToolCallV1[]) {
          return calls.map((item) => success(item.id, "delegate"));
        },
      },
      profile,
      contextResolver: {
        resolverVersion: PAW_MEMORY_CONTEXT_RESOLVER_VERSION_V1,
        async resolve(query) {
          expect(query).toBe("Why Compose?");
          return {
            schemaVersion: "paw.memory-resolved-context.v1",
            resolverVersion: PAW_MEMORY_CONTEXT_RESOLVER_VERSION_V1,
            packetRevision: "packet-1",
            mode: "planned",
            stop: "sufficient",
            requirements: [],
            verification: {
              status: "verified",
              verifierVersion: "test-verifier-v1",
              verificationRevision: "verification-1",
              supportingCount: 0,
              contradictionCount: 0,
              unknownCount: 0,
            },
            evidence: [],
            topics: [],
            spans: [],
          };
        },
      },
    });
    const settled = await executor.executeSettled(
      [
        call("resolve-1", "memory_resolve_context", {
          query: "Why Compose?",
        }),
        call("early-1", "memory_search_atoms", { query: "Compose" }),
      ],
      batch(),
    );
    expect(settled[0]?.status).toBe("success");
    expect(settled[1]?.status).toBe("failed");
    if (settled[0]?.status !== "success") throw new Error("resolver failed");
    expect((settled[0].result.payload as Record<string, unknown>).stop).toBe(
      "sufficient",
    );
    const afterSufficient = await executor.executeSettled(
      [call("late-1", "memory_search_atoms", { query: "Compose" })],
      batch(),
    );
    expect(afterSufficient[0]?.status).toBe("failed");
  });

  test("preserves result order for mixed memory and ordinary tool batches", async () => {
    const provider: MemoryProviderV1 = Object.freeze({
      providerVersion: PAW_NEXT_MEMORY_V2_PROVIDER_VERSION_V1,
      async retrieve(query: MemoryProviderQueryV1) {
        return {
          status: "completed" as const,
          cards: [card(query.scope.repositoryId)],
        };
      },
    });
    const delegate = Object.freeze({
      async executeSettled(calls: readonly RuntimeToolCallV1[]) {
        return calls.map((item) => success(item.id, `delegate:${item.name}`));
      },
    });
    const executor = createPawNextMemoryToolExecutorV1({
      delegate,
      profile,
      provider,
    });
    const settled = await executor.executeSettled(
      [
        call("d1", "workspace_read_file", { path: "a.ts" }),
        call("m1", "memory_search_atoms", { query: "deploy" }),
        call("d2", "workspace_search", { query: "x" }),
      ],
      batch(),
    );
    expect(settled.map((item) => item.callId)).toEqual(["d1", "m1", "d2"]);
    expect(settled.map((item) => item.status)).toEqual([
      "success",
      "success",
      "success",
    ]);
  });

  test("canonicalizes only one known topic id from model decoration", () => {
    const known = ["topic/alpha", "topic/beta"];
    expect(resolveMemoryTopicIdV1("topic/alpha", known)).toBe("topic/alpha");
    expect(resolveMemoryTopicIdV1('read "topic/beta"', known)).toBe(
      "topic/beta",
    );
    expect(resolveMemoryTopicIdV1("topic/unknown", known)).toBeUndefined();
    expect(
      resolveMemoryTopicIdV1("topic/alpha or topic/beta", known),
    ).toBeUndefined();
  });

  test("projects overlapping tool reads as session evidence deltas", () => {
    const ledger = createMemoryEvidenceLedgerV1();
    const first = ledger.project("memory.search_atoms", {
      evidence: [
        { memoryId: "m1", statement: "first" },
        { memoryId: "m2", statement: "second" },
      ],
    });
    const second = ledger.project("memory.search_atoms", {
      evidence: [
        { memoryId: "m2", statement: "second" },
        { memoryId: "m3", statement: "third" },
      ],
    });

    expect(first.newItems).toBe(2);
    expect(first.repeatedItems).toBe(0);
    expect(second.newItems).toBe(1);
    expect(second.repeatedItems).toBe(1);
    expect(second.totalDistinctItems).toBe(3);
    expect(second.payload.evidence).toEqual([
      { memoryId: "m3", statement: "third" },
    ]);
    expect(second.payload.evidenceLedger).toEqual({
      schemaVersion: "paw.memory-evidence-ledger.v1",
      newItems: 1,
      repeatedItems: 1,
      totalDistinctItems: 3,
    });
  });

  test("writer prompt preserves a source-grounded causal unit", () => {
    const request = buildMemoryAtomExtractionRequestV1({
      writeId: "write-1",
      runId: "run-1",
      repositoryId: "repo-a",
      sourceFromSeq: 1,
      sourceThroughSeq: 3,
      source: Object.freeze([
        { seq: 1, kind: "user_input", content: "cost was too high" },
        { seq: 2, kind: "user_input", content: "I changed the deployment" },
      ]),
      conflicts: Object.freeze([]),
      maxAtoms: 4,
    });
    expect(request.system).toContain("Preserve causal units");
    expect(request.system).toContain("trigger/reason");
    expect(request.system).toContain("cite every supporting sourceSeq");
  });
});

function card(repositoryId: string): MemoryCardV1 {
  return Object.freeze({
    id: "memory-1",
    revision: 1,
    kind: "episodic",
    statement: "High deployment cost caused the user to choose Compose.",
    applicability: "reference",
    scope: Object.freeze({ repositoryId }),
    sources: Object.freeze([
      Object.freeze({ kind: "memory_store_evidence", ref: "evidence/1" }),
    ]),
    confidence: 0.9,
    contentHash: "hash-1",
  });
}

function call(
  id: string,
  name: string,
  args: Readonly<Record<string, unknown>>,
): RuntimeToolCallV1 {
  return Object.freeze({ id, name, arguments: Object.freeze({ ...args }) });
}

function batch() {
  return Object.freeze({ turn: 1, signal: new AbortController().signal });
}

function success(
  callId: string,
  summary: string,
): ToolSettlement<ToolRunResult> {
  return Object.freeze({
    status: "success" as const,
    callId,
    result: Object.freeze({ ok: true, summary, payload: { summary } }),
  });
}
