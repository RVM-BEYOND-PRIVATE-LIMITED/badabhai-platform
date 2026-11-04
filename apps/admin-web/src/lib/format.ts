/**
 * Display formatting. Pure, so it is testable without a DOM.
 *
 * Everything here is about being HONEST at a glance on an operations console: a
 * timestamp an operator can correlate with a log, an id they can copy, and — most
 * importantly — a suppressed statistic that reads as suppressed rather than as zero.
 */
import { formatInr } from "@badabhai/pricing";

/** India Standard Time is a fixed +05:30 with no daylight saving, so a plain offset is exact. */
const IST_OFFSET_MS = 330 * 60 * 1000;
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** The instant's IST wall-clock fields, or null for an unparseable value. */
function istParts(iso: string): { date: string; hhmm: string; ss: string } | null {
  const t = new Date(iso).getTime();
  if (Number.isNaN(t)) return null;
  // Shift by the offset and read the UTC fields: the result never depends on the host's zone,
  // so the server render and the browser agree.
  const d = new Date(t + IST_OFFSET_MS);
  const pad = (n: number) => String(n).padStart(2, "0");
  return {
    date: `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()}`,
    hhmm: `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}`,
    ss: pad(d.getUTCSeconds()),
  };
}

/**
 * The console's one timestamp shape (#2572): "19 Aug 2026, 13:08 IST". The operators work in
 * IST; the exact UTC instant stays one hover away ({@link formatTimestampUtc}).
 */
export function formatTimestamp(iso: string): string {
  const p = istParts(iso);
  return p ? `${p.date}, ${p.hhmm} IST` : "—";
}

/** Just the IST calendar day: "19 Aug 2026". For "since …" captions and date-only cells. */
export function formatDate(iso: string): string {
  return istParts(iso)?.date ?? "—";
}

/** IST wall-clock to the second: "13:08:54 IST". The live indicator's last-updated time. */
export function formatClock(iso: string): string {
  const p = istParts(iso);
  return p ? `${p.hhmm}:${p.ss} IST` : "—";
}

/** Absolute UTC, second precision: "2026-08-19 07:38:54 UTC". Operators correlate it with logs. */
export function formatTimestampUtc(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toISOString().replace("T", " ").replace(/\.\d+Z$/, " UTC");
}

/**
 * The hover text for a timestamp shown in another form (relative, or IST): both readings, so an
 * operator never has to convert. "19 Aug 2026, 13:08 IST · 2026-08-19 07:38:54 UTC".
 */
export function timestampTitle(iso: string): string {
  const ist = formatTimestamp(iso);
  return ist === "—" ? ist : `${ist} · ${formatTimestampUtc(iso)}`;
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
  return formatDate(iso);
}

/**
 * Shorten an opaque id in the MIDDLE for a dense table: "be16…a3f2". Both ends survive, so two
 * ids that share a prefix still read apart. The full value always stays in `title` and in the
 * copy affordance (`CopyId`) — a truncated id that cannot be recovered is worse than none.
 * `edge` is how many characters each end keeps.
 */
export function shortId(id: string | null, edge = 4): string {
  if (!id) return "—";
  return id.length <= edge * 2 + 1 ? id : `${id.slice(0, edge)}…${id.slice(-edge)}`;
}

/**
 * A posting decision's match tier, the same words on the worker page and the posting page: 1 is a
 * match on a skill the posting asked for, 2 on a related one. Anything else (no tier recorded,
 * or a tier this portal has not been taught) is a dash rather than a bare number.
 */
export function matchTierLabel(tier: number | null | undefined): string {
  if (tier === 1) return "1 — asked-for skill";
  if (tier === 2) return "2 — related skill";
  return "—";
}

/**
 * How an event's DOMAIN reads on screen, where the console's names differ from the event's
 * (owner ruling 2026-10-01: the job entity is "Posting"; Company and Agency together are
 * "Customers"). DISPLAY ONLY: the event names in the data, in filters and in the payload view
 * keep their words (`payer.suspended`, `job_posting.created`). `job.*` is the legacy jobs table,
 * a different entity, and stays "Job".
 */
const EVENT_DOMAIN_LABELS: Readonly<Record<string, string>> = {
  payer: "Customer",
  job_posting: "Posting",
};

