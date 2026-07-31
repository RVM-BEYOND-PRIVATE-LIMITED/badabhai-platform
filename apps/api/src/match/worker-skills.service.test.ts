import "reflect-metadata";
import { describe, it, expect, vi } from "vitest";
import { DEFAULT_MATCH_CONFIG, type MatchConfig } from "@badabhai/match-engine";
import { WorkerMatchSkillsRebuiltPayload } from "@badabhai/event-schema";
import type { EventsService } from "../events/events.service";
import type { MatchConfigService } from "./match-config.service";
import type {
  DerivedWorkerSkillRow,
  WorkerProfileSignals,
  WorkerSkillsRepository,
  WorkerTenureRow,
} from "./worker-skills.repository";
import { WorkerSkillsService } from "./worker-skills.service";

/**
 * MOMENTS ①② — the derive-on-profile-write path (ADR-0036, spec Part 6).
 *
 * Everything asserted here is a REAL number or a REAL id: the service's whole job is to
 * turn one profile row into the exact `worker_skill` / `worker_industry_tenure` rows the
 * feed then sorts on, so an off-by-one in the bucket or a dropped half of the skill
 * union is invisible in production until a man's feed is silently wrong.
 *
 * The engine functions it calls (`deriveWorkerSkills`, `computeIndustryTenure`) are pure
 * and already have their own suites; what is NOT covered anywhere else is that THIS
 * service wires the right inputs into them, passes the CONFIGURED bucket rather than a
 * hard-coded 6, reads `wants` back from the database instead of from its own derivation,
 * and puts PII-free counts on the audit spine.
 */

const WORKER = "11111111-1111-4111-8111-111111111111";
const MFG = "ind_industrial_manufacturing";

/** The bridge outcomes this file depends on, named so a vocabulary edit reads loudly. */
const ROLE_VMC = "role_vmc_operator"; // -> mskill_vmc_operator
const ATTR_TURNING = "skill_turning"; // -> mskill_cnc_turner
const ATTR_MIG = "skill_mig_welding"; // -> mskill_mig_welder
const ATTR_GDT = "skill_gdt_reading"; // -> [] (a pure attribute: shown, never matched)

interface Harness {
  svc: WorkerSkillsService;
  repo: {
    findLatestProfileSignals: ReturnType<typeof vi.fn>;
    replaceDerivedSkillsAndTenure: ReturnType<typeof vi.fn>;
    listWantedSkillIds: ReturnType<typeof vi.fn>;
    reconcileReachForWorker: ReturnType<typeof vi.fn>;
    listPostingIdsReaching: ReturnType<typeof vi.fn>;
  };
  events: { emit: ReturnType<typeof vi.fn> };
  /** Every repository/event call, in the order it happened. */
  order: string[];
  /** The `rows` argument of the single `replaceDerivedSkillsAndTenure` call. */
  writtenSkills: () => DerivedWorkerSkillRow[];
  writtenTenure: () => WorkerTenureRow[];
  emittedPayload: () => Record<string, unknown>;
}

