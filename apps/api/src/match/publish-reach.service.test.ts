import "reflect-metadata";
import { describe, it, expect, vi } from "vitest";
import { BadRequestException, NotFoundException } from "@nestjs/common";
import { DEFAULT_MATCH_CONFIG, type MatchConfig } from "@badabhai/match-engine";
import type { RequestContext } from "../common/request-context";
import { MatchSkillsService } from "./match-skills.service";
import { PublishReachService } from "./publish-reach.service";

/**
 * MOMENT ③ — "Company publishes" (ADR-0036 §1/§4, spec Part 6).
 *
 * The two properties worth pinning here are the ones that fail SILENTLY. A reach set
 * resolved wrongly still publishes, still charges, still serves a feed — it just serves
 * the wrong men, and nothing in the response tells anyone. So every assertion below is
 * on a VALUE that crossed the service boundary (what was persisted, what was handed to
 * the materializer, what landed on the event), never on "a collaborator was called".
 *
 * `MatchSkillsService` is deliberately the REAL one (wired to a stub config + repo).
 * `resolveForPublish` is where "match ∪ related ⊖ unticks" actually happens, and a
 * stubbed resolver would let this suite pass while the published reach set was garbage.
 * The stub boundary is drawn at the database, not inside the rule.
 */

const POSTING = "0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d";
const PAYER = "aaaaaaaa-0000-4000-8000-000000000001";
const OPS = "bbbbbbbb-0000-4000-8000-000000000002";
const CTX: RequestContext = {
  correlationId: "22222222-2222-4222-8222-222222222222",
  requestId: "req-1",
};

/** The spec's reference job: VMC Operator → HMC · CNC Setter-Operator · CNC Turner. */
const VMC = "mskill_vmc_operator";
const HMC = "mskill_hmc_operator";
const TURNER = "mskill_cnc_turner";
const SETTER = "mskill_cnc_setter_operator";
/** A real closed-set id that is NOT related to the VMC — an untick of it must do nothing. */
const PLUMBER = "mskill_plumber";
/** Sorted, because `resolveReachSet` sorts: reach expansion is byte-stable. */
const VMC_FULL_REACH = [SETTER, TURNER, HMC, VMC];

interface EmittedEvent {
  event_name: string;
  actor: Record<string, unknown>;
  subject: { subject_type: string; subject_id: string };
  payload: Record<string, unknown>;
  idempotencyKey?: string;
  correlationId?: string;
  requestId?: string;
}

type Counts = { total: number; tier1: number };
/** One `job_reach_widen` due-grant row as the repository returns it. */
interface DueGrantFixture {
  id: string;
  jobPostingId: string;
  addedSkillIds: string[];
  opsActorId: string;
}
type Existing = {
  matchSkillIds: string[];
  reachSkillIds: string[];
  publishedAt: Date | null;
  payerId: string | null;
  createdBy: string;
};

function posting(over: Partial<Existing> = {}): Existing {
  return {
    matchSkillIds: [VMC],
    reachSkillIds: VMC_FULL_REACH,
    publishedAt: null,
    payerId: PAYER,
    createdBy: PAYER,
    ...over,
  };
}

