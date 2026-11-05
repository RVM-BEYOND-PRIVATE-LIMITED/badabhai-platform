import { Inject, Injectable } from "@nestjs/common";
import type { ServerConfig } from "@badabhai/config";
import { SERVER_CONFIG } from "../config/config.module";
import { AdminEventsRepository } from "./admin-events.repository";
import { AdminFunnelRepository } from "./admin-funnel.repository";
import { AdminWorkerJourneyRepository } from "./admin-worker-journey.repository";
import {
  ADMIN_FUNNEL_K_ANON_FLOOR,
  ADMIN_FUNNEL_OTHER_BUCKET,
  ADMIN_FUNNEL_SPLIT_VALUE_MAX,
  ADMIN_FUNNEL_STEP_KEYS,
  ADMIN_FUNNEL_UNKNOWN_BUCKET,
  type AdminFunnelQueryDto,
  type AdminFunnelSplitCell,
  type AdminFunnelStepCounts,
  type AdminFunnelStepKey,
  type AdminFunnelStopBucket,
  type AdminFunnelStopKey,
  type AdminOnboardingFunnel,
} from "./admin-funnel.dto";

/** One worker's 7 step statuses — the aggregate's unit of counting. */
export interface FunnelWorkerStatuses {
  workerId: string;
  statuses: Record<AdminFunnelStepKey, "done" | "in_progress" | "not_done">;
  stoppedAt: AdminFunnelStopKey;
}

/** The cohort facts `workerStatuses` needs beyond the id (photo lives on `workers`). */
export interface FunnelStatusWorker {
  id: string;
  hasPhoto: boolean;
}

/**
 * The ONBOARDING FUNNEL service (B14, #2568) — the 7 journey steps counted across the
 * whole base, plus where workers stop, split by trade / city / language / app version.
 *
 * ── STATUS RULES MIRROR THE PER-WORKER JOURNEY, AND THE PARITY TEST PROVES IT ──────
 * `AdminWorkerJourneyService.getJourneySummary` owns the definitions; this file restates
 * them over grouped aggregates (one worker's rows vs the whole cohort's cannot share
 * code without one side paying the other's query shape). What keeps the two from
 * drifting is `admin-funnel.parity.db.test.ts`: one seeded cohort, both surfaces, the
 * 7 statuses asserted equal worker for worker. A rule changed on one side without the
 * other reddens that gate.
 *
 * The restated rules, each pointing at its definition:
 *   1. login — ALWAYS `done` (a `workers` row implies a completed OTP verify; the
 *      journey DTO header states why).
 *   2. profiling — `progressStatus(completed, total)`: 0 → not_done; total > 0 and
 *      completed >= total → done; else in_progress. `completed` = DISTINCT settled keys
 *      the contributing packs own + the #1504 city-seed credit; `total` = contributing
 *      pair item counts summed (see the journey service header for why the universal
 *      tail joins the denominator).
 *   3. resume — a `generated_resumes` row exists.
 *   4. profile_confirmed — `confirmed` → done; `extracting`/`extracted` → in_progress;
 *      else (draft/missing) → not_done. Current row per CURRENT_PROFILE_ORDER.
 *   5. job_search_apply — `applied > 0` → done; else searched/skipped → in_progress.
 *   6. photo — `photo_storage_key IS NOT NULL`.
 *   7. interview_kit — an attributed download exists.
 * `stopped_at` = the first step (in order) that is not `done`; `completed` when all are.
 *
 * ── READ-ONLY, BOUNDED, K-ANON ────────────────────────────────────────────────────
 * Nine grouped, index-backed reads in one `Promise.all` (cohort + 8 per-worker
 * aggregates) — never one query per worker, never an unbounded scan. Split cells below
 * {@link ADMIN_FUNNEL_K_ANON_FLOOR} workers report nothing (suppressed), so a rare
 * trade/city can never single a worker out. No audit event: this is the dashboard's
 * data class (k-anon'd aggregates), not the per-worker journey's (see the DTO header).
 */
