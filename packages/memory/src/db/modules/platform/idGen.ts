/**
 * ID 生成器 —— 前缀 + 时间戳 + 随机字符
 *
 * ponytail: 不用 uuid 库，12 字节随机 + 时间戳防碰撞足够
 */

export function generateId(prefix: string): string {
  const rnd = Math.random().toString(36).slice(2, 10);
  const ts = Date.now().toString(36);
  return `${prefix}_${ts}_${rnd}`;
}

/** 验证 ID 前缀，用于参数校验 */
export function isId(prefix: string, value: string): boolean {
  return value.startsWith(`${prefix}_`);
}