function setup(opts: {
  existing?: Existing | undefined;
  /** Successive `countReachForPosting` answers; the last one repeats. */
  counts?: Counts[];
  config?: Partial<MatchConfig>;
} = {}) {
  const cfg: MatchConfig = { ...DEFAULT_MATCH_CONFIG, ...opts.config };
  const countQueue = [...(opts.counts ?? [{ total: 10, tier1: 3 }])];

  const config = { get: vi.fn(async () => cfg) };
  const repo = {
    findPostingSkillSets: vi.fn(async () =>
      opts.existing === undefined && !("existing" in opts) ? posting() : opts.existing,
    ),
    setPostingSkillSets: vi.fn(
      async (
        _id: string,
        _match: readonly string[],
        _reach: readonly string[],
        _publishedAt: Date | null,
      ) => undefined,
    ),
    materializeReachForPosting: vi.fn(
      async (_id: string, _posted: readonly string[], _reach: readonly string[]) => undefined,
    ),
    countReachForPosting: vi.fn(async () =>
      countQueue.length > 1 ? (countQueue.shift() as Counts) : (countQueue[0] as Counts),
    ),
    countWorkersReachedBy: vi.fn(async () => 0),
  };
  const events = {
    emit: vi.fn(async (_p: EmittedEvent) => undefined),
    emitOnce: vi.fn(async (_p: EmittedEvent & { idempotencyKey?: string }) => undefined),
  };
  // Provenance store (migration 0090). Default: every insert succeeds, nothing is due.
  const widenRepo = {
    insertGrant: vi.fn(async (_g: unknown) => undefined),
    findDueBatch: vi.fn(async (_limit: number): Promise<DueGrantFixture[]> => []),
    countDue: vi.fn(async () => 0),
    activeIdsForPostings: vi.fn(
      async (_p: readonly string[], _x: readonly string[]) => new Set<string>(),
    ),
    statusForPostings: vi.fn(
      async (_ids: readonly string[]) => new Map<string, { status: string }>(),
    ),
    markRetracted: vi.fn(async (_ids: readonly string[]) => undefined),
  };

  const skills = new MatchSkillsService(config as never, repo as never);
  const svc = new PublishReachService(
    skills,
    repo as never,
    events as never,
    widenRepo as never,
    config as never,
  );

  return { svc, repo, events, cfg, widenRepo };
}

function emittedNames(events: ReturnType<typeof setup>["events"]): string[] {
  return events.emit.mock.calls.map(([p]) => p.event_name);
}

function emittedOne(
  events: ReturnType<typeof setup>["events"],
  name: string,
): EmittedEvent {
  const found = events.emit.mock.calls.map(([p]) => p).filter((p) => p.event_name === name);
  expect(found, `expected exactly one ${name}`).toHaveLength(1);
  return found[0] as EmittedEvent;
}

/** The `(id, matchSkillIds, reachSkillIds, publishedAt)` of the persist call. */
function persisted(repo: ReturnType<typeof setup>["repo"]) {
  const call = repo.setPostingSkillSets.mock.calls[0];
  expect(call, "setPostingSkillSets was never called").toBeTruthy();
  return call as [string, readonly string[], readonly string[], Date | null];
}

