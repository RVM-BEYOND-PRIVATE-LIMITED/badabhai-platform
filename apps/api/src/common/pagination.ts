/**
 * Parse + clamp a `?limit=` query string for read-only list endpoints.
 * Falls back to `def` on missing/invalid input and never exceeds `max`.
 */
export function clampLimit(raw: string | undefined, def = 100, max = 500): number {
  const n = raw ? Number.parseInt(raw, 10) : def;
  if (!Number.isFinite(n) || n <= 0) return def;
  return Math.min(n, max);
}
