import { describe, it, expect } from "vitest";
import { AdminDashboardService } from "./admin-dashboard.service";
import type { AdminDashboardRepository, AdminKeyCount } from "./admin-dashboard.repository";
import type { AdminEventsRepository } from "./admin-events.repository";
import {
  AI_COST_CAVEAT_SINCE_0077,
  ADMIN_DASHBOARD_WINDOW_DAYS_DEFAULT,
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
} from "./admin-dashboard.dto";

/**
 * The dashboard composition — what the SERVICE decides, over faked repositories.
 *
 * Four properties are pinned here because the repository layer cannot express them:
 *   1. THE HONESTY MARKERS. `accruing_since` comes from `min(first_recorded_at)` and the figures
 *      are never labelled a lifetime total; `cap_breaches.scope` says which surfaces that count
 *      covers. A partial number rendered as authoritative is the same failure class as a mock
 *      rupee rendered as a real one.
 *   2. DENSIFICATION over closed enums. "0 suspended workers" and "we did not measure suspended
 *      workers" are the same JSON to a client unless every enum member is emitted.
 *   3. THE `other` BUCKET, and therefore `total === count(*)`. Four of the five enums have no DB
 *      CHECK behind them, so a drifted value is reachable; dropping it used to shrink the
 *      headline as well as the breakdown.
 *   4. RAW PROVIDER LABELS. No provider remapping is applied anywhere in the service.
 */

const ACCRUAL_START = new Date("2026-08-18T09:00:00.000Z");

/**
 * The provider labels the ai-service ACTUALLY produces (`provider_for_model` in
 * apps/ai-service/app/ai/model_config.py) — `google`, `anthropic`, `openai`, `sarvam`,
 * `unknown`. Both Sarvam-relevant labels are in these fixtures on purpose: the table is a
 * running sum with no backfill, so STT spend that accrued BEFORE `provider_for_model` learned
 * the Sarvam families is still filed under `unknown`, while everything since is `sarvam`. The
 * read layer must pass BOTH through untouched.
 */
const PROVIDER_ROWS = [
  {
    provider: "google",
    total_cost_inr: "12.500000",
    call_count: 100,
    real_call_count: 90,
    first_recorded_at: ACCRUAL_START,
  },
  {
    provider: "anthropic",
    total_cost_inr: "7.250000",
    call_count: 40,
    real_call_count: 40,
    first_recorded_at: new Date("2026-08-19T00:00:00.000Z"),
  },
  {
    // Post-fix Sarvam STT spend.
    provider: "sarvam",
    total_cost_inr: "3.000000",
    call_count: 12,
    real_call_count: 12,
    first_recorded_at: new Date("2026-08-19T01:00:00.000Z"),
  },
  {
    // PRE-fix Sarvam STT spend, plus any genuinely unrecognised model id. Same table, same
    // rupees, permanently under a different label because nothing backfills a running sum.
    provider: "unknown",
    total_cost_inr: "1.000000",
    call_count: 4,
    real_call_count: 4,
    first_recorded_at: new Date("2026-08-17T01:00:00.000Z"),
  },
];

interface Overrides {
  /** The TABLE-WIDE accrual bound — `min(first_recorded_at)` over every task type. */
  since?: Date | null;
  /**
   * The PROFILING bound — `min(first_recorded_at)` over the profiling task types only, and a
   * SEPARATE knob from `since` on purpose. The two are the same instant only when the first
   * money the platform ever spent was profiling money; when anything else accrued first this
   * one is later, and every test that conflates them stops being able to see the difference.
   */
  profilingSince?: Date | null;
  totalCostInr?: string;
  profilingCostInr?: string;
  profilesCompleted?: number;
  workerStatuses?: AdminKeyCount[];
  profileStatuses?: AdminKeyCount[];
  postingStatuses?: AdminKeyCount[];
  payerRoles?: AdminKeyCount[];
  payerStatuses?: AdminKeyCount[];
  breaches?: AdminKeyCount[];
}

