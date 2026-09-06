import { afterAll, beforeAll, expect, setDefaultTimeout, test } from "bun:test";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { ToolRunResult } from "@paw/harness";
import type { LanguageModel } from "@paw/models";
import { assertVisualAuditCheckV1 } from "@paw/protocol";
import {
  BROWSER_PROOF_PREFIX,
  runBrowserCheck,
} from "../src/paw-next/browser-check.js";
import {
  createVisualBrowserCheck,
  verifyVisualEvidence,
} from "../src/paw-next/visual-check.js";

setDefaultTimeout(30_000);
const root = fs.mkdtempSync(path.join(os.tmpdir(), "paw-visual-unit-"));
let captured: ToolRunResult;
beforeAll(async () => {
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: () =>
      new Response(
        '<!doctype html><h1 style="color:blue">Paw visual test</h1>',
        { headers: { "content-type": "text/html" } },
      ),
  });
  try {
    captured = await runBrowserCheck(
      {
        url: server.url.href,
        steps: [{ action: "assert_visible", selector: "h1" }],
      },
      undefined,
      true,
    );
    expect(captured.ok).toBe(true);
  } finally {
    await server.stop(true);
  }
});
afterAll(() => fs.rmSync(root, { recursive: true, force: true }));

test("cancellation completes even if the visual model ignores its signal", async () => {
  const controller = new AbortController();
  const check = createVisualBrowserCheck({
    workspaceRoot: root,
    requirements: "Title must be blue",
    capture: async () => captured,
    model: {
      label: "non-cooperative-fixture",
      capabilities: { contextWindow: 32000, imageInput: true },
      complete() {
        setTimeout(() => controller.abort(), 10);
        return new Promise(() => {});
      },
    },
  });
  expect((await check({}, controller.signal)).ok).toBe(false);
});

for (const variant of [
  "pass",
  "wrong_hash",
  "empty_checks",
  "contradiction",
  "extra",
  "tool",
  "truncated",
  "missing_image",
  "bad_image",
  "unsupported",
  "cancelled",
] as const) {
  test(`visual evidence: ${variant}`, async () => {
    let calls = 0;
    const model: LanguageModel = {
      label: "visual-fixture",
      capabilities: {
        contextWindow: 32000,
        ...(variant !== "unsupported" ? { imageInput: true as const } : {}),
      },
      async complete(messages, options) {
        calls++;
        expect(messages).toHaveLength(2);
        expect(options?.tools).toEqual([]);
        const image = messages[1]?.attachments?.[0];
        expect(image?.type).toBe("image");
        const bytes = Buffer.from(image?.content.split(",")[1] ?? "", "base64");
        expect(bytes.readUInt32BE(16)).toBe(1280);
        expect(bytes.readUInt32BE(20)).toBe(800);
        const report = {
          screenshotHash:
            variant === "wrong_hash"
              ? "f".repeat(64)
              : createHash("sha256").update(bytes).digest("hex"),
          requirementsHash: createHash("sha256")
            .update("Title must be blue")
            .digest("hex"),
          verdict: "pass",
          summary: "标题清晰可见",
          checks:
            variant === "empty_checks"
              ? []
              : [
                  {
                    criterion: "蓝色标题",
                    verdict: variant === "contradiction" ? "unknown" : "pass",
                    observation: "页面左上方有蓝色 Paw visual test 标题。",
                  },
                ],
          ...(variant === "extra" ? { invented: true } : {}),
        };
        return {
          text: JSON.stringify(report),
          finishReason: variant === "truncated" ? "length" : "stop",
          ...(variant === "tool"
            ? { toolCalls: [{ id: "bad", name: "shell", arguments: {} }] }
            : {}),
        };
      },
    };
    const controller = new AbortController();
    if (variant === "cancelled") controller.abort();
    const check = createVisualBrowserCheck({
      workspaceRoot: root,
      model,
      requirements: "Title must be blue",
      capture: async () => {
        const clone = structuredClone(captured);
        const payload = clone.payload as Record<string, unknown>;
        if (variant === "missing_image") payload.screenshot = undefined;
        if (variant === "bad_image")
          (payload.screenshot as { data: string }).data = "not an image";
        return clone;
      },
    });
    const result = await check({}, controller.signal);
    expect(result.ok).toBe(variant === "pass");
    expect(JSON.stringify(result)).not.toContain("iVBOR");
    if (
      ["missing_image", "bad_image", "unsupported", "cancelled"].includes(
        variant,
      )
    )
      expect(calls).toBe(0);
    if (variant === "pass") {
      const proof = JSON.parse(
        result.summary.slice(BROWSER_PROOF_PREFIX.length),
      ).visual;
      assertVisualAuditCheckV1(proof);
      expect(verifyVisualEvidence(root, proof)).toBe(true);
      expect(verifyVisualEvidence(root, { ...proof, summary: "forged" })).toBe(
        false,
      );
      const file = path.join(
        root,
        ".paw",
        "visual-audits",
        `${proof.screenshotHash}.png`,
      );
      const original = fs.readFileSync(file);
      fs.writeFileSync(file, "tampered");
      expect(verifyVisualEvidence(root, proof)).toBe(false);
      fs.writeFileSync(file, original);
    }
  });
}
