import { Text } from "ink";

/**
 * Renders a single-line prompt with an insertion cursor (inverse block like many terminals).
 */
export function PromptLine({
  line,
  cursor,
}: {
  readonly line: string;
  readonly cursor: number;
}) {
  const c = Math.max(0, Math.min(cursor, line.length));
  const before = line.slice(0, c);
  const at = line.slice(c, c + 1);
  const after = line.slice(c + 1);
  const showEmptySlot = at.length === 0;
  return (
    <>
      {before}
      <Text inverse>{showEmptySlot ? " " : at}</Text>
      {after}
    </>
  );
}
