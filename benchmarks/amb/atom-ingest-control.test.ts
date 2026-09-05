import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";

import {
  createAmbMemoryLlmBudgetPortfolioV1,
  createAtomIngestBudgetV1,
  createAtomIngestCheckpointStoreV1,
  parseAmbCachedMemoryUsageV1,
  projectAmbMemoryEvidenceV1,
  readAmbMemoryLlmBudgetLimitsV1,
  readAtomIngestLimitsV1,
  resolveAmbIndexWriterIdentityV1,
  runKeyedInOrderV1,
  selectAmbSourceChunksV1,
  selectAmbSourceEvidenceV1,
} from "./atom-ingest-control.js";

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("AMB atom ingest controls", () => {
  test("keeps a frozen index writer identity separate from the active reader model", () => {
    expect(
      resolveAmbIndexWriterIdentityV1({
        activeModel: "glm-5.3-flash",
        activeBaseUrl: "https://glm.example/v4/",
        frozenWriterModel: "deepseek-v4-flash",
        frozenWriterBaseUrl: "https://api.deepseek.com/",
      }),
    ).toEqual({
      model: "deepseek-v4-flash",
      baseUrl: "https://api.deepseek.com",
      overrideActive: true,
    });
    expect(() =>
      resolveAmbIndexWriterIdentityV1({
        activeModel: "glm-5.3-flash",
        frozenWriterModel: "deepseek-v4-flash",
      }),
    ).toThrow("must be configured together");
  });

  test("keeps complete dialogue context but sanitizes assistant evidence", () => {
    const windows = projectAmbMemoryEvidenceV1(
      [
        "[SYSTEM] Current user persona: likes music",
        "[USER] User: I prefer concise answers.",
        "[ASSISTANT] Assistant: API_KEY=test-token-1234567890abcdef",
        "[USER] User: I moved to Shanghai in 2024.",
      ].join("\n"),
      1_024,
    );
    expect(windows).toHaveLength(1);
    expect(windows[0]?.source.map((item) => item.kind)).toEqual([
      "verification",
      "user_input",
      "assistant_output",
      "user_input",
    ]);
    expect(windows[0]?.text).toContain("likes music");
    expect(windows[0]?.text).toContain("concise answers");
    expect(windows[0]?.text).not.toContain("test-token-1234567890abcdef");
    expect(windows[0]?.source.map((item) => item.seq)).toEqual([1, 2, 3, 4]);
  });

  test("preserves roles from standard JSON conversation sessions", () => {
    const windows = projectAmbMemoryEvidenceV1(
      JSON.stringify([
        { role: "user", content: "I collect first-edition novels." },
        { role: "assistant", content: "I can track author events for you." },
        { role: "user", content: "Yes, especially local author signings." },
      ]),
      1_024,
    );
    expect(windows).toHaveLength(1);
    expect(windows[0]?.archiveSource).toEqual([
      {
        seq: 1,
        kind: "user_input",
        content: "I collect first-edition novels.",
      },
      {
        seq: 2,
        kind: "assistant_output",
        content: "I can track author events for you.",
      },
      {
        seq: 3,
        kind: "user_input",
        content: "Yes, especially local author signings.",
      },
    ]);
  });

  test("keeps archive dialogue bodies raw when the normal source sidecar compacts", () => {
    const assistantBody = "x".repeat(2_000);
    const windows = projectAmbMemoryEvidenceV1(
      `[USER] write a song\n[ASSISTANT] ${assistantBody}`,
      4_000,
    );
    expect(windows).toHaveLength(1);
    expect(windows[0]?.source[1]?.content).toHaveLength(1_600);
    expect(windows[0]?.archiveSource[1]?.content).toHaveLength(2_000);
    expect(windows[0]?.archiveSource[1]?.content).toBe(assistantBody);
  });

  test("uses atom terms to select bounded source evidence deterministically", () => {
    const input = {
      sourceTexts: [
        "The user discussed generic weekend errands. " +
          "They later adopted a rescued greyhound named Pixel. " +
          "The user also compared unrelated laptop stands.",
      ],
      query: "Which pet does the person have?",
      atomStatements: ["The user adopted a greyhound named Pixel."],
      maxChars: 256,
    } as const;
    const first = selectAmbSourceEvidenceV1(input);
    expect(first).toContain("greyhound named Pixel");
    expect(first.length).toBeLessThanOrEqual(256);
    expect(selectAmbSourceEvidenceV1(input)).toBe(first);
  });

  test("keeps selected L0 chunks contiguous and within the global budget", () => {
    const selected = selectAmbSourceChunksV1({
      chunks: [
        { documentId: "d1", index: 0, text: "generic ".repeat(80) },
        {
          documentId: "d2",
          index: 0,
          text: "The user adopted a greyhound named Pixel. ".repeat(8),
        },
      ],
      query: "Which greyhound did the user adopt?",
      maxChars: 512,
    });
    expect(selected).toHaveLength(1);
    expect(selected[0]?.documentId).toBe("d2");
    expect(selected[0]?.text.endsWith(" ")).toBeTrue();
    expect(
      selected.reduce((sum, chunk) => sum + chunk.text.length, 0),
    ).toBeLessThanOrEqual(512);
  });

  test("enforces call and reserved token budgets before a remote request", () => {
    const budget = createAtomIngestBudgetV1({
      maxRemoteCalls: 2,
      maxPromptTokens: 1_000,
      maxCompletionTokens: 500,
      concurrency: 2,
    });
    const first = budget.reserveRemoteCall({
      promptTokenUpperBound: 400,
      completionTokenUpperBound: 200,
    });
    expect(() =>
      budget.reserveRemoteCall({
        promptTokenUpperBound: 700,
        completionTokenUpperBound: 100,
      }),
    ).toThrow("AtomIngestPromptTokenBudgetExceeded");
    budget.settleRemoteCall(first, { promptTokens: 120, completionTokens: 80 });
    const second = budget.reserveRemoteCall({
      promptTokenUpperBound: 400,
      completionTokenUpperBound: 200,
    });
    budget.releaseRemoteCall(second);
    expect(() =>
      budget.reserveRemoteCall({
        promptTokenUpperBound: 1,
        completionTokenUpperBound: 1,
      }),
    ).toThrow("AtomIngestRemoteCallBudgetExceeded");
    budget.recordCacheHit({
      promptTokens: 90,
      completionTokens: 10,
      providerCacheHitTokens: 30,
      providerCacheMissTokens: 60,
    });
    expect(budget.snapshot()).toMatchObject({
      remoteCalls: 2,
      cacheHits: 1,
      cacheHitsWithOriginUsage: 1,
      cacheHitsWithoutOriginUsage: 0,
      promptTokens: 120,
      completionTokens: 80,
      cachedOriginPromptTokens: 90,
      cachedOriginCompletionTokens: 10,
      workloadPromptTokens: 210,
      workloadCompletionTokens: 90,
      workloadTotalTokens: 300,
      costEvidenceComplete: true,
      reservedPromptTokens: 0,
      reservedCompletionTokens: 0,
    });
    budget.recordCacheHit();
    expect(budget.snapshot()).toMatchObject({
      cacheHits: 2,
      cacheHitsWithoutOriginUsage: 1,
      costEvidenceComplete: false,
    });
  });

  test("strictly parses bounded environment controls", () => {
    expect(
      readAtomIngestLimitsV1({
        PAW_AMB_ATOM_MAX_REMOTE_CALLS: "7",
        PAW_AMB_ATOM_MAX_PROMPT_TOKENS: "9000",
        PAW_AMB_ATOM_MAX_COMPLETION_TOKENS: "4000",
        PAW_AMB_ATOM_CONCURRENCY: "3",
      }),
    ).toEqual({
      maxRemoteCalls: 7,
      maxPromptTokens: 9_000,
      maxCompletionTokens: 4_000,
      concurrency: 3,
    });
    expect(() =>
      readAtomIngestLimitsV1({ PAW_AMB_ATOM_CONCURRENCY: "9" }),
    ).toThrow("PAW_AMB_ATOM_CONCURRENCYInvalid");
  });

  test("gives online evidence workloads independent bounded defaults", () => {
    const limits = readAmbMemoryLlmBudgetLimitsV1({
      PAW_AMB_ATOM_MAX_REMOTE_CALLS: "7",
      PAW_AMB_QUERY_PLAN_MAX_REMOTE_CALLS: "11",
      PAW_AMB_EVIDENCE_SUPPORT_MAX_PROMPT_TOKENS: "123456",
    });
    expect(limits["memory-write"].maxRemoteCalls).toBe(7);
    expect(limits["query-plan"]).toMatchObject({
      maxRemoteCalls: 11,
      maxPromptTokens: 750_000,
      maxCompletionTokens: 150_000,
    });
    expect(limits["evidence-support"]).toMatchObject({
      maxRemoteCalls: 2_400,
      maxPromptTokens: 123_456,
      maxCompletionTokens: 4_000_000,
    });
    expect(limits["dialogue-ordinal-admission"]).toMatchObject({
      maxRemoteCalls: 600,
      maxPromptTokens: 600_000,
      maxCompletionTokens: 60_000,
    });
    expect(limits["state-semantic-audit-a"]).toMatchObject({
      maxRemoteCalls: 120,
      maxPromptTokens: 1_500_000,
      maxCompletionTokens: 120_000,
    });
    expect(limits["state-semantic-audit-b"]).toMatchObject({
      maxRemoteCalls: 120,
      maxPromptTokens: 1_500_000,
      maxCompletionTokens: 120_000,
    });
    expect(limits["closure-audit"]).toMatchObject({
      maxRemoteCalls: 180,
      maxPromptTokens: 450_000,
      maxCompletionTokens: 90_000,
    });
    expect(() =>
      readAmbMemoryLlmBudgetLimitsV1({
        PAW_AMB_QUERY_PLAN_CONCURRENCY: "0",
      }),
    ).toThrow("PAW_AMB_QUERY_PLAN_CONCURRENCYInvalid");
  });

  test("does not let one memory LLM purpose starve another", () => {
    const portfolio = createAmbMemoryLlmBudgetPortfolioV1({
      "memory-write": {
        maxRemoteCalls: 1,
        maxPromptTokens: 100,
        maxCompletionTokens: 50,
        concurrency: 1,
      },
      "query-plan": {
        maxRemoteCalls: 2,
        maxPromptTokens: 200,
        maxCompletionTokens: 100,
        concurrency: 1,
      },
      "evidence-support": {
        maxRemoteCalls: 3,
        maxPromptTokens: 300,
        maxCompletionTokens: 150,
        concurrency: 1,
      },
      "dialogue-ordinal-admission": {
        maxRemoteCalls: 3,
        maxPromptTokens: 300,
        maxCompletionTokens: 150,
        concurrency: 1,
      },
      "state-binding": {
        maxRemoteCalls: 3,
        maxPromptTokens: 3_000,
        maxCompletionTokens: 300,
        concurrency: 1,
      },
      "state-verification": {
        maxRemoteCalls: 3,
        maxPromptTokens: 3_000,
        maxCompletionTokens: 300,
        concurrency: 1,
      },
      "state-semantic-audit-a": {
        maxRemoteCalls: 3,
        maxPromptTokens: 3_000,
        maxCompletionTokens: 300,
        concurrency: 1,
      },
      "state-semantic-audit-b": {
        maxRemoteCalls: 3,
        maxPromptTokens: 3_000,
        maxCompletionTokens: 300,
        concurrency: 1,
      },
      "closure-audit": {
        maxRemoteCalls: 3,
        maxPromptTokens: 3_000,
        maxCompletionTokens: 300,
        concurrency: 1,
      },
    });
    const memoryWrite = portfolio.budgetFor("memory-write");
    const writeReservation = memoryWrite.reserveRemoteCall({
      promptTokenUpperBound: 100,
      completionTokenUpperBound: 50,
    });
    memoryWrite.settleRemoteCall(writeReservation, {
      promptTokens: 80,
      completionTokens: 20,
    });
    expect(() =>
      memoryWrite.reserveRemoteCall({
        promptTokenUpperBound: 1,
        completionTokenUpperBound: 1,
      }),
    ).toThrow("AtomIngestRemoteCallBudgetExceeded");

    const queryPlan = portfolio.budgetFor("query-plan");
    const queryReservation = queryPlan.reserveRemoteCall({
      promptTokenUpperBound: 120,
      completionTokenUpperBound: 40,
    });
    queryPlan.settleRemoteCall(queryReservation, {
      promptTokens: 90,
      completionTokens: 30,
      providerCacheHitTokens: 50,
      providerCacheMissTokens: 40,
    });
    portfolio.budgetFor("evidence-support").recordCacheHit({
      promptTokens: 70,
      completionTokens: 10,
      providerCacheHitTokens: 20,
      providerCacheMissTokens: 50,
    });

    const snapshot = portfolio.snapshot();
    expect(snapshot.byPurpose["memory-write"].remoteCalls).toBe(1);
    expect(snapshot.byPurpose["query-plan"]).toMatchObject({
      remoteCalls: 1,
      promptTokens: 90,
      completionTokens: 30,
    });
    expect(snapshot.byPurpose["evidence-support"].cacheHits).toBe(1);
    expect(snapshot.aggregate).toMatchObject({
      maxRemoteCalls: 24,
      remoteCalls: 2,
      cacheHits: 1,
      promptTokens: 170,
      completionTokens: 50,
      workloadPromptTokens: 240,
      workloadCompletionTokens: 60,
      workloadTotalTokens: 300,
      costEvidenceComplete: true,
    });
  });

  test("accepts only complete non-negative cache-origin usage", () => {
    expect(
      parseAmbCachedMemoryUsageV1({
        promptTokens: 100,
        completionTokens: 20,
        providerCacheHitTokens: 30,
        providerCacheMissTokens: 70,
      }),
    ).toEqual({
      promptTokens: 100,
      completionTokens: 20,
      providerCacheHitTokens: 30,
      providerCacheMissTokens: 70,
    });
    expect(
      parseAmbCachedMemoryUsageV1({
        promptTokens: 100,
        completionTokens: -1,
        providerCacheHitTokens: 30,
        providerCacheMissTokens: 70,
      }),
    ).toBeNull();
    expect(
      parseAmbCachedMemoryUsageV1({
        promptTokens: 100,
        completionTokens: 20,
      }),
    ).toBeNull();
  });

  test("persists only hashes and resumes exact checkpoint identity", () => {
    const directory = mkdtempSync(resolve(tmpdir(), "paw-atom-checkpoint-"));
    temporaryDirectories.push(directory);
    const path = resolve(directory, "checkpoint.json");
    const identityHash = "a".repeat(64);
    const completedKey = "b".repeat(64);
    const fresh = createAtomIngestCheckpointStoreV1({
      path,
      runKey: "run-1",
      identityHash,
      resume: false,
    });
    fresh.markCompleted(completedKey);
    const resumed = createAtomIngestCheckpointStoreV1({
      path,
      runKey: "run-1",
      identityHash,
      resume: true,
    });
    expect(resumed.resumed).toBeTrue();
    expect(resumed.has(completedKey)).toBeTrue();
    expect(resumed.snapshot().completedCount).toBe(1);
    expect(() =>
      createAtomIngestCheckpointStoreV1({
        path,
        runKey: "run-1",
        identityHash: "c".repeat(64),
        resume: true,
      }),
    ).toThrow("AtomIngestCheckpointIdentityMismatch");

    writeFileSync(path, "contains raw memory text", "utf8");
    expect(() =>
      createAtomIngestCheckpointStoreV1({
        path,
        runKey: "run-1",
        identityHash,
        resume: true,
      }),
    ).toThrow("AtomIngestCheckpointInvalid");
  });

  test("runs different users concurrently but preserves each user's order", async () => {
    const activeByUser = new Set<string>();
    const seen = new Map<string, number[]>();
    let active = 0;
    let maxActive = 0;
    await runKeyedInOrderV1({
      items: [
        { user: "a", seq: 1 },
        { user: "b", seq: 1 },
        { user: "a", seq: 2 },
        { user: "c", seq: 1 },
        { user: "b", seq: 2 },
      ],
      concurrency: 2,
      key: (item) => item.user,
      async run(item) {
        expect(activeByUser.has(item.user)).toBeFalse();
        activeByUser.add(item.user);
        active += 1;
        maxActive = Math.max(maxActive, active);
        await new Promise<void>((finish) => setTimeout(finish, 5));
        const values = seen.get(item.user) ?? [];
        values.push(item.seq);
        seen.set(item.user, values);
        active -= 1;
        activeByUser.delete(item.user);
      },
    });
    expect(maxActive).toBe(2);
    expect(seen.get("a")).toEqual([1, 2]);
    expect(seen.get("b")).toEqual([1, 2]);
    expect(seen.get("c")).toEqual([1]);
  });
});