describe("materialize — the reach set is RESOLVED server-side, never accepted (Policy 10)", () => {
  it("publishes posted ∪ curated related as the reach set (the spec's VMC reference job)", async () => {
    const { svc, repo } = setup();
    const result = await svc.materialize(
      POSTING,
      { matchSkillIds: [VMC], untickedIds: [], trigger: "publish", actor: { actor_type: "payer", actor_id: PAYER } },
      CTX,
    );

    // The exact set, in the exact order the engine produces it. If the related
    // expansion silently stopped happening, this posting would reach only exact-skill
    // VMC men and the company would never learn it lost three quarters of its net.
    expect(result.reachSkillIds).toEqual(VMC_FULL_REACH);
    expect(result.matchSkillIds).toEqual([VMC]);
    expect(persisted(repo)[2]).toEqual(VMC_FULL_REACH);
  });

  it("HONOURS an untick that names a suggested related skill", async () => {
    const { svc, events } = setup();
    const result = await svc.materialize(
      POSTING,
      { matchSkillIds: [VMC], untickedIds: [HMC], trigger: "publish", actor: { actor_type: "payer", actor_id: PAYER } },
      CTX,
    );

    expect(result.reachSkillIds).toEqual([SETTER, TURNER, VMC]);
    expect(result.reachSkillIds).not.toContain(HMC);
    expect(result.appliedUntickedIds).toEqual([HMC]);
    // The audit trail the company's edit leaves behind.
    expect(emittedOne(events, "job_posting.reach_materialized").payload.unticked_count).toBe(1);
  });

  it("IGNORES an untick that names a POSTED skill — a company cannot exclude the trade it advertised", async () => {
    const { svc, repo } = setup();
    const result = await svc.materialize(
      POSTING,
      { matchSkillIds: [VMC], untickedIds: [VMC], trigger: "publish", actor: { actor_type: "payer", actor_id: PAYER } },
      CTX,
    );

    // Honouring this would publish a VMC job that is invisible to every VMC operator.
    expect(result.reachSkillIds).toContain(VMC);
    expect(result.reachSkillIds).toEqual(VMC_FULL_REACH);
    expect(result.appliedUntickedIds).toEqual([]);
    expect(persisted(repo)[2]).toContain(VMC);
  });

  it("IGNORES unticks outside the SUGGESTED set (an arbitrary client id changes nothing)", async () => {
    const { svc, events } = setup();
    const result = await svc.materialize(
      POSTING,
      {
        matchSkillIds: [VMC],
        // One valid-but-unsuggested closed-set id and one that is not an id at all.
        untickedIds: [PLUMBER, "mskill_nope"],
        trigger: "publish",
        actor: { actor_type: "payer", actor_id: PAYER },
      },
      CTX,
    );

    expect(result.reachSkillIds).toEqual(VMC_FULL_REACH);
    expect(result.appliedUntickedIds).toEqual([]);
    expect(emittedOne(events, "job_posting.reach_materialized").payload.unticked_count).toBe(0);
  });

  it("with related expansion configured OFF, the reach set is the posted skills alone", async () => {
    const { svc } = setup({ config: { relatedSkillsDefault: "off" } });
    const result = await svc.materialize(
      POSTING,
      { matchSkillIds: [VMC], untickedIds: [], trigger: "publish", actor: { actor_type: "payer", actor_id: PAYER } },
      CTX,
    );
    expect(result.reachSkillIds).toEqual([VMC]);
  });

  it("rejects an unknown skill id BEFORE anything is written or evented", async () => {
    const { svc, repo, events } = setup();
    await expect(
      svc.materialize(
        POSTING,
        { matchSkillIds: [VMC, "mskill_not_a_trade"], untickedIds: [], trigger: "publish", actor: { actor_type: "payer", actor_id: PAYER } },
        CTX,
      ),
    ).rejects.toBeInstanceOf(BadRequestException);

    expect(repo.setPostingSkillSets).not.toHaveBeenCalled();
    expect(repo.materializeReachForPosting).not.toHaveBeenCalled();
    expect(events.emit).not.toHaveBeenCalled();
  });

  it("404s on an unknown posting WITHOUT writing or eventing a reach set", async () => {
    const { svc, repo, events } = setup({ existing: undefined });
    await expect(
      svc.materialize(
        POSTING,
        { matchSkillIds: [VMC], untickedIds: [], trigger: "publish", actor: { actor_type: "payer", actor_id: PAYER } },
        CTX,
      ),
    ).rejects.toBeInstanceOf(NotFoundException);

    expect(repo.setPostingSkillSets).not.toHaveBeenCalled();
    expect(repo.materializeReachForPosting).not.toHaveBeenCalled();
    expect(events.emit).not.toHaveBeenCalled();
  });
});

describe("materialize — tier 1 is decided against the POSTED skills only (E6 best-tier-wins)", () => {
  it("hands the materializer the posted set and the reach set as SEPARATE arguments", async () => {
    const { svc, repo } = setup();
    await svc.materialize(
      POSTING,
      { matchSkillIds: [VMC], untickedIds: [], trigger: "publish", actor: { actor_type: "payer", actor_id: PAYER } },
      CTX,
    );

    // `MIN(CASE WHEN ws.skill_id = ANY(posted) THEN 1 ELSE 2 END)` is what makes a
    // worker who matches on two skills land at his BEST tier. It can only tell the
    // tiers apart if the posted set is a STRICT SUBSET of the reach set — pass the
    // reach set in both slots and every related-only man silently becomes tier 1,
    // every E18 "via related" badge becomes a lie, and the payer is sold exact-skill
    // supply that does not exist. Nothing else in the system would notice.
    expect(repo.materializeReachForPosting).toHaveBeenCalledWith(POSTING, [VMC], VMC_FULL_REACH);
    const [, posted, reach] = repo.materializeReachForPosting.mock.calls[0] as [
      string,
      readonly string[],
      readonly string[],
    ];
    expect(posted).not.toContain(TURNER);
    expect(posted).not.toContain(HMC);
    expect(posted.every((id) => reach.includes(id))).toBe(true);
    expect(posted.length).toBeLessThan(reach.length);
  });

  it("materializes AFTER persisting the sets, and counts AFTER materializing", async () => {
    const { svc, repo } = setup();
    await svc.materialize(
      POSTING,
      { matchSkillIds: [VMC], untickedIds: [], trigger: "publish", actor: { actor_type: "payer", actor_id: PAYER } },
      CTX,
    );

    // Counting before the materialize would emit — and alert on — the reach set of the
    // PREVIOUS publish, so E12/E13 would describe a posting that no longer exists.
    const persistedAt = repo.setPostingSkillSets.mock.invocationCallOrder[0] as number;
    const materializedAt = repo.materializeReachForPosting.mock.invocationCallOrder[0] as number;
    const countedAt = repo.countReachForPosting.mock.invocationCallOrder[0] as number;
    expect(persistedAt).toBeLessThan(materializedAt);
    expect(materializedAt).toBeLessThan(countedAt);
  });
});

