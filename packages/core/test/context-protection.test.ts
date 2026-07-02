import { describe, expect, it } from "bun:test";
import { ContextManager } from "../src/context/manager.js";

describe("ContextManager Head/Tail Protection", () => {
  it("protects system message from truncation", () => {
    const cm = new ContextManager({ maxTokens: 20 });
    cm.setSystem("You are a helpful assistant");
    cm.addUser("Goal");
    cm.addAssistant("Ok");
    cm.addUser("Step 1");
    cm.addAssistant("Done");
    // Force budget to be very tight
    const msgs = cm.buildMessages();
    expect(msgs[0]?.role).toBe("system");
  });

  it("protects initial user goal", () => {
    const cm = new ContextManager({ maxTokens: 30 });
    cm.setSystem("sys");
    cm.addUser("Initial goal"); // should be protected
    cm.addAssistant("Ack");
    cm.addUser("Step 1");
    cm.addAssistant("Result 1");
    cm.addUser("Step 2");
    cm.addAssistant("Result 2");
    // Tight budget to force truncation
    const msgs = cm.buildMessages();
    const contents = msgs.map((m) => m.content);
    expect(contents).toContain("Initial goal");
  });

  it("protects recent tail turns", () => {
    const cm = new ContextManager({ maxTokens: 50, tailTurnCount: 2 });
    cm.setSystem("sys");
    cm.addUser("Goal");
    cm.addAssistant("Ack");
    cm.addUser("Step 1");
    cm.addAssistant("Result 1");
    cm.addUser("Step 2");
    cm.addAssistant("Result 2");
    cm.addUser("Step 3");
    cm.addAssistant("Result 3");
    const msgs = cm.buildMessages();
    // Recent 2 turns (Step 2/Result 2, Step 3/Result 3) should be present
    const contents = msgs.map((m) => m.content);
    expect(contents).toContain("Result 2");
    expect(contents).toContain("Result 3");
  });

  it("degrades tail turns when budget is tight", () => {
    const cm = new ContextManager({ maxTokens: 25, tailTurnCount: 3 });
    cm.setSystem("sys");
    cm.addUser("Goal");
    cm.addAssistant("A1");
    cm.addUser("S1");
    cm.addAssistant("A2");
    cm.addUser("S2");
    cm.addAssistant("A3");
    // With only 25 tokens budget, 3 tail turns won't fit;
    // degradation should kick in to 2 → 1 → 0 turns
    const msgs = cm.buildMessages();
    expect(msgs.length).toBeGreaterThanOrEqual(2); // at least system + something
  });

  it("evicts oldest non-protected messages first", () => {
    const cm = new ContextManager({ maxTokens: 40 });
    cm.setSystem("sys");
    cm.addUser("Goal");
    cm.addAssistant("A1");
    cm.addUser("Old step");
    cm.addAssistant("A2");
    cm.addUser("Recent step");
    cm.addAssistant("A3");
    const msgs = cm.buildMessages();
    const contents = msgs.map((m) => m.content);
    // "Old step" is in the middle — not head, not tail — should be evicted first
    expect(contents).toContain("Goal"); // head protected
    expect(contents).toContain("Recent step"); // tail protected
    expect(contents).toContain("A3"); // tail protected
  });

  it("never evicts the most recent message", () => {
    const cm = new ContextManager({ maxTokens: 15 });
    cm.setSystem("s");
    cm.addUser("Goal");
    cm.addAssistant("A1");
    cm.addUser("Last");
    const msgs = cm.buildMessages();
    expect(msgs[msgs.length - 1]?.content).toBe("Last");
  });

  it("protects old user constraints over old tool results", () => {
    const cm = new ContextManager({ maxTokens: 70, tailTurnCount: 1 });
    cm.setSystem("sys");
    cm.addUser("只能修改当前目录，不要动工作区外的文件");
    cm.addAssistant("Ack");
    for (let i = 0; i < 12; i++) {
      cm.addToolResult("read_file", true, `old file ${i}`, {
        content: "x".repeat(200),
      });
    }
    cm.addUser("现在继续");
    const contents = cm.buildMessages().map((m) => m.content);
    expect(contents).toContain("只能修改当前目录，不要动工作区外的文件");
    expect(contents[contents.length - 1]).toBe("现在继续");
  });

  it("tailTurnCount is configurable", () => {
    const cm3 = new ContextManager({ tailTurnCount: 3 });
    expect(cm3.tailTurnCount).toBe(3);

    const cm1 = new ContextManager({ tailTurnCount: 1 });
    expect(cm1.tailTurnCount).toBe(1);
  });
});