/** `worker.profile_confirmed` → `Worker · profile confirmed`; `payer.suspended` → `Customer · suspended`. */
export function humanizeEventName(name: string): string {
  const [domain = "", ...rest] = name.split(".");
  const action = rest.join(".").replace(/_/g, " ");
  const cap = (s: string) => (s ? s[0]!.toUpperCase() + s.slice(1) : s);
  const shown = Object.hasOwn(EVENT_DOMAIN_LABELS, domain)
    ? EVENT_DOMAIN_LABELS[domain]!
    : cap(domain.replace(/_/g, " "));
  return action ? `${shown} · ${action}` : cap(name.replace(/_/g, " "));
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
 * Human label for a posting's pay-type bucket (`in_hand` | `gross` | `ctc`, migration 0121).
 *
 * A raw enum never reaches an operator's eye — same vocabulary payer-web's `payTypeLabel`
 * shows the poster, so the two surfaces name the same value identically. An unmapped code is
 * shown de-underscored rather than blanked, mirroring `creditReasonLabel`'s fallback.
 */
export function payTypeLabel(payType: string): string {
  switch (payType) {
    case "in_hand":
      return "In-hand";
    case "gross":
      return "Gross";
    case "ctc":
      return "CTC";
    default:
      return payType.replace(/_/g, " ");
  }
}

/**
 * A required-experience window in whole years, with the same partial-case discipline as
 * {@link formatPayBand}: "2–5 years", "from 2 years", "up to 5 years" and "not stated" are four
 * different claims, and collapsing a missing bound into the one that exists would state a
 * requirement the poster never set. Singular "year" when a bound is exactly one.
 */
export function formatExperienceBand(min: number | null, max: number | null): string {
  const yr = (n: number) => `${n} ${n === 1 ? "year" : "years"}`;
  if (min !== null && max !== null) {
    return min === max ? yr(min) : `${min}–${yr(max)}`;
  }
  if (min !== null) return `from ${yr(min)}`;
  if (max !== null) return `up to ${yr(max)}`;
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

/** Round a plain non-negative decimal string to `places`, half-up, as an integer of 10^-places. */
function roundDecimal(whole: string, fraction: string, places: number): bigint {
  const units = BigInt(whole + fraction);
  const n = fraction.length;
  if (n <= places) return units * 10n ** BigInt(places - n);
  const div = 10n ** BigInt(n - places);
  const q = units / div;
  return (units % div) * 2n >= div ? q + 1n : q;
}

/**
 * A decimal ₹ amount (string, as {@link formatExactRupees} takes it) at a READABLE precision
 * (#2572) — for lists and tiles, with the exact figure kept for the hover and detail views:
 *
 *  - ₹100 and up: whole rupees ("₹871"), rounded half-up;
 *  - under ₹100: two decimals ("₹1.51");
 *  - above zero but under ₹0.01: "<₹0.01" — never "₹0.00", which would claim nothing was spent;
 *  - exactly zero: "₹0.00", a measurement like any other.
 *
 * Still string arithmetic (BigInt), never a float, and an unrecognised value is returned
 * unchanged — the same contract as the exact formatter.
 */
export function formatDisplayRupees(value: string): string {
  if (!EXACT_DECIMAL.test(value)) return value;
  const negative = value.startsWith("-");
  const [rawWhole = "0", fraction = ""] = (negative ? value.slice(1) : value).split(".");
  const whole = rawWhole.replace(/^0+(?=\d)/, "");
  const sign = negative ? "−" : "";
  const isZero = /^0+$/.test(whole + fraction);
  if (isZero) return "₹0.00";
  const cents = roundDecimal(whole, fraction, 2);
  if (BigInt(whole) < 1n && cents === 0n) return negative ? "> −₹0.01" : "<₹0.01";
  if (BigInt(whole) >= 100n || cents >= 10000n) {
    return `${sign}₹${groupIndianDigits(roundDecimal(whole, fraction, 0).toString())}`;
  }
  const c = cents.toString().padStart(3, "0");
  return `${sign}₹${groupIndianDigits(c.slice(0, -2))}.${c.slice(-2)}`;
}

/**
 * The same display rules for a ₹ figure that arrives as a NUMBER (`ai_jobs.cost_inr` is
 * `double precision`). Ten fixed places keep a sub-paisa value from collapsing to zero.
 */
export function formatDisplayRupeesFromNumber(n: number): string {
  return Number.isFinite(n) ? formatDisplayRupees(n.toFixed(10)) : "—";
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
      return "Credit grant";
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
