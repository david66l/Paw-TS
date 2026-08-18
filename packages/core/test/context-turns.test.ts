import { describe, expect, test } from "bun:test";
import type { ChatMessage } from "../src/context/manager.js";
import {
  flattenContextTurnsV1,
  groupContextTurnsV1,
} from "../src/context/turns.js";

describe("derived context turns v1", () => {
  test("groups a leading prefix and assistant-boundary units", () => {
    const messages: ChatMessage[] = [
      { role: "user", content: "goal" },
      { role: "assistant", content: "tool call 1" },
      { role: "user", content: "tool result 1" },
      { role: "user", content: "environment observation" },
      { role: "assistant", content: "tool call 2" },
      { role: "user", content: "tool result 2" },
    ];
    const turns = groupContextTurnsV1(messages);
    expect(turns.map((turn) => [turn.start, turn.endExclusive])).toEqual([
      [0, 1],
      [1, 4],
      [4, 6],
    ]);
    expect(flattenContextTurnsV1(turns)).toEqual(messages);
    expect(turns[1]?.messages[0]).toBe(messages[1]);
    expect(turns[1]?.messages[1]).toBe(messages[2]);
  });

  test("keeps a native tool envelope as one atomic unit", () => {
    const messages: ChatMessage[] = [
      {
        role: "assistant",
        content: "native fallback",
        attachments: [
          { type: "file", name: "trace.txt", content: "trace" },
        ],
        nativeToolTurn: {
          schemaVersion: 1,
          protocol: "openai-compatible",
          assistantContent: "",
          calls: [
            {
              callId: "call-1",
              providerName: "workspace.read_file",
              rawArguments: '{"path":"a.ts"}',
            },
          ],
          results: [{ callId: "call-1", content: "read ok" }],
        },
      },
    ];
    const turns = groupContextTurnsV1(messages);
    expect(turns).toHaveLength(1);
    expect(turns[0]?.messages[0]).toBe(messages[0]);
    expect(turns[0]?.messages[0]?.attachments).toBe(messages[0]?.attachments);
    expect(turns[0]?.messages[0]?.nativeToolTurn).toEqual(
      messages[0]?.nativeToolTurn,
    );
  });

  test("keeps leading pre-assistant messages as standalone units", () => {
    const messages: ChatMessage[] = [
      { role: "user", content: "goal" },
      { role: "user", content: "follow-up" },
    ];
    const turns = groupContextTurnsV1(messages);
    expect(turns.map((turn) => [turn.start, turn.endExclusive])).toEqual([
      [0, 1],
      [1, 2],
    ]);
    expect(turns[0]?.messages[0]).toBe(messages[0]);
    expect(turns[1]?.messages[0]).toBe(messages[1]);
  });

  test("documents conservative legacy grouping of a real follow-up", () => {
    const messages: ChatMessage[] = [
      { role: "assistant", content: "previous answer" },
      { role: "user", content: "new human follow-up" },
      { role: "assistant", content: "follow-up answer" },
    ];
    const turns = groupContextTurnsV1(messages);
    // Without durable provenance, the follow-up cannot be distinguished from
    // an action observation. Preserve the assistant-to-observation invariant.
    expect(turns.map((turn) => [turn.start, turn.endExclusive])).toEqual([
      [0, 2],
      [2, 3],
    ]);
  });
});