@Injectable()
export class AdminFunnelService {
  constructor(
    private readonly repo: AdminFunnelRepository,
    // The funnel's two `events` reads. They live on the shared spine repository, not on
    // `AdminFunnelRepository`, because `events` has exactly ONE admin reader by design
    // (build-blocked in `admin-static-guards.test.ts`) — so the COMPOSITION happens here.
    private readonly eventsRepo: AdminEventsRepository,
    // The active universal pair — asked of the journey's own lookup, never re-derived,
    // so the denominator here and the denominator on the per-worker page cannot drift.
    private readonly journeyRepo: AdminWorkerJourneyRepository,
    @Inject(SERVER_CONFIG) private readonly config: ServerConfig,
  ) {}

  async onboardingFunnel(query: AdminFunnelQueryDto): Promise<AdminOnboardingFunnel> {
    const cohort = await this.repo.listCohort({
      signupFrom: query.signupFrom,
      signupTo: query.signupTo,
      testAccounts: query.testAccounts,
    });
    const ids = cohort.map((w) => w.id);
    const [statuses, trades, appVersions] = await Promise.all([
      this.workerStatuses(cohort),
      this.repo.primaryTradeByWorker(ids),
      this.repo.appVersionByWorker(ids),
    ]);
    const byWorker = new Map(cohort.map((w) => [w.id, w]));

    return {
      generated_at: new Date(),
      signup_from: query.signupFrom ?? null,
      signup_to: query.signupTo ?? null,
      test_accounts: query.testAccounts,
      total_workers: cohort.length,
      steps: AdminFunnelService.stepCounts(statuses),
      stopped_at: AdminFunnelService.stopBuckets(statuses),
      splits: {
        trade: AdminFunnelService.splitCells(
          statuses,
          (id) => trades.get(id) ?? ADMIN_FUNNEL_UNKNOWN_BUCKET,
        ),
        city: AdminFunnelService.splitCells(statuses, (id) => {
          const city = (byWorker.get(id)?.city ?? "").trim();
          return city === "" ? ADMIN_FUNNEL_UNKNOWN_BUCKET : city;
        }),
        language: AdminFunnelService.splitCells(
          statuses,
          (id) => byWorker.get(id)?.language ?? ADMIN_FUNNEL_UNKNOWN_BUCKET,
        ),
        app_version: AdminFunnelService.splitCells(
          statuses,
          (id) => appVersions.get(id) ?? ADMIN_FUNNEL_UNKNOWN_BUCKET,
        ),
      },
      // Kit downloads carry a worker id only from migration 0079 — same honest-absence
      // rule as the per-worker page, restated at aggregate grain.
      caveats: ["interview_kit_attribution_since_0079"],
    };
  }

  /**
   * The cohort's per-worker statuses in one call — listCohort + workerStatuses. Public
   * so the parity gate has a stable seam (rather than reaching into the repository).
   */
  async funnelWorkerStatuses(query: AdminFunnelQueryDto): Promise<FunnelWorkerStatuses[]> {
    const cohort = await this.repo.listCohort({
      signupFrom: query.signupFrom,
      signupTo: query.signupTo,
      testAccounts: query.testAccounts,
    });
    return this.workerStatuses(cohort);
  }

