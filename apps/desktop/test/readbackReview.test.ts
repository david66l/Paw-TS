import { expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { OpenAICompatibleModel } from "@paw/models";
import { runDesktopNext } from "../agent-host/paw-next.js";

test("desktop hands persisted readback payload to the reviewer on the first completion attempt", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "paw-readback-review-"));
  const nativeFetch = globalThis.fetch;
  let turns = 0;
  let reviews = 0;
  let actualPacket:
    | { observations: Array<{ observedOutput?: unknown }> }
    | undefined;
  globalThis.fetch = Object.assign(
    async (_url: unknown, init?: RequestInit) => {
      const request = JSON.parse(String(init?.body));
      if (!request.stream) {
        reviews++;
        actualPacket = JSON.parse(request.messages.at(-1).content);
        return Response.json({
          choices: [
            {
              message: {
                content:
                  '{"decision":"allow","reasonCode":"evidence_sufficient","summary":"Readback matches the requested file."}',
              },
              finish_reason: "stop",
            },
          ],
        });
      }
      turns++;
      const delta =
        turns <= 2
          ? {
              tool_calls: [
                {
                  index: 0,
                  id: `call-${turns}`,
                  type: "function",
                  function: {
                    name:
                      turns === 1
                        ? "workspace_write_file"
                        : "workspace_read_file",
                    arguments: JSON.stringify(
                      turns === 1
                        ? { path: "probe.txt", content: "PAW_TOOL_PROBE_OK\n" }
                        : { path: "probe.txt" },
                    ),
                  },
                },
              ],
            }
          : { content: "Done." };
      return new Response(
        `data: ${JSON.stringify({ choices: [{ delta }] })}\n\ndata: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: turns <= 2 ? "tool_calls" : "stop" }] })}\n\ndata: [DONE]\n\n`,
      );
    },
    { preconnect: nativeFetch.preconnect },
  ) as typeof fetch;
  try {
    const result = await runDesktopNext(
      "Write probe.txt containing PAW_TOOL_PROBE_OK followed by one newline, and read it back to verify.",
      {
        workspaceRoot: root,
        model: new OpenAICompatibleModel({
          apiKey: "test",
          model: "readback-test",
          capabilities: { contextWindow: 128_000, maxOutputTokens: 4096 },
        }),
        settings: {},
        taskMode: "standard",
        memoryEnabled: false,
        environmentAudit: false,
        maxSteps: 4,
        resolveToolApproval: async () => true,
        onEvent: () => {},
      },
    );
    expect(result.ok).toBe(true);
    expect(turns).toBe(3);
    expect(reviews).toBe(1);
    expect(
      actualPacket?.observations.some((e) =>
        JSON.stringify(e.observedOutput).includes("PAW_TOOL_PROBE_OK"),
      ),
    ).toBe(true);
    expect(actualPacket?.observations[0]?.observedOutput).toMatchObject({
      text: "PAW_TOOL_PROBE_OK\n",
      byteSize: 18,
      partial: false,
      truncated: false,
    });
    expect(
      fs
        .readFileSync(path.join(root, "probe.txt"))
        .equals(Buffer.from("PAW_TOOL_PROBE_OK\n")),
    ).toBe(true);
  } finally {
    globalThis.fetch = nativeFetch;
    if (
      path
        .resolve(root)
        .startsWith(path.join(os.tmpdir(), "paw-readback-review-"))
    ) {
      fs.rmSync(root, { recursive: true, force: true });
    }
  }
}, 30_000);