describe("materialize — published_at is stamped on FIRST OPEN only (Policy 13)", () => {
  const publish = (svc: PublishReachService, trigger: "publish" | "unpause" | "edit" | "ops_widen") =>
    svc.materialize(
      POSTING,
      { matchSkillIds: [VMC], untickedIds: [], trigger, actor: { actor_type: "payer", actor_id: PAYER } },
      CTX,
    );

  it("stamps a date when a never-published posting is PUBLISHED", async () => {
    const { svc, repo } = setup({ existing: posting({ publishedAt: null }) });
    await publish(svc, "publish");
    expect(persisted(repo)[3]).toBeInstanceOf(Date);
  });

  it("does NOT restamp a posting that has already been published", async () => {
    const { svc, repo } = setup({
      existing: posting({ publishedAt: new Date("2026-01-01T00:00:00.000Z") }),
    });
    await publish(svc, "publish");
    // A restamp is a free boost: pause/resume your way back to the top of a
    // newest-first feed and the ₹999 SKU is worth nothing.
    expect(persisted(repo)[3]).toBeNull();
  });

  it("does NOT stamp on an unpause, even of a posting that was never published", async () => {
    const { svc, repo } = setup({ existing: posting({ publishedAt: null }) });
    await publish(svc, "unpause");
    expect(persisted(repo)[3]).toBeNull();
  });

  it("does NOT stamp on an edit", async () => {
    const { svc, repo } = setup({ existing: posting({ publishedAt: null }) });
    await publish(svc, "edit");
    expect(persisted(repo)[3]).toBeNull();
  });
});

describe("materialize — the audit event reports the set that just went live", () => {
  it("emits job_posting.reach_materialized with the resolved counts and the trigger", async () => {
    const { svc, events } = setup({ counts: [{ total: 10, tier1: 3 }] });
    await svc.materialize(
      POSTING,
      { matchSkillIds: [VMC], untickedIds: [HMC], trigger: "unpause", actor: { actor_type: "ops", actor_id: OPS } },
      CTX,
    );

    const ev = emittedOne(events, "job_posting.reach_materialized");
    expect(ev.payload).toEqual({
      job_posting_id: POSTING,
      match_skill_count: 1,
      reach_skill_count: 3, // VMC + setter + turner, HMC unticked
      unticked_count: 1,
      reach_total: 10,
      reach_tier1: 3,
      reach_tier2: 7, // total - tier1; a payer reads this as "exact vs adjacent supply"
      trigger: "unpause",
    });
    expect(ev.actor).toEqual({ actor_type: "ops", actor_id: OPS });
    expect(ev.subject).toEqual({ subject_type: "job_posting", subject_id: POSTING });
  });

  it("splits the tiers so tier1 + tier2 always equals the total", async () => {
    const { svc } = setup({ counts: [{ total: 7, tier1: 7 }] });
    const result = await svc.materialize(
      POSTING,
      { matchSkillIds: [VMC], untickedIds: [], trigger: "publish", actor: { actor_type: "payer", actor_id: PAYER } },
      CTX,
    );
    expect(result.reachTier1).toBe(7);
    expect(result.reachTier2).toBe(0);
    expect(result.reachTier1 + result.reachTier2).toBe(result.reachTotal);
  });

  it("carries ONLY opaque ids, closed-set counts and the trigger (§2: no PII rides the spine)", async () => {
    const { svc, events } = setup();
    await svc.materialize(
      POSTING,
      { matchSkillIds: [VMC], untickedIds: [], trigger: "publish", actor: { actor_type: "payer", actor_id: PAYER } },
      CTX,
    );
    // A future field (org_label, role_title, a contact) would break this line rather
    // than quietly reaching `audit_logs`.
    expect(Object.keys(emittedOne(events, "job_posting.reach_materialized").payload).sort()).toEqual([
      "job_posting_id",
      "match_skill_count",
      "reach_skill_count",
      "reach_tier1",
      "reach_tier2",
      "reach_total",
      "trigger",
      "unticked_count",
    ]);
  });
});

