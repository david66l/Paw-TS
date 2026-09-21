import { describe, expect, test } from "bun:test";

import {
  type CheckpointDistillationModelRequestV1,
  createModelCheckpointSemanticVerifierV1,
  projectCheckpointEvidenceV1,
} from "../src/index.js";
import {
  sourceEntries,
  validCheckpoint,
} from "./support/checkpoint-fixture.js";

describe("model checkpoint semantic verifier", () => {
  test("settles a model that ignores the semantic verification deadline", async () => {
    const verifier = createModelCheckpointSemanticVerifierV1({
      model: { complete: () => new Promise(() => {}) },
      policy: { timeoutMs: 15, maxPromptChars: 192_000, maxOutputTokens: 512 },
    });
    expect(await runVerifier(verifier)).toEqual({
      status: "unknown",
      errorCode: "CheckpointSemanticVerificationTimeout",
    });
  });

  test("does not accept support reported during cancellation", async () => {
    const parent = new AbortController();
    const verifier = createModelCheckpointSemanticVerifierV1({
      model: {
        async complete() {
          parent.abort();
          return { status: "completed", text: '{"status":"supported"}' };
        },
      },
    });
    expect(await runVerifier(verifier, parent.signal)).toEqual({
      status: "unknown",
      errorCode: "CheckpointSemanticVerificationCancelled",
    });
  });

  test("accepts only the exact supported verdict", async () => {
    const requests: CheckpointDistillationModelRequestV1[] = [];
    const verifier = createModelCheckpointSemanticVerifierV1({
      model: {
        async complete(request) {
          requests.push(request);
          return { status: "completed", text: '{"status":"supported"}' };
        },
      },
    });

    expect(await runVerifier(verifier)).toEqual({ status: "supported" });
    expect(requests[0]?.system).toContain("independent, read-only");
    expect(requests[0]?.user).toContain('"sourceSeqs":[4,5]');
  });

  test("maps a closed-set rejection reason to a stable error code", async () => {
    const verifier = createModelCheckpointSemanticVerifierV1({
      model: {
        async complete() {
          return {
            status: "completed",
            text: '{"status":"rejected","reasonCode":"meaning_changed"}',
          };
        },
      },
    });

    expect(await runVerifier(verifier)).toEqual({
      status: "rejected",
      errorCode: "CheckpointSemanticRejected_meaning_changed",
    });
  });

  test("fails closed for commentary, extra keys, and unknown reasons", async () => {
    for (const text of [
      'OK {"status":"supported"}',
      '{"status":"supported","note":"looks good"}',
      '{"status":"rejected","reasonCode":"trust_me"}',
    ]) {
      const verifier = createModelCheckpointSemanticVerifierV1({
        model: {
          async complete() {
            return { status: "completed", text };
          },
        },
      });
      expect((await runVerifier(verifier)).status).toBe("unknown");
    }
  });

  test("does not call the model after cancellation", async () => {
    let modelCalls = 0;
    const controller = new AbortController();
    controller.abort();
    const verifier = createModelCheckpointSemanticVerifierV1({
      model: {
        async complete() {
          modelCalls += 1;
          return { status: "completed", text: '{"status":"supported"}' };
        },
      },
    });

    expect(await runVerifier(verifier, controller.signal)).toEqual({
      status: "unknown",
      errorCode: "CheckpointSemanticVerificationCancelled",
    });
    expect(modelCalls).toBe(0);
  });
});

function runVerifier(
  verifier: ReturnType<typeof createModelCheckpointSemanticVerifierV1>,
  signal = new AbortController().signal,
) {
  return verifier.verify(
    {
      checkpoint: validCheckpoint(),
      evidence: projectCheckpointEvidenceV1(sourceEntries()),
    },
    { signal },
  );
}