  /**
   * Per-worker 7-step statuses for a cohort. Public so the parity gate can run it
   * against the per-worker journey summaries without going through HTTP.
   */
  async workerStatuses(workers: readonly FunnelStatusWorker[]): Promise<FunnelWorkerStatuses[]> {
    const ids = workers.map((w) => w.id);
    // The universal pair first: the profiling rule NEEDS it, so it is read here (not
    // inside a flags query) and handed down — one source of the denominator's second
    // half, whichever surface asks.
    const universal = await this.journeyRepo.findActiveUniversalPack(
      this.config.PROFILING_PACK_LOCALE,
    );
    const stamped = await this.repo.stampedPairsByWorker(ids);
    // The distinct pairs across the cohort bound the item read: the corpus is small
    // (tens of versions), so one grouped query covers every worker's denominator.
    const distinctPairs = new Map<string, { packId: string; packVersion: number }>();
    for (const pairs of stamped.values()) {
      for (const p of pairs) distinctPairs.set(`${p.packId}:${p.packVersion}`, p);
    }
    const [items, settled, prefilled, resumes, profiles, apps, search, kit] = await Promise.all([
      this.repo.itemKeysByPair([...distinctPairs.values()]),
      this.repo.settledKeysByWorker(ids),
      this.repo.prefilledCityWorkers(ids),
      this.repo.resumeFlags(ids),
      this.repo.profileStatuses(ids),
      this.repo.applicationFlags(ids),
      this.eventsRepo.workerSubjectEventCounts(ids, ["job.search_performed"] as const),
      this.eventsRepo.interviewKitDownloadsForWorkers(ids),
    ]);
    const photoByWorker = new Map(workers.map((w) => [w.id, w.hasPhoto]));
    const searchByWorker = new Map(
      search.filter((r) => r.eventName === "job.search_performed").map((r) => [r.workerId, r.n]),
    );
    const kitByWorker = new Map(kit.map((r) => [r.workerId, r.n]));
    return ids.map((id) => {
      const { completed, total } = AdminFunnelService.profilingCounts(
        stamped.get(id) ?? [],
        settled.get(id) ?? [],
        prefilled.has(id),
        universal,
        items,
      );
      const profileStatus = profiles.get(id) ?? null;
      const applied = apps.get(id)?.applied ?? 0;
      const skipped = apps.get(id)?.skipped ?? 0;
      const searched = searchByWorker.get(id) ?? 0;
      const statuses: FunnelWorkerStatuses["statuses"] = {
        login: "done",
        profiling: AdminFunnelService.progressStatus(completed, total),
        resume: resumes.has(id) ? "done" : "not_done",
        profile_confirmed:
          profileStatus === "confirmed"
            ? "done"
            : profileStatus === "extracting" || profileStatus === "extracted"
              ? "in_progress"
              : "not_done",
        job_search_apply:
          applied > 0 ? "done" : searched > 0 || skipped > 0 ? "in_progress" : "not_done",
        photo: photoByWorker.get(id) === true ? "done" : "not_done",
        interview_kit: (kitByWorker.get(id) ?? 0) > 0 ? "done" : "not_done",
      };
      return { workerId: id, statuses, stoppedAt: AdminFunnelService.stoppedAt(statuses) };
    });
  }

  // -- internals ---------------------------------------------------------------

  /**
   * One worker's profiling (completed, total) — the per-worker journey's rule, over the
   * grouped primitives (no per-worker queries here).
   *
   *   pairs    = stamped pairs, PLUS the active universal pair when the worker has
   *              stamped rows but stamped no universal pack of its own (matched on
   *              pack_id, not the pair — `denominatorPairs`).
   *   total    = those pairs' item counts summed (a retired pair contributes 0).
   *   completed = DISTINCT settled keys owned by those pairs + the #1504 city-seed
   *              credit (`current_city` seeded, still owned, never settled as a row).
   */
  private static profilingCounts(
    stamped: ReadonlyArray<{ packId: string; packVersion: number }>,
    settledKeys: readonly string[],
    hasPrefilledCity: boolean,
    universal: { packId: string; packVersion: number } | null,
    itemsByPair: ReadonlyMap<string, readonly string[]>,
  ): { completed: number; total: number } {
    const pairs =
      stamped.length === 0 ||
      universal === null ||
      stamped.some((p) => p.packId === universal.packId)
        ? stamped
        : [...stamped, universal];
    let total = 0;
    const owned = new Set<string>();
    for (const p of pairs) {
      const keys = itemsByPair.get(`${p.packId}:${p.packVersion}`) ?? [];
      total += keys.length;
      for (const k of keys) owned.add(k);
    }
    let completed = 0;
    for (const k of new Set(settledKeys)) {
      if (owned.has(k)) completed += 1;
    }
    if (hasPrefilledCity && owned.has("current_city") && !settledKeys.includes("current_city")) {
      completed += 1;
    }
    return { completed, total };
  }

