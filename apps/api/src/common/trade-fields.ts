/**
 * Order-insensitive compare for a trade answer map.
 *
 * Each question's selected options are stored in the order the poster tapped them, and a
 * re-tap in another order is NOT a change to the vacancy; question keys are compared as a
 * set for the same reason. NULL means "not stated" and is never equal to any map, including
 * `{}` — the columns exist precisely to keep those two facts apart.
 */
export function sameTradeAnswers(
  next: Record<string, readonly string[]> | null | undefined,
  current: Record<string, string[]> | null,
): boolean {
  if (next === undefined || next === null || current === null) return false;
  const nextKeys = Object.keys(next).sort();
  const currentKeys = Object.keys(current).sort();
  if (nextKeys.length !== currentKeys.length) return false;
  if (nextKeys.some((key, i) => key !== currentKeys[i])) return false;
  return nextKeys.every(
    (key) =>
      JSON.stringify([...(next[key] ?? [])].sort()) ===
      JSON.stringify([...(current[key] ?? [])].sort()),
  );
}