function setup(opts: {
  signals: WorkerProfileSignals | undefined;
  /** What the DB says the worker WANTS after the write. Defaults to the derived set. */
  wanted?: string[];
  postings?: string[];
  config?: MatchConfig;
}): Harness {
  const order: string[] = [];
  let derivedIds: string[] = [];

  const repo = {
    findLatestProfileSignals: vi.fn(async () => {
      order.push("find");
      return opts.signals;
    }),
    replaceDerivedSkillsAndTenure: vi.fn(async (_w: string, rows: DerivedWorkerSkillRow[]) => {
      order.push("replace");
      derivedIds = rows.map((r) => r.skillId);
    }),
    listWantedSkillIds: vi.fn(async () => {
      order.push("wanted");
      return opts.wanted ?? derivedIds;
    }),
    reconcileReachForWorker: vi.fn(async () => {
      order.push("reconcile");
    }),
    listPostingIdsReaching: vi.fn(async () => {
      order.push("postings");
      return opts.postings ?? [];
    }),
  };
  const events = {
    emit: vi.fn(async (params: unknown) => {
      order.push("emit");
      return params;
    }),
  };
  const config = { get: async () => opts.config ?? DEFAULT_MATCH_CONFIG };

  return {
    svc: new WorkerSkillsService(
      repo as unknown as WorkerSkillsRepository,
      config as unknown as MatchConfigService,
      events as unknown as EventsService,
    ),
    repo,
    events,
    order,
    writtenSkills: () =>
      (repo.replaceDerivedSkillsAndTenure.mock.calls[0] as unknown[])?.[1] as DerivedWorkerSkillRow[],
    writtenTenure: () =>
      (repo.replaceDerivedSkillsAndTenure.mock.calls[0] as unknown[])?.[2] as WorkerTenureRow[],
    emittedPayload: () =>
      (events.emit.mock.calls[0]?.[0] as { payload: Record<string, unknown> }).payload,
  };
}

function signals(over: Partial<WorkerProfileSignals> = {}): WorkerProfileSignals {
  return { canonicalRoleId: null, profileSkills: [], totalYears: null, ...over };
}

describe("WorkerSkillsService — the match-skill SET is role bridge ∪ attribute bridge", () => {
  it("derives the role's match skill", async () => {
    const h = setup({ signals: signals({ canonicalRoleId: ROLE_VMC, totalYears: 4 }) });
    await h.svc.rebuildForWorker(WORKER);
    expect(h.writtenSkills()).toEqual([
      { skillId: "mskill_vmc_operator", industryId: MFG, monthsBucketed: 48 },
    ]);
  });

  it("derives the attribute bridge too — a UNION, not the role alone", async () => {
    // If this were role-only, a man whose role never resolved but whose attributes name
    // real trades would reach nothing at all; if it were attribute-only, every worker
    // would lose the one skill his canonical role states outright.
    const h = setup({
      signals: signals({
        canonicalRoleId: ROLE_VMC,
        profileSkills: [ATTR_TURNING, ATTR_MIG],
        totalYears: 2,
      }),
    });
    await h.svc.rebuildForWorker(WORKER);
    expect(h.writtenSkills().map((r) => r.skillId)).toEqual([
      "mskill_cnc_turner",
      "mskill_mig_welder",
      "mskill_vmc_operator",
    ]);
  });

  it("dedupes when the role and an attribute name the SAME skill", async () => {
    // `role_vmc_operator` and `skill_milling` both bridge to mskill_vmc_operator. A
    // duplicate row would break the (worker_id, skill_id) upsert target.
    const h = setup({
      signals: signals({ canonicalRoleId: ROLE_VMC, profileSkills: ["skill_milling"] }),
    });
    await h.svc.rebuildForWorker(WORKER);
    expect(h.writtenSkills().map((r) => r.skillId)).toEqual(["mskill_vmc_operator"]);
  });

  it("a PURE attribute (GD&T reading) contributes NO match skill — attributes are display-only", async () => {
    // ADR-0036 §3. Mapping GD&T to a posting-level skill would reach a lathe hand for a
    // programmer's vacancy on the strength of him reading a drawing.
    const h = setup({ signals: signals({ profileSkills: [ATTR_GDT] }) });
    await h.svc.rebuildForWorker(WORKER);
    expect(h.writtenSkills()).toEqual([]);
  });

  it("an UNKNOWN role and an UNKNOWN attribute derive nothing — no skill is ever fabricated", async () => {
    const h = setup({
      signals: signals({
        canonicalRoleId: "role_astronaut",
        profileSkills: ["skill_not_in_the_corpus"],
        totalYears: 10,
      }),
    });
    const result = await h.svc.rebuildForWorker(WORKER);
    expect(h.writtenSkills()).toEqual([]);
    expect(result?.skillCount).toBe(0);
  });

  it("writes rows in a DETERMINISTIC id order (the same profile twice writes the same rows)", async () => {
    // Order is part of the contract: the live path and `db:backfill:worker-skills` must
    // not disagree about what a worker's rows are.
    const profile = signals({
      canonicalRoleId: ROLE_VMC,
      profileSkills: [ATTR_MIG, ATTR_TURNING],
    });
    const first = setup({ signals: profile });
    await first.svc.rebuildForWorker(WORKER);
    const second = setup({
      signals: signals({
        canonicalRoleId: ROLE_VMC,
        profileSkills: [ATTR_TURNING, ATTR_MIG], // same set, different order in
      }),
    });
    await second.svc.rebuildForWorker(WORKER);
    expect(second.writtenSkills()).toEqual(first.writtenSkills());
  });

  it("claims NO stint dates and NO per-row wants — the coarse launch rule, visibly", async () => {
    // ADR-0036 "Coarse history at launch": `last_worked_at`/started_at/ended_at are null
    // because the extraction does not carry them. A date field appearing here would be
    // history the service invented, and it would then rank people.
    const h = setup({ signals: signals({ canonicalRoleId: ROLE_VMC, totalYears: 3 }) });
    await h.svc.rebuildForWorker(WORKER);
    expect(Object.keys(h.writtenSkills()[0]!).sort()).toEqual([
      "industryId",
      "monthsBucketed",
      "skillId",
    ]);
  });
});