/**
 * What the service actually ASKED the repository for. The arguments are half the contract here:
 * "the profile count is scoped to the bound the response DISPLAYS" is a claim about a parameter,
 * and it is unassertable from the returned numbers alone.
 */
interface Asked {
  profilingTaskTypes: readonly string[] | null;
  profileCountSince: Date | null;
  profileCountStatuses: readonly string[] | null;
  profileCountCalls: number;
}

function blankAsked(): Asked {
  return {
    profilingTaskTypes: null,
    profileCountSince: null,
    profileCountStatuses: null,
    profileCountCalls: 0,
  };
}

function makeService(over: Overrides = {}, asked: Asked = blankAsked()): AdminDashboardService {
  const repo = {
    platformCostTotals: async () => ({
      totalCostInr: over.totalCostInr ?? "22.750000",
      totalCalls: 152,
      realCalls: 142,
      since: over.since === undefined ? ACCRUAL_START : over.since,
    }),
    costByProvider: async () => PROVIDER_ROWS,
    costByTaskType: async () => [
      {
        task_type: "profiling_chat_turn",
        total_cost_inr: "19.750000",
        call_count: 140,
        real_call_count: 130,
      },
      {
        task_type: "stt_transcription",
        total_cost_inr: "3.000000",
        call_count: 12,
        real_call_count: 12,
      },
      {
        // The trap: in the TOTAL and never in the profiling numerator. A résumé is rendered
        // FROM a profile that already exists, so it produced none.
        task_type: "resume_generation",
        total_cost_inr: "3.000000",
        call_count: 12,
        real_call_count: 12,
      },
    ],
    profilingCostSubtotal: async (taskTypes: readonly string[]) => {
      asked.profilingTaskTypes = taskTypes;
      return {
        totalCostInr: over.profilingCostInr ?? "19.750000",
        callCount: 140,
        realCallCount: 130,
        // Defaults to the table-wide bound so the ordinary fixture is the coinciding case;
        // `profilingSince` is what pulls them apart.
        since: over.profilingSince === undefined ? ACCRUAL_START : over.profilingSince,
      };
    },
    countCurrentProfilesCompletedSince: async (since: Date, statuses: readonly string[]) => {
      asked.profileCountSince = since;
      asked.profileCountStatuses = statuses;
      asked.profileCountCalls += 1;
      return over.profilesCompleted ?? 5;
    },
    countWorkersByStatus: async () => over.workerStatuses ?? [{ key: "active", count: 7 }],
    countWorkersPendingDeletion: async () => 2,
    countCurrentProfilesByStatus: async () =>
      over.profileStatuses ?? [{ key: "extracted", count: 4 }],
    countJobPostingsByStatus: async () => over.postingStatuses ?? [{ key: "open", count: 3 }],
    applicationCounts: async () => ({ total: 90, applied: 55 }),
    countPayersByRole: async () => over.payerRoles ?? [{ key: "employer", count: 5 }],
    countPayersByStatus: async () => over.payerStatuses ?? [{ key: "active", count: 5 }],
    countUnlocksIssued: async () => 11,
    countGeneratedResumes: async () => 6,
  } as unknown as AdminDashboardRepository;

  const events = {
    countByPayloadField: async () =>
      over.breaches ?? [
        { key: "user_daily_cap_exceeded", count: 9 },
        { key: "cumulative_cap_exceeded", count: 1 },
      ],
  } as unknown as AdminEventsRepository;

  return new AdminDashboardService(repo, events);
}

const DTO = { windowDays: ADMIN_DASHBOARD_WINDOW_DAYS_DEFAULT };