  /**
   * `completed`/`total` → a funnel status. Byte-identical to the per-worker journey's
   * `progressStatus` (`total === 0` is "unknown", never "complete") — restated here
   * rather than imported because that helper is private to the journey service, and the
   * parity gate (not a shared import) is what keeps the two copies honest.
   */
  private static progressStatus(
    completed: number,
    total: number,
  ): "done" | "in_progress" | "not_done" {
    if (completed === 0) return "not_done";
    if (total > 0 && completed >= total) return "done";
    return "in_progress";
  }

  private static stoppedAt(statuses: FunnelWorkerStatuses["statuses"]): AdminFunnelStopKey {
    for (const key of ADMIN_FUNNEL_STEP_KEYS) {
      if (statuses[key] !== "done") return key;
    }
    return "completed";
  }

  private static stepCounts(workers: FunnelWorkerStatuses[]): AdminFunnelStepCounts[] {
    return ADMIN_FUNNEL_STEP_KEYS.map((key, i) => ({
      key,
      order: i + 1,
      done: workers.filter((w) => w.statuses[key] === "done").length,
      in_progress: workers.filter((w) => w.statuses[key] === "in_progress").length,
      not_done: workers.filter((w) => w.statuses[key] === "not_done").length,
    }));
  }

  private static stopBuckets(workers: FunnelWorkerStatuses[]): AdminFunnelStopBucket[] {
    const keys: AdminFunnelStopKey[] = [...ADMIN_FUNNEL_STEP_KEYS, "completed"];
    return keys.map((key) => ({
      key,
      count: workers.filter((w) => w.stoppedAt === key).length,
    }));
  }

  private static splitCells(
    workers: FunnelWorkerStatuses[],
    valueOf: (workerId: string) => string,
  ): AdminFunnelSplitCell[] {
    const groups = new Map<string, FunnelWorkerStatuses[]>();
    for (const w of workers) {
      const value = valueOf(w.workerId);
      const list = groups.get(value) ?? [];
      list.push(w);
      groups.set(value, list);
    }
    // Open vocabularies (city, app version) are capped — the tail folds into `other`
    // so one unbounded dimension cannot blow up the response.
    const entries = [...groups.entries()].sort((a, b) => b[1].length - a[1].length);
    const head = entries.slice(0, ADMIN_FUNNEL_SPLIT_VALUE_MAX);
    const tail = entries.slice(ADMIN_FUNNEL_SPLIT_VALUE_MAX);
    const cells = head.map(([value, list]) => AdminFunnelService.splitCell(value, list));
    if (tail.length > 0) {
      cells.push(
        AdminFunnelService.splitCell(
          ADMIN_FUNNEL_OTHER_BUCKET,
          tail.flatMap(([, list]) => list),
        ),
      );
    }
    return cells;
  }

  private static splitCell(value: string, list: FunnelWorkerStatuses[]): AdminFunnelSplitCell {
    if (list.length < ADMIN_FUNNEL_K_ANON_FLOOR) {
      return { value, total: 0, suppressed: true, stopped_at: [] };
    }
    const keys: AdminFunnelStopKey[] = [...ADMIN_FUNNEL_STEP_KEYS, "completed"];
    return {
      value,
      total: list.length,
      suppressed: false,
      stopped_at: keys.map((key) => ({
        key,
        count: list.filter((w) => w.stoppedAt === key).length,
      })),
    };
  }
}
