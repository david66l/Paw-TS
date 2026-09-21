/** Per-estimator LRU: exact text keys, bounded retained UTF-16 units and entries. */
export function createBoundedTokenCounter(
  encodeCount: (text: string) => number,
  limits = { maxEntries: 2048, maxCharacters: 1_048_576 },
): (text: string) => number {
  const { maxEntries, maxCharacters } = limits;
  if (
    !Number.isSafeInteger(maxEntries) ||
    maxEntries <= 0 ||
    !Number.isSafeInteger(maxCharacters) ||
    maxCharacters <= 0
  ) {
    throw new Error("Token count cache limits must be positive safe integers");
  }
  const counts = new Map<string, number>();
  let retainedCharacters = 0;
  return (text) => {
    const cached = counts.get(text);
    if (cached !== undefined) {
      counts.delete(text);
      counts.set(text, cached);
      return cached;
    }
    const tokens = encodeCount(text);
    // One oversized request must not evict the useful working set or defeat the bound.
    if (text.length > maxCharacters) return tokens;
    while (
      counts.size >= maxEntries ||
      retainedCharacters + text.length > maxCharacters
    ) {
      const oldest = counts.keys().next();
      if (oldest.done) break;
      counts.delete(oldest.value);
      retainedCharacters -= oldest.value.length;
    }
    counts.set(text, tokens);
    retainedCharacters += text.length;
    return tokens;
  };
}