describe("AI cost — the honesty marker", () => {
  it("reports accruing_since from the totals, and NEVER claims a lifetime total", async () => {
    const out = await makeService().summary(DTO);
    expect(out.ai_cost.accruing_since).toEqual(ACCRUAL_START);
    expect(out.ai_cost.is_lifetime_total).toBe(false);
    expect(out.ai_cost.caveat).toBe(AI_COST_CAVEAT_SINCE_0077);
  });

  it("accruing_since is NULL when nothing has ever accrued — not a fabricated date", async () => {
    const out = await makeService({ since: null, totalCostInr: "0" }).summary(DTO);
    expect(out.ai_cost.accruing_since).toBeNull();
    // A zero that is genuinely zero still carries the caveat: the reader cannot tell "nothing
    // was spent" from "nothing was spent SINCE 0077" without it.
    expect(out.ai_cost.caveat).toBe(AI_COST_CAVEAT_SINCE_0077);
    expect(out.ai_cost.total_cost_inr).toBe("0");
  });

  it("₹ crosses the wire as the exact decimal STRING it was summed as", async () => {
    const out = await makeService().summary(DTO);
    expect(out.ai_cost.total_cost_inr).toBe("22.750000");
    expect(typeof out.ai_cost.total_cost_inr).toBe("string");
    for (const bucket of out.ai_cost.by_provider) {
      expect(typeof bucket.total_cost_inr).toBe("string");
    }
  });
});

describe("AI cost — the provider split", () => {
  it("passes the RAW provider labels through, in the repository's order", async () => {
    const out = await makeService().summary(DTO);
    expect(out.ai_cost.by_provider.map((p) => p.provider)).toEqual([
      "google",
      "anthropic",
      "sarvam",
      "unknown",
    ]);
  });

  it("keeps the pre-fix `unknown` bucket SEPARATE from `sarvam` — no read-time remapping", async () => {
    const out = await makeService().summary(DTO);
    const labels = out.ai_cost.by_provider.map((p) => p.provider);
    // Both survive as stored. Folding `unknown` into `sarvam` would move money between buckets
    // after the fact AND mislabel every genuinely-unrecognised model id, which still lands in
    // `unknown` by design.
    expect(labels).toContain("sarvam");
    expect(labels).toContain("unknown");
    expect(out.ai_cost.by_provider.find((p) => p.provider === "unknown")?.total_cost_inr).toBe(
      "1.000000",
    );
    // …and no display-name guessing either.
    for (const guessed of ["Sarvam", "gemini", "Gemini", "claude", "Claude"]) {
      expect(labels).not.toContain(guessed);
    }
  });

  it("carries the per-task split, which is what makes the historical `unknown` bucket readable", async () => {
    const out = await makeService().summary(DTO);
    expect(out.ai_cost.by_task_type.map((t) => t.task_type)).toContain("stt_transcription");
  });
});