describe("WorkerSkillsService — month bucketing is where the off-by-one lives", () => {
  const monthsFor = async (totalYears: number | null, config?: MatchConfig) => {
    const h = setup({
      signals: signals({ canonicalRoleId: ROLE_VMC, totalYears }),
      config,
    });
    await h.svc.rebuildForWorker(WORKER);
    return h.writtenSkills()[0]!.monthsBucketed;
  };

  it("rounds DOWN to the 6-month bucket at every boundary (5→0, 6→6, 11→6, 12→12)", async () => {
    // Bucketing UP would inflate a worker's claim, which is the one direction that
    // matters: it would put him above men who actually worked longer.
    expect(await monthsFor(5 / 12)).toBe(0);
    expect(await monthsFor(6 / 12)).toBe(6); // the boundary is INCLUSIVE
    expect(await monthsFor(11 / 12)).toBe(6);
    expect(await monthsFor(12 / 12)).toBe(12);
  });

  it("36 months — the tier floor — is reached at 3.0 years and MISSED at 2.99", async () => {
    // `tierFloorMonths` (36) is the E3 ruling's promotion threshold, so this exact
    // boundary decides whether a related-skill worker enters tier-1 ordering.
    expect(await monthsFor(2.99)).toBe(30);
    expect(await monthsFor(3)).toBe(36);
  });

  it("unknown / zero / negative experience is 0 months, never a guess", async () => {
    // E4's duration-unknown case: (tier, 0, …) — last within his tier, never dropped.
    expect(await monthsFor(null)).toBe(0);
    expect(await monthsFor(0)).toBe(0);
    expect(await monthsFor(-5)).toBe(0);
  });

  it("uses the CONFIGURED bucket, not a hard-coded 6", async () => {
    // Spec Part 5 "config, never code": an ops change to `month_bucket` must move this
    // number. 22.8 months at a 12-month bucket is 12, and at 6 would be 18.
    const twelve: MatchConfig = { ...DEFAULT_MATCH_CONFIG, monthBucket: 12 };
    expect(await monthsFor(1.9, twelve)).toBe(12);
    expect(await monthsFor(1.9)).toBe(18);
  });

  it("gives every derived row the SAME bucketed total (the coarse rule, stated not hidden)", async () => {
    const h = setup({
      signals: signals({
        canonicalRoleId: ROLE_VMC,
        profileSkills: [ATTR_TURNING, ATTR_MIG],
        totalYears: 8,
      }),
    });
    await h.svc.rebuildForWorker(WORKER);
    expect(h.writtenSkills().map((r) => r.monthsBucketed)).toEqual([96, 96, 96]);
  });
});

