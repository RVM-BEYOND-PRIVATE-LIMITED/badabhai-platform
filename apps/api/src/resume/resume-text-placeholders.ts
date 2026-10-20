/**
 * The value both résumé builders used to print for an empty headline field (#2378).
 *
 * `build_resume` (apps/ai-service/app/extraction.py) and its outage fallback
 * (`AiService.generateResume`) wrote `Role:`, `Trade:`, `Machines:` and `Skills:` with this value
 * whenever the field was empty. The worker app draws every `Label: value` line of `resume_text` as
 * a row, so a chat-built profile showed "Machines: (to be confirmed)" for a trade with no machines.
 * Owner ruling 2026-10-20: an empty field gets no row at all. Both builders now omit the line.
 */
export const RESUME_PLACEHOLDER_VALUE = "(to be confirmed)";

/**
 * `resume_text` with every `Label: (to be confirmed)` row removed — THE READ-PATH HALF of #2378.
 *
 * The builders stopped emitting these rows, but `resume_text` is stored, and a résumé generated
 * before the fix is served from that row until it is regenerated. Stripping on read cleans those up
 * at once, with no backfill and no rewrite of stored data (owner ruling 2026-10-20).
 *
 * A row matches ONLY when its whole value is the placeholder, split the way the worker app splits
 * it (`label` before the first colon, `value` trimmed after it). Every other line passes through
 * byte-identical, so a real value that merely contains the phrase is never touched.
 */
export function withoutPlaceholderRows(text: string): string {
  return text
    .split("\n")
    .filter((line) => !isPlaceholderRow(line))
    .join("\n");
}

function isPlaceholderRow(line: string): boolean {
  const colon = line.indexOf(":");
  if (colon <= 0) return false;
  return line.slice(colon + 1).trim() === RESUME_PLACEHOLDER_VALUE;
}
