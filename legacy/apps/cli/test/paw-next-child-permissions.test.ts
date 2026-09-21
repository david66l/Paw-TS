import { expect, test } from "bun:test";
import {
  type FrozenPermissionConfigV1,
  FrozenPermissionEngineV1,
  type PermissionRuleV1,
} from "@paw/runtime";
import { mergeChildPermissionRules } from "../../../../packages/paw-next/src/child-permissions.js";

const inspector: readonly PermissionRuleV1[] = [
  {
    id: "allow-child-read",
    layer: "default",
    category: "read",
    action: "allow",
  },
  { id: "deny-child-write", layer: "hard", category: "write", action: "deny" },
  { id: "deny-child-shell", layer: "hard", category: "shell", action: "deny" },
];
const config = (
  rules: readonly PermissionRuleV1[],
): FrozenPermissionConfigV1 => ({
  policyVersion: "test",
  defaultAction: "deny",
  rules,
});

test("nested inspectors reuse inherited denials across multiple generations", () => {
  let parent = config(inspector);
  for (let level = 0; level < 3; level++) {
    parent = config(mergeChildPermissionRules(parent, inspector));
    expect(() => new FrozenPermissionEngineV1(parent)).not.toThrow();
    expect(parent.rules).toHaveLength(3);
    expect(parent.rules.filter((rule) => rule.action === "deny")).toEqual(
      inspector.slice(1),
    );
    expect(Object.isFrozen(parent.rules)).toBe(true);
  }
});

test("equivalent denials reuse parent IDs while unrelated ID collisions keep both targets", () => {
  const parent = config([
    { id: "org-shell", layer: "hard", category: "shell", action: "deny" },
    {
      id: "deny-child-write",
      layer: "admin",
      tool: "workspace.read_file",
      action: "deny",
    },
    {
      id: "allow-child-read",
      layer: "hard",
      tool: "workspace.list_dir",
      action: "deny",
    },
    { id: "user-write", layer: "user", category: "write", action: "allow" },
  ]);
  const original = JSON.stringify(parent);
  const merged = config(mergeChildPermissionRules(parent, inspector));
  expect(() => new FrozenPermissionEngineV1(merged)).not.toThrow();
  expect(JSON.stringify(parent)).toBe(original);
  expect(merged.rules.slice(0, 3)).toEqual(parent.rules.slice(0, 3));
  expect(merged.rules).toContainEqual({
    id: "deny-child-write:1",
    layer: "hard",
    category: "write",
    action: "deny",
  });
  expect(merged.rules).toContainEqual({
    id: "allow-child-read:1",
    layer: "default",
    category: "read",
    action: "allow",
  });
  expect(merged.rules.some((rule) => rule.id === "user-write")).toBe(false);
});

test("invalid inherited policies remain rejected rather than silently weakened", () => {
  const parent = config([
    { id: "first", layer: "hard", category: "write", action: "deny" },
    { id: "second", layer: "hard", category: "write", action: "deny" },
  ]);
  expect(
    () =>
      new FrozenPermissionEngineV1(
        config(mergeChildPermissionRules(parent, inspector)),
      ),
  ).toThrow("Ambiguous permission rules");
});