describe("AI cost — what a finished profile costs", () => {
  it("divides the PROFILING subtotal, never the platform total (the resume_generation trap)", async () => {
    // ₹19.75 of profiling spend over 5 profiles = ₹3.95. The platform total is ₹22.75, which
    // over the same 5 would read ₹4.55 — a 15% overstatement made of résumé rendering, work
    // that produced no profile at all. Both are plausible numbers on screen.
    const out = await makeService({ profilingCostInr: "19.750000", profilesCompleted: 5 }).summary(
      DTO,
    );
    const perProfile = out.ai_cost.per_profile!;
    expect(perProfile.profiling_cost_inr).toBe("19.750000");
    expect(perProfile.cost_per_profile_inr).toBe("3.950000");
    // The figure the total would have produced must NOT be what shipped.
    expect(perProfile.cost_per_profile_inr).not.toBe("4.550000");
    expect(perProfile.profiling_cost_inr).not.toBe(out.ai_cost.total_cost_inr);
  });

  it("asks for exactly the profiling task types — and resume_generation is not one", async () => {
    const asked = blankAsked();
    await makeService({}, asked).summary(DTO);
    expect(asked.profilingTaskTypes).toEqual(PROFILING_TASK_TYPES);
    expect(asked.profilingTaskTypes).toEqual([
      "profiling_chat_turn",
      "profile_extraction",
      "profile_parse",
    ]);
    expect(asked.profilingTaskTypes).not.toContain("resume_generation");
    // …and the response says which set it used, so the split is auditable from the wire.
    const out = await makeService().summary(DTO);
    expect(out.ai_cost.per_profile!.profiling_task_types).toEqual(PROFILING_TASK_TYPES);
  });

  it("scopes the profile count to the NUMERATOR's bound, not the table-wide one", async () => {
    /*
     * THE ASSERTION THIS BLOCK EXISTS FOR, and the previous version of it could not fail.
     *
     * It read `expect(asked.profileCountSince).toEqual(out.ai_cost.accruing_since)` — two
     * aliases of ONE variable, because the service passed `costTotals.since` to both. That
     * pinned the wrong invariant: the numerator is FILTERED to the profiling task types, so the
     * window it actually covers starts at the first PROFILING accrual, which is later than the
     * table-wide minimum whenever a résumé or a payer-side embedding was paid for first.
     *
     * Measured against the local verification database before the fix: a `job_posting_chat_turn`
     * row at 2020-01-01 and profiling spend from 2026-08-19 gave a denominator of 22 against a
     * numerator covering 1 of them — ₹0.454545 reported where the truth was ₹10.000000. Nothing
     * about the response's shape changed.
     *
     * The bounds are pulled APART here so the assertion has something to be wrong about.
     */
    const PROFILING_START = new Date("2026-08-18T12:00:00.000Z");
    const asked = blankAsked();
    const out = await makeService({ profilingSince: PROFILING_START }, asked).summary(DTO);

    expect(asked.profileCountSince).toEqual(PROFILING_START);
    expect(out.ai_cost.per_profile!.since).toEqual(PROFILING_START);
    // …and explicitly NOT the bound the section displays, which is earlier here.
    expect(out.ai_cost.accruing_since).toEqual(ACCRUAL_START);
    expect(asked.profileCountSince).not.toEqual(out.ai_cost.accruing_since);
    // Nor the cap-breach window, which is a rolling `windowDays` back from NOW. Compared as a
    // distance rather than "is it old", so the assertion does not depend on when it is run.
    const breachWindowStart =
      Date.now() - ADMIN_DASHBOARD_WINDOW_DAYS_DEFAULT * 24 * 60 * 60 * 1000;
    expect(Math.abs(asked.profileCountSince!.getTime() - breachWindowStart)).toBeGreaterThan(
      60_000,
    );
  });

  it("uses the ONE bound for both halves — the count's is the block's own `since`", async () => {
    // Whatever that bound is, the two halves must share it: the field the portal dates both
    // tiles from has to be the field the count was actually filtered by.
    for (const profilingSince of [ACCRUAL_START, new Date("2026-08-21T00:00:00.000Z")]) {
      const asked = blankAsked();
      const out = await makeService({ profilingSince }, asked).summary(DTO);
      expect(asked.profileCountSince).toEqual(out.ai_cost.per_profile!.since);
    }
  });

  it("counts `extracted`/`confirmed`, and the field name says so", async () => {
    const asked = blankAsked();
    const out = await makeService({ profilesCompleted: 7 }, asked).summary(DTO);
    expect(asked.profileCountStatuses).toEqual(PROFILE_COMPLETED_STATUSES);
    expect(asked.profileCountStatuses).toEqual(["extracted", "confirmed"]);
    // `extracting` means an extraction IN FLIGHT — a `<> 'draft'` predicate would count it.
    expect(asked.profileCountStatuses).not.toContain("extracting");
    expect(out.ai_cost.per_profile!.profiles_extracted_or_confirmed).toBe(7);
  });

  it("a ZERO denominator yields a NULL average, not ₹0.00", async () => {
    // Spend in the window and no completed profile means every interview is still in flight or
    // was abandoned. `0.000000` would read as "profiles are free" — the strongest claim
    // available and the wrong one.
    const out = await makeService({ profilesCompleted: 0 }).summary(DTO);
    const perProfile = out.ai_cost.per_profile!;
    expect(perProfile).not.toBeNull();
    expect(perProfile.profiles_extracted_or_confirmed).toBe(0);
    expect(perProfile.cost_per_profile_inr).toBeNull();
    // The spend that bought nothing is still reported — it did happen.
    expect(perProfile.profiling_cost_inr).toBe("19.750000");
  });

  it("an empty table removes the whole block — not a zero, and not a query", async () => {
    const asked = blankAsked();
    const out = await makeService(
      { since: null, profilingSince: null, totalCostInr: "0" },
      asked,
    ).summary(DTO);
    // No window, so there is no "profiles in the same period" to count and nothing to divide.
    expect(out.ai_cost.per_profile).toBeNull();
    // …and the count is not even ISSUED: a count over all time would be the wrong number
    // rather than an unused one, and issuing it invites someone to start using it.
    expect(asked.profileCountCalls).toBe(0);
    // The rest of the cost section is unaffected — a genuine zero is still a zero.
    expect(out.ai_cost.total_cost_inr).toBe("0");
    expect(out.ai_cost.accruing_since).toBeNull();
  });

  it("SPEND WITH NO PROFILING IN IT removes the block too — never ₹0.00 over real profiles", async () => {
    /*
     * THE STATE THE LOCAL VERIFICATION DATABASE WAS ACTUALLY IN, and the one the previous
     * contract got wrong. Its cost table held a single `resume_generation` row, so
     * `accruing_since` was set — by a NON-profiling task type — while the profiling numerator
     * was empty. The old guard covered only a zero DENOMINATOR, so the service divided ₹0 by a
     * real profile count and shipped `"0.000000"`, which the portal rendered as a confident
     * ₹0.00 average with no caveat firing anywhere: `profiling_calls - profiling_real_calls`
     * is 0 in that state, so even the mock-posture sentence was suppressed.
     *
     * Production sat in exactly this state for the whole interval between the first accrual
     * after migration 0077 and the first profiling call, and returns to it whenever the
     * profiling task types are re-targeted — which has already happened once (`profile_parse`
     * replaced twelve per-turn ones).
     */
    const asked = blankAsked();
    const out = await makeService(
      { profilingSince: null, profilingCostInr: "0", profilesCompleted: 12 },
      asked,
    ).summary(DTO);
    expect(out.ai_cost.per_profile).toBeNull();
    expect(asked.profileCountCalls).toBe(0);
    // The SECTION still reports its own bound and its own money — only the ratio is absent.
    expect(out.ai_cost.accruing_since).toEqual(ACCRUAL_START);
    expect(out.ai_cost.total_cost_inr).toBe("22.750000");
  });

  it("never renders a positive average as ₹0.000000 — rounding may not make spend free", async () => {
    /*
     * `toFixed(6)` rounds, and a true quotient under ₹0.0000005 rounds to all zeros — which
     * `formatExactRupees` then shows as ₹0.00 while its own header promises that "we spent a
     * fraction of a paisa" and "we spent nothing" stay different facts. Rounding is accepted
     * everywhere else in this expression; the ONE rounding that flips the qualitative claim
     * from "small" to "free" is not.
     */
    const out = await makeService({
      profilingCostInr: "0.000001",
      profilesCompleted: 3,
    }).summary(DTO);
    const average = out.ai_cost.per_profile!.cost_per_profile_inr!;
    expect(Number(average)).toBeGreaterThan(0);
    expect(average).not.toBe("0.000000");
    expect(average).toBe("0.000001");
  });

  it("a numerator that IS zero still renders zero — a measured zero is not a rounded one", async () => {
    // Every profiling call mocked (`real_call=False` is priced at ₹0.0 at source) or a
    // free-tier model. The spend genuinely is ₹0, the calls are on the wire beside it, and
    // suppressing that would hide a fact about the table rather than protect anyone.
    const out = await makeService({
      profilingCostInr: "0",
      profilesCompleted: 4,
    }).summary(DTO);
    expect(out.ai_cost.per_profile!.cost_per_profile_inr).toBe("0.000000");
  });

  it("carries the call counts the average is over, and both in-band caveat codes", async () => {
    const out = await makeService().summary(DTO);
    const perProfile = out.ai_cost.per_profile!;
    expect(perProfile.profiling_calls).toBe(140);
    expect(perProfile.profiling_real_calls).toBe(130);
    // The numerator includes abandoned interviews; the denominator counts finished profiles.
    // The figure is exactly right for forecasting PROFILES and too large for forecasting
    // WORKERS, and the number cannot say which reading it is — so the codes ship beside it.
    expect(perProfile.basis).toBe(COST_PER_PROFILE_BASIS_INCLUDES_ABANDONED);
    expect(perProfile.window_caveat).toBe(COST_PER_PROFILE_WINDOW_EDGE_SKEW);
    // The third caveat: DPDP erasure takes the profile out of the count and leaves the money
    // in the total, so this average drifts upward permanently and the drift accumulates.
    expect(perProfile.erasure_caveat).toBe(COST_PER_PROFILE_ERASURE_BIAS);
    // STABLE machine codes, not prose — the portal keys captions off them.
    expect(COST_PER_PROFILE_BASIS_INCLUDES_ABANDONED).toBe(
      "profiling_spend_per_completed_profile_incl_abandoned_interviews",
    );
    expect(COST_PER_PROFILE_WINDOW_EDGE_SKEW).toBe(
      "interviews_straddling_the_accrual_bound_are_split",
    );
    expect(COST_PER_PROFILE_ERASURE_BIAS).toBe("erased_workers_leave_the_count_but_not_the_spend");
  });

  it("₹ stays an exact decimal STRING on both halves of the ratio", async () => {
    const out = await makeService().summary(DTO);
    const perProfile = out.ai_cost.per_profile!;
    expect(typeof perProfile.profiling_cost_inr).toBe("string");
    expect(typeof perProfile.cost_per_profile_inr).toBe("string");
    // Six places, the scale `numeric(16,6)` stores — not a bare JS float's rendering.
    expect(perProfile.cost_per_profile_inr).toMatch(/^\d+\.\d{6}$/);
  });

  it("the classification lists are non-empty — an empty IN list is a runtime error", () => {
    // `inArray(col, [])` THROWS in drizzle, so an emptied constant would take the whole endpoint
    // down rather than merely reporting a wrong number. Both lists are derived by filtering a
    // Record, which is exactly the shape that can silently become empty.
    expect(PROFILING_TASK_TYPES.length).toBeGreaterThan(0);
    expect(PROFILE_COMPLETED_STATUSES.length).toBeGreaterThan(0);
    // Every entry must be a real member of the enum it partitions.
    for (const status of PROFILE_COMPLETED_STATUSES) {
      expect(DASHBOARD_PROFILE_STATUSES).toContain(status);
    }
  });
});