describe("WorkerSkillsService — industry tenure (moment ②, E8 clamp)", () => {
  it("clamps industry months to the worker's skill months (E8) — never below them", async () => {
    // E8: "he said three years on the VMC" must not read as less than the skill row
    // says. Within one industry the tenure can never be smaller than a skill in it.
    const h = setup({
      signals: signals({ canonicalRoleId: ROLE_VMC, profileSkills: [ATTR_TURNING], totalYears: 3 }),
    });
    await h.svc.rebuildForWorker(WORKER);
    expect(h.writtenTenure()).toEqual([{ industryId: MFG, calendarMonths: 36 }]);
    expect(h.writtenTenure()[0]!.calendarMonths).toBeGreaterThanOrEqual(
      Math.max(...h.writtenSkills().map((r) => r.monthsBucketed)),
    );
  });

  it("does NOT sum the same coarse total across skills (three skills at 96 is 96, not 288)", async () => {
    // The dated-stint rule is a MERGE precisely so one span of a man's life is counted
    // once (E9). With coarse rows a plain sum would multiply his career by his skill
    // count and hand him an industry-months key nobody earned.
    const h = setup({
      signals: signals({
        canonicalRoleId: ROLE_VMC,
        profileSkills: [ATTR_TURNING, ATTR_MIG],
        totalYears: 8,
      }),
    });
    await h.svc.rebuildForWorker(WORKER);
    expect(h.writtenTenure()).toEqual([{ industryId: MFG, calendarMonths: 96 }]);
  });

  it("derives NO tenure row when no skill was derived", async () => {
    const h = setup({ signals: signals({ totalYears: 20 }) });
    const result = await h.svc.rebuildForWorker(WORKER);
    // 20 years of something we could not place is 20 years in NO industry — inventing a
    // tenure row here would give a man industry months in a trade he never named.
    expect(h.writtenTenure()).toEqual([]);
    expect(result?.industryCount).toBe(0);
  });

  it("uses the configured bucket for tenure as well as for skills", async () => {
    const twelve: MatchConfig = { ...DEFAULT_MATCH_CONFIG, monthBucket: 12 };
    const h = setup({
      signals: signals({ canonicalRoleId: ROLE_VMC, totalYears: 1.9 }),
      config: twelve,
    });
    await h.svc.rebuildForWorker(WORKER);
    expect(h.writtenTenure()).toEqual([{ industryId: MFG, calendarMonths: 12 }]);
  });
});

describe("WorkerSkillsService — the reach tail reconciles against the DATABASE's wants", () => {
  it("reconciles with what the DB says he WANTS, not with what the derivation proposed", async () => {
    // The derivation always proposes `wants: true`. A worker who turned a skill OFF (an
    // `interview` row the derived writer must not touch) has to LEAVE the reach set, or
    // he keeps being shown — and can keep applying to — work he just declined.
    const h = setup({
      signals: signals({ canonicalRoleId: ROLE_VMC, totalYears: 5 }),
      wanted: ["mskill_cnc_turner"], // an interview row; the derived VMC row is off
    });
    await h.svc.rebuildForWorker(WORKER);
    expect(h.repo.reconcileReachForWorker).toHaveBeenCalledWith(WORKER, ["mskill_cnc_turner"]);
    expect(h.repo.listPostingIdsReaching).toHaveBeenCalledWith(["mskill_cnc_turner"]);
  });

  it("reconciles with an EMPTY set when he wants nothing (he must leave every reach set)", async () => {
    const h = setup({ signals: signals({ canonicalRoleId: ROLE_VMC }), wanted: [] });
    const result = await h.svc.rebuildForWorker(WORKER);
    expect(h.repo.reconcileReachForWorker).toHaveBeenCalledWith(WORKER, []);
    expect(result?.reachedPostings).toBe(0);
  });

  it("still reconciles when the rebuild derived ZERO skills", async () => {
    // Otherwise a worker whose re-extraction lost every skill keeps his stale job_reach
    // rows forever and goes on appearing in paid candidate lists.
    const h = setup({ signals: signals({ totalYears: 4 }), wanted: [] });
    await h.svc.rebuildForWorker(WORKER);
    expect(h.repo.reconcileReachForWorker).toHaveBeenCalledWith(WORKER, []);
  });

  it("WRITES the rows before it reads `wants` and reconciles (order, not coincidence)", async () => {
    // Reading wants first would reconcile reach against the PREVIOUS rebuild's rows, so
    // a newly derived skill would not reach anyone until the next profile write.
    const h = setup({ signals: signals({ canonicalRoleId: ROLE_VMC }) });
    await h.svc.rebuildForWorker(WORKER);
    expect(h.order).toEqual(["find", "replace", "wanted", "reconcile", "postings", "emit"]);
  });

  it("reports reachedPostings as the SIZE of the reaching-posting set", async () => {
    const h = setup({
      signals: signals({ canonicalRoleId: ROLE_VMC }),
      postings: ["p1", "p2", "p3"],
    });
    const result = await h.svc.rebuildForWorker(WORKER);
    expect(result?.reachedPostings).toBe(3);
  });
});

