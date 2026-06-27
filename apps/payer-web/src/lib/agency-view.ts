import type { AgencyJob, NeededBy } from "./contracts";
import { formatInr } from "./format";

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
    return `${formatInr(payMin)}–${formatInr(payMax)}`;
  }
  if (payMin !== null) return `${formatInr(payMin)}+`;
  return `up to ${formatInr(payMax!)}`;
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

/**
 * Domain acronyms / brand casing that must NEVER be title-cased down (e.g. "CNC", not
 * "Cnc") — this is industrial manufacturing copy, so the trade jargon stays correct.
 */
const TRADE_CASING: Record<string, string> = {
  cnc: "CNC",
  vmc: "VMC",
  cad: "CAD",
  solidworks: "SolidWorks",
  autocad: "AutoCAD",
};

/**
 * A readable trade label from the stable trade_key slug — proper Title Case with the
 * domain acronyms forced uppercase (e.g. "cnc_operator" → "CNC Operator",
 * "cad_designer" → "CAD Designer", "quality_inspector" → "Quality Inspector").
 */
export function tradeLabel(tradeKey: string): string {
  const slug = tradeKey.replace(/_/g, " ").trim();
  if (slug.length === 0) return tradeKey;
  return slug
    .split(/\s+/)
    .map((word) => TRADE_CASING[word.toLowerCase()] ?? word.charAt(0).toUpperCase() + word.slice(1))
    .join(" ");
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
