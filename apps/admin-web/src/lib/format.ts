/**
 * Display formatting. Pure, so it is testable without a DOM.
 *
 * Everything here is about being HONEST at a glance on an operations console: a
 * timestamp an operator can correlate with a log, an id they can copy, and — most
 * importantly — a suppressed statistic that reads as suppressed rather than as zero.
 */
import { formatInr } from "@badabhai/pricing";

/** Absolute UTC, second precision. Operators correlate these with server logs. */
export function formatTimestamp(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toISOString().replace("T", " ").replace(/\.\d+Z$/, "Z");
}

/**
 * "3m ago". Relative time is the scanning aid; the absolute value stays in a `title`
 * so nothing is ever ONLY relative — "2 days ago" is useless in an incident review.
 */
export function formatRelative(iso: string, now: number = Date.now()): string {
  const t = new Date(iso).getTime();
  if (Number.isNaN(t)) return "—";
  const secs = Math.round((now - t) / 1000);
  if (secs < 0) return "just now"; // clock skew — never render "in -3s"
  if (secs < 60) return `${secs}s ago`;
  const mins = Math.floor(secs / 60);
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days}d ago`;
  return formatTimestamp(iso).slice(0, 10);
}

/**
 * Shorten an opaque id for a dense table. The full value always stays in `title` and in
 * the copy affordance — a truncated id that cannot be recovered is worse than none.
 */
export function shortId(id: string | null, chars = 8): string {
  if (!id) return "—";
  return id.length <= chars ? id : `${id.slice(0, chars)}…`;
}

/** `worker.profile_confirmed` → `Worker · profile confirmed`. */
export function humanizeEventName(name: string): string {
  const [domain, ...rest] = name.split(".");
  const action = rest.join(".").replace(/_/g, " ");
  const cap = (s: string) => (s ? s[0]!.toUpperCase() + s.slice(1) : s);
  return action ? `${cap(domain ?? "")} · ${action}` : cap(name);
}

/** Thousands separators. Counts only — never money (₹ has its own rules). */
export function formatCount(n: number): string {
  return new Intl.NumberFormat("en-IN").format(n);
}

/**
 * Render a k-anonymity-floored statistic.
 *
 * The server sets `suppressed` and floors the value to 0 when fewer than `k` distinct
 * subjects reached a stage. Printing that 0 would state "nobody did this" when the truth
 * is "too few did this to report safely" — a different claim, and a false one. So the
 * suppressed case returns a marker the UI renders as text, never as a number.
 */
export function formatSuppressible(
  value: number,
  suppressed: boolean,
  floor: number,
): { text: string; isSuppressed: boolean; hint?: string } {
  if (suppressed) {
    return {
      text: `< ${floor}`,
      isSuppressed: true,
      hint: `Fewer than ${floor} distinct subjects — withheld to protect individuals.`,
    };
  }
  return { text: formatCount(value), isSuppressed: false };
}

/** Map a health check value to a severity the UI can colour. */
export function healthTone(value: string): "ok" | "warn" | "bad" {
  const v = value.toLowerCase();
  if (v === "up" || v === "ok" || v === "real") return "ok";
  if (v === "down" || v === "error" || v === "fail") return "bad";
  // `mock`, `degraded`, `unknown` — not broken, but not the real thing either, and
  // saying so plainly is the entire point of TD81.
  return "warn";
}

/**
 * A monthly pay band in whole rupees.
 *
 * Pay is nullable on a posting, and the three partial cases are NOT the same claim:
 * "₹18,000–25,000", "from ₹18,000" and "not stated" each tell an operator something
 * different. Collapsing a missing bound into the one that exists — rendering a min-only
 * posting as a fixed "₹18,000" — would state a ceiling the employer never offered.
 *
 * Never paise: the column is an integer ₹ amount, and showing decimals would imply a
 * precision the band does not have.
 *
 * Delegates to `@badabhai/pricing`'s `formatInr` (BL-10 fast-follow) — the same formatter
 * `formatRupees` in this file already uses, so a pay band and a rupee figure never drift.
 */
export function formatPayBand(min: number | null, max: number | null): string {
  if (min !== null && max !== null) {
    return min === max ? formatInr(min) : `${formatInr(min)}–${formatInr(max)}`;
  }
  if (min !== null) return `from ${formatInr(min)}`;
  if (max !== null) return `up to ${formatInr(max)}`;
  return "not stated";
}

/**
 * Whole rupees, Indian digit grouping. Never paise — the columns are integer ₹, and
 * decimals would imply a precision the data does not have.
 *
 * Delegates to `@badabhai/pricing`'s `formatInr` (BL-10) — the same formatter payer-web
 * and apps/web use, so the same catalog renders identically across all three apps.
 */
export function formatRupees(n: number): string {
  return formatInr(n);
}

/**
 * Group an integer digit string the Indian way — last three, then pairs.
 *
 * STRING IN, STRING OUT, and that is the whole point: the caller's value came off a
 * `numeric(16,6)` column and must never touch `Number`. `toLocaleString` would require a
 * float first, which is exactly the round trip the column type exists to avoid.
 */
function groupIndianDigits(digits: string): string {
  const s = digits.replace(/^0+(?=\d)/, "");
  if (s.length <= 3) return s;
  return `${s.slice(0, -3).replace(/\B(?=(\d{2})+(?!\d))/g, ",")},${s.slice(-3)}`;
}

/** What a value has to look like to be a decimal this function may reformat. */
const EXACT_DECIMAL = /^-?\d+(?:\.\d+)?$/;

/**
 * An EXACT decimal ₹ amount that arrived as a STRING — AI spend, and nothing else today.
 *
 * ── WHY THIS IS NOT `formatRupees` ──────────────────────────────────────────────────────
 * `formatRupees` takes a whole-rupee integer and `formatInr` throws on anything else, which
 * is right for a credit pack. AI spend is not that: `platform_ai_cost_totals.total_cost_inr`
 * is `numeric(16,6)` and a single embedding call costs a small fraction of a paisa. The API
 * serialises it verbatim ("12.480000") precisely so a running sum of millions of sub-paisa
 * calls does not drift through IEEE-754 — so this formatter never parses it either. Every
 * step below is string surgery: group the integer part, trim the fraction's trailing zeros
 * (lossless — 12.480000 IS 12.48), and keep a two-decimal minimum so ₹3 reads as money.
 *
 * NOTHING IS ROUNDED. A sub-paisa figure renders all six of its places rather than
 * collapsing to ₹0.00, because "we spent a fraction of a paisa" and "we spent nothing" are
 * different facts and this console exists to keep them apart.
 *
 * A value that is not a plain decimal is returned UNCHANGED rather than coerced or blanked:
 * it came from the server, this portal does not know what it means, and inventing a ₹ figure
 * for it would be worse than showing it raw.
 */
export function formatExactRupees(value: string): string {
  if (!EXACT_DECIMAL.test(value)) return value;
  const negative = value.startsWith("-");
  const [whole = "0", fraction = ""] = (negative ? value.slice(1) : value).split(".");
  const trimmed = fraction.replace(/0+$/, "");
  // A real minus sign (U+2212), for the same reason `formatDelta` uses one: it aligns with
  // digits in the tabular figures these amounts are set in.
  return `${negative ? "−" : ""}₹${groupIndianDigits(whole)}.${
    trimmed.length <= 2 ? trimmed.padEnd(2, "0") : trimmed
  }`;
}

/**
 * A duration in seconds, coarsened for scanning: "45s", "12m", "3h 20m", "2d 4h".
 *
 * Used for `idle_seconds` on a chat session — "idle since" is the abandonment signal, and an
 * operator reads it to answer "did they walk away, or is this live right now?". A negative or
 * non-finite input renders an em dash rather than a nonsense duration.
 */
export function formatDuration(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return "—";
  const s = Math.floor(seconds);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ${m % 60}m`;
  return `${Math.floor(h / 24)}d ${h % 24}h`;
}

