import type { FrozenPermissionConfigV1, PermissionRuleV1 } from "@paw/runtime";

/** Keep inherited restrictions intact when a child starts another inspector. */
export function mergeChildPermissionRules(
  parent: FrozenPermissionConfigV1 | undefined,
  child: readonly PermissionRuleV1[],
): readonly PermissionRuleV1[] {
  const rules = (parent?.rules ?? [])
    .filter((rule) => rule.layer === "hard" || rule.layer === "admin")
    .map((rule) => Object.freeze({ ...rule }));
  const ids = new Set(rules.map((rule) => rule.id));
  for (const rule of child) {
    // Matching IDs alone are not enough: an inherited rule may protect a
    // different target. Reuse only an identical denial in the same layer.
    if (
      rule.action === "deny" &&
      rules.some(
        (inherited) =>
          inherited.action === "deny" &&
          inherited.layer === rule.layer &&
          inherited.tool === rule.tool &&
          inherited.category === rule.category,
      )
    )
      continue;
    let id = rule.id;
    for (let suffix = 1; ids.has(id); suffix++) id = `${rule.id}:${suffix}`;
    rules.push(Object.freeze({ ...rule, id }));
    ids.add(id);
  }
  return Object.freeze(rules);
}
