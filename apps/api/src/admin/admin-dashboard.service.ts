import { Injectable } from "@nestjs/common";
import { AdminDashboardRepository, type AdminKeyCount } from "./admin-dashboard.repository";
import { AdminEventsRepository, type AdminPayloadGroupField } from "./admin-events.repository";
import {
  AI_COST_CAVEAT_SINCE_0077,
  CAP_BREACH_SCOPE_PROFILE_EXTRACTION,
  DASHBOARD_JOB_POSTING_STATUSES,
  DASHBOARD_OTHER_BUCKET,
  DASHBOARD_PAYER_ROLES,
  DASHBOARD_PAYER_STATUSES,
  DASHBOARD_PROFILE_STATUSES,
  DASHBOARD_WORKER_STATUSES,
  type AdminCapBreachBucket,
  type AdminDashboardSummary,
  type AdminDashboardSummaryQueryDto,
  type AdminEnumBuckets,
} from "./admin-dashboard.dto";

/**
 * The admin DASHBOARD summary service (BP-5) — "what have we spent on AI, and how big are we".
 *
 * ── WHY IT IS NOT A METHOD ON `AdminEventsService` ──────────────────────────────────────
 * That class is scoped to the event spine and says so: it reads `events` and nothing else, and
 * that narrowness is what makes its SELECT-only promise checkable. These numbers come from
 * `platform_ai_cost_totals`, `workers`, `worker_profiles`, `job_postings`, `applications`,
 * `payers`, `unlocks` and `generated_resumes` — bolting eight tables onto the spine service
 * would dissolve the boundary it exists to hold. It is composed the way
 * `AdminFinanceService.summary()` is instead: one service, its own repository, one `Promise.all`
 * of independent aggregates.
 *
 * ── WHAT THE SERVICE DECIDES (and the repository therefore does not) ────────────────────
 *  1. DENSIFICATION. A `GROUP BY` returns no row for a status nothing is in. That is the
 *     difference between "0 suspended workers" and "we did not measure suspended workers", and
 *     to a client the two look identical. Every closed enum is emitted in full, zeros included,
 *     in the domain's declared order — plus one `other` bucket, so a value the enum does not
 *     name cannot fall out of the headline total. See {@link AdminDashboardService.densify}.
 *  2. THE HONESTY MARKERS. `accruing_since` / `is_lifetime_total` / `caveat` are asserted here,
 *     from `min(first_recorded_at)`, so a partial figure cannot render as a lifetime total; and
 *     `cap_breaches.scope` says which surfaces that count actually covers.
 *  3. WHICH EVENT AND WHICH FIELD the breach split reads.
 *
 * ── NO EVENTS EMITTED ───────────────────────────────────────────────────────────────────
 * A read is not a state change (CLAUDE.md §1). The audited `admin.action_performed` belongs to
 * export and mutation paths; a dashboard render is neither.
 */
@Injectable()
export class AdminDashboardService {
  /**
   * The breach event this dashboard splits by reason. `ai.spend_cap_exceeded` is TD27's
   * fail-closed record: the AI gateway refused a real provider call.
   *
   * HONEST SCOPE NOTE, AND IT SHIPS ON THE WIRE: `ProfileExtractionProcessor` is the ONLY
   * emitter of this event in `apps/api`. So a zero here means "extraction hit no cap", NOT "no
   * surface anywhere hit a cap" — the profiling-chat, résumé, embedding and payer-chat surfaces
   * have no emitter yet. A comment cannot reach the UI, so the response carries
   * `cap_breaches.scope` = {@link CAP_BREACH_SCOPE_PROFILE_EXTRACTION}. Widening the coverage is
   * an emitter-side change; when it lands, that constant changes with it.
   */
  static readonly CAP_BREACH_EVENT = "ai.spend_cap_exceeded";
  /**
   * The closed-enum field on that payload (`AI_SPEND_CAP_REASONS`). Typed as
   * `AdminPayloadGroupField`, which is the closed set the repository will render as a SQL
   * literal — see `AdminEventsRepository.payloadKeyExpr`. This constant is the ONLY value that
   * argument ever takes.
   */
  static readonly CAP_BREACH_FIELD: AdminPayloadGroupField = "reason";

  constructor(
    private readonly repo: AdminDashboardRepository,
    /**
     * The spine reader, reused rather than re-implemented — see its `countByPayloadField`
     * header for why `events` keeps exactly one admin reader.
     */
    private readonly events: AdminEventsRepository,
  ) {}

  /**
   * Densify a `GROUP BY` result over a CLOSED enum: every declared member, in declared order,
   * with 0 for the ones the query returned nothing for, followed by ONE `other` bucket holding
   * everything the enum does not name.
   *
   * ── WHY `other` EXISTS (BUGFIX, 2026-08-19) ─────────────────────────────────────────────
   * This used to DROP out-of-enum keys, on the reasoning that the column is typed to the enum
   * so a foreign value is corrupt data. The reasoning was right and the consequence was wrong:
   * the totals below are summed from these very buckets, so a dropped row left BOTH the
   * breakdown and the headline short, and `workers.total` quietly stopped equalling
   * `count(*)`. Only `job_postings.status` has a DB CHECK (`job_postings_status_chk`);
   * `workers.status`, `worker_profiles.profile_status`, `payers.role` and `payers.status` are
   * plain `text` columns typed in TypeScript alone, so "corrupt data" is a state a bad write,
   * a migration or an older deploy can actually reach. Silently undercounting the headline is
   * the exact failure class this surface was built to prevent for spend.
   *
   * `other` is ALWAYS emitted, zero included — the same rule every enum member follows, and
   * what makes `sum(buckets) === count(*)` structural instead of conditional. It is part of the
   * bucket-key UNION (see {@link AdminEnumBuckets}), so a client switch-casing on the key is
   * forced by the type to account for it rather than meeting it at runtime.
   *
   * (The OPEN sets — provider, task type, breach reason — are passed through raw and are not
   * densified at all: nothing there is closed, so there is no enum to be outside of.)
   */
  private static densify<K extends string>(
    rows: AdminKeyCount[],
    members: readonly K[],
  ): AdminEnumBuckets<K> {
    const found = new Map(rows.map((r) => [r.key, r.count]));
    const known = new Set<string>(members);
    const buckets: AdminEnumBuckets<K> = members.map((key) => ({
      key,
      count: found.get(key) ?? 0,
    }));
    // Everything the enum does not name, in one bucket — never dropped, never merged into a
    // member it is not.
    const other = rows.reduce((n, r) => (known.has(r.key) ? n : n + r.count), 0);
    buckets.push({ key: DASHBOARD_OTHER_BUCKET, count: other });
    return buckets;
  }

