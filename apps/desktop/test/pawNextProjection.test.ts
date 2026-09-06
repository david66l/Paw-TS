import { expect, test } from "bun:test";
import { desktopFileChanges } from "../agent-host/paw-next-changes";
import { runStatusLabel, settledRunStatus } from "../src/agent/types";

test("multi-file patches project only successful changes with their own patch section", () => {
  const patch =
    "--- a/one.txt\n+++ b/one.txt\n@@ -1 +1 @@\n-old\n+new\n--- a/two.txt\n+++ b/two.txt\n@@ -1 +1 @@\n-before\n+after\n";
  const changes = desktopFileChanges(
    {
      results: [
        { path: "one.txt", ok: true, linesAdded: 1, linesRemoved: 1 },
        { path: "two.txt", ok: true, linesAdded: 1, linesRemoved: 1 },
        { path: "failed.txt", ok: false, linesAdded: 9 },
        { path: "noop.txt", changed: false, linesAdded: 0 },
      ],
    },
    { patch },
    process.cwd(),
  );
  expect(changes).toHaveLength(2);
  expect(changes[0]?.diff).toContain("+new");
  expect(changes[0]?.diff).not.toContain("+after");
  expect(changes[1]?.diff).toContain("+after");
});

test("waiting and budget exhaustion stay distinct from success and failure", () => {
  expect(settledRunStatus("await_user")).toBe("await_user");
  expect(settledRunStatus("await_external")).toBe("await_external");
  expect(settledRunStatus("incomplete")).toBe("incomplete");
  expect(settledRunStatus("unexpected")).toBe("incomplete");
  expect(runStatusLabel("await_user")).toBe("等待回复");
  expect(runStatusLabel("await_external")).toBe("等待外部任务");
});
