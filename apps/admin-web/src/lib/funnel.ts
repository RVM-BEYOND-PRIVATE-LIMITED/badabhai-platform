import "server-only";
import { z } from "zod";
import { adminFetch } from "./admin-http";
import { formatCount } from "./format";
import { isJourneyStepKey, stepTitle } from "./journey-view";

/**
 * The ONBOARDING-FUNNEL data layer — `GET /admin/funnel/onboarding` (B14, #2568): the
 * 7 journey steps counted across the whole base, where workers stop, split by trade /
 * city / language / app version.
 *
 * Its own module rather than a block inside `dashboard.ts`, for the same reason
 * `events.ts` is its own: one module per admin API surface, so a controller's contract
 * has exactly one mirror on this side. Everything else here follows `dashboard.ts`
 * verbatim — `server-only`, `adminFetch`, and every response parsed rather than trusted.
 *
 * ── MIRRORED FROM `apps/api/src/admin/admin-funnel.dto.ts` ─────────────────────────
 * Compared, never assumed — the same rule `ai-cost.ts` states for the dashboard codes:
 * the server owns the contract, this file re-states it in zod, and a field the server
 * adds must appear here the day it ships. Screens arrive separately (#2580); this is
 * the typed fetch + the pure copy helpers the screens will read.
 *
 * ── OPEN SETS STAY OPEN ─────────────────────────────────────────────────────────────
 * Split values, task labels and stop keys are `z.string()`, never enums — the API DTO
 * is explicit that task types and city/app-version labels are read out of stored rows.
 * An enum here would reject the whole response the first time a new trade ships,
 * blanking the page over a value the UI could simply have displayed.
 */

// ---------------------------------------------------------------------------
// Wire shapes (mirrored)
// ---------------------------------------------------------------------------

const funnelStepCountsSchema = z.object({
  key: z.string(),
  order: z.number(),
  done: z.number(),
  in_progress: z.number(),
  not_done: z.number(),
});
export type AdminFunnelStepCounts = z.infer<typeof funnelStepCountsSchema>;

const funnelStopBucketSchema = z.object({ key: z.string(), count: z.number() });
export type AdminFunnelStopBucket = z.infer<typeof funnelStopBucketSchema>;

const funnelSplitCellSchema = z.object({
  value: z.string(),
  /**
   * #2580: the API's human name for `value` (today the taxonomy role name of a trade cell),
   * or null. OPTIONAL as well as nullable, so this build reads an API from before the field.
   */
  label: z.string().nullable().optional(),
  total: z.number(),
  suppressed: z.boolean(),
  stopped_at: z.array(funnelStopBucketSchema),
});
export type AdminFunnelSplitCell = z.infer<typeof funnelSplitCellSchema>;

/** Exported so tests can parse a captured payload through the REAL schema. */
export const onboardingFunnelSchema = z.object({
  generated_at: z.string(),
  signup_from: z.string().nullable(),
  signup_to: z.string().nullable(),
  test_accounts: z.string(),
  total_workers: z.number(),
  steps: z.array(funnelStepCountsSchema),
  stopped_at: z.array(funnelStopBucketSchema),
  splits: z.object({
    trade: z.array(funnelSplitCellSchema),
    city: z.array(funnelSplitCellSchema),
    language: z.array(funnelSplitCellSchema),
    app_version: z.array(funnelSplitCellSchema),
  }),
  caveats: z.array(z.string()),
});
export type AdminOnboardingFunnel = z.infer<typeof onboardingFunnelSchema>;

/**
 * Onboarding funnel across all workers. Requires `read_entities`.
 *
 * `signupFrom`/`signupTo` scope the cohort to a sign-up window (ISO strings; absent =
 * the whole base); `testAccounts` is `exclude` (default) | `include` | `only`. The
 * response echoes the cohort bound back — the UI renders the echoed value, never the
 * argument passed here.
 */
export function getOnboardingFunnel(opts?: {
  signupFrom?: string;
  signupTo?: string;
  testAccounts?: string;
}) {
  const q = new URLSearchParams();
  if (opts?.signupFrom) q.set("signupFrom", opts.signupFrom);
  if (opts?.signupTo) q.set("signupTo", opts.signupTo);
  if (opts?.testAccounts) q.set("testAccounts", opts.testAccounts);
  const qs = q.toString();
  return adminFetch(`/admin/funnel/onboarding${qs ? `?${qs}` : ""}`, {
    schema: onboardingFunnelSchema,
  });
}