describe("AI cost — cap breaches by reason", () => {
  it("splits the breach count by reason and totals it from those buckets", async () => {
    const out = await makeService().summary(DTO);
    expect(out.ai_cost.cap_breaches.by_reason).toEqual([
      { reason: "user_daily_cap_exceeded", count: 9 },
      { reason: "cumulative_cap_exceeded", count: 1 },
    ]);
    // The whole point of the split: 9 workers hitting their own budget and 1 platform-wide stop
    // are different incidents that one aggregate counter reports identically.
    expect(out.ai_cost.cap_breaches.total).toBe(10);
  });

  it("reads the `reason` field of `ai.spend_cap_exceeded`, and stamps the window it used", async () => {
    expect(AdminDashboardService.CAP_BREACH_EVENT).toBe("ai.spend_cap_exceeded");
    expect(AdminDashboardService.CAP_BREACH_FIELD).toBe("reason");
    const out = await makeService().summary({ windowDays: 7 });
    expect(out.ai_cost.cap_breaches.window_days).toBe(7);
  });

  it("an empty window is reported as zero buckets, not as a missing section", async () => {
    const out = await makeService({ breaches: [] }).summary(DTO);
    expect(out.ai_cost.cap_breaches.by_reason).toEqual([]);
    expect(out.ai_cost.cap_breaches.total).toBe(0);
  });

  it("ships the SCOPE marker in band — a zero here is not 'nothing anywhere hit a cap'", async () => {
    // One emitter (`ProfileExtractionProcessor`), so the count covers profile extraction only.
    // The spend figures got `caveat`/`is_lifetime_total` for exactly this reason; a UI given a
    // bare `0` renders the strongest reading, which is the wrong one.
    const zero = await makeService({ breaches: [] }).summary(DTO);
    expect(zero.ai_cost.cap_breaches.scope).toBe(CAP_BREACH_SCOPE_PROFILE_EXTRACTION);
    const nonZero = await makeService().summary(DTO);
    expect(nonZero.ai_cost.cap_breaches.scope).toBe(CAP_BREACH_SCOPE_PROFILE_EXTRACTION);
    // A STABLE machine code, not prose — the portal keys a caption off it.
    expect(CAP_BREACH_SCOPE_PROFILE_EXTRACTION).toBe("cap_breaches_cover_profile_extraction_only");
  });

  it("surfaces an UNKNOWN reason rather than dropping it (fail-open on the label only)", async () => {
    const out = await makeService({
      breaches: [{ key: "some_future_reason", count: 3 }],
    }).summary(DTO);
    expect(out.ai_cost.cap_breaches.by_reason).toEqual([
      { reason: "some_future_reason", count: 3 },
    ]);
  });
});

