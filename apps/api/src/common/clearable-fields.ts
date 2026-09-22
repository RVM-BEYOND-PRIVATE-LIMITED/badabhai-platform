import { z } from "zod";

/**
 * THE `clear` CONTRACT (#1652) — how a payer says "remove this value", not "set it to
 * something else".
 *
 * Both posting PATCH contracts were **value-or-absent**: every key was `<type>.optional()`
 * and the services applied a key only when it was `!== undefined`. So a payer who set a pay
 * band, a shift or a city by mistake could never REMOVE it — only overwrite it with a
 * different wrong value. On the worker card that meant a wage or a timing the employer no
 * longer stood behind stayed on screen indefinitely.
 *
 * WHY A LIST AND NOT `field: null` (owner ruling, 2026-09-22). An explicit `null` would
 * have been the smaller contract, but `clear: ["pay_min"]` reads as an INTENT at the call
 * site — the payer app builds a "clear" action, not a "send null" action — and it cannot be
 * produced by a client that merely forgot to strip an unset form field. A stray `null` from
 * a serializer is indistinguishable from a deliberate erasure; a stray `clear` list is not.
 *
 * THE CONTRADICTION IS REJECTED, NEVER RESOLVED. A body carrying BOTH `pay_min: 5000` and
 * `clear: ["pay_min"]` is not a precedence puzzle to settle with a rule nobody will
 * remember — it is a client bug, and it 400s naming the field. Picking a winner would mean
 * one of the two things the payer asked for silently did not happen.
 *
 * CLOSED SET PER CONTRACT, never a free string. Each surface passes the field names its
 * OWN nullable columns allow, so `clear` can never reach a NOT NULL column: `jobs.city`,
 * `jobs.title` and `jobs.trade_key` are NOT NULL and are absent from the agency set, while
 * `job_postings.city` IS nullable and is present in the posting set. The same word means
 * different things on the two tables, and the enum is what keeps that straight.
 */

/**
 * Build the `clear` field for one contract from that contract's OWN clearable names.
 *
 * `.min(1)` because an empty `clear: []` expresses nothing — it is neither an edit nor an
 * erasure, and accepting it would let a body pass the "at least one field" refine while
 * asking for no change at all.
 */
export function clearFieldSchema<T extends readonly [string, ...string[]]>(names: T) {
  return z
    .array(z.enum(names))
    .min(1)
    .max(names.length)
    .describe("field names to unset (store NULL)")
    // OPTIONAL: an edit that clears nothing simply omits the key. Making it required would
    // break every shipped PATCH caller on both surfaces for no gain.
    .optional();
}

/**
 * Reject a body that both SETS and CLEARS the same field. Returns the offending names so
 * the caller can name them in the 400 — they are closed-set field names, never values, so
 * nothing about the payer's data appears in the error.
 */
export function contradictoryClears(
  body: Record<string, unknown>,
  clear: readonly string[] | undefined,
): string[] {
  if (!clear?.length) return [];
  return clear.filter((name) => body[name] !== undefined);
}

/**
 * A `clear` list as a lookup, for the services' per-field patch builders.
 *
 * The services ask "was this field cleared?" once per column, and a Set keeps that a
 * membership test rather than a linear scan repeated fifteen times per request.
 */
export function clearedSet(clear: readonly string[] | undefined): ReadonlySet<string> {
  return new Set(clear ?? []);
}
