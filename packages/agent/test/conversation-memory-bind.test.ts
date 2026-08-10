import { describe, expect, test } from "bun:test";
import {
  bindConversationMemoryTask,
  clearConversationMemoryBindings,
  getConversationMemoryTask,
  takeConversationMemoryTask,
} from "../src/conversation-memory-bind.js";

describe("conversation-memory-bind", () => {
  test("bind get take", () => {
    clearConversationMemoryBindings();
    bindConversationMemoryTask("conv-1", "task-a");
    expect(getConversationMemoryTask("conv-1")).toBe("task-a");
    expect(takeConversationMemoryTask("conv-1")).toBe("task-a");
    expect(getConversationMemoryTask("conv-1")).toBeUndefined();
  });

  test("overwrite same conversation", () => {
    clearConversationMemoryBindings();
    bindConversationMemoryTask("c", "t1");
    bindConversationMemoryTask("c", "t2");
    expect(getConversationMemoryTask("c")).toBe("t2");
  });
});
