/**
 * PURE, dependency-free SCREEN-LEVEL faceless-presentation helpers for the payer/agency
 * portal. NO React, no render, no I/O, no Date.now / Math.random.
 *
 * These are PII-FREE by construction — every function here can ONLY produce initials, an
 * opaque-id fragment, or a band/signal join. None of them can emit a full name, phone,
 * email, or employer string. This is the masking motif at the SCREEN level; the DS
 * primitives (Avatar / MaskedCandidate) still compute their own initials internally — do
 * not route those through here.
 */

/**
 * 1–2 uppercase initials from a display label, or "?" when there is nothing to show.
 *
 * Used for an avatar fallback when a (already-masked / non-PII) label is present. Because
 * it returns at most TWO letters it can never reconstruct a name. Whitespace-only and
 * empty inputs fall back to "?".
 *
 *   maskedInitials("Acme Tools")  === "AT"
 *   maskedInitials("cnc")         === "C"
 *   maskedInitials("  ")          === "?"
 *   maskedInitials(undefined)     === "?"
 */
export function maskedInitials(name?: string): string {
  const words = (name ?? "")
    .trim()
    .split(/\s+/)
    .filter((w) => w.length > 0);
  if (words.length === 0) return "?";
  const first = words[0]!.charAt(0);
  const last = words.length > 1 ? words[words.length - 1]!.charAt(0) : "";
  const initials = (first + last).toUpperCase();
  return initials.length === 0 ? "?" : initials;
}

/**
 * The SCREEN-level masked opaque-id chip text: the first `length` chars of an opaque id
 * (a UUID / unlock id — never PII) followed by a horizontal ellipsis. Mirrors the
 * applicant feed / credits history `id.slice(0, 8) + "…"` treatment so there is ONE
 * source. A short id is returned whole (still suffixed) — it is opaque either way.
 *
 *   opaqueId("3f2a9c1e-...") === "3f2a9c1e…"
 */
export function opaqueId(id: string, length = 8): string {
  return `${id.slice(0, length)}…`;
}

/**
 * Render a MASKED last-4 for an agency KYC field (PAN / bank account) — four bullet
 * glyphs then the last-4 the API returns, e.g. "234F" → "••••234F". NEVER a full PAN /
 * account number (the API only ever returns the last-4). Empty / nullish → "—" so a
 * not-yet-submitted field renders a neutral dash, never "••••".
 *
 *   maskLast4("234F")     === "••••234F"
 *   maskLast4(null)       === "—"
 *   maskLast4("  ")       === "—"
 */
export function maskLast4(last4: string | null | undefined): string {
  const s = (last4 ?? "").trim();
  return s.length === 0 ? "—" : `••••${s}`;
}

/**
 * Join coarse, non-PII band/signal fragments with the DS middot separator, dropping any
 * empty / nullish parts. Mirrors the applicant feed's `[band, city].filter(Boolean).join(" · ")`
 * and the credits-page join so the separator + drop rule live in ONE place. Returns ""
 * when nothing survives the filter (caller decides whether to render the row).
 *
 *   bandLabel(["6–10 yrs", "Pune"]) === "6–10 yrs · Pune"
 *   bandLabel([undefined, "Pune"])  === "Pune"
 *   bandLabel([])                   === ""
 */
export function bandLabel(parts: ReadonlyArray<string | null | undefined>): string {
  return parts.filter((p): p is string => Boolean(p)).join(" · ");
}
