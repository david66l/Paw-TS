import { describe, expect, test } from "bun:test";
import {
  type InputFactV1,
  RUN_JOURNAL_SCHEMA_VERSION_V1,
  type RunJournalEnvelopeV1,
  parseRunJournalPrefixV1,
} from "@paw/protocol";

import {
  type AcceptInputRequestV1,
  type WorkSegmentInputAdmissionSessionV1,
  acceptQueuedWorkSegmentInputV1,
} from "../src/index.js";

describe("queued work-segment input admission", () => {
  test("linearizes concurrent same-id retries into one accepted fact", async () => {
    const session = new MemoryAdmissionSession(basePrefix());
    const gate = twoPartyGate();
    const request = queued("same-id");

    const calls = [1, 2].map(() =>
      acceptQueuedWorkSegmentInputV1({
        session,
        request,
        signal: new AbortController().signal,
        preflight: async () => gate.arrive(),
        validateProspective: () => {},
      }),
    );
    const results = await Promise.all(calls);

    expect(results.map((result) => result.status).sort()).toEqual([
      "accepted",
      "already_accepted",
    ]);
    expect(session.accepted("same-id")).toHaveLength(1);
    expect(session.commitAttempts).toBe(2);
  });

  test("allows only one concurrent different-id FIFO winner", async () => {
    const session = new MemoryAdmissionSession(basePrefix());
    const gate = twoPartyGate();
    const outcomes = await Promise.allSettled(
      ["queue-a", "queue-b"].map((inputId) =>
        acceptQueuedWorkSegmentInputV1({
          session,
          request: queued(inputId),
          signal: new AbortController().signal,
          preflight: async () => gate.arrive(),
          validateProspective: () => {},
        }),
      ),
    );

    expect(
      outcomes.filter((result) => result.status === "fulfilled"),
    ).toHaveLength(1);
    expect(
      outcomes.filter((result) => result.status === "rejected"),
    ).toHaveLength(1);
    expect(
      session.prefix.filter(
        (entry) =>
          entry.record.kind === "input_fact" &&
          entry.record.fact.type === "input.accepted",
      ),
    ).toHaveLength(1);
  });

  test("retries a CAS conflict from a fresh prefix and never reuses stale preflight", async () => {
    const session = new MemoryAdmissionSession(basePrefix());
    session.conflictOnceWith({
      type: "input.accepted",
      inputId: "cas-id",
      delivery: "queue",
      content: "content:cas-id",
      contentHash: textHash("content:cas-id"),
      callerId: "runtime-test",
    });
    let preflightCalls = 0;
    const result = await acceptQueuedWorkSegmentInputV1({
      session,
      request: queued("cas-id"),
      signal: new AbortController().signal,
      preflight: () => {
        preflightCalls += 1;
        return undefined;
      },
      validateProspective: () => {},
    });

    expect(result.status).toBe("already_accepted");
    expect(preflightCalls).toBe(2);
    expect(session.accepted("cas-id")).toHaveLength(1);
  });

  test("fails closed on preflight, prospective validation, stale evidence, and abort", async () => {
    for (const mode of [
      "preflight",
      "prospective",
      "evidence",
      "abort",
    ] as const) {
      const session = new MemoryAdmissionSession(basePrefix());
      const controller = new AbortController();
      const reason = new Error(`blocked-${mode}`);
      const evidence = {
        assertSnapshot() {
          throw reason;
        },
      } as never;
      const operation = acceptQueuedWorkSegmentInputV1({
        session,
        request: queued(`blocked-${mode}`),
        signal: controller.signal,
        preflight: () => {
          if (mode === "preflight") throw reason;
          if (mode === "abort") controller.abort(reason);
          return mode === "evidence" ? evidence : undefined;
        },
        validateProspective: () => {
          if (mode === "prospective") throw reason;
        },
      });

      await expect(operation).rejects.toBe(reason);
      expect(session.commitAttempts, mode).toBe(0);
      expect(session.accepted(`blocked-${mode}`), mode).toHaveLength(0);
    }
  });
});

class MemoryAdmissionSession implements WorkSegmentInputAdmissionSessionV1 {
  prefix: RunJournalEnvelopeV1[];
  commitAttempts = 0;
  private conflictFact?: InputFactV1;

  constructor(prefix: readonly RunJournalEnvelopeV1[]) {
    this.prefix = structuredClone(prefix) as RunJournalEnvelopeV1[];
  }

  async readCanonicalPrefix(): Promise<readonly RunJournalEnvelopeV1[]> {
    return structuredClone(this.prefix) as RunJournalEnvelopeV1[];
  }

  async commitInputFacts(
    expectedTailSeq: number,
    facts: readonly InputFactV1[],
  ): Promise<"committed" | "conflict"> {
    this.commitAttempts += 1;
    if (this.conflictFact) {
      const fact = this.conflictFact;
      this.conflictFact = undefined;
      this.append([fact]);
      return "conflict";
    }
    if (expectedTailSeq !== this.prefix.length) return "conflict";
    this.append(facts);
    return "committed";
  }

  conflictOnceWith(fact: InputFactV1): void {
    this.conflictFact = structuredClone(fact) as InputFactV1;
  }

  accepted(inputId: string): readonly InputFactV1[] {
    return this.prefix.flatMap((entry) =>
      entry.record.kind === "input_fact" &&
      entry.record.fact.type === "input.accepted" &&
      entry.record.fact.inputId === inputId
        ? [entry.record.fact]
        : [],
    );
  }

  private append(facts: readonly InputFactV1[]): void {
    for (const fact of facts) {
      const seq = this.prefix.length + 1;
      this.prefix.push({
        schemaVersion: RUN_JOURNAL_SCHEMA_VERSION_V1,
        sessionId: "admission-session",
        runId: "admission-run",
        seq,
        ts: 1_900_000_000_000 + seq,
        record: { kind: "input_fact", fact: structuredClone(fact) },
      });
    }
    parseRunJournalPrefixV1(this.prefix);
  }
}

function basePrefix(): readonly RunJournalEnvelopeV1[] {
  return [
    envelope(1, {
      type: "attempt.started",
      goalHash: "goal-hash",
      configHash: "config-hash",
    }),
    envelope(2, {
      type: "input.promoted",
      inputId: "initial-input",
      delivery: "initial",
      content: "initial content",
      contentHash: textHash("initial content"),
    }),
  ];
}

function queued(inputId: string): AcceptInputRequestV1 {
  return {
    inputId,
    delivery: "queue",
    content: `content:${inputId}`,
    callerId: "runtime-test",
  };
}

function envelope(seq: number, fact: InputFactV1): RunJournalEnvelopeV1 {
  return {
    schemaVersion: RUN_JOURNAL_SCHEMA_VERSION_V1,
    sessionId: "admission-session",
    runId: "admission-run",
    seq,
    ts: 1_900_000_000_000 + seq,
    record: { kind: "input_fact", fact },
  };
}

function twoPartyGate(): { arrive(): Promise<undefined> } {
  let arrivals = 0;
  let release!: () => void;
  const opened = new Promise<void>((resolve) => {
    release = resolve;
  });
  return {
    async arrive() {
      arrivals += 1;
      if (arrivals === 2) release();
      await opened;
      return undefined;
    },
  };
}

function textHash(value: string): string {
  const hasher = new Bun.CryptoHasher("sha256");
  hasher.update(value);
  return hasher.digest("hex");
}