// ---------------------------------------------------------------------------
// Pure copy helpers (no DOM, no fetch — testable like `ai-cost.ts`)
// ---------------------------------------------------------------------------

/**
 * A stop key as an operator reads it (#2580): a journey step's own title ("Searched and
 * applied", never `job_search_apply`), `completed` as "Finished every step", and a key this
 * build has never heard of verbatim (the server may add a step before the portal learns it).
 */
export function funnelStopTitle(key: string): string {
  if (key === "completed") return "Finished every step";
  return isJourneyStepKey(key) ? stepTitle(key) : key;
}

/**
 * Where a cohort is held, as one sentence. `stopped_at` is the first non-done step,
 * so the top bucket IS the answer to "where do we lose people".
 */
export function describeFunnelStop(stop: { key: string; count: number }, total: number): string {
  if (total === 0) return "No workers in this cohort — nothing to describe.";
  const share = `${formatCount(stop.count)} of ${formatCount(total)}`;
  if (stop.key === "completed") {
    return `${share} finished every step.`;
  }
  return `${share} are held at ${funnelStopTitle(stop.key)}.`;
}

/** The API's two catch-all bucket values (`ADMIN_FUNNEL_UNKNOWN_BUCKET` / `_OTHER_BUCKET`). */
const SPLIT_BUCKET_LABELS: Record<string, string> = {
  unknown: "Not stated",
  other: "Everything else",
};

/** `LANGUAGE_CODES` (@badabhai/types) by name: the language split arrives as codes. */
const LANGUAGE_NAMES: Record<string, string> = {
  en: "English",
  hi: "Hindi",
  bn: "Bengali",
  te: "Telugu",
  ta: "Tamil",
  mr: "Marathi",
  gu: "Gujarati",
  kn: "Kannada",
  ml: "Malayalam",
  pa: "Punjabi",
  or: "Odia",
  as: "Assamese",
};

export type FunnelSplitDimension = "trade" | "city" | "language" | "app_version";

/**
 * A split cell's row label (#2580). The catch-all buckets read as words; a language code
 * reads as its name; a trade reads as the API's taxonomy role name, or, for a role id the
 * taxonomy does not know, as the id without its `role_` prefix ("role_vmc_setter" → "vmc
 * setter"): readable, and plainly not a curated name. City and app version are shown as sent.
 */
export function splitCellLabel(
  dimension: FunnelSplitDimension,
  cell: { value: string; label?: string | null },
): string {
  const bucket = SPLIT_BUCKET_LABELS[cell.value];
  if (bucket) return bucket;
  if (cell.label) return cell.label;
  if (dimension === "language") return LANGUAGE_NAMES[cell.value] ?? cell.value;
  if (dimension === "trade" && /^role_[a-z_]+$/.test(cell.value)) {
    return cell.value.slice("role_".length).replace(/_/g, " ");
  }
  return cell.value;
}

/**
 * Where one group is held, as one sentence (#2580): the group's biggest stop, out of its own
 * total, and how many of it finished. A suppressed cell (`total: 0, suppressed`) is a k-anon
 * floor, not a zero; rendering it as "0 workers" would turn a privacy rule into a false
 * measurement, the same silence-means-zero failure the caveats on the dashboard exist to stop.
 * The row's label is beside this sentence, so the sentence never repeats it.
 */
export function describeSplitCell(cell: {
  value: string;
  total: number;
  suppressed: boolean;
  stopped_at?: readonly { key: string; count: number }[];
}): string {
  if (cell.suppressed) return "Too few workers to report.";
  const total = formatCount(cell.total);
  const buckets = cell.stopped_at ?? [];
  const finished = buckets.find((b) => b.key === "completed")?.count ?? 0;
  const top = buckets
    .filter((b) => b.key !== "completed" && b.count > 0)
    .sort((a, b) => b.count - a.count)[0];
  if (!top) {
    if (buckets.length === 0) return `${total} workers.`;
    return finished > 0 ? `All ${total} finished every step.` : `${total} workers.`;
  }
  const finishedText = finished > 0 ? ` ${formatCount(finished)} finished every step.` : "";
  return `Most held at ${funnelStopTitle(top.key)}: ${formatCount(top.count)} of ${total}.${finishedText}`;
}