describe("materialize — the E12/E13 ops alert fires only when supply is actually short", () => {
  it("E13 — zero reach raises `zero_reach` and flags the result", async () => {
    const { svc, events } = setup({ counts: [{ total: 0, tier1: 0 }] });
    const result = await svc.materialize(
      POSTING,
      { matchSkillIds: [VMC], untickedIds: [], trigger: "publish", actor: { actor_type: "payer", actor_id: PAYER } },
      CTX,
    );

    expect(result.zeroReach).toBe(true);
    const alert = emittedOne(events, "job_posting.reach_alert");
    expect(alert.payload).toEqual({
      job_posting_id: POSTING,
      reason: "zero_reach",
      reach_total: 0,
      reach_tier1: 0,
      reach_skill_count: 4,
    });
    expect(alert.actor).toEqual({ actor_type: "system" });
    // Keyed, so republishing a still-empty posting does not spam the spine.
    expect(alert.idempotencyKey).toBe(`job_posting.reach_alert:${POSTING}:zero_reach`);
    // The audit event is still emitted — the alert is additional, not a replacement.
    expect(emittedNames(events)).toEqual([
      "job_posting.reach_materialized",
      "job_posting.reach_alert",
    ]);
  });

  it("E12 — reach that is entirely RELATED raises `no_tier1_reach`, not zero_reach", async () => {
    const { svc, events } = setup({ counts: [{ total: 5, tier1: 0 }] });
    const result = await svc.materialize(
      POSTING,
      { matchSkillIds: [VMC], untickedIds: [], trigger: "publish", actor: { actor_type: "payer", actor_id: PAYER } },
      CTX,
    );

    expect(result.zeroReach).toBe(false);
    const alert = emittedOne(events, "job_posting.reach_alert");
    expect(alert.payload.reason).toBe("no_tier1_reach");
    expect(alert.payload.reach_total).toBe(5);
    expect(alert.idempotencyKey).toBe(`job_posting.reach_alert:${POSTING}:no_tier1_reach`);
  });

  it("a HEALTHY posting raises NO alert at all", async () => {
    const { svc, events } = setup({ counts: [{ total: 5, tier1: 2 }] });
    await svc.materialize(
      POSTING,
      { matchSkillIds: [VMC], untickedIds: [], trigger: "publish", actor: { actor_type: "payer", actor_id: PAYER } },
      CTX,
    );
    // An alert that fires on every publish is an alert ops stops reading.
    expect(emittedNames(events)).toEqual(["job_posting.reach_materialized"]);
  });
});

