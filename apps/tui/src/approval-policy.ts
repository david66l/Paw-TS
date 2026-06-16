/**
 * 工具审批策略。
 *
 * 在严格模式下，所有工具调用都需要用户显式确认；非严格模式下则走默认策略
 *（通常仅对未知/危险工具提示审批）。
 */

/**
 * 根据严格模式开关返回审批策略。
 *
 * @param strict true 表示所有工具都需要审批
 * @returns 审批策略函数；非严格模式返回 undefined，使用 orchestrator 默认策略
 */
export function approvalPolicyWhenStrict(
  strict: boolean,
): ((tool: string) => boolean) | undefined {
  return strict ? () => true : undefined;
}
