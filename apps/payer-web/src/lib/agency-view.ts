import type { AgencyJob, NeededBy } from "./contracts";

/**
 * PURE, presentational formatting for the Agency Supply Portal DEMAND surface (ADR-0022).
 * NO I/O, no secrets, no PII — only coarse, non-PII display strings derived from the
 * faceless `jobs` projection. Kept separate so the server page + client components share
 * ONE formatting source and a unit test can pin the k-anon "<floor" surfacing.
 */

/** A coarse ₹ pay band label, or "—" when neither end is set. Whole rupees, never paise. */
export function payBandLabel(payMin: number | null, payMax: number | null): string {
  if (payMin === null && payMax === null) return "—";
  if (payMin !== null && payMax !== null) {
    return `₹${payMin.toLocaleString("en-IN")}–₹${payMax.toLocaleString("en-IN")}`;
  }
  if (payMin !== null) return `₹${payMin.toLocaleString("en-IN")}+`;
  return `up to ₹${payMax!.toLocaleString("en-IN")}`;
}

/** A coarse experience band label (years), or "—" when neither end is set. */
export function experienceBandLabel(min: number | null, max: number | null): string {
  if (min === null && max === null) return "—";
  if (min !== null && max !== null) return `${min}–${max} yrs`;
  if (min !== null) return `${min}+ yrs`;
  return `up to ${max} yrs`;
}

/** Human label for the coarse timing enum. */
export function neededByLabel(neededBy: NeededBy | null): string {
  switch (neededBy) {
    case "immediate":
      return "Immediate";
    case "soon":
      return "Soon";
    case "flexible":
      return "Flexible";
    default:
      return "—";
  }
}

/** A readable trade label from the stable trade_key slug (e.g. "cnc_operator" → "Cnc operator"). */
export function tradeLabel(tradeKey: string): string {
  const words = tradeKey.replace(/_/g, " ").trim();
  return words.length === 0 ? tradeKey : words.charAt(0).toUpperCase() + words.slice(1);
}

/** ISO date (yyyy-mm-dd) from a wire timestamp; echoes the input on a parse failure. */
export function day(ts: string): string {
  const d = new Date(ts);
  return Number.isNaN(d.getTime()) ? ts : d.toISOString().slice(0, 10);
}

/**
 * K-ANON SURFACING (ADR-0022 C.1 #2): the backend already suppresses any stage count
 * strictly below `minBucket` to 0. A 0 therefore means "below the floor", NOT literally
 * zero — render it as "<minBucket" so a single named invitee's consent can never be
 * inferred. A non-zero count is shown as-is (it is already >= the floor).
 */
export function kAnonCount(count: number, minBucket: number): string {
  return count === 0 ? `<${minBucket}` : String(count);
}

/**
 * Whether a job is in an ACTIVE state that can be paused/closed. Agency-job status is
 * `open|closed` ONLY (Phase-1 `JobStatus`; pause == close), so "open" is the only
 * active state.
 */
export function isActiveJob(job: AgencyJob): boolean {
  return job.status === "open";
}