describe("WorkerSkillsService — no profile is a legitimate state, not a failure", () => {
  it("returns null and writes NOTHING when the worker has no profile row", async () => {
    const h = setup({ signals: undefined });
    expect(await h.svc.rebuildForWorker(WORKER)).toBeNull();
    // Writing a skill/tenure/reach row for a worker with no profile would put a man in
    // an employer's list on the strength of a profile that does not exist.
    expect(h.order).toEqual(["find"]);
  });
});

describe("WorkerSkillsService — the spine record (moment ①② event)", () => {
  it("emits worker.match_skills_rebuilt with the counts the rebuild actually produced", async () => {
    const h = setup({
      signals: signals({
        canonicalRoleId: ROLE_VMC,
        profileSkills: [ATTR_TURNING, ATTR_MIG],
        totalYears: 6,
      }),
      postings: ["p1", "p2"],
    });
    await h.svc.rebuildForWorker(WORKER);
    const params = h.events.emit.mock.calls[0]![0] as Record<string, unknown>;
    expect(params.event_name).toBe("worker.match_skills_rebuilt");
    expect(params.actor).toEqual({ actor_type: "system" });
    expect(params.subject).toEqual({ subject_type: "worker", subject_id: WORKER });
    expect(h.emittedPayload()).toEqual({
      worker_id: WORKER,
      skill_count: 3,
      industry_count: 1,
      reached_postings: 2,
    });
  });

  it("emits even when the rebuild derived ZERO skills (the E17 low-tag signal)", async () => {
    // Only emitting on success-with-rows makes `avg_skill_tags_per_worker` unmeasurable
    // and hides exactly the workers whose CONVERSATION is the bug.
    const h = setup({ signals: signals({ totalYears: 2 }) });
    await h.svc.rebuildForWorker(WORKER);
    expect(h.events.emit).toHaveBeenCalledTimes(1);
    expect(h.emittedPayload()).toMatchObject({ skill_count: 0, industry_count: 0 });
  });

  it("the payload VALIDATES against the registry schema (strict — nothing may ride along)", async () => {
    const h = setup({ signals: signals({ canonicalRoleId: ROLE_VMC, totalYears: 6 }) });
    await h.svc.rebuildForWorker(WORKER);
    const emitted = h.emittedPayload();

    // The registry schema is `.strict()`, so parsing is itself the assertion: an extra
    // field (a skill array, an employer name) throws rather than being stripped. Compare
    // the RESULT to the input as well, so the test also fails if the schema is ever
    // relaxed to strip-unknown — at which point a leaked field would parse "successfully"
    // and a `.not.toThrow()` check would go on passing while PII reached the spine.
    expect(WorkerMatchSkillsRebuiltPayload.parse(emitted)).toEqual(emitted);
  });

  it("the payload carries NO skill ids and NO PII — counts and an opaque uuid only", async () => {
    // §2: the audit spine gets the FACT, never the supply profile. A skill array here
    // would be a per-worker trade list on a table ops and the LEARN corpus both read.
    const h = setup({
      signals: signals({ canonicalRoleId: ROLE_VMC, profileSkills: [ATTR_TURNING] }),
    });
    await h.svc.rebuildForWorker(WORKER);
    const json = JSON.stringify(h.emittedPayload());
    expect(json).not.toContain("mskill_");
    expect(json).not.toContain("skill_turning");
    expect(json).not.toContain("ind_");
  });

  it("threads the request/correlation ids through so the rebuild is traceable", async () => {
    const h = setup({ signals: signals({ canonicalRoleId: ROLE_VMC }) });
    await h.svc.rebuildForWorker(WORKER, { requestId: "req-1", correlationId: "corr-1" });
    const params = h.events.emit.mock.calls[0]![0] as Record<string, unknown>;
    expect(params.correlationId).toBe("corr-1");
    expect(params.requestId).toBe("req-1");
  });

  it("emits AFTER the rows are written (never announces a rebuild that did not happen)", async () => {
    const h = setup({ signals: signals({ canonicalRoleId: ROLE_VMC }) });
    await h.svc.rebuildForWorker(WORKER);
    expect(h.order.indexOf("emit")).toBeGreaterThan(h.order.indexOf("replace"));
  });
});

