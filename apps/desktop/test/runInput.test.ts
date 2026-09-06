import { expect, test } from "bun:test";
import { createRequire } from "node:module";
const { runInputFields } = createRequire(import.meta.url)(
  "../electron/run-input.cjs",
);

test("Electron forwards recovery and explicit empty history without inventing a budget", () => {
  expect(runInputFields({ intent: "recover", history: [] })).toEqual({
    intent: "recover",
    history: [],
  });
  expect(runInputFields({})).toEqual({ intent: "continue" });
  expect(
    runInputFields({
      intent: "reset",
      maxSteps: 12,
      history: [
        { role: "user", content: " hello " },
        { role: "system", content: "bad" },
      ],
    }),
  ).toEqual({
    intent: "reset",
    maxSteps: 12,
    history: [{ role: "user", content: "hello" }],
  });
  expect(runInputFields({ maxSteps: -1 })).not.toHaveProperty("maxSteps");
});
