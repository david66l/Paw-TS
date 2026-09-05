import { describe, expect, test } from "bun:test";

import { createJsonMemoryDialogueOrdinalAdmissionV1 } from "../src/dialogue-ordinal-admission.js";
import { compileMemoryDialogueOrdinalConstraintV1 } from "../src/dialogue-ordinal.js";

const direct =
  "Of the two sad songs you created, what chord progression made up the chorus of the second sad song?";

function compiledConstraint() {
  const constraint = compileMemoryDialogueOrdinalConstraintV1(direct);
  if (!constraint) throw new Error("test ordinal constraint did not compile");
  return constraint;
}

describe("dialogue ordinal semantic admission", () => {
  test("only sees the normalized query and immutable compiler constraint", async () => {
    const constraint = compiledConstraint();
    let seen: unknown;
    const admission = createJsonMemoryDialogueOrdinalAdmissionV1({
      model: {
        async complete(request) {
          seen = JSON.parse(request.user);
          return {
            status: "completed" as const,
            text: '{"classification":"artifact_internal_content"}',
          };
        },
      },
      admissionVersion: "glm-5.3-flash:low:cache:ordinal-admission",
    });
    const receipt = await admission.admit(
      { query: direct, constraint },
      new AbortController().signal,
    );
    expect(receipt?.classification).toBe("artifact_internal_content");
    expect(seen).toEqual({
      schemaVersion: "paw.memory-dialogue-ordinal-admission-result.v1",
      query: direct,
      constraint: {
        constraintVersion: constraint.constraintVersion,
        constraintRevision: constraint.constraintRevision,
        ordinal: 2,
        role: "assistant_output",
        order: "ascending",
        scope: "within_session",
        artifactHead: "song",
        artifactPhrase: "sad song",
        granularity: "assistant_reply_artifact",
      },
    });
  });

  test("rejects non-direct, malformed, and unavailable replies without a receipt", async () => {
    const constraint = compiledConstraint();
    for (const result of [
      '{"classification":"non_direct_or_ambiguous"}',
      '{"classification":"artifact_itself","ordinal":2}',
      '{"classification":"uncertain"}',
    ]) {
      const admission = createJsonMemoryDialogueOrdinalAdmissionV1({
        model: {
          async complete() {
            return { status: "completed" as const, text: result };
          },
        },
        admissionVersion: "test-admission.v1",
      });
      if (result.includes("non_direct")) {
        expect(
          await admission.admit(
            { query: direct, constraint },
            new AbortController().signal,
          ),
        ).toBeUndefined();
      } else {
        await expect(
          admission.admit(
            { query: direct, constraint },
            new AbortController().signal,
          ),
        ).rejects.toHaveProperty(
          "name",
          "MemoryDialogueOrdinalAdmissionOutputInvalid",
        );
      }
    }
    const unavailable = createJsonMemoryDialogueOrdinalAdmissionV1({
      model: {
        async complete() {
          return { status: "truncated" as const, errorCode: "length" };
        },
      },
      admissionVersion: "test-admission.v1",
    });
    await expect(
      unavailable.admit(
        { query: direct, constraint },
        new AbortController().signal,
      ),
    ).rejects.toHaveProperty(
      "name",
      "MemoryDialogueOrdinalAdmissionUnavailable",
    );
  });

  test("propagates AbortError but makes transport failures fail closed upstream", async () => {
    const constraint = compiledConstraint();
    const transport = createJsonMemoryDialogueOrdinalAdmissionV1({
      model: {
        async complete() {
          throw new Error("transport unavailable");
        },
      },
      admissionVersion: "test-admission.v1",
    });
    await expect(
      transport.admit(
        { query: direct, constraint },
        new AbortController().signal,
      ),
    ).rejects.toThrow("transport unavailable");

    const aborted = createJsonMemoryDialogueOrdinalAdmissionV1({
      model: {
        async complete() {
          return {
            status: "completed" as const,
            text: '{"classification":"artifact_itself"}',
          };
        },
      },
      admissionVersion: "test-admission.v1",
    });
    const controller = new AbortController();
    controller.abort();
    await expect(
      aborted.admit({ query: direct, constraint }, controller.signal),
    ).rejects.toHaveProperty("name", "AbortError");
  });

  test("binds model/reasoning/cache identity through the admission version", async () => {
    const constraint = compiledConstraint();
    const receive = async (admissionVersion: string) =>
      createJsonMemoryDialogueOrdinalAdmissionV1({
        model: {
          async complete() {
            return {
              status: "completed" as const,
              text: '{"classification":"artifact_itself"}',
            };
          },
        },
        admissionVersion,
      }).admit({ query: direct, constraint }, new AbortController().signal);
    const low = await receive("glm-5.3-flash:low:cache:ordinal-admission");
    const max = await receive("glm-5.3-flash:max:cache:ordinal-admission");
    expect(low?.admissionRevision).not.toBe(max?.admissionRevision);
  });
});
