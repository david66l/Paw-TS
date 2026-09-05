import { describe, expect, test } from "bun:test";
import {
  compileMemoryDialogueOrdinalConstraintV1,
  isMemoryDialogueOrdinalConstraintV1,
} from "../src/dialogue-ordinal.js";

describe("dialogue ordinal constraint v1", () => {
  test("compiles a query-owned second assistant artifact reply", () => {
    const query =
      "Of the two sad songs you created, what chord progression made up the chorus of the second sad song?";
    const compiled = compileMemoryDialogueOrdinalConstraintV1(query);
    expect(compiled).toMatchObject({
      ordinal: 2,
      role: "assistant_output",
      order: "ascending",
      scope: "within_session",
    });
    expect(isMemoryDialogueOrdinalConstraintV1(compiled)).toBe(true);
  });
  test("accepts numeric ordinals only for a bound multi-reply artifact set", () => {
    expect(
      compileMemoryDialogueOrdinalConstraintV1(
        "You wrote three recipe drafts. What was in the 3rd recipe draft you wrote?",
      )?.ordinal,
    ).toBe(3);
  });
  test("does not turn a proper work title or book part into reply order", () => {
    expect(
      compileMemoryDialogueOrdinalConstraintV1(
        "What genre was the Fifth Album you mentioned?",
      ),
    ).toBeUndefined();
    expect(
      compileMemoryDialogueOrdinalConstraintV1(
        "What happened in the second part of the book?",
      ),
    ).toBeUndefined();
  });
  test("does not turn an ordinal inside one response into assistant-turn order", () => {
    expect(
      compileMemoryDialogueOrdinalConstraintV1(
        "You gave me a list of bottles; what was the fifth bottle?",
      ),
    ).toBeUndefined();
    expect(
      compileMemoryDialogueOrdinalConstraintV1(
        "You created two songs in the same response; what was the second song?",
      ),
    ).toBeUndefined();
  });
  test("rejects cross-clause binding, multiple ordinals, and the ninth/tenth cap", () => {
    expect(
      compileMemoryDialogueOrdinalConstraintV1(
        "You created two songs, and the second recipe was spicy.",
      ),
    ).toBeUndefined();
    expect(
      compileMemoryDialogueOrdinalConstraintV1(
        "You created two songs; was the first or second song better?",
      ),
    ).toBeUndefined();
    expect(
      compileMemoryDialogueOrdinalConstraintV1(
        "You created ten songs; what was the ninth song you created?",
      ),
    ).toBeUndefined();
    expect(
      compileMemoryDialogueOrdinalConstraintV1(
        "You created ten songs; what was the tenth song you created?",
      ),
    ).toBeUndefined();
    expect(
      compileMemoryDialogueOrdinalConstraintV1(
        "You wrote two songs. After the second song, what recipe did you recommend?",
      ),
    ).toBeUndefined();
    for (const query of [
      "You wrote two songs. What did you later say about the second song?",
      "You wrote two songs. What feedback did you give about the second song?",
      "You wrote two songs. Who did you tell about the second song?",
      "You wrote two songs. What was your opinion of the second song?",
      "You wrote two songs. What review did you give of the second song?",
      "You wrote two songs. What did you think of the second song?",
      "You wrote two songs. What did you later say of the second song?",
    ]) {
      expect(compileMemoryDialogueOrdinalConstraintV1(query)).toBeUndefined();
    }
  });
  test("requires the assistant owner, compatible qualifiers, and a valid numeric suffix", () => {
    expect(
      compileMemoryDialogueOrdinalConstraintV1(
        "Bob wrote two happy songs. What was the second song?",
      ),
    ).toBeUndefined();
    expect(
      compileMemoryDialogueOrdinalConstraintV1(
        "You wrote two happy songs. What was the second sad song?",
      ),
    ).toBeUndefined();
    expect(
      compileMemoryDialogueOrdinalConstraintV1(
        "You wrote two songs. What was the 2th song?",
      ),
    ).toBeUndefined();
    expect(
      compileMemoryDialogueOrdinalConstraintV1(
        "You wrote two songs for Bob. What was the second song?",
      ),
    ).toBeUndefined();
    expect(
      compileMemoryDialogueOrdinalConstraintV1(
        "You wrote two songs. What was his second song?",
      ),
    ).toBeUndefined();
    expect(
      compileMemoryDialogueOrdinalConstraintV1(
        "You wrote two drafts. Alice's second draft was excellent.",
      ),
    ).toBeUndefined();
    expect(
      compileMemoryDialogueOrdinalConstraintV1(
        "You wrote two songs. What was the 02nd song?",
      ),
    ).toBeUndefined();
  });
});
