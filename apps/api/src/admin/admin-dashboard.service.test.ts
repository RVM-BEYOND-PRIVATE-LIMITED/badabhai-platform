import { describe, it, expect } from "vitest";
import { AdminDashboardService } from "./admin-dashboard.service";
import type { AdminDashboardRepository, AdminKeyCount } from "./admin-dashboard.repository";
import type { AdminEventsRepository } from "./admin-events.repository";
import {
  AI_COST_CAVEAT_SINCE_0077,
  ADMIN_DASHBOARD_WINDOW_DAYS_DEFAULT,
  CAP_BREACH_SCOPE_PROFILE_EXTRACTION,
  DASHBOARD_JOB_POSTING_STATUSES,
  DASHBOARD_OTHER_BUCKET,
  DASHBOARD_PAYER_ROLES,
  DASHBOARD_PAYER_STATUSES,
  DASHBOARD_PROFILE_STATUSES,
  DASHBOARD_WORKER_STATUSES,
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
  since?: Date | null;
  totalCostInr?: string;
  workerStatuses?: AdminKeyCount[];
  profileStatuses?: AdminKeyCount[];
  postingStatuses?: AdminKeyCount[];
  payerRoles?: AdminKeyCount[];
  payerStatuses?: AdminKeyCount[];
  breaches?: AdminKeyCount[];
}

function makeService(over: Overrides = {}): AdminDashboardService {
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
    ],
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
    expect(out.ai_cost.cap_breaches.by_reason).toEqual([{ reason: "some_future_reason", count: 3 }]);
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