/**
 * A signed credit movement: "+25" / "−10".
 *
 * The sign is the whole meaning of a ledger row, so it is always explicit — a bare "25"
 * beside a debit reads as a grant. Uses a real minus sign (U+2212), which aligns with digits
 * in the tabular figures the table uses; a hyphen renders shorter and makes a column of
 * negatives look ragged.
 */
export function formatDelta(n: number): string {
  if (n < 0) return `\u2212${formatCount(Math.abs(n))}`;
  return `+${formatCount(n)}`;
}

/** Human label for a credit-ledger reason code. */
export function creditReasonLabel(reason: string): string {
  switch (reason) {
    case "pack_purchase":
      return "Pack purchase";
    case "unlock_debit":
      return "Contact unlock";
    case "refund":
      return "Refund";
    case "grant":
      return "Ops grant";
    default:
      // An unmapped reason is shown RAW rather than hidden — a code nobody recognises is a
      // reason to look, not to render a blank cell.
      return reason.replace(/_/g, " ");
  }
}

/**
 * Human label for a credit-pack code (`packages/db/src/credit-packs.ts` — the §3A offered
 * packs plus the two legacy codes retained for `credit_ledger` history). Kept local rather
 * than importing that package: this is a display label, not a pricing rule, and admin-web
 * must not gain a dependency on the pricing package for it.
 */
export function packCodeLabel(code: string): string {
  switch (code) {
    case "pack_10":
      return "10-credit pack";
    case "pack_25":
      return "25-credit pack";
    case "pack_50":
      return "50-credit pack";
    case "pack_200":
      return "200-credit pack";
    case "pack_1000":
      return "1,000-credit pack";
    default:
      // An unmapped pack code is shown RAW rather than hidden — mirrors creditReasonLabel's
      // fallback, so a future pack code degrades gracefully instead of rendering blank.
      return code.replace(/_/g, " ");
  }
}