describe("opsWiden — append-only, audited, and never a promotion to tier 1 (Policy 27)", () => {
  const widen = (svc: PublishReachService, add: string[]) => svc.opsWiden(POSTING, add, OPS, CTX);

  it("404s on an unknown posting without writing", async () => {
    const { svc, repo, events } = setup({ existing: undefined });
    await expect(widen(svc, [HMC])).rejects.toBeInstanceOf(NotFoundException);
    expect(repo.setPostingSkillSets).not.toHaveBeenCalled();
    expect(events.emit).not.toHaveBeenCalled();
  });

  it("rejects an unknown skill id without widening anything", async () => {
    const { svc, repo, events } = setup({ existing: posting({ reachSkillIds: [VMC] }) });
    await expect(widen(svc, [HMC, "mskill_not_a_trade"])).rejects.toBeInstanceOf(
      BadRequestException,
    );
    // All-or-nothing: the VALID id in the same request must not slip through.
    expect(repo.setPostingSkillSets).not.toHaveBeenCalled();
    expect(repo.materializeReachForPosting).not.toHaveBeenCalled();
    expect(events.emit).not.toHaveBeenCalled();
  });

  it("rejects a no-op widen rather than emitting an empty audit event", async () => {
    const { svc, repo, events } = setup({ existing: posting({ reachSkillIds: [VMC, HMC] }) });
    await expect(widen(svc, [HMC])).rejects.toBeInstanceOf(BadRequestException);
    expect(repo.setPostingSkillSets).not.toHaveBeenCalled();
    // `added_skill_ids` is `.min(1)` in the registry, so an empty widen would throw at
    // validation anyway — this refuses it with a readable 400 first.
    expect(events.emit).not.toHaveBeenCalled();
  });

  it("UNIONS the added ids into the reach set and removes nothing", async () => {
    const { svc, repo } = setup({
      existing: posting({ matchSkillIds: [VMC], reachSkillIds: [TURNER, VMC] }),
    });
    const result = await widen(svc, [HMC]);

    expect(result.reachSkillIds).toEqual([TURNER, HMC, VMC].sort());
    expect(result.reachSkillIds).toContain(TURNER); // the pre-existing ids survive
    expect(result.reachSkillIds).toContain(VMC);
    expect(persisted(repo)[2]).toEqual([TURNER, HMC, VMC].sort());
  });

  it("leaves the POSTED skills untouched, so a widened-in skill can only be tier 2 (E18)", async () => {
    const { svc, repo } = setup({
      existing: posting({ matchSkillIds: [VMC], reachSkillIds: [VMC] }),
    });
    await widen(svc, [HMC]);

    // If the widened id joined the POSTED set, an ops widen would silently mint tier-1
    // candidates and the "via related" badge would stop being honest.
    expect(persisted(repo)[1]).toEqual([VMC]);
    expect(repo.materializeReachForPosting).toHaveBeenCalledWith(POSTING, [VMC], [HMC, VMC]);
  });

  it("never restamps published_at on a widen", async () => {
    const { svc, repo } = setup({
      existing: posting({ reachSkillIds: [VMC], publishedAt: null }),
    });
    await widen(svc, [HMC]);
    expect(persisted(repo)[3]).toBeNull();
  });

  it("reports only the ids that were genuinely ADDED (dedup + already-present dropped)", async () => {
    const { svc, events } = setup({
      existing: posting({ matchSkillIds: [VMC], reachSkillIds: [TURNER, VMC] }),
    });
    await widen(svc, [HMC, HMC, TURNER]);

    const ev = emittedOne(events, "job_posting.reach_widened");
    // TURNER was already in the set and HMC was named twice: one new id, listed once.
    expect(ev.payload.added_skill_ids).toEqual([HMC]);
    expect(ev.actor).toEqual({ actor_type: "ops", actor_id: OPS });
  });

  it("records the reach counts BEFORE and AFTER the widen, in that order", async () => {
    const { svc, events } = setup({
      existing: posting({ matchSkillIds: [VMC], reachSkillIds: [VMC] }),
      counts: [
        { total: 5, tier1: 5 }, // before
        { total: 9, tier1: 5 }, // after
      ],
    });
    const result = await widen(svc, [HMC]);

    // Swap these two and "did widening this actually help?" becomes unanswerable — the
    // event would claim the widen SHRANK the reach.
    expect(emittedOne(events, "job_posting.reach_widened").payload).toEqual({
      job_posting_id: POSTING,
      added_skill_ids: [HMC],
      reach_before: 5,
      reach_after: 9,
    });
    // The RESULT reports the post-widen state, not the pre-widen one.
    expect(result.reachTotal).toBe(9);
    expect(result.reachTier2).toBe(4);
  });

  it("re-runs the supply alert after widening (a widen that still reaches nobody alerts)", async () => {
    const { svc, events } = setup({
      existing: posting({ matchSkillIds: [VMC], reachSkillIds: [VMC] }),
      counts: [
        { total: 0, tier1: 0 },
        { total: 0, tier1: 0 },
      ],
    });
    const result = await widen(svc, [HMC]);

    expect(result.zeroReach).toBe(true);
    expect(emittedOne(events, "job_posting.reach_alert").payload.reason).toBe("zero_reach");
  });

  it("a widen that fixed the supply raises NO alert", async () => {
    const { svc, events } = setup({
      existing: posting({ matchSkillIds: [VMC], reachSkillIds: [VMC] }),
      counts: [
        { total: 0, tier1: 0 },
        { total: 12, tier1: 4 },
      ],
    });
    await widen(svc, [HMC]);
    expect(emittedNames(events)).toEqual(["job_posting.reach_widened"]);
  });

  it("writes a PROVENANCE grant whose expiry is now + widenExpiryHours (Policy 27 'expiring')", async () => {
    const { svc, widenRepo } = setup({
      existing: posting({ matchSkillIds: [VMC], reachSkillIds: [VMC] }),
      config: { widenExpiryHours: 48 },
    });
    const beforeMs = Date.now();
    await widen(svc, [HMC]);

    expect(widenRepo.insertGrant).toHaveBeenCalledTimes(1);
    const grant = widenRepo.insertGrant.mock.calls[0]?.[0] as {
      jobPostingId: string;
      addedSkillIds: string[];
      expiresAt: Date;
      opsActorId: string;
    };
    // Only the GENUINELY ADDED ids go into the grant — an id already in the set has no
    // expiry to run out (it was there before any widen).
    expect(grant.addedSkillIds).toEqual([HMC]);
    expect(grant.jobPostingId).toBe(POSTING);
    expect(grant.opsActorId).toBe(OPS);
    const hours = (grant.expiresAt.getTime() - beforeMs) / 3_600_000;
    expect(hours).toBeGreaterThanOrEqual(47.9);
    expect(hours).toBeLessThanOrEqual(48.1);
  });

  it("a FAILED provenance write never undoes the widen (fail toward more reach)", async () => {
    const { svc, repo } = setup({
      existing: posting({ matchSkillIds: [VMC], reachSkillIds: [VMC] }),
    });
    // Provenance store down: the widen itself already committed. Retrying ops would
    // re-widen; the pre-0090 posture ("never expires") is the safe degradation.
    (svc as unknown as { widenRepo: { insertGrant: () => Promise<void> } }).widenRepo.insertGrant =
      async () => {
        throw new Error("provenance store down");
      };
    await expect(widen(svc, [HMC])).rejects.toThrow("provenance store down");
    expect(repo.setPostingSkillSets).toHaveBeenCalledTimes(1);
  });
});

