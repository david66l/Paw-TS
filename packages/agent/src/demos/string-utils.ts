/**
 * 首字母大写，空串安全。
 * @param s 输入字符串
 * @returns 首字母大写后的字符串，空串返回空串
 */
export function capitalize(s: string): string {
  if (!s) return "";
  return s.charAt(0).toUpperCase() + s.slice(1);
}

/**
 * 判断字符串是否为空或仅包含空白字符。
 * @param s 输入字符串
 * @returns 如果 s 为 null/undefined/空串/仅空白字符则返回 true
 */
export function isBlank(s: string): boolean {
  return !s || s.trim().length === 0;
}
