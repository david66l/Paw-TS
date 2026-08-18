import { describe, expect, test } from "bun:test";

import {
  createMemoryHintCheckpointV1,
  migrateLegacyMemoryProjectionsV1,
  parseMemoryHintCheckpointV1,
  renderRelevantMemoryV1,
} from "../src/memory-host-state.js";
import { wrapObservationContentV1 } from "../src/observation-provenance.js";

describe("memory HostState projection", () => {
  test("renders fixed provenance-wrapped channels under the total cap", () => {
    const rendered = renderRelevantMemoryV1({
      primary: "P".repeat(10_000),
      latestHint: createMemoryHintCheckpointV1(
        "action_failed",
        "H".repeat(4_000),
      ),
      coldResume: {
        task: "T".repeat(1_000),
        state: "S".repeat(3_000),
      },
    });

    expect(rendered).toBeDefined();
    expect(rendered?.length).toBeLessThanOrEqual(8_000);
    expect(rendered).toContain("[Task Memory]");
    expect(rendered).toContain("[Action Failure Memory]");
    expect(rendered).toContain("source=memory");
    expect(rendered).toContain("instruction_authority=none");
    expect(rendered).not.toContain("[Post-compact Memory]");
  });

  test("validates one bounded crash-safe latest hint", () => {
    const hint = createMemoryHintCheckpointV1(
      "post_compact",
      `  ${"x".repeat(3_000)}  `,
    );
    expect(hint?.text).toHaveLength(2_000);
    expect(parseMemoryHintCheckpointV1(hint)).toEqual(hint);
    expect(
      parseMemoryHintCheckpointV1({
        schemaVersion: "paw.memory-hint.v1",
        kind: "post_compact",
        text: "x".repeat(2_001),
      }),
    ).toBeUndefined();
  });

  test("migrates structured legacy memory projections across the transcript", () => {
    const xml =
      '<agent-memory source="semantic" id="m1" status="verified">\nuse port 42\n</agent-memory>';
    expect(
      migrateLegacyMemoryProjectionsV1([
        { role: "user", content: `[Memory hint]\n${xml}` },
      ]).latestHint,
    ).toMatchObject({ kind: "action_failed", text: xml });
    expect(
      migrateLegacyMemoryProjectionsV1([
        { role: "user", content: "[Memory hint]\nplease explain this title" },
      ]).messages,
    ).toHaveLength(1);
    expect(
      migrateLegacyMemoryProjectionsV1([
        { role: "user", content: `[Memory hint]\n${xml}` },
        { role: "assistant", content: "consumed" },
      ]),
    ).toEqual({
      messages: [{ role: "assistant", content: "consumed" }],
    });
    expect(
      migrateLegacyMemoryProjectionsV1([
        { role: "assistant", content: "tool action" },
        { role: "user", content: "tool observation" },
        { role: "user", content: `[Memory hint]\n${xml}` },
      ]).latestHint,
    ).toMatchObject({ kind: "action_failed", text: xml });
    const migrated = migrateLegacyMemoryProjectionsV1([
      { role: "user", content: `[Memory hint]\n${xml}` },
      { role: "assistant", content: "tool action" },
      {
        role: "user",
        content:
          "[Previous session context]\nTask: old task\nwith details\nState: old state\nwith progress",
      },
      {
        role: "user",
        content: `[Memory refresh]\n${wrapObservationContentV1("memory.read", xml)}`,
      },
      {
        role: "user",
        content: `[Memory refresh]\n${wrapObservationContentV1("memory.read", "[CURRENT GOAL]\nfix parser\n\n[BACKGROUND CONTEXT]\nlegacy v1 fact")}`,
      },
      { role: "user", content: "[Memory refresh]\nnot a Paw wrapper" },
      {
        role: "user",
        content: `[Memory hint]\n${xml}\nplease explain`,
      },
      {
        role: "user",
        content:
          '[Memory hint]\n<agent-memory source="semantic" id="m1" status="verified" extra="no">\nuser text\n</agent-memory>',
      },
      {
        role: "user",
        content: "[Memory hint]\n<agent-memory please explain</agent-memory>",
      },
      {
        role: "user",
        content: "[Previous session context] is my title",
      },
    ]);
    expect(migrated.latestHint).toBeUndefined();
    expect(migrated.coldResume).toEqual({
      task: "old task\nwith details",
      state: "old state\nwith progress",
    });
    expect(migrated.messages.map((message) => message.content)).toEqual([
      "tool action",
      "[Memory refresh]\nnot a Paw wrapper",
      `[Memory hint]\n${xml}\nplease explain`,
      '[Memory hint]\n<agent-memory source="semantic" id="m1" status="verified" extra="no">\nuser text\n</agent-memory>',
      "[Memory hint]\n<agent-memory please explain</agent-memory>",
      "[Previous session context] is my title",
    ]);
  });
});