describe("retractExpiredWidens — Policy 27's expiring leg, pure subtraction", () => {
  const DUE = {
    id: "aaaaaaaa-0000-4000-8000-000000000001",
    jobPostingId: POSTING,
    addedSkillIds: [HMC],
    opsActorId: OPS,
  };

  function dueSetup(opts: {
    existing: Existing;
    due?: Array<{ id: string; addedSkillIds: string[]; jobPostingId?: string }>;
    activeIds?: Set<string>;
    statuses?: Map<string, { status: string }>;
    counts?: Counts[];
  }) {
    const s = setup({ existing: opts.existing, counts: opts.counts });
    const dueRows = (opts.due ?? [{ id: DUE.id, addedSkillIds: [HMC] }]).map((r) => ({
      id: r.id,
      jobPostingId: r.jobPostingId ?? POSTING,
      addedSkillIds: r.addedSkillIds,
      opsActorId: OPS,
    }));
    s.widenRepo.findDueBatch.mockResolvedValue(dueRows);
    s.widenRepo.activeIdsForPostings.mockResolvedValue(opts.activeIds ?? new Set<string>());
    s.widenRepo.statusForPostings.mockResolvedValue(
      opts.statuses ?? new Map([[POSTING, { status: "open" }]]),
    );
    return { ...s, dueRows };
  }

  it("retracts exactly the expired id from the stored set and re-materializes", async () => {
    const t = dueSetup({
      existing: posting({ matchSkillIds: [VMC], reachSkillIds: [VMC, HMC].sort() }),
      counts: [
        { total: 7, tier1: 5 }, // before
        { total: 5, tier1: 5 }, // after
      ],
    });
    const summary = await t.svc.retractExpiredWidens(100);

    expect(summary).toEqual({ grantsRetracted: 1, postingsShrunk: 1, postingsSkippedNotLive: 0 });
    // The posted skill SURVIVES; only the widened one leaves.
    expect(t.repo.setPostingSkillSets.mock.calls[0]?.slice(1, 3)).toEqual([
      [VMC],
      [VMC],
    ]);
    expect(t.widenRepo.markRetracted).toHaveBeenCalledWith([DUE.id]);
  });

  it("emits reach_widen_expired with actor system and stable keyed idempotency", async () => {
    const t = dueSetup({
      existing: posting({ matchSkillIds: [VMC], reachSkillIds: [VMC, HMC] }),
    });
    await t.svc.retractExpiredWidens(100);

    const calls = t.events.emitOnce.mock.calls.map(([p]) => p);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.event_name).toBe("job_posting.reach_widen_expired");
    expect(calls[0]?.actor).toEqual({ actor_type: "system", actor_id: null });
    expect(calls[0]?.payload.expired_skill_ids).toEqual([HMC]);
    expect(calls[0]?.payload.reach_before).toBe(10); // default count stub
    expect(calls[0]?.payload.reach_after).toBe(10);
    expect(String(calls[0]?.idempotencyKey)).toContain(DUE.id);
  });

  it("NEVER removes a posted skill even when a due grant names it", async () => {
    const t = dueSetup({
      existing: posting({ matchSkillIds: [VMC], reachSkillIds: [VMC, HMC] }),
      due: [{ id: DUE.id, addedSkillIds: [HMC, VMC] }],
    });
    await t.svc.retractExpiredWidens(100);

    const persistedReach = t.repo.setPostingSkillSets.mock.calls[0]?.[2];
    expect(persistedReach).toEqual([VMC]);
  });

  it("an id held by a STILL-ACTIVE newer grant survives the older row's expiry", async () => {
    const t = dueSetup({
      existing: posting({ matchSkillIds: [VMC], reachSkillIds: [VMC, HMC] }),
      activeIds: new Set([HMC]),
    });
    const summary = await t.svc.retractExpiredWidens(100);

    // Nothing left to remove → no shrink, no event; the row is still stamped so the
    // sweep stops seeing it.
    expect(summary.postingsShrunk).toBe(0);
    expect(summary.grantsRetracted).toBe(1);
    expect(t.repo.setPostingSkillSets).not.toHaveBeenCalled();
    expect(t.events.emitOnce).not.toHaveBeenCalled();
  });

  it("a non-live posting gets its provenance stamped WITHOUT touching its sets", async () => {
    const t = dueSetup({
      existing: posting({ matchSkillIds: [VMC], reachSkillIds: [VMC, HMC] }),
      statuses: new Map([[POSTING, { status: "closed" }]]),
    });
    const summary = await t.svc.retractExpiredWidens(100);

    expect(summary).toEqual({
      grantsRetracted: 1,
      postingsShrunk: 0,
      postingsSkippedNotLive: 1,
    });
    expect(t.repo.setPostingSkillSets).not.toHaveBeenCalled();
    expect(t.events.emitOnce).not.toHaveBeenCalled();
  });

  it("an id NOT in the current reach set is dropped silently (already re-materialized away)", async () => {
    const t = dueSetup({
      existing: posting({ matchSkillIds: [VMC], reachSkillIds: [VMC] }),
    });
    const summary = await t.svc.retractExpiredWidens(100);

    // A publish/unpause between widen and expiry already rebuilt the set without HMC;
    // subtracting nothing must not emit a lying "reach shrank" event.
    expect(summary.postingsShrunk).toBe(0);
    expect(t.events.emitOnce).not.toHaveBeenCalled();
  });

  it("re-checks the supply alert after shrinking (expiry can unmask an unsupplied trade)", async () => {
    const t = dueSetup({
      existing: posting({ matchSkillIds: [VMC], reachSkillIds: [VMC, HMC] }),
      counts: [
        { total: 6, tier1: 0 }, // before
        { total: 0, tier1: 0 }, // after — the widen was masking zero base supply
      ],
    });
    await t.svc.retractExpiredWidens(100);

    const alerts = t.events.emit.mock.calls
      .map(([p]) => p)
      .filter((p) => p.event_name === "job_posting.reach_alert");
    expect(alerts).toHaveLength(1);
    expect(alerts[0]?.payload.reason).toBe("zero_reach");
  });
});