describe("volume — every closed enum is reported in full", () => {
  it("emits every worker status, including the ones at zero, then `other`", async () => {
    const out = await makeService({ workerStatuses: [{ key: "active", count: 7 }] }).summary(DTO);
    expect(out.volume.workers.by_status).toEqual([
      { key: "pending", count: 0 },
      { key: "active", count: 7 },
      { key: "suspended", count: 0 },
      { key: "other", count: 0 },
    ]);
    expect(out.volume.workers.by_status.map((b) => b.key)).toEqual([
      ...DASHBOARD_WORKER_STATUSES,
      DASHBOARD_OTHER_BUCKET,
    ]);
  });

  it("emits every profile status, every posting status, every payer role and status", async () => {
    const out = await makeService().summary(DTO);
    expect(out.volume.worker_profiles.by_status.map((b) => b.key)).toEqual([
      ...DASHBOARD_PROFILE_STATUSES,
      DASHBOARD_OTHER_BUCKET,
    ]);
    expect(out.volume.job_postings.by_status.map((b) => b.key)).toEqual([
      ...DASHBOARD_JOB_POSTING_STATUSES,
      DASHBOARD_OTHER_BUCKET,
    ]);
    expect(out.volume.payers.by_role.map((b) => b.key)).toEqual([
      ...DASHBOARD_PAYER_ROLES,
      DASHBOARD_OTHER_BUCKET,
    ]);
    expect(out.volume.payers.by_status.map((b) => b.key)).toEqual([
      ...DASHBOARD_PAYER_STATUSES,
      DASHBOARD_OTHER_BUCKET,
    ]);
  });

  it("the `other` sentinel collides with NO enum member (it would double a bucket if it did)", () => {
    for (const members of [
      DASHBOARD_WORKER_STATUSES,
      DASHBOARD_PROFILE_STATUSES,
      DASHBOARD_JOB_POSTING_STATUSES,
      DASHBOARD_PAYER_ROLES,
      DASHBOARD_PAYER_STATUSES,
    ]) {
      expect([...(members as readonly string[])]).not.toContain(DASHBOARD_OTHER_BUCKET);
    }
  });

  it("a key outside the enum lands in `other` — never dropped, never merged into a member", async () => {
    const out = await makeService({
      workerStatuses: [
        { key: "active", count: 7 },
        { key: "not_a_status", count: 99 },
      ],
    }).summary(DTO);
    expect(out.volume.workers.by_status).toEqual([
      { key: "pending", count: 0 },
      { key: "active", count: 7 },
      { key: "suspended", count: 0 },
      { key: "other", count: 99 },
    ]);
    // THE POINT: the headline still equals `count(*)`. Dropping the drifted row used to make
    // this 7 — a silent undercount in the one number a reader trusts without checking.
    expect(out.volume.workers.total).toBe(106);
  });

  it("several drifted keys collapse into ONE `other` bucket, summed", async () => {
    const out = await makeService({
      payerStatuses: [
        { key: "active", count: 5 },
        { key: "archived", count: 3 },
        { key: "", count: 2 },
      ],
      payerRoles: [{ key: "employer", count: 10 }],
    }).summary(DTO);
    expect(out.volume.payers.by_status.filter((b) => b.key === "other")).toEqual([
      { key: "other", count: 5 },
    ]);
    // by_status and by_role are two views of the same table, so both must reach the same total.
    const statusTotal = out.volume.payers.by_status.reduce((n, b) => n + b.count, 0);
    expect(statusTotal).toBe(10);
    expect(out.volume.payers.total).toBe(10);
  });

  it("every enum-bucketed list sums to its own headline, drift included", async () => {
    const out = await makeService({
      workerStatuses: [
        { key: "active", count: 7 },
        { key: "zombie", count: 1 },
      ],
      profileStatuses: [
        { key: "confirmed", count: 4 },
        { key: "half_baked", count: 2 },
      ],
      postingStatuses: [
        { key: "open", count: 3 },
        { key: "archived", count: 5 },
      ],
    }).summary(DTO);
    const sum = (bs: { count: number }[]) => bs.reduce((n, b) => n + b.count, 0);
    expect(out.volume.workers.total).toBe(sum(out.volume.workers.by_status));
    expect(out.volume.workers.total).toBe(8);
    expect(out.volume.worker_profiles.workers_with_profile).toBe(
      sum(out.volume.worker_profiles.by_status),
    );
    expect(out.volume.worker_profiles.workers_with_profile).toBe(6);
    expect(out.volume.job_postings.total).toBe(sum(out.volume.job_postings.by_status));
    expect(out.volume.job_postings.total).toBe(8);
  });
});

