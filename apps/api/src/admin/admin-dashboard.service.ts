import { Injectable } from "@nestjs/common";
import { AdminDashboardRepository, type AdminKeyCount } from "./admin-dashboard.repository";
import { AdminEventsRepository, type AdminPayloadGroupField } from "./admin-events.repository";
import {
  AI_COST_CAVEAT_SINCE_0077,
  CAP_BREACH_SCOPE_PROFILE_EXTRACTION,
  COST_PER_PROFILE_BASIS_INCLUDES_ABANDONED,
  COST_PER_PROFILE_ERASURE_BIAS,
  COST_PER_PROFILE_WINDOW_EDGE_SKEW,
  DASHBOARD_JOB_POSTING_STATUSES,
  DASHBOARD_OTHER_BUCKET,
  DASHBOARD_PAYER_ROLES,
  DASHBOARD_PAYER_STATUSES,
  DASHBOARD_PROFILE_STATUSES,
  DASHBOARD_WORKER_STATUSES,
  PROFILE_COMPLETED_STATUSES,
  PROFILING_TASK_TYPES,
  type AdminCapBreachBucket,
  type AdminCostPerProfile,
  type AdminDashboardSummary,
  type AdminDashboardSummaryQueryDto,
  type AdminEnumBuckets,
} from "./admin-dashboard.dto";
import type { AdminProfilingCostSubtotal } from "./admin-dashboard.repository";

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
 *  4. THE COST-PER-PROFILE RATIO, and both of its classifications. Which task types count as
 *     profiling spend, which profile statuses count as a produced profile, that BOTH halves are
 *     scoped to the bound the PROFILING SUBTOTAL begins at (which is NOT `accruing_since` —
 *     that one is table-wide and can belong to a task type the numerator excludes), that no
 *     profiling accrual at all means the block is ABSENT rather than ₹0.00, and that a zero
 *     denominator yields a NULL average. The repository holds none of that: it is handed the
 *     bound and the two sets and runs the query. See {@link AdminDashboardService.perProfile}.
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

  /**
   * The exact-decimal scale the wire and `numeric(16,6)` agree on, and the smallest non-zero
   * amount representable at it. A quotient below `SMALLEST` is positive but unrenderable.
   */
  private static readonly INR_SCALE = 6;
  private static readonly SMALLEST_INR = "0.000001";

  /**
   * The cost-per-profile block — or NULL when there is no PROFILING accrual window to compute
   * it over.
   *
   * ── THE DIVISION IS DONE IN JAVASCRIPT, AND THAT IS NOT THE FLOAT-DRIFT CASE ────────────
   * The repository sums `numeric` IN POSTGRES and returns `::text` because ADDING MANY ROWS in
   * IEEE-754 is neither exact nor associative, and a total that changes with row order is
   * indefensible on a page labelled "spend". A single division of one exact subtotal by one
   * integer has neither property to lose: there is one operation, the true quotient rarely
   * terminates in decimal anyway, and `toFixed(6)` renders it at the same scale
   * `numeric(16,6)` stores. Pushing this into SQL and reading it back would buy no precision
   * and cost a round trip — so the next reader does not "fix" it, this paragraph exists.
   *
   * The one thing that argument does NOT cover, and which is recorded here rather than left to
   * be rediscovered: `Number()` on the string is a decimal→binary conversion, and at the very
   * top of `numeric(16,6)`'s range (16 significant digits against a double's ~15–17) it is
   * lossy — `Number("9999999999.999999")` is `9999999999.999998`. That is ₹10 billion of
   * profiling spend against a lifetime total presently measured in tens of rupees, so it is
   * noted as a known bound of this approach and not treated as a live defect.
   *
   * ── A ZERO DENOMINATOR IS AN ABSENT AVERAGE, NEVER ₹0.00 ────────────────────────────────
   * Spend in the window with no completed profile means every interview is still in flight or
   * was abandoned. `null` says that; `0.00` says profiles are free, which is the strongest
   * available claim and the wrong one. Same discipline as `accruing_since` refusing to coalesce.
   *
   * ── A POSITIVE QUOTIENT NEVER RENDERS AS ZERO ───────────────────────────────────────────
   * `toFixed(6)` ROUNDS, and a true quotient under ₹0.0000005 rounds to `"0.000000"` — which
   * `formatExactRupees` then renders as `₹0.00` while its own header promises the opposite
   * ("a sub-paisa figure renders all six of its places rather than collapsing to ₹0.00, because
   * 'we spent a fraction of a paisa' and 'we spent nothing' are different facts"). Rounding is
   * already accepted everywhere else in this expression — ₹5.9857754 ships as `"5.985775"` — so
   * the objection is not to rounding but to the ONE rounding that changes the qualitative claim
   * from "small" to "free". A positive quotient is therefore clamped UP to the smallest
   * representable amount: an error of under one micro-rupee, strictly smaller than the rounding
   * already tolerated, and it never says the platform got something for nothing.
   */
  private static perProfile(
    since: Date | null,
    subtotal: AdminProfilingCostSubtotal,
    profilesCompleted: number,
  ): AdminCostPerProfile | null {
    // NO PROFILING WINDOW, NO RATIO. `since` here is `min(first_recorded_at)` over the PROFILING
    // task types, so null means no profiling call has ever been recorded — and then there is no
    // period for a profile count to cover. The whole block is absent rather than ₹0 over a real
    // profile count, which is the state a table holding only `resume_generation` or a payer-side
    // `skill_embedding` is in, and which would otherwise render a confident "profiles are free".
    // The caller does not even issue the count query in this case.
    if (since === null) return null;

    return {
      since,
      profiling_task_types: PROFILING_TASK_TYPES,
      profiling_cost_inr: subtotal.totalCostInr,
      profiling_calls: subtotal.callCount,
      profiling_real_calls: subtotal.realCallCount,
      profiles_extracted_or_confirmed: profilesCompleted,
      cost_per_profile_inr: AdminDashboardService.average(subtotal.totalCostInr, profilesCompleted),
      basis: COST_PER_PROFILE_BASIS_INCLUDES_ABANDONED,
      window_caveat: COST_PER_PROFILE_WINDOW_EDGE_SKEW,
      erasure_caveat: COST_PER_PROFILE_ERASURE_BIAS,
    };
  }

  /**
   * `numerator / count` as an exact-decimal string at {@link INR_SCALE} — null on a zero
   * denominator, and never `"0.000000"` for a numerator that is not itself zero. See the two
   * final paragraphs of {@link perProfile} for why each of those is the honest answer.
   */
  private static average(numerator: string, count: number): string | null {
    if (count === 0) return null;
    const exact = Number(numerator) / count;
    const rendered = exact.toFixed(AdminDashboardService.INR_SCALE);
    // `Number(rendered) === 0` rather than a string compare: it catches "0.000000" and the
    // "-0.000000" a negative zero would produce, without either literal appearing here.
    if (Number(rendered) === 0 && exact > 0) return AdminDashboardService.SMALLEST_INR;
    return rendered;
  }

  async summary(dto: AdminDashboardSummaryQueryDto): Promise<AdminDashboardSummary> {
    // The CAP-BREACH window — a rolling `windowDays` back from now, and nothing to do with the
    // accrual bound below. Two different "since" values on one page is exactly the confusion
    // the cost-per-profile figure exists to avoid, so neither of them is called `since`.
    const breachWindowSince = new Date(Date.now() - dto.windowDays * 24 * 60 * 60 * 1000);

    // ── READ ONE: THE TWO BOUNDS, AND THEY MUST COME FIRST ──────────────────────────────
    // The profile count is scoped to the bound the PROFILING SUBTOTAL begins at, so it cannot be
    // issued until that value is known. Both aggregates are read here, concurrently, because the
    // section's bound (`accruing_since`, table-wide) and the ratio's bound (profiling rows only)
    // are DIFFERENT INSTANTS with different jobs — see `AdminCostPerProfile`. This costs one
    // extra round trip, deliberately: both are aggregates over `platform_ai_cost_totals`, which
    // is ~4 providers x ~9 task types by construction, so they scan a few dozen rows and are not
    // a page-latency term.
    //
    // THE COUNT'S BOUND IS READ OFF THE SAME AGGREGATE THAT PRODUCED THE NUMERATOR, which is
    // what makes the two halves of the ratio structurally incapable of covering different
    // periods. Bounding the count by `costTotals.since` instead — the value the section
    // displays, and the obvious-looking choice — is a measured 22× error the moment any
    // non-profiling task type accrued first.
    const [costTotals, profilingSubtotal] = await Promise.all([
      this.repo.platformCostTotals(),
      // The profiling SLICE of the same table, not a sum of the buckets below — see the
      // repository header for why that sum belongs in Postgres.
      this.repo.profilingCostSubtotal(PROFILING_TASK_TYPES),
    ]);

    // Thirteen independent aggregates. Run concurrently so the page's latency is the slowest
    // ONE, not their sum — the same reason `AdminFinanceService.summary` does it.
    const [
      byProvider,
      byTaskType,
      profilesCompleted,
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
      this.repo.costByProvider(),
      this.repo.costByTaskType(),
      // NOT ISSUED AT ALL when no PROFILING spend has accrued: with no window there is no
      // "profiles in the same period" to count, and a count over all time would be the wrong
      // number rather than an unused one. Note this is the PROFILING bound, not `costTotals`':
      // a table holding only `resume_generation` has a non-null `accruing_since` and still has
      // no profiling window at all.
      profilingSubtotal.since === null
        ? Promise.resolve(0)
        : this.repo.countCurrentProfilesCompletedSince(
            profilingSubtotal.since,
            PROFILE_COMPLETED_STATUSES,
          ),
      this.events.countByPayloadField(
        AdminDashboardService.CAP_BREACH_EVENT,
        AdminDashboardService.CAP_BREACH_FIELD,
        breachWindowSince,
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
        // What a finished profile costs, over the bound the PROFILING spend itself begins at —
        // null when no profiling call has ever been recorded. The numerator is the profiling
        // slice, never the total: `resume_generation` is rendered FROM a profile and must not
        // be billed to producing one. Its `since` is at or after `accruing_since` above and is
        // deliberately a different field; the portal labels this block's tiles from it.
        per_profile: AdminDashboardService.perProfile(
          profilingSubtotal.since,
          profilingSubtotal,
          profilesCompleted,
        ),
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
