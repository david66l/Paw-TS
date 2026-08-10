/**
 * 轻量工具函数：稳定字符串哈希。
 * ================================
 * 非密码学用途，仅用于内容寻址（P1 去重 / P3 归档去重键），
 * 保证同一字符串在不同模块中产生一致的 hash。
 */

/** 稳定字符串哈希（非密码学，仅用于内容寻址/去重） */
export function simpleHash(s: string): string {
  let h1 = 0xdeadbeef;
  let h2 = 0x41c6ce57;
  for (let i = 0; i < s.length; i++) {
    const ch = s.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 =
    Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^
    Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 =
    Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^
    Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(16);
}
