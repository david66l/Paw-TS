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

test("Electron only forwards the supported long-task mode", () => {
  expect(runInputFields({ taskMode: "long" })).toMatchObject({
    taskMode: "long",
  });
  expect(runInputFields({ taskMode: "unsupported" })).not.toHaveProperty(
    "taskMode",
  );
});

test("Electron forwards only an explicit visual requirement", () => {
  expect(runInputFields({ visualAudit: true })).toMatchObject({
    visualAudit: true,
  });
  for (const value of [false, "true", 1, null])
    expect(runInputFields({ visualAudit: value })).not.toHaveProperty(
      "visualAudit",
    );
});
