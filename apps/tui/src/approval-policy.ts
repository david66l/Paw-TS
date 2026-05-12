/**
 * When strict tool approval is enabled, every harness tool requires y/n (including read/list/search).
 */
export function approvalPolicyWhenStrict(
  strict: boolean,
): ((tool: string) => boolean) | undefined {
  return strict ? () => true : undefined;
}