  private static sum(buckets: { count: number }[]): number {
    return buckets.reduce((n, b) => n + b.count, 0);
  }

  async summary(dto: AdminDashboardSummaryQueryDto): Promise<AdminDashboardSummary> {
    const since = new Date(Date.now() - dto.windowDays * 24 * 60 * 60 * 1000);

    // Thirteen independent aggregates. Run concurrently so the page's latency is the slowest
    // ONE, not their sum — the same reason `AdminFinanceService.summary` does it.
    const [
      costTotals,
      byProvider,
      byTaskType,
      breaches,
      workerStatuses,
      pendingDeletion,
      profileStatuses,
      postingStatuses,
      applicationCounts,
      payerRoles,
      payerStatuses,
      unlocksIssued,
      resumes,
    ] = await Promise.all([
      this.repo.platformCostTotals(),
      this.repo.costByProvider(),
      this.repo.costByTaskType(),
      this.events.countByPayloadField(
        AdminDashboardService.CAP_BREACH_EVENT,
        AdminDashboardService.CAP_BREACH_FIELD,
        since,
      ),
      this.repo.countWorkersByStatus(),
      this.repo.countWorkersPendingDeletion(),
      this.repo.countCurrentProfilesByStatus(),
      this.repo.countJobPostingsByStatus(),
      this.repo.applicationCounts(),
      this.repo.countPayersByRole(),
      this.repo.countPayersByStatus(),
      this.repo.countUnlocksIssued(),
      this.repo.countGeneratedResumes(),
    ]);

    const byReason: AdminCapBreachBucket[] = breaches.map((b) => ({
      reason: b.key,
      count: b.count,
    }));

    const workersByStatus = AdminDashboardService.densify(
      workerStatuses,
      DASHBOARD_WORKER_STATUSES,
    );
    const profilesByStatus = AdminDashboardService.densify(
      profileStatuses,
      DASHBOARD_PROFILE_STATUSES,
    );
    const postingsByStatus = AdminDashboardService.densify(
      postingStatuses,
      DASHBOARD_JOB_POSTING_STATUSES,
    );
    const payersByRole = AdminDashboardService.densify(payerRoles, DASHBOARD_PAYER_ROLES);
    const payersByStatus = AdminDashboardService.densify(payerStatuses, DASHBOARD_PAYER_STATUSES);

    return {
      generated_at: new Date(),
      ai_cost: {
        // THE HONESTY MARKER. Null until something accrues; `false` until a backfill lands.
        accruing_since: costTotals.since,
        is_lifetime_total: false,
        caveat: AI_COST_CAVEAT_SINCE_0077,
        total_cost_inr: costTotals.totalCostInr,
        total_calls: costTotals.totalCalls,
        real_calls: costTotals.realCalls,
        // RAW provider labels, in spend order. No remapping is applied — see the DTO header:
        // Sarvam spend now arrives as `sarvam`, but what accrued BEFORE that ai-service fix
        // shipped stays under `unknown` (running totals, no backfill), and rewriting it here
        // would also relabel every genuinely-unlabelled call.
        by_provider: byProvider,
        by_task_type: byTaskType,
        cap_breaches: {
          window_days: dto.windowDays,
          total: AdminDashboardService.sum(byReason),
          // IN BAND, next to the number: one emitter today, so a `0` here is not "nothing
          // anywhere hit a cap". Same device as `caveat` on the spend figures above.
          scope: CAP_BREACH_SCOPE_PROFILE_EXTRACTION,
          by_reason: byReason,
        },
      },
      volume: {
        workers: {
          // Summed from the SAME buckets the response carries, not a separate `count(*)`. Two
          // queries could disagree (rows are written between them) and a total that does not
          // equal its own breakdown is the kind of defect nobody reports and everybody notices.
          // That sum EQUALS `count(*)` only because `densify` now keeps an `other` bucket — the
          // enums it densifies against are not all enforced in the database.
          total: AdminDashboardService.sum(workersByStatus),
          by_status: workersByStatus,
          pending_deletion: pendingDeletion,
        },
        worker_profiles: {
          workers_with_profile: AdminDashboardService.sum(profilesByStatus),
          by_status: profilesByStatus,
        },
        job_postings: {
          total: AdminDashboardService.sum(postingsByStatus),
          by_status: postingsByStatus,
        },
        applications: applicationCounts,
        payers: {
          total: AdminDashboardService.sum(payersByRole),
          by_role: payersByRole,
          by_status: payersByStatus,
        },
        unlocks: { issued: unlocksIssued },
        resumes: { total: resumes },
      },
    };
  }
}
