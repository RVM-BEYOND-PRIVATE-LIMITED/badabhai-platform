/**
 * Display formatting. Pure, so it is testable without a DOM.
 *
 * Everything here is about being HONEST at a glance on an operations console: a
 * timestamp an operator can correlate with a log, an id they can copy, and — most
 * importantly — a suppressed statistic that reads as suppressed rather than as zero.
 */

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
 */
export function formatPayBand(min: number | null, max: number | null): string {
  const rupees = (n: number) => `₹${formatCount(n)}`;
  if (min !== null && max !== null) {
    return min === max ? rupees(min) : `${rupees(min)}–${rupees(max)}`;
  }
  if (min !== null) return `from ${rupees(min)}`;
  if (max !== null) return `up to ${rupees(max)}`;
  return "not stated";
}

/**
 * Whole rupees, Indian digit grouping. Never paise — the columns are integer ₹, and
 * decimals would imply a precision the data does not have.
 */
export function formatRupees(n: number): string {
  return `₹${formatCount(n)}`;
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