describe("volume — the totals equal their own breakdowns", () => {
  it("worker/posting/payer totals are summed from the buckets, not queried separately", async () => {
    const out = await makeService({
      workerStatuses: [
        { key: "pending", count: 2 },
        { key: "active", count: 7 },
        { key: "suspended", count: 1 },
      ],
      postingStatuses: [
        { key: "open", count: 3 },
        { key: "closed", count: 4 },
      ],
      payerRoles: [
        { key: "employer", count: 5 },
        { key: "agent", count: 2 },
      ],
    }).summary(DTO);

    expect(out.volume.workers.total).toBe(10);
    expect(out.volume.job_postings.total).toBe(7);
    expect(out.volume.payers.total).toBe(7);
    // A total that does not equal its own breakdown is the defect nobody reports and everybody
    // notices; two separate queries can disagree because rows are written between them.
    expect(out.volume.workers.total).toBe(
      out.volume.workers.by_status.reduce((n, b) => n + b.count, 0),
    );
  });

  it("profile progress counts WORKERS, not worker_profiles rows", async () => {
    const out = await makeService({
      profileStatuses: [
        { key: "draft", count: 1 },
        { key: "extracted", count: 4 },
        { key: "confirmed", count: 2 },
      ],
    }).summary(DTO);
    expect(out.volume.worker_profiles.workers_with_profile).toBe(7);
  });

  it("carries the remaining scale indicators", async () => {
    const out = await makeService().summary(DTO);
    expect(out.volume.workers.pending_deletion).toBe(2);
    expect(out.volume.applications).toEqual({ total: 90, applied: 55 });
    expect(out.volume.unlocks).toEqual({ issued: 11 });
    expect(out.volume.resumes).toEqual({ total: 6 });
  });
});

describe("the response carries no identity at all", () => {
  it("no id, phone, name or email appears anywhere in the serialized summary", async () => {
    const out = await makeService().summary(DTO);
    const json = JSON.stringify(out);
    for (const forbidden of ["worker_id", "payer_id", "session_id", "phone", "email", "name"]) {
      expect(json, `the dashboard summary must not carry ${forbidden}`).not.toContain(forbidden);
    }
    expect(out.generated_at).toBeInstanceOf(Date);
  });
});
