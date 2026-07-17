/**
 * Reach Engine — ordering (RANK). Orders a set of workers best-first for a job and
 * flags the "hot" top ~10–15%. The cardinal rule: **sort, never block** — every
 * worker passed in appears in the output; ordering only changes what you see FIRST,
 * it never hides anyone (§2, §11).
 */
import { scoreWorkerForJob } from "./scoring";
import type { JobSpec, RankedWorker, RankOptions, WorkerJobScore, WorkerSignals } from "./types";

const DEFAULT_HOT_FRACTION = 0.12; // ~12% wear the hot tag (§4); a dial (§12)
const DEFAULT_PUSH_FLOOR = 0.4; // below this a worker still appears, just isn't push-notified (§12)

/**
 * A dial must be a finite 0..1 fraction. A garbage / NaN / Infinity / out-of-range
 * dial (caller error or tampering) falls back to the default rather than poisoning
 * the hot count or push gate — sort-never-block must hold for ANY options.
 */
function sane01(value: number | undefined, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value)
    ? Math.max(0, Math.min(1, value))
    : fallback;
}

/**
 * Recency tie-break key. Since ADR-0033 the activity component carries WEIGHT 0 (the
 * CEO ledger dropped it from the score) but its RAW is still computed — deliberately
 * kept so this deterministic tie-break (and the LEARN feature pipeline) is unchanged.
 */
function activityRaw(s: WorkerJobScore): number {
  return s.components.find((c) => c.signal === "activity")?.raw ?? 0;
}

function roleRaw(s: WorkerJobScore): number {
  return s.components.find((c) => c.signal === "role")?.raw ?? 0;
}

/** Non-finite scores sort lowest, keeping the order total + deterministic. */
function finiteScore(s: WorkerJobScore): number {
  return Number.isFinite(s.score) ? s.score : -1;
}

/**
 * Score every worker and return them ordered best-first. Deterministic: ties break
 * by recency (more-active first), then `workerId` for a stable, reproducible order.
 *
 * SORT-NEVER-BLOCK: the result always has exactly `workers.length` entries — no
 * filtering. A so-so or off-trade fit is included, just further down (and never
 * "hot"). The hot flag marks the top `hotFraction`; `pushEligible` marks who clears
 * the push-notify floor (everyone else still appears).
 */
export function rankWorkersForJob(
  job: JobSpec,
  workers: WorkerSignals[],
  opts: RankOptions = {},
): RankedWorker[] {
  const hotFraction = sane01(opts.hotFraction, DEFAULT_HOT_FRACTION);
  const pushFloor = sane01(opts.pushFloor, DEFAULT_PUSH_FLOOR);

  const scored = workers.map((w) => scoreWorkerForJob(job, w, opts));
  const ordered = scored.sort(
    (a, b) =>
      finiteScore(b) - finiteScore(a) ||
      activityRaw(b) - activityRaw(a) ||
      (a.workerId < b.workerId ? -1 : a.workerId > b.workerId ? 1 : 0),
  );

  const n = ordered.length;
  // At least one hot when there are any workers (a busy payer always gets a "start here").
  const hotCount = n === 0 ? 0 : Math.min(n, Math.max(1, Math.round(n * hotFraction)));

  return ordered.map((s, i) => ({
    ...s,
    rank: i + 1,
    // Hot only for a real candidate: in the top fraction AND on-/related-trade
    // (role raw > 0). An off-trade worker (role raw 0) is NEVER hot, even at rank 1 —
    // so an all-off-trade feed yields zero hot (§8.5: off-trade never gets the tag).
    hot: i < hotCount && roleRaw(s) > 0,
    pushEligible: s.score >= pushFloor,
  }));
}
