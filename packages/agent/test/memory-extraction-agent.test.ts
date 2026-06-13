import { describe, expect, it } from "bun:test";
import type { ChatMessage, LanguageModel } from "@paw/models";
import {
  extractMemories,
  scanForSensitiveInfo,
} from "../src/memory-extraction-agent.js";

const EXTRACTION_TEXT = `## Entry 1
- **Name**: user_prefers_tabs
- **Type**: user
- **Description**: User prefers tabs over spaces
- **Content**: The user explicitly stated they prefer using tabs for indentation instead of spaces.

## Entry 2
- **Name**: project_stack
- **Type**: project
- **Description**: Tech stack is React + TypeScript
- **Content**: This project uses React with TypeScript and Vite for bundling.

## Entry 3
- **Name**: ignored_section
- **Type**: invalid_type
- **Description**: Should be ignored
- **Content**: Invalid type`;

function fakeModel(text: string): LanguageModel {
  return {
    label: "fake-memory",
    async complete() {
      return { text };
    },
    async *completeStream() {
      yield { type: "done" as const };
    },
  };
}

describe("extractMemories", () => {
  it("parses memory entries from model output", async () => {
    const result = await extractMemories(
      fakeModel(EXTRACTION_TEXT),
      "Some conversation",
    );
    expect(result.entries).toHaveLength(3);
    expect(result.entries[0]?.name).toBe("user_prefers_tabs");
    expect(result.entries[0]?.type).toBe("user");
    expect(result.entries[1]?.name).toBe("project_stack");
    expect(result.entries[1]?.type).toBe("project");
  });

  it("passes conversation text to model", async () => {
    let receivedUser = "";
    const capturingModel: LanguageModel = {
      label: "capture",
      async complete(messages: readonly ChatMessage[]) {
        receivedUser =
          messages.find((m) => m.role === "user")?.content?.toString() ?? "";
        return { text: "No memories to extract." };
      },
      async *completeStream() {
        yield { type: "done" as const };
      },
    };
    await extractMemories(capturingModel, "my conversation");
    expect(receivedUser).toContain("my conversation");
  });

  it("returns empty array for 'no memories' response", async () => {
    const result = await extractMemories(
      fakeModel("No memories to extract."),
      "Short conversation",
    );
    expect(result.entries).toEqual([]);
  });

  it("handles empty result gracefully", async () => {
    const result = await extractMemories(
      fakeModel(""),
      "Short conversation",
    );
    expect(result.entries).toEqual([]);
  });
});

describe("scanForSensitiveInfo", () => {
  const baseEntry = {
    name: "test_entry",
    description: "A test entry",
    type: "project" as const,
    content: "Normal project content.",
  };

  it("returns null for clean content", () => {
    expect(scanForSensitiveInfo(baseEntry)).toBeNull();
  });

  it("detects OpenAI API key", () => {
    const reason = scanForSensitiveInfo({
      ...baseEntry,
      content: "Set OPENAI_API_KEY=sk-proj1234567890abcdefghij",
    });
    expect(reason).toContain("OpenAI API key");
  });

  it("detects Anthropic API key", () => {
    const reason = scanForSensitiveInfo({
      ...baseEntry,
      content: "export ANTHROPIC_API_KEY=sk-ant-api03-abcdefghijklmnopqrstuvwxyz",
    });
    expect(reason).toContain("Anthropic API key");
  });

  it("detects Bearer token", () => {
    const reason = scanForSensitiveInfo({
      ...baseEntry,
      content: "Authorization: Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.abcdefghij12345.abcdefghij",
    });
    expect(reason).toMatch(/Bearer|JWT/);
  });

  it("detects private key block", () => {
    const reason = scanForSensitiveInfo({
      ...baseEntry,
      content: "-----BEGIN PRIVATE KEY-----\nMIIEvQIBADANBgkqhkiG9w0BAQEFAASCBKcwggSjAgEAAoIBAQ...\n-----END PRIVATE KEY-----",
    });
    expect(reason).toContain("private key");
  });

  it("detects password assignment", () => {
    const reason = scanForSensitiveInfo({
      ...baseEntry,
      content: "DB_PASSWORD = supersecret123",
    });
    expect(reason).toContain("password");
  });

  it("rejects entries with sensitive content from extraction result", async () => {
    const text = `## Entry 1
- **Name**: clean_entry
- **Type**: project
- **Description**: A clean project fact
- **Content**: The project uses pnpm as the package manager.

## Entry 2
- **Name**: leaked_key
- **Type**: reference
- **Description**: API configuration
- **Content**: Set the env var: API_KEY=sk-proj-deadbeef1234567890abcdef`;  // cursor is inside content
    const result = await extractMemories(fakeModel(text), "test conv");
    expect(result.entries.length).toBe(1);
    expect(result.entries[0]?.name).toBe("clean_entry");
    expect(result.rejected.length).toBe(1);
    expect(result.rejected[0]?.entry.name).toBe("leaked_key");
    expect(result.rejected[0]?.reason).toContain("OpenAI API key");
  });
});