describe("WorkerSkillsService.rebuildQuietly — a projection failure never fails extraction", () => {
  it("swallows a repository failure instead of rejecting", async () => {
    // The extraction processor calls this. A `job_reach` write that failed must not turn
    // a SUCCESSFUL profile extraction into a failed one — the nightly backfill repairs
    // the projection, and `db:verify:match-v1` fails the deploy gate if it did not.
    const h = setup({ signals: signals({ canonicalRoleId: ROLE_VMC }) });
    h.repo.reconcileReachForWorker.mockRejectedValueOnce(new Error("deadlock detected"));
    await expect(h.svc.rebuildQuietly(WORKER)).resolves.toBeUndefined();
  });

  it("swallows an EVENT failure too (the emit is the last thing that can throw)", async () => {
    const h = setup({ signals: signals({ canonicalRoleId: ROLE_VMC }) });
    h.events.emit.mockRejectedValueOnce(new Error("events table unreachable"));
    await expect(h.svc.rebuildQuietly(WORKER)).resolves.toBeUndefined();
  });

  it("still does the work — quiet means it does not throw, not that it skips the rebuild", async () => {
    const h = setup({ signals: signals({ canonicalRoleId: ROLE_VMC, totalYears: 5 }) });
    await h.svc.rebuildQuietly(WORKER);
    expect(h.writtenSkills()).toEqual([
      { skillId: "mskill_vmc_operator", industryId: MFG, monthsBucketed: 60 },
    ]);
    expect(h.repo.reconcileReachForWorker).toHaveBeenCalledTimes(1);
  });

  it("returns quietly for a worker with no profile", async () => {
    const h = setup({ signals: undefined });
    await expect(h.svc.rebuildQuietly(WORKER)).resolves.toBeUndefined();
    expect(h.events.emit).not.toHaveBeenCalled();
  });
});

describe("WorkerSkillsService.setWants — an unwired seam must FAIL, never no-op", () => {
  it("throws rather than silently accepting a wants change", async () => {
    // A silent no-op is the dangerous shape: the worker's toggle would appear to work
    // while `job_reach` kept showing him the job he just declined.
    const h = setup({ signals: signals() });
    await expect(h.svc.setWants(WORKER, "mskill_vmc_operator", false)).rejects.toThrow(
      /unwired seam/i,
    );
  });
});
