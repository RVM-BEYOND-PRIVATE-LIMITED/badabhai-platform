import { describe, it, expect, vi, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  BadRequestException,
  ConflictException,
  InternalServerErrorException,
  NotFoundException,
} from "@nestjs/common";
import { createEvent, type CreateEventInput } from "@badabhai/event-schema";
import { statusForDecision } from "@badabhai/db";
import type { SkillCandidateStatus } from "@badabhai/db";
import type { RequestContext } from "../common/request-context";
import type { EventsService } from "../events/events.service";
import { ADMIN_ACTION_CODES } from "./admin-actions.service";
import type { AdminSkillDiscoveryRepository } from "./admin-skill-discovery.repository";
import type {
  AdminSkillCandidateDetailRow,
  AdminSkillDiscoveryQueueRow,
} from "./admin-skill-discovery.repository";
import { ADMIN_SKILL_GROUPS_MAX_CANDIDATES } from "./admin-skill-discovery.dto";
import type {
  AdminSkillCandidateMatchRow,
  AdminSkillCandidateSource,
  AdminSkillDecisionDto,
  AdminSkillDiscoveryDetail,
  AdminSkillDiscoveryListItem,
} from "./admin-skill-discovery.dto";
import { AdminSkillDiscoveryService } from "./admin-skill-discovery.service";

/**
 * The decision path's SAFETY BRANCHES, each with the failure it prevents — plus the reads,
 * because two of the invariants (the similarity score never reaching the wire, the alias preview
 * being the corpus converter's own answer) live on the read side.
 *
 * NO DATABASE. Every collaborator is a fake, and the repository fake is deliberately a PROXY that
 * throws on any member the port does not have: that is how "no code path writes a `skill`, a
 * `skill_alias` or a `job_domain_skill`" is tested as a property of the code rather than asserted
 * as a hope. A service that grew a `this.repo.mintSkill(...)` call would fail every test in this
 * file at once, not just a dedicated one.
 */

const CANDIDATE_ID = "11111111-1111-4111-8111-111111111111";
const ADMIN_ID = "22222222-2222-4222-8222-222222222222";
/** A DIFFERENT admin from {@link ADMIN_ID} — the one who decided a row somebody else then retries. */
const FIRST_REVIEWER = "44444444-4444-4444-8444-444444444444";
const CTX: RequestContext = {
  requestId: "req-1",
  correlationId: "33333333-3333-4333-8333-333333333333",
};
const TARGET_SKILL = "skill_arc_welding";
const OTHER_SKILL = "skill_gas_welding";

/** Three candidates that batch into two groups — one pair on a shared anchor, one singleton. */
const GROUPING_FACTS = [
  {
    candidate_id: "c1",
    evidence_tokens: ["wood", "turn"],
    trade_family: "Craft",
    phrase_class: "OCCUPATION_WITH_SKILL_EVIDENCE",
    has_strong_match: false,
    source_alias_count: 2,
    job_domain_ids: ["jd_1", "jd_2"],
    proposed_action: "create",
    status: "pending",
  },
  {
    candidate_id: "c2",
    evidence_tokens: ["wood", "saw"],
    trade_family: "Craft",
    phrase_class: "OCCUPATION_WITH_SKILL_EVIDENCE",
    has_strong_match: false,
    source_alias_count: 1,
    // Overlaps c1 on jd_2 — the union must not double-count it.
    job_domain_ids: ["jd_2", "jd_3"],
    proposed_action: "create",
    status: "approved_create",
  },
  {
    candidate_id: "c3",
    evidence_tokens: ["metal"],
    trade_family: "Plant",
    phrase_class: "ACTIVITY_PHRASE",
    has_strong_match: false,
    source_alias_count: 1,
    job_domain_ids: ["jd_9"],
    proposed_action: "create",
    status: "needs_review",
  },
];

const AUDIT_EVENTS = [
  {
    event_id: "11111111-1111-4111-8111-00000000000a",
    occurred_at: new Date("2026-08-26T13:00:00.000Z"),
    action_code: "skill_candidate_approved_create",
    admin_id: ADMIN_ID,
  },
];

const CORPUS_SKILLS = [
  { skill_id: "skill_arc_welding", label_en: "Arc Welding", status: "active", kind: "attribute" },
  { skill_id: "skill_old_welding", label_en: "Old Welding", status: "deprecated", kind: "attribute" },
  { skill_id: "mskill_welder", label_en: "Welder", status: "active", kind: "match_skill" },
];

/** A fake `tx` token the mocked withTransaction hands to the callback. */
const FAKE_TX = { __tx: true } as unknown;

const SOURCES: AdminSkillCandidateSource[] = [
  {
    source_type: "job_domain_alias",
    source_id: "a1",
    original_text: "Arc Welding",
    normalized_text: "arc welding",
    job_domain_id: "jd_nco_7212_0100",
  },
  {
    source_type: "worker_phrase",
    source_id: "w1",
    original_text: "arc welder work",
    normalized_text: "arc welder work",
    job_domain_id: null,
  },
];

const MATCHES: AdminSkillCandidateMatchRow[] = [
  {
    skill_id: OTHER_SKILL,
    skill_label: "Gas Welding",
    relation: "high_token_overlap",
    score: 0.87,
    strength: "weak",
    rank: 1,
    evidence_detail: null,
  },
];

function detailRow(over: Partial<AdminSkillCandidateDetailRow> = {}): AdminSkillCandidateDetailRow {
  return {
    id: CANDIDATE_ID,
    run_id: "sdr_20260826T120000Z_nightly",
    cluster_key: "arc welding",
    normalized_phrase: "arc welding",
    proposed_skill_name: "Arc Welding",
    phrase_class: "ACTIVITY_PHRASE",
    trade_family: "welding",
    source_alias_count: 2,
    source_domain_count: 1,
    proposed_action: "create",
    confidence_band: "medium",
    status: "needs_review",
    reviewer_admin_id: null,
    reviewed_at: null,
    resulting_skill_id: null,
    created_at: new Date("2026-08-26T12:00:00.000Z"),
    updated_at: new Date("2026-08-26T12:00:00.000Z"),
    proposed_description: null,
    review_reason: null,
    classifier_rule: "ACTIVITY_HEADED",
    occupation_heads: [],
    evidence_tokens: ["welding"],
    embedding_status: "not_required",
    model: null,
    prompt_version: null,
    corpus_fingerprint: "cf_0001",
    provenance_digest: "0123456789abcdef0123456789abcdef",
    confidence: null,
    approved_job_domain_ids: [],
    approved_requirement: "preferred",
    created_at_iso: "2026-08-26T12:00:00.000600Z",
    ...over,
  };
}

// ── the five decision bodies ─────────────────────────────────────────────────────────────

const CREATE: AdminSkillDecisionDto = {
  decision: "create",
  expected_status: "needs_review",
  review_reason: "names a real competency, not a job title",
  proposed_skill_name: "Arc Welding",
  approved_job_domain_ids: ["jd_nco_7212_0100"],
  approved_requirement: "preferred",
};
const ALIAS: AdminSkillDecisionDto = {
  decision: "alias",
  expected_status: "needs_review",
  review_reason: "same competency, another spelling",
  resulting_skill_id: TARGET_SKILL,
};
const MERGE: AdminSkillDecisionDto = {
  decision: "merge",
  expected_status: "needs_review",
  review_reason: "duplicate of an existing skill",
  resulting_skill_id: TARGET_SKILL,
};
const REJECT: AdminSkillDecisionDto = {
  decision: "reject",
  expected_status: "needs_review",
  review_reason: "seniority marker, not a competency",
};
const HOLD: AdminSkillDecisionDto = {
  decision: "hold",
  expected_status: "needs_review",
  review_reason: "needs a ruling on scope first",
};

// ── the fakes ────────────────────────────────────────────────────────────────────────────

/**
 * EVERY member of the repository this service is allowed to touch. The list is the contract: a
 * `skill` writer, an alias writer or a `job_domain_skill` writer is not on it, so reaching for
 * one throws with the name of the member that was reached for.
 */
const ALLOWED_REPO_MEMBERS = new Set<string>([
  "list",
  "matchFactsFor",
  "findCandidate",
  "listSources",
  "listMatches",
  "metricFacts",
  // The grouping read and its bound. `countMatching` runs FIRST so an over-broad filter is
  // refused with a number instead of answered with tens of thousands of rows.
  "countMatching",
  "groupingFacts",
  // The audit read (the event spine) and the MAP picker's lookup. Both SELECTs.
  "listAuditEvents",
  "searchCorpusSkills",
  "findCorpusSkill",
  // Reads `job_domain` to resolve the trades a `create` decision names. A READ, and the second
  // of the two tables outside migration 0093 this surface may touch — an array column cannot
  // carry a foreign key, so nothing in the schema refuses a `jd_` id that names no domain.
  "findLiveJobDomainIds",
  "findStatus",
  "advanceToNeedsReview",
  "recordDecision",
  "withTransaction",
]);

interface RepoFake {
  list: ReturnType<typeof vi.fn>;
  matchFactsFor: ReturnType<typeof vi.fn>;
  findCandidate: ReturnType<typeof vi.fn>;
  listSources: ReturnType<typeof vi.fn>;
  listMatches: ReturnType<typeof vi.fn>;
  metricFacts: ReturnType<typeof vi.fn>;
  countMatching: ReturnType<typeof vi.fn>;
  groupingFacts: ReturnType<typeof vi.fn>;
  listAuditEvents: ReturnType<typeof vi.fn>;
  searchCorpusSkills: ReturnType<typeof vi.fn>;
  findCorpusSkill: ReturnType<typeof vi.fn>;
  findLiveJobDomainIds: ReturnType<typeof vi.fn>;
  findStatus: ReturnType<typeof vi.fn>;
  advanceToNeedsReview: ReturnType<typeof vi.fn>;
  recordDecision: ReturnType<typeof vi.fn>;
  withTransaction: ReturnType<typeof vi.fn>;
}

interface Mocks {
  repo: RepoFake;
  events: { emit: ReturnType<typeof vi.fn> };
  service: AdminSkillDiscoveryService;
  /** The un-proxied fake, for tests that need to prove the guard itself can fail. */
  guarded: AdminSkillDiscoveryRepository;
}

function make(): Mocks {
  const repo: RepoFake = {
    list: vi.fn(async () => [] as AdminSkillDiscoveryQueueRow[]),
    matchFactsFor: vi.fn(async () => []),
    findCandidate: vi.fn(async () => detailRow()),
    listSources: vi.fn(async () => SOURCES),
    listMatches: vi.fn(async () => MATCHES),
    metricFacts: vi.fn(async () => ({
      by_status: [],
      by_band: [],
      by_proposed_action: [],
      by_phrase_class: [],
      oldest_awaiting_created_at: null,
    })),
    countMatching: vi.fn(async () => 3),
    groupingFacts: vi.fn(async () => GROUPING_FACTS),
    listAuditEvents: vi.fn(async () => AUDIT_EVENTS),
    searchCorpusSkills: vi.fn(async () => CORPUS_SKILLS),
    findCorpusSkill: vi.fn(async () => ({
      skill_id: TARGET_SKILL,
      status: "active" as const,
      kind: "attribute" as const,
    })),
    // Resolves whatever it is asked for by default, so the ordinary path is not about domains.
    // The tests that care override it — including with an EMPTY set, which is what a `jd_` typo
    // actually looks like from here.
    findLiveJobDomainIds: vi.fn(async (ids: readonly string[]) => new Set(ids)),
    findStatus: vi.fn(async () => ({ candidate_id: CANDIDATE_ID, status: "needs_review" as const })),
    advanceToNeedsReview: vi.fn(async () => ({ status: "needs_review" as const })),
    recordDecision: vi.fn(async (write: { nextStatus: SkillCandidateStatus }) => ({
      status: write.nextStatus,
    })),
    withTransaction: vi.fn(async (cb: (tx: unknown) => Promise<unknown>) => cb(FAKE_TX)),
  };
  const guarded = new Proxy(repo, {
    get(target, prop, receiver): unknown {
      if (typeof prop === "string" && !ALLOWED_REPO_MEMBERS.has(prop)) {
        throw new Error(
          `the service reached for repository member "${prop}" — the decision path may only read and write skill_candidate`,
        );
      }
      return Reflect.get(target, prop, receiver) as unknown;
    },
  }) as unknown as AdminSkillDiscoveryRepository;
  const events = { emit: vi.fn(async () => undefined) };
  const service = new AdminSkillDiscoveryService(guarded, events as unknown as EventsService);
  return { repo, events, service, guarded };
}

/** The emit params the service passed to EventsService.emit. */
interface CapturedEmit {
  event_name: "admin.action_performed";
  actor: { actor_type: string; actor_id: string };
  subject: { subject_type: string; subject_id: string | null };
  payload: Record<string, unknown>;
  correlationId: string;
  requestId: string;
  idempotencyKey: string;
  tx?: unknown;
}

function soleEmit(events: Mocks["events"]): CapturedEmit {
  expect(events.emit).toHaveBeenCalledTimes(1);
  return events.emit.mock.calls[0]![0] as CapturedEmit;
}

/** Recursively walk every primitive leaf of a value (for the no-value scan). */
function leaves(value: unknown, out: string[] = []): string[] {
  if (value === null || value === undefined) return out;
  if (typeof value === "object") {
    for (const v of Object.values(value as Record<string, unknown>)) leaves(v, out);
  } else {
    out.push(String(value));
  }
  return out;
}

/**
 * Every VALUE a review decision must keep OFF the spine. The reason text, the proposed label, the
 * mapping target and the resulting status are all facts about the decision — they live on the
 * `skill_candidate` row, and `admin.action_performed` carries the CODE plus two opaque ids.
 */
const FORBIDDEN_VALUE_FRAGMENTS = [
  "names a real competency",
  "same competency",
  "duplicate of an existing skill",
  "seniority marker",
  "needs a ruling",
  "Arc Welding",
  "arc welding",
  TARGET_SKILL,
  "jd_nco_7212_0100",
  "medium",
  "ACTIVITY_PHRASE",
];

let m: Mocks;
beforeEach(() => {
  m = make();
});

// ═════════════════════════════════════════════════════════════════════════════════════════
// The guard that makes every other assertion in this file mean something
// ═════════════════════════════════════════════════════════════════════════════════════════

describe("the repository guard is CAPABLE of failing", () => {
  it("throws when anything reaches for a member outside the allowed set", () => {
    const { guarded } = make();
    expect(() =>
      (guarded as unknown as { mintSkill: () => void }).mintSkill(),
    ).toThrowError(/mintSkill/);
  });

  it("does not throw for a member the service is allowed to use", () => {
    const { guarded } = make();
    expect(typeof (guarded as unknown as { recordDecision: unknown }).recordDecision).toBe(
      "function",
    );
  });
});

describe("no code path writes skill / skill_alias / job_domain_skill", () => {
  it("every decision kind completes without reaching for a corpus writer", async () => {
    for (const dto of [CREATE, ALIAS, MERGE, REJECT, HOLD]) {
      const local = make();
      const out = await local.service.decide(ADMIN_ID, CANDIDATE_ID, dto, CTX);
      expect(out.changed).toBe(true);
      // The result SAYS the taxonomy did not change, in a literal a client cannot widen.
      expect(out.corpus_effect).toBe("decision_recorded_no_corpus_write");
      expect(out.next_step).toBe("awaiting_offline_corpus_chain");
    }
  });

  it("an approved_create records the decision and writes NO resulting_skill_id", async () => {
    await m.service.decide(ADMIN_ID, CANDIDATE_ID, CREATE, CTX);
    const write = m.repo.recordDecision.mock.calls[0]![0] as Record<string, unknown>;
    expect(write.nextStatus).toBe("approved_create");
    // The column stays NULL until the OFFLINE chain mints the skill and somebody backfills it —
    // which is what makes it the honest answer to "did this approval ever ship?".
    expect(write).not.toHaveProperty("resultingSkillId");
    // The reviewer's trade judgement is RECORDED on the candidate row; no edge is written.
    expect(write.approvedJobDomainIds).toEqual(["jd_nco_7212_0100"]);
    expect(write.approvedRequirement).toBe("preferred");
  });

  it("the service source names no corpus table and issues no write of its own", () => {
    const src = readFileSync(join(__dirname, "admin-skill-discovery.service.ts"), "utf8");
    const code = src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
    // The scan is on the COMMENT-STRIPPED source, because the header argues about these very
    // names in prose. A regression would be a call, not a sentence.
    for (const forbidden of [
      "skillAliases",
      "jobDomainSkills",
      "skill_alias",
      "job_domain_skill",
      ".insert(",
      ".delete(",
      ".update(",
      "drizzle-orm",
    ]) {
      expect(code, `${forbidden} must not appear in the service`).not.toContain(forbidden);
    }
  });
});

// ═════════════════════════════════════════════════════════════════════════════════════════
// A decision must name a reason
// ═════════════════════════════════════════════════════════════════════════════════════════

describe("every decision records WHY", () => {
  it("refuses a whitespace-only reason with a 400, before any read or write", async () => {
    await expect(
      m.service.decide(ADMIN_ID, CANDIDATE_ID, { ...REJECT, review_reason: "   " }, CTX),
    ).rejects.toBeInstanceOf(BadRequestException);
    // `skill_candidate_reviewed_chk` would have ACCEPTED this row (it only demands NOT NULL);
    // `validateCandidate` calls it DECISION_WITHOUT_REVIEWER. The database keeping a row the
    // corpus layer refuses is the failure this branch prevents.
    expect(m.repo.findStatus).not.toHaveBeenCalled();
    expect(m.repo.withTransaction).not.toHaveBeenCalled();
    expect(m.events.emit).not.toHaveBeenCalled();
  });

  it("writes the reviewer, the moment and the reason together, and takes none of them from the body", async () => {
    const before = Date.now();
    await m.service.decide(ADMIN_ID, CANDIDATE_ID, REJECT, CTX);
    const write = m.repo.recordDecision.mock.calls[0]![0] as Record<string, unknown>;
    expect(write.reviewerAdminId).toBe(ADMIN_ID);
    expect(write.reviewReason).toBe("seniority marker, not a competency");
    expect(write.reviewedAt).toBeInstanceOf(Date);
    // The SERVER clock: an actor — or a moment — a caller can type is not one.
    expect((write.reviewedAt as Date).getTime()).toBeGreaterThanOrEqual(before);
  });

  it("trims the reason rather than storing the caller's padding", async () => {
    await m.service.decide(
      ADMIN_ID,
      CANDIDATE_ID,
      { ...REJECT, review_reason: "  seniority marker, not a competency  " },
      CTX,
    );
    const write = m.repo.recordDecision.mock.calls[0]![0] as Record<string, unknown>;
    expect(write.reviewReason).toBe("seniority marker, not a competency");
  });
});

// ═════════════════════════════════════════════════════════════════════════════════════════
// The match-skill wall
// ═════════════════════════════════════════════════════════════════════════════════════════

describe("mskill_* can never be a decision target", () => {
  const walled = [
    ["the bare prefix", "mskill_arc_welding"],
    ["the prefix in another case", "MSKILL_ARC_WELDING"],
    ["a match-skill label in corpus-id clothing", "skill_mskill_arc_welding"],
  ] as const;

  for (const [why, id] of walled) {
    it(`refuses ${why} on an alias, with a 400 and no transaction`, async () => {
      const local = make();
      await expect(
        local.service.decide(ADMIN_ID, CANDIDATE_ID, { ...ALIAS, resulting_skill_id: id }, CTX),
      ).rejects.toBeInstanceOf(BadRequestException);
      // Refused AT THE PIPE-equivalent, before a transaction is opened. The alternative is a
      // CHECK violation arriving as a 500, mid-decision, naming a constraint.
      expect(local.repo.withTransaction).not.toHaveBeenCalled();
      expect(local.events.emit).not.toHaveBeenCalled();
    });

    it(`refuses ${why} on a merge too`, async () => {
      const local = make();
      await expect(
        local.service.decide(ADMIN_ID, CANDIDATE_ID, { ...MERGE, resulting_skill_id: id }, CTX),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(local.repo.recordDecision).not.toHaveBeenCalled();
    });
  }

  it("refuses a target whose stored kind is match_skill, even when the id looks ordinary", async () => {
    m.repo.findCorpusSkill.mockResolvedValueOnce({
      skill_id: TARGET_SKILL,
      status: "active",
      kind: "match_skill",
    });
    await expect(m.service.decide(ADMIN_ID, CANDIDATE_ID, ALIAS, CTX)).rejects.toBeInstanceOf(
      BadRequestException,
    );
    // THE LAST WALL: the three id-shaped refusals all look at the STRING. This one looks at the
    // row, and is the only one that still holds for a match skill renamed out of the prefix
    // convention AND out of MATCH_SKILLS.
    expect(m.repo.withTransaction).not.toHaveBeenCalled();
  });
});

// ═════════════════════════════════════════════════════════════════════════════════════════
// The mapping target must exist and be live
// ═════════════════════════════════════════════════════════════════════════════════════════

describe("alias / merge verify the target skill", () => {
  it("refuses a target that is not in the corpus", async () => {
    m.repo.findCorpusSkill.mockResolvedValueOnce(undefined);
    await expect(m.service.decide(ADMIN_ID, CANDIDATE_ID, ALIAS, CTX)).rejects.toBeInstanceOf(
      BadRequestException,
    );
    // Without this read the FK fails from inside an open transaction, and a well-formed id for a
    // skill that does not exist reads as a constraint name rather than as a fix.
    expect(m.repo.recordDecision).not.toHaveBeenCalled();
  });

  it("refuses a deprecated target", async () => {
    m.repo.findCorpusSkill.mockResolvedValueOnce({
      skill_id: TARGET_SKILL,
      status: "deprecated",
      kind: "attribute",
    });
    await expect(m.service.decide(ADMIN_ID, CANDIDATE_ID, MERGE, CTX)).rejects.toBeInstanceOf(
      BadRequestException,
    );
    expect(m.repo.withTransaction).not.toHaveBeenCalled();
  });

  it("accepts a live attribute skill and records it as the resolution", async () => {
    const out = await m.service.decide(ADMIN_ID, CANDIDATE_ID, ALIAS, CTX);
    const write = m.repo.recordDecision.mock.calls[0]![0] as Record<string, unknown>;
    expect(write.resultingSkillId).toBe(TARGET_SKILL);
    // An alias has no opinion about the label the run proposed; blanking it would destroy
    // information the next run's reviewer might want.
    expect(write).not.toHaveProperty("proposedSkillName");
    expect(out.status).toBe("approved_map");
  });

  it("a reject or a hold names no target at all", async () => {
    for (const dto of [REJECT, HOLD]) {
      const local = make();
      await local.service.decide(ADMIN_ID, CANDIDATE_ID, dto, CTX);
      const write = local.repo.recordDecision.mock.calls[0]![0] as Record<string, unknown>;
      expect(write).not.toHaveProperty("resultingSkillId");
      expect(write).not.toHaveProperty("proposedSkillName");
      // A rejection that names a resulting skill is not a rejection, and the row would fail
      // validateCandidate on the next pass.
      expect(local.repo.findCorpusSkill).not.toHaveBeenCalled();
    }
  });
});

// ═════════════════════════════════════════════════════════════════════════════════════════
// The ladder — canTransition is the ONLY enforcement
// ═════════════════════════════════════════════════════════════════════════════════════════

describe("a CREATE must name trades that actually exist", () => {
  // `approved_job_domain_ids` is `text[]`, and Postgres cannot put a foreign key on an array
  // element. So NOTHING in migration 0093 refuses an id that names no domain:
  // `skill_candidate_create_domain_chk` counts the array and stops, and the DTO checks the SHAPE
  // (`jd_` + charset) because shape is all a schema can see. A plausible typo therefore passes
  // the pipe, passes the CHECK, and is recorded as a decision — surfacing weeks later as an FK
  // violation halfway through a seed, naming a constraint instead of a fix.
  //
  // This block is the only thing standing between those two moments.

  it("resolves every named trade against job_domain before opening a transaction", async () => {
    await m.service.decide(ADMIN_ID, CANDIDATE_ID, CREATE, CTX);
    expect(m.repo.findLiveJobDomainIds).toHaveBeenCalledWith(CREATE.approved_job_domain_ids);
    // BEFORE, not inside: the answer cannot change the ladder, and finding out mid-transaction
    // means a 500 naming a constraint rather than a 400 naming the field.
    const resolveOrder = m.repo.findLiveJobDomainIds.mock.invocationCallOrder[0] ?? 0;
    const txOrder = m.repo.withTransaction.mock.invocationCallOrder[0] ?? Number.MAX_SAFE_INTEGER;
    expect(resolveOrder).toBeLessThan(txOrder);
  });

  it("400s a well-formed id that names no domain, and NAMES the id", async () => {
    m.repo.findLiveJobDomainIds.mockResolvedValueOnce(new Set<string>());
    const err = await m.service
      .decide(ADMIN_ID, CANDIDATE_ID, CREATE, CTX)
      .catch((e: unknown) => e);
    expect((err as { status?: number }).status).toBe(400);
    // Echoing the reviewer's own input back is not a disclosure — no skill, no worker, nothing
    // but what they just typed — and a bare "one or more trades are invalid" makes them re-check
    // twenty tick-boxes by hand.
    expect(String((err as Error).message)).toContain(CREATE.approved_job_domain_ids[0] as string);
    expect(m.repo.withTransaction).not.toHaveBeenCalled();
    expect(m.repo.recordDecision).not.toHaveBeenCalled();
    expect(m.events.emit).not.toHaveBeenCalled();
  });

  it("refuses the whole decision when only SOME of the trades resolve", async () => {
    // Partial acceptance would silently drop a trade the reviewer deliberately ticked, and the
    // skill would ship attached to fewer pickers than the human approved.
    const body = { ...CREATE, approved_job_domain_ids: ["jd_nco_7212_0100", "jd_typo_here"] };
    m.repo.findLiveJobDomainIds.mockResolvedValueOnce(new Set(["jd_nco_7212_0100"]));
    const err = await m.service.decide(ADMIN_ID, CANDIDATE_ID, body, CTX).catch((e: unknown) => e);
    expect((err as { status?: number }).status).toBe(400);
    expect(String((err as Error).message)).toContain("jd_typo_here");
    expect(String((err as Error).message)).not.toContain("jd_nco_7212_0100");
    expect(m.repo.recordDecision).not.toHaveBeenCalled();
  });

  it("only asks about DISTINCT ids — a duplicated tick is not two trades", async () => {
    const body = {
      ...CREATE,
      approved_job_domain_ids: ["jd_nco_7212_0100", "jd_nco_7212_0100"],
    };
    await m.service.decide(ADMIN_ID, CANDIDATE_ID, body, CTX);
    expect(m.repo.findLiveJobDomainIds).toHaveBeenCalledWith(["jd_nco_7212_0100"]);
  });

  it("does NOT resolve domains for alias, merge, reject or hold", async () => {
    // Only `create` carries the field — `.strict()` makes it a 400 on the other four — so asking
    // would be a round trip for a value that cannot exist. An `alias` lands on a skill that
    // already has its own edges.
    for (const body of [ALIAS, MERGE, REJECT, HOLD]) {
      m.repo.findLiveJobDomainIds.mockClear();
      m.repo.findStatus.mockResolvedValueOnce({
        candidate_id: CANDIDATE_ID,
        status: "needs_review",
      });
      await m.service.decide(ADMIN_ID, CANDIDATE_ID, body, CTX).catch(() => undefined);
      expect(m.repo.findLiveJobDomainIds).not.toHaveBeenCalled();
    }
  });

  it("records the approved trades verbatim on the write once they all resolve", async () => {
    // The reviewer's judgement RECORDED, not an edge written: `db:seed:domain-skills` writes the
    // `job_domain_skill` rows later, from the corpus, after a human commit.
    await m.service.decide(ADMIN_ID, CANDIDATE_ID, CREATE, CTX);
    expect(m.repo.recordDecision).toHaveBeenCalledWith(
      expect.objectContaining({
        approvedJobDomainIds: CREATE.approved_job_domain_ids,
        approvedRequirement: CREATE.approved_requirement,
      }),
      FAKE_TX,
    );
  });
});

describe("the transition is validated with canTransition before any write", () => {
  it("refuses pending -> approved_create as illegal_transition", async () => {
    m.repo.findStatus.mockResolvedValueOnce({ candidate_id: CANDIDATE_ID, status: "pending" });
    const err = await m.service
      .decide(ADMIN_ID, CANDIDATE_ID, { ...CREATE, expected_status: "pending" }, CTX)
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ConflictException);
    // Skipping the human-review rung is exactly what the ladder forbids, and NO CHECK in
    // migration 0093 would have stopped it.
    expect((err as ConflictException).getResponse()).toMatchObject({
      conflict: "illegal_transition",
      current_status: "pending",
      candidate_id: CANDIDATE_ID,
    });
    expect(m.repo.withTransaction).not.toHaveBeenCalled();
    expect(m.repo.recordDecision).not.toHaveBeenCalled();
    expect(m.events.emit).not.toHaveBeenCalled();
  });

  it("refuses pending -> approved_map and pending -> approved_merge the same way", async () => {
    for (const dto of [ALIAS, MERGE]) {
      const local = make();
      local.repo.findStatus.mockResolvedValueOnce({
        candidate_id: CANDIDATE_ID,
        status: "pending",
      });
      await expect(
        local.service.decide(ADMIN_ID, CANDIDATE_ID, { ...dto, expected_status: "pending" }, CTX),
      ).rejects.toBeInstanceOf(ConflictException);
      expect(local.repo.recordDecision).not.toHaveBeenCalled();
    }
  });

  it("allows pending -> rejected, which the ladder does permit", async () => {
    m.repo.findStatus.mockResolvedValueOnce({ candidate_id: CANDIDATE_ID, status: "pending" });
    const out = await m.service.decide(
      ADMIN_ID,
      CANDIDATE_ID,
      { ...REJECT, expected_status: "pending" },
      CTX,
    );
    expect(out.changed).toBe(true);
    expect(out.status).toBe("rejected");
    expect(m.repo.advanceToNeedsReview).not.toHaveBeenCalled();
  });

  it("runs a HOLD on a pending candidate as two legal rungs inside ONE transaction", async () => {
    m.repo.findStatus.mockResolvedValueOnce({ candidate_id: CANDIDATE_ID, status: "pending" });
    const out = await m.service.decide(
      ADMIN_ID,
      CANDIDATE_ID,
      { ...HOLD, expected_status: "pending" },
      CTX,
    );
    // canTransition("pending","deferred") is FALSE. Writing `deferred` straight onto a pending row
    // passes every DB CHECK and violates the ladder silently — the worst combination available.
    expect(m.repo.advanceToNeedsReview).toHaveBeenCalledTimes(1);
    expect(m.repo.advanceToNeedsReview.mock.calls[0]![1]).toBe(FAKE_TX);
    const write = m.repo.recordDecision.mock.calls[0]![0] as Record<string, unknown>;
    // The second rung is guarded on the rung the first one produced, not on what the reviewer sent.
    expect(write.expectedStatus).toBe("needs_review");
    expect(write.nextStatus).toBe("deferred");
    expect(m.repo.withTransaction).toHaveBeenCalledTimes(1);
    expect(out.status).toBe("deferred");
    // ONE event for one decision, never one per rung.
    expect(m.events.emit).toHaveBeenCalledTimes(1);
  });

  it("does not invent a two-step for anything other than a hold", async () => {
    m.repo.findStatus.mockResolvedValueOnce({ candidate_id: CANDIDATE_ID, status: "pending" });
    await expect(
      m.service.decide(ADMIN_ID, CANDIDATE_ID, { ...ALIAS, expected_status: "pending" }, CTX),
    ).rejects.toBeInstanceOf(ConflictException);
    expect(m.repo.advanceToNeedsReview).not.toHaveBeenCalled();
  });

  it("decides directly from deferred, which is re-openable", async () => {
    m.repo.findStatus.mockResolvedValueOnce({ candidate_id: CANDIDATE_ID, status: "deferred" });
    const out = await m.service.decide(
      ADMIN_ID,
      CANDIDATE_ID,
      { ...CREATE, expected_status: "deferred" },
      CTX,
    );
    expect(out.status).toBe("approved_create");
    expect(out.changed).toBe(true);
  });
});

// ═════════════════════════════════════════════════════════════════════════════════════════
// Terminal, idempotency and concurrency
// ═════════════════════════════════════════════════════════════════════════════════════════

describe("re-deciding", () => {
  it("is an idempotent no-op when the row already carries THIS decision", async () => {
    m.repo.findStatus.mockResolvedValueOnce({
      candidate_id: CANDIDATE_ID,
      status: "approved_create",
    });
    const out = await m.service.decide(ADMIN_ID, CANDIDATE_ID, CREATE, CTX);
    expect(out).toMatchObject({ changed: false, already_decided: true, status: "approved_create" });
    // Nothing written, and — the point — the FIRST reviewer's id, timestamp and reason are not
    // overwritten. A retry must never silently reassign authorship of a decision.
    expect(m.repo.withTransaction).not.toHaveBeenCalled();
    expect(m.repo.recordDecision).not.toHaveBeenCalled();
    expect(m.events.emit).not.toHaveBeenCalled();
  });

  it("does not let a SECOND admin re-stamp their own authorship by resubmitting the decision", async () => {
    // The row was decided by somebody else. A different admin sends the IDENTICAL decision — a
    // plausible double-click across two open consoles, or two reviewers who agree. It is a no-op
    // success, and the sharp part is what must NOT happen: no `recordDecision`, so
    // `reviewer_admin_id` / `reviewed_at` / `review_reason` still name the human who made the
    // call; and no emit, so no `admin.action_performed` row appears attributing the decision to
    // the admin who merely agreed with it. Agreement is not authorship, and a taxonomy decision's
    // audit trail outlives everyone in it.
    //
    // The pre-read is why this costs nothing: the row is already terminal in exactly this state,
    // so the service answers without opening a transaction at all.
    m.repo.findStatus.mockResolvedValueOnce({
      candidate_id: CANDIDATE_ID,
      status: "approved_create",
    });
    const out = await m.service.decide(FIRST_REVIEWER, CANDIDATE_ID, CREATE, CTX);
    expect(out).toMatchObject({ changed: false, already_decided: true });
    expect(m.repo.recordDecision).not.toHaveBeenCalled();
    expect(m.repo.advanceToNeedsReview).not.toHaveBeenCalled();
    expect(m.events.emit).not.toHaveBeenCalled();
  });

  it("answers a retry whose expected_status the FIRST attempt made stale as a no-op, not a 409", async () => {
    // The retried request still says `needs_review`; the row is already `rejected` because the
    // first attempt succeeded. Comparing expected_status first would tell the reviewer their
    // decision failed at the exact moment it had succeeded.
    m.repo.findStatus.mockResolvedValueOnce({ candidate_id: CANDIDATE_ID, status: "rejected" });
    const out = await m.service.decide(ADMIN_ID, CANDIDATE_ID, REJECT, CTX);
    expect(out).toMatchObject({ changed: false, already_decided: true, status: "rejected" });
    expect(m.events.emit).not.toHaveBeenCalled();
  });

  it("refuses a DIFFERENT decision on a terminal row with already_decided", async () => {
    m.repo.findStatus.mockResolvedValueOnce({ candidate_id: CANDIDATE_ID, status: "rejected" });
    const err = await m.service
      .decide(ADMIN_ID, CANDIDATE_ID, { ...CREATE, expected_status: "rejected" }, CTX)
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ConflictException);
    expect((err as ConflictException).getStatus()).toBe(409);
    expect((err as ConflictException).getResponse()).toMatchObject({
      conflict: "already_decided",
      current_status: "rejected",
      expected_status: "rejected",
    });
    // The decision was recorded against a specific corpus_fingerprint; re-opening the row in
    // place would silently re-scope it to a corpus the human never saw.
    expect(m.repo.recordDecision).not.toHaveBeenCalled();
  });

  it("refuses the same status onto a DIFFERENT mapping target", async () => {
    m.repo.findStatus.mockResolvedValueOnce({ candidate_id: CANDIDATE_ID, status: "approved_map" });
    m.repo.findCandidate.mockResolvedValueOnce(
      detailRow({ status: "approved_map", resulting_skill_id: OTHER_SKILL }),
    );
    const err = await m.service
      .decide(ADMIN_ID, CANDIDATE_ID, { ...ALIAS, expected_status: "approved_map" }, CTX)
      .catch((e: unknown) => e);
    // Same status, different target: that is a second opinion, not a retry.
    expect(err).toBeInstanceOf(ConflictException);
    expect((err as ConflictException).getResponse()).toMatchObject({ conflict: "already_decided" });
    expect(m.repo.recordDecision).not.toHaveBeenCalled();
  });

  it("treats the same status onto the SAME mapping target as the retry it is", async () => {
    m.repo.findStatus.mockResolvedValueOnce({ candidate_id: CANDIDATE_ID, status: "approved_map" });
    m.repo.findCandidate.mockResolvedValueOnce(
      detailRow({ status: "approved_map", resulting_skill_id: TARGET_SKILL }),
    );
    const out = await m.service.decide(
      ADMIN_ID,
      CANDIDATE_ID,
      { ...ALIAS, expected_status: "approved_map" },
      CTX,
    );
    expect(out).toMatchObject({ changed: false, already_decided: true });
    expect(m.events.emit).not.toHaveBeenCalled();
  });

  it("re-holding a deferred candidate is a no-op that is NOT already_decided", async () => {
    m.repo.findStatus.mockResolvedValueOnce({ candidate_id: CANDIDATE_ID, status: "deferred" });
    const out = await m.service.decide(
      ADMIN_ID,
      CANDIDATE_ID,
      { ...HOLD, expected_status: "deferred" },
      CTX,
    );
    // `deferred` is deliberately NOT terminal: somebody looked and could not decide, and the row
    // is still re-openable. Reporting already_decided would say the opposite.
    expect(out).toMatchObject({ changed: false, already_decided: false, status: "deferred" });
    expect(m.repo.recordDecision).not.toHaveBeenCalled();
  });

  it("refuses a stale expected_status on a still-undecided row", async () => {
    m.repo.findStatus.mockResolvedValueOnce({ candidate_id: CANDIDATE_ID, status: "deferred" });
    const err = await m.service
      .decide(ADMIN_ID, CANDIDATE_ID, { ...CREATE, expected_status: "needs_review" }, CTX)
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ConflictException);
    expect((err as ConflictException).getResponse()).toMatchObject({
      conflict: "stale_expected_status",
      current_status: "deferred",
      expected_status: "needs_review",
    });
    expect(m.repo.withTransaction).not.toHaveBeenCalled();
  });

  it("404s an unknown candidate before anything else", async () => {
    m.repo.findStatus.mockResolvedValueOnce(undefined);
    await expect(m.service.decide(ADMIN_ID, CANDIDATE_ID, REJECT, CTX)).rejects.toBeInstanceOf(
      NotFoundException,
    );
    expect(m.repo.withTransaction).not.toHaveBeenCalled();
  });

  it("puts the concurrency token in the WHERE, not only in the pre-read", async () => {
    await m.service.decide(ADMIN_ID, CANDIDATE_ID, REJECT, CTX);
    const write = m.repo.recordDecision.mock.calls[0]![0] as Record<string, unknown>;
    // A read-then-write has the same code and none of the protection.
    expect(write.expectedStatus).toBe("needs_review");
    expect(write.candidateId).toBe(CANDIDATE_ID);
  });

  it("reports a lost race that landed on the SAME decision as a no-op", async () => {
    m.repo.recordDecision.mockResolvedValueOnce(undefined);
    m.repo.findStatus
      .mockResolvedValueOnce({ candidate_id: CANDIDATE_ID, status: "needs_review" })
      .mockResolvedValueOnce({ candidate_id: CANDIDATE_ID, status: "rejected" });
    const out = await m.service.decide(ADMIN_ID, CANDIDATE_ID, REJECT, CTX);
    expect(out).toMatchObject({ changed: false, already_decided: true, status: "rejected" });
    expect(m.events.emit).not.toHaveBeenCalled();
  });

  it("refuses a lost race that landed on a DIFFERENT decision", async () => {
    m.repo.recordDecision.mockResolvedValueOnce(undefined);
    m.repo.findStatus
      .mockResolvedValueOnce({ candidate_id: CANDIDATE_ID, status: "needs_review" })
      .mockResolvedValueOnce({ candidate_id: CANDIDATE_ID, status: "approved_create" });
    const err = await m.service
      .decide(ADMIN_ID, CANDIDATE_ID, REJECT, CTX)
      .catch((e: unknown) => e);
    // Reporting changed:false here would tell the second reviewer their decision was recorded
    // when somebody else's was.
    expect(err).toBeInstanceOf(ConflictException);
    expect((err as ConflictException).getResponse()).toMatchObject({
      conflict: "already_decided",
      current_status: "approved_create",
    });
    expect(m.events.emit).not.toHaveBeenCalled();
  });
});

// ═════════════════════════════════════════════════════════════════════════════════════════
// Provenance is frozen
// ═════════════════════════════════════════════════════════════════════════════════════════

describe("a decision may never move a provenance field", () => {
  it("rolls back and emits nothing when a frozen field moved between before and after", async () => {
    m.repo.findCandidate
      .mockResolvedValueOnce(detailRow())
      .mockResolvedValueOnce(detailRow({ cluster_key: "arc welder", status: "rejected" }));
    const err = await m.service
      .decide(ADMIN_ID, CANDIDATE_ID, REJECT, CTX)
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(InternalServerErrorException);
    // The refusal NAMES the field that moved — field names are safe to log, values are not.
    expect((err as InternalServerErrorException).message).toContain("cluster_key");
    // Throwing inside the transaction is what rolls the decision back; the event never fires, so
    // there is no spine row claiming a decision that did not survive.
    expect(m.events.emit).not.toHaveBeenCalled();
  });

  it("names no frozen field in the write, and never the digest", async () => {
    for (const dto of [CREATE, ALIAS, MERGE, REJECT, HOLD]) {
      const local = make();
      await local.service.decide(ADMIN_ID, CANDIDATE_ID, dto, CTX);
      const write = local.repo.recordDecision.mock.calls[0]![0] as Record<string, unknown>;
      // The patch is an ALLOW-LIST, asserted as a subset: the review columns, the two editable
      // proposal columns, and the concurrency token. Not one of the 19 PROVENANCE_FIELDS is
      // reachable, and `provenanceDigest` least of all — recomputing it to make a mismatch go
      // away is the one repair that must never happen, because it launders the lineage lie the
      // field exists to expose.
      const allowed = new Set([
        "candidateId",
        "expectedStatus",
        "nextStatus",
        "reviewerAdminId",
        "reviewedAt",
        "reviewReason",
        "resultingSkillId",
        "proposedSkillName",
        "proposedDescription",
        "approvedJobDomainIds",
        "approvedRequirement",
      ]);
      for (const key of Object.keys(write)) {
        expect(allowed.has(key), `the decision write must not carry "${key}"`).toBe(true);
      }
      for (const frozen of [
        "provenanceDigest",
        "corpusFingerprint",
        "clusterKey",
        "runId",
        "normalizedPhrase",
        "phraseClass",
        "classifierRule",
        "occupationHeads",
        "evidenceTokens",
        "tradeFamily",
        "sourceAliasCount",
        "sourceDomainCount",
        "proposedAction",
        "confidenceBand",
        "confidence",
        "embeddingStatus",
        "model",
        "promptVersion",
        "createdAt",
      ]) {
        expect(write).not.toHaveProperty(frozen);
      }
    }
  });

  it("lets an ordinary decision through — the assertion is not vacuous", async () => {
    m.repo.findCandidate
      .mockResolvedValueOnce(detailRow())
      .mockResolvedValueOnce(
        detailRow({
          status: "rejected",
          reviewer_admin_id: ADMIN_ID,
          reviewed_at: new Date(),
          review_reason: "seniority marker, not a competency",
        }),
      );
    const out = await m.service.decide(ADMIN_ID, CANDIDATE_ID, REJECT, CTX);
    // The review columns are OUTSIDE the 19 frozen fields, deliberately: a reviewer's decision is
    // a NEW FACT, never a correction of what the run observed.
    expect(out.changed).toBe(true);
    expect(m.events.emit).toHaveBeenCalledTimes(1);
  });
});

// ═════════════════════════════════════════════════════════════════════════════════════════
// The corpus layer's own post-condition
// ═════════════════════════════════════════════════════════════════════════════════════════

describe("a decision may not introduce a validateCandidate problem", () => {
  it("400s when the resulting row would be an approved_map with no resolution", async () => {
    m.repo.findCandidate
      .mockResolvedValueOnce(detailRow())
      .mockResolvedValueOnce(
        detailRow({
          status: "approved_map",
          resulting_skill_id: null,
          reviewer_admin_id: ADMIN_ID,
          reviewed_at: new Date(),
          review_reason: "same competency, another spelling",
        }),
      );
    const err = await m.service.decide(ADMIN_ID, CANDIDATE_ID, ALIAS, CTX).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(BadRequestException);
    expect((err as BadRequestException).message).toContain("RESOLUTION_WITHOUT_SKILL");
    expect(m.events.emit).not.toHaveBeenCalled();
  });

  it("500s and rolls back when the row we wrote breaks something the body did not cause", async () => {
    const decided = detailRow({
      status: "rejected",
      reviewer_admin_id: ADMIN_ID,
      reviewed_at: new Date(),
      review_reason: "seniority marker, not a competency",
    });
    m.repo.findCandidate.mockResolvedValueOnce(detailRow()).mockResolvedValueOnce(decided);
    // The child set went wrong under us: two match rows for one skill, which the PK forbids and
    // MATCH_DUPLICATE_SKILL re-checks. Not the reviewer's doing, and not something the body could
    // have caused — so it is a 500, and either way the decision does not stand.
    m.repo.listMatches
      .mockResolvedValueOnce(MATCHES)
      .mockResolvedValueOnce([MATCHES[0]!, { ...MATCHES[0]!, rank: 2 }]);
    const err = await m.service
      .decide(ADMIN_ID, CANDIDATE_ID, REJECT, CTX)
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(InternalServerErrorException);
    expect((err as InternalServerErrorException).message).toContain("MATCH_DUPLICATE_SKILL");
    expect(m.events.emit).not.toHaveBeenCalled();
  });

  it("does NOT block a decision on a problem the run already shipped", async () => {
    // The pipeline wrote a duplicated match set. That is not this reviewer's fault, and refusing
    // their decision over it would make a bad run permanently un-reviewable.
    const duplicated = [MATCHES[0]!, { ...MATCHES[0]!, rank: 2 }];
    m.repo.findCandidate
      .mockResolvedValueOnce(detailRow())
      .mockResolvedValueOnce(
        detailRow({
          status: "rejected",
          reviewer_admin_id: ADMIN_ID,
          reviewed_at: new Date(),
          review_reason: "seniority marker, not a competency",
        }),
      );
    m.repo.listMatches.mockResolvedValueOnce(duplicated).mockResolvedValueOnce(duplicated);
    const out = await m.service.decide(ADMIN_ID, CANDIDATE_ID, REJECT, CTX);
    expect(out.changed).toBe(true);
  });
});

// ═════════════════════════════════════════════════════════════════════════════════════════
// One transaction, one value-free event
// ═════════════════════════════════════════════════════════════════════════════════════════

describe("the SoR write and the audit event commit together", () => {
  it("emits on the SAME transaction the write used", async () => {
    await m.service.decide(ADMIN_ID, CANDIDATE_ID, CREATE, CTX);
    expect(m.repo.withTransaction).toHaveBeenCalledTimes(1);
    expect(m.repo.recordDecision.mock.calls[0]![1]).toBe(FAKE_TX);
    // Omitting `tx` compiles, passes a naive test, and writes the event on a connection that
    // SURVIVES the rollback — a decision with no audit trail, or an audit trail with no decision.
    expect(soleEmit(m.events).tx).toBe(FAKE_TX);
  });

  it("propagates an emit failure instead of reporting a decision that rolled back", async () => {
    m.events.emit.mockRejectedValueOnce(new Error("spine down"));
    await expect(m.service.decide(ADMIN_ID, CANDIDATE_ID, REJECT, CTX)).rejects.toThrowError(
      /spine down/,
    );
  });

  it("emits nothing when the write changed nothing", async () => {
    m.repo.recordDecision.mockResolvedValueOnce(undefined);
    m.repo.findStatus
      .mockResolvedValueOnce({ candidate_id: CANDIDATE_ID, status: "needs_review" })
      .mockResolvedValueOnce({ candidate_id: CANDIDATE_ID, status: "rejected" });
    await m.service.decide(ADMIN_ID, CANDIDATE_ID, REJECT, CTX);
    expect(m.events.emit).not.toHaveBeenCalled();
  });

  it("carries the action CODE, two opaque ids, and no value at all", async () => {
    await m.service.decide(ADMIN_ID, CANDIDATE_ID, ALIAS, CTX);
    const emitted = soleEmit(m.events);
    expect(emitted.event_name).toBe("admin.action_performed");
    expect(emitted.actor).toEqual({ actor_type: "admin", actor_id: ADMIN_ID });
    // The subject is the CANDIDATE: "what happened to this candidate" is the question a taxonomy
    // decision has to survive being asked years later.
    expect(emitted.subject).toEqual({
      subject_type: "skill_candidate",
      subject_id: CANDIDATE_ID,
    });
    expect(Object.keys(emitted.payload).sort()).toEqual([
      "action_code",
      "admin_id",
      "target_id",
      "target_type",
    ]);
    const { action_code: _code, ...rest } = emitted.payload;
    const blob = leaves(rest).join("");
    for (const frag of FORBIDDEN_VALUE_FRAGMENTS) {
      expect(blob, `value "${frag}" must not ride on the spine`).not.toContain(frag);
    }
  });

  it("is a registry-VALID event end to end, which is what proves skill_candidate is a registered subject", async () => {
    await m.service.decide(ADMIN_ID, CANDIDATE_ID, CREATE, CTX);
    const emitted = soleEmit(m.events);
    // Built exactly as EventsService would. `subject_type` is the CLOSED z.enum(SUBJECT_TYPES);
    // an unregistered subject throws at stage:"envelope" INSIDE the transaction, before any
    // insert — compile-clean, runtime-fatal, invisible to a test that only stubs the emit.
    const built = createEvent<"admin.action_performed">({
      event_name: emitted.event_name,
      payload: emitted.payload as CreateEventInput<"admin.action_performed">["payload"],
      source: "api",
      correlation_id: emitted.correlationId,
      metadata: { environment: "test", service: "api", request_id: emitted.requestId },
      ...({ actor: emitted.actor, subject: emitted.subject } as Pick<
        CreateEventInput<"admin.action_performed">,
        "actor" | "subject"
      >),
    });
    expect(built.event_name).toBe("admin.action_performed");
  });

  it("dedups on action + actor + target + request", async () => {
    await m.service.decide(ADMIN_ID, CANDIDATE_ID, REJECT, CTX);
    expect(soleEmit(m.events).idempotencyKey).toBe(
      `admin_action:skill_candidate_rejected:${ADMIN_ID}:${CANDIDATE_ID}:req-1`,
    );
  });

  it("uses one code per decision, and every code is named for the status it records", async () => {
    const expected: Array<[AdminSkillDecisionDto, string]> = [
      [CREATE, ADMIN_ACTION_CODES.skill_candidate_approved_create],
      [ALIAS, ADMIN_ACTION_CODES.skill_candidate_approved_map],
      [MERGE, ADMIN_ACTION_CODES.skill_candidate_approved_merge],
      [REJECT, ADMIN_ACTION_CODES.skill_candidate_rejected],
      [HOLD, ADMIN_ACTION_CODES.skill_candidate_deferred],
    ];
    for (const [dto, code] of expected) {
      const local = make();
      await local.service.decide(ADMIN_ID, CANDIDATE_ID, dto, CTX);
      const emitted = soleEmit(local.events);
      expect(emitted.payload.action_code).toBe(code);
      // The code is a TOTAL FUNCTION of statusForDecision — so an auditor reconciling the spine
      // against a skill_candidate row needs no translation table.
      const library = { create: "create", alias: "map", merge: "merge", reject: "reject", hold: "defer" } as const;
      expect(code).toBe(`skill_candidate_${statusForDecision(library[dto.decision])}`);
    }
  });

  it("does not stamp a reviewer on the intermediate rung of a hold", async () => {
    m.repo.findStatus.mockResolvedValueOnce({ candidate_id: CANDIDATE_ID, status: "pending" });
    await m.service.decide(ADMIN_ID, CANDIDATE_ID, { ...HOLD, expected_status: "pending" }, CTX);
    // `skill_candidate_machine_status_chk` FORBIDS a reviewer on needs_review, so the bounce takes
    // an id and a tx and nothing else — the human is recorded by the second rung.
    expect(m.repo.advanceToNeedsReview.mock.calls[0]).toEqual([CANDIDATE_ID, FAKE_TX]);
  });
});

// ═════════════════════════════════════════════════════════════════════════════════════════
// The reads
// ═════════════════════════════════════════════════════════════════════════════════════════

/**
 * THE WIRE CONTRACT, WRITTEN OUT, so a response can be compared against it as a SET.
 *
 * Both lists are `satisfies readonly (keyof T)[]`, so a typo is a compile error, and each is
 * followed by an exhaustiveness line that fails to compile when the interface gains a field this
 * list does not. That pairing is what makes them maintainable: adding a field to the contract
 * forces exactly one edit here, and forgetting is caught by `tsc`, not by a reviewer.
 */
const LIST_CONTRACT_KEYS = [
  "id",
  "run_id",
  "cluster_key",
  "normalized_phrase",
  "proposed_skill_name",
  "phrase_class",
  "trade_family",
  "source_alias_count",
  "source_domain_count",
  "proposed_action",
  "confidence_band",
  "status",
  "review_tier",
  "has_strong_match",
  "related_skill_count",
  "reviewer_admin_id",
  "reviewed_at",
  "resulting_skill_id",
  "created_at",
  "updated_at",
] as const satisfies readonly (keyof AdminSkillDiscoveryListItem)[];

const DETAIL_CONTRACT_KEYS = [
  ...LIST_CONTRACT_KEYS,
  "phrase_class_label",
  "proposed_description",
  "rationale",
  "sources",
  "source_type_counts",
  "related_skills",
  "suggested_aliases",
  "review_reason",
  "approved_job_domain_ids",
  "approved_requirement",
  "provenance",
] as const satisfies readonly (keyof AdminSkillDiscoveryDetail)[];

// Compile-time exhaustiveness. If the interface gains a field, `Exclude<...>` stops being `never`
// and the annotation stops accepting `true`.
type UnlistedListKey = Exclude<keyof AdminSkillDiscoveryListItem, (typeof LIST_CONTRACT_KEYS)[number]>;
type UnlistedDetailKey = Exclude<keyof AdminSkillDiscoveryDetail, (typeof DETAIL_CONTRACT_KEYS)[number]>;
const _listKeysAreExhaustive: [UnlistedListKey] extends [never] ? true : never = true;
const _detailKeysAreExhaustive: [UnlistedDetailKey] extends [never] ? true : never = true;
void _listKeysAreExhaustive;
void _detailKeysAreExhaustive;

describe("the reads", () => {
  it("emit nothing — a read is not a state change, and there is no subject to name", async () => {
    m.repo.findCandidate.mockResolvedValueOnce(detailRow());
    await m.service.detail(CANDIDATE_ID);
    await m.service.list({ limit: 50, sort: "newest" } as never);
    await m.service.metrics({});
    expect(m.events.emit).not.toHaveBeenCalled();
  });

  it("404s an unknown candidate rather than rendering an empty detail page", async () => {
    m.repo.findCandidate.mockResolvedValueOnce(undefined);
    await expect(m.service.detail(CANDIDATE_ID)).rejects.toBeInstanceOf(NotFoundException);
  });

  it("never puts the similarity score on the wire", async () => {
    const detail = await m.service.detail(CANDIDATE_ID);
    expect(detail.related_skills).toHaveLength(1);
    // A 0..1 number on a review screen re-imports the threshold thinking this surface exists to
    // keep out: a UI that sorts by it has invented an approval floor with no owner behind it.
    expect(detail.related_skills[0]).not.toHaveProperty("score");
    expect(JSON.stringify(detail)).not.toContain("0.87");
    // `rank` survives, because an ORDER is not a measurement.
    expect(detail.related_skills[0]!.rank).toBe(1);
  });

  /**
   * The CANDIDATE's own score, which is a different number from the match score above and was
   * reaching the wire.
   *
   * `detailOf` builds on `listItem`, `listItem` spread its row, and the detail read calls it with
   * an `AdminSkillCandidateDetailRow` — a SUBTYPE carrying the columns the service needs only to
   * assemble a `SkillCandidateRecord`. A subtype is structurally assignable and TypeScript does
   * not excess-property-check a spread, so `confidence` (raw `real`, CHECKed 0..1) and
   * `created_at_iso` landed on the response under keys no DTO declares.
   *
   * THE TEST ABOVE COULD NOT SEE IT, and the reason is worth keeping: it asserts
   * `not.toContain("0.87")`, which is the MATCH score, and the fixture leaves the candidate's own
   * `confidence` null — so the key was on the wire rendering as `"confidence":null` and every
   * assertion passed. `contract-parity` missed it too: it looks for `score`, `cosine`,
   * `embedding_model` and `vector`, and this key is called none of those.
   *
   * So this pins the KEY SET rather than probing for names nobody has thought of yet. A field
   * added to the contract must be added here, which is the point — the list is the contract.
   */
  it("serves EXACTLY the declared detail contract, so no repository-only column can ride a spread", async () => {
    // A value, not the fixture's null: a leak should be a number a reviewer could sort by.
    m.repo.findCandidate.mockResolvedValueOnce({ ...detailRow(), confidence: 0.9312 });
    const detail = await m.service.detail(CANDIDATE_ID);

    expect(Object.keys(detail).sort()).toEqual([...DETAIL_CONTRACT_KEYS].sort());
    expect(detail).not.toHaveProperty("confidence");
    expect(detail).not.toHaveProperty("created_at_iso");
    expect(JSON.stringify(detail)).not.toContain("0.9312");
  });

  it("serves EXACTLY the declared queue contract", async () => {
    // Seeded with a DETAIL row, as every other list test here is — which is the interesting case:
    // it carries the repository-only columns, so the projection is what has to drop them.
    m.repo.list.mockResolvedValueOnce([
      { row: { ...detailRow(), confidence: 0.9312 }, sortKey: "2026-08-26T12:00:00.000600Z" },
    ]);
    const page = await m.service.list({ limit: 50, sort: "newest" } as never);
    expect(page.items).toHaveLength(1);
    expect(Object.keys(page.items[0]!).sort()).toEqual([...LIST_CONTRACT_KEYS].sort());
    expect(JSON.stringify(page)).not.toContain("0.9312");
  });

  it("translates the relation and never leaves the evidence blank", async () => {
    const detail = await m.service.detail(CANDIDATE_ID);
    const related = detail.related_skills[0]!;
    expect(related.relation).toBe("high_token_overlap");
    expect(related.relation_label).not.toBe("");
    expect(related.strength_label).not.toBe("");
    // The column is nullable; a blank cell would read as "no reason was found", which is a
    // strictly stronger and false claim than "the reason is the relation itself".
    expect(related.evidence).toBe(related.relation_label);
  });

  it("renders an unrecognised relation as its own raw code rather than a guessed sentence", async () => {
    m.repo.listMatches.mockResolvedValueOnce([{ ...MATCHES[0]!, relation: "future_relation" }]);
    const detail = await m.service.detail(CANDIDATE_ID);
    expect(detail.related_skills[0]!.relation_label).toBe("future_relation");
  });

  it("previews exactly the aliases a create approval would mint, canonical label excluded", async () => {
    const detail = await m.service.detail(CANDIDATE_ID);
    // approvedCandidateToCorpusSkill's own rule: the cluster's OTHER surface forms, deduped, with
    // the canonical label removed — including it produces ALIAS_DUPLICATE_WITHIN_SKILL downstream,
    // long after the decision, with nobody left to ask.
    expect(detail.suggested_aliases).toEqual(["arc welder work"]);
    expect(detail.suggested_aliases).not.toContain("Arc Welding");
  });

  it("composes the rationale from stored columns only", async () => {
    const detail = await m.service.detail(CANDIDATE_ID);
    expect(detail.rationale).toContain("ACTIVITY_PHRASE");
    expect(detail.rationale).toContain("ACTIVITY_HEADED");
    expect(detail.rationale).toContain("Attested by 2 phrases across 1 trade.");
  });

  it("densifies the source-type counts with no catch-all bucket", async () => {
    const detail = await m.service.detail(CANDIDATE_ID);
    expect(detail.source_type_counts).toHaveLength(6);
    expect(detail.source_type_counts.map((b) => b.key)).not.toContain("other");
    expect(detail.source_type_counts.find((b) => b.key === "job_text")!.count).toBe(0);
    expect(detail.source_type_counts.find((b) => b.key === "worker_phrase")!.count).toBe(1);
  });

  it("derives the tier through reviewTier and reports the fact behind it", async () => {
    const detail = await m.service.detail(CANDIDATE_ID);
    expect(detail.review_tier).toBe("direct");
    expect(detail.has_strong_match).toBe(false);
    expect(detail.related_skill_count).toBe(1);
  });

  it("over-fetches by one and reads match facts only for the page it will serve", async () => {
    const rows: AdminSkillDiscoveryQueueRow[] = Array.from({ length: 3 }, (_, i) => ({
      row: { ...detailRow({ id: `id-${i}` }) },
      sortKey: `2026-08-26T12:00:0${i}.000600Z`,
    }));
    m.repo.list.mockResolvedValueOnce(rows);
    const page = await m.service.list({ limit: 2, sort: "newest" } as never);
    expect(m.repo.list.mock.calls[0]![3]).toBe(3);
    expect(page.items).toHaveLength(2);
    expect(page.nextCursor).not.toBeNull();
    // The peeked row is sliced off BEFORE the second query.
    expect(m.repo.matchFactsFor.mock.calls[0]![0]).toEqual(["id-0", "id-1"]);
  });

  it("mints the cursor from the microsecond sort key, never from a millisecond Date", async () => {
    const rows: AdminSkillDiscoveryQueueRow[] = [
      { row: { ...detailRow({ id: "id-0" }) }, sortKey: "2026-08-26T12:00:00.000600Z" },
      { row: { ...detailRow({ id: "id-1" }) }, sortKey: "2026-08-26T12:00:00.000700Z" },
    ];
    m.repo.list.mockResolvedValueOnce(rows);
    const page = await m.service.list({ limit: 1, sort: "newest" } as never);
    const decoded = JSON.parse(
      Buffer.from(page.nextCursor!, "base64url").toString("utf8"),
    ) as Record<string, string>;
    // A Date-derived cursor sits strictly below the row it describes and drops every other row in
    // that millisecond — the id tie-breaker cannot save it (migration 0083).
    expect(decoded.c).toBe("2026-08-26T12:00:00.000600Z");
    expect(decoded.i).toBe("id-0");
  });

  it("treats a candidate with no match facts as having none, not as missing data", async () => {
    m.repo.list.mockResolvedValueOnce([
      { row: { ...detailRow({ id: "id-0" }) }, sortKey: "2026-08-26T12:00:00.000600Z" },
    ]);
    m.repo.matchFactsFor.mockResolvedValueOnce([]);
    const page = await m.service.list({ limit: 50, sort: "newest" } as never);
    expect(page.items[0]).toMatchObject({ has_strong_match: false, related_skill_count: 0 });
    expect(page.nextCursor).toBeNull();
  });

  it("serves a malformed cursor as the first page rather than an error", async () => {
    await m.service.list({ limit: 50, sort: "newest", cursor: "not-a-cursor" } as never);
    expect(m.repo.list.mock.calls[0]![2]).toBeNull();
  });

  it("densifies every metrics breakdown and sums the total from by_status", async () => {
    m.repo.metricFacts.mockResolvedValueOnce({
      by_status: [
        { key: "pending", count: 3 },
        { key: "needs_review", count: 2 },
        { key: "deferred", count: 1 },
      ],
      by_band: [{ key: "low", count: 6 }],
      by_proposed_action: [{ key: "review", count: 6 }],
      by_phrase_class: [
        { phrase_class: "ACTIVITY_PHRASE", with_strong_match: 1, without_strong_match: 2 },
        { phrase_class: "OCCUPATION_ONLY", with_strong_match: 1, without_strong_match: 1 },
        { phrase_class: "AMBIGUOUS", with_strong_match: 0, without_strong_match: 1 },
      ],
      oldest_awaiting_created_at: new Date("2026-08-01T00:00:00.000Z"),
    });
    const out = await m.service.metrics({});
    expect(out.by_status).toHaveLength(7);
    expect(out.by_band).toHaveLength(3);
    expect(out.by_proposed_action).toHaveLength(5);
    expect(out.total).toBe(6);
    // Two statuses, never one: "the run has not routed it" and "a human has not opened it" are
    // different facts, and `deferred` is neither.
    expect(out.awaiting_decision).toBe(5);
    expect(out.deferred).toBe(1);
    expect(out.tier_basis).toBe("review_tier_is_derived_not_stored");
    expect(out.oldest_awaiting_created_at).toEqual(new Date("2026-08-01T00:00:00.000Z"));
  });

  it("sums the tier breakdown through the same reviewTier the rows use", async () => {
    m.repo.metricFacts.mockResolvedValueOnce({
      by_status: [],
      by_band: [],
      by_proposed_action: [],
      by_phrase_class: [
        // ACTIVITY_PHRASE is `direct` either way; OCCUPATION_ONLY is `direct` only with a strong
        // match; AMBIGUOUS without one is `ambiguous`.
        { phrase_class: "ACTIVITY_PHRASE", with_strong_match: 1, without_strong_match: 2 },
        { phrase_class: "OCCUPATION_ONLY", with_strong_match: 1, without_strong_match: 4 },
        { phrase_class: "AMBIGUOUS", with_strong_match: 0, without_strong_match: 3 },
      ],
      oldest_awaiting_created_at: null,
    });
    const out = await m.service.metrics({});
    const tier = (key: string): number => out.by_tier.find((b) => b.key === key)!.count;
    expect(tier("direct")).toBe(4);
    expect(tier("derived")).toBe(4);
    expect(tier("ambiguous")).toBe(3);
  });

  it("scopes the metrics to a run and echoes which one", async () => {
    const out = await m.service.metrics({ runId: "sdr_20260826T120000Z_nightly" });
    expect(out.run_id).toBe("sdr_20260826T120000Z_nightly");
    expect(m.repo.metricFacts.mock.calls[0]![0]).toMatchObject({
      runId: "sdr_20260826T120000Z_nightly",
      awaitingStatuses: ["pending", "needs_review"],
    });
  });
});

describe("the grouped view", () => {
  it("groups the WHOLE filtered population, never a page", () => {
    // The anchor a candidate is batched on comes from a token count across everything passed in,
    // so a paged grouping gives the same candidate a different batch on every page-turn. The
    // repository call therefore takes a filter and no cursor and no limit — asserted, because
    // "we did not pass a cursor" is exactly the kind of thing a later refactor adds for symmetry.
    return m.service.groups({ tier: "derived" }).then(() => {
      expect(m.repo.groupingFacts).toHaveBeenCalledWith({ tier: "derived" });
      const [arg] = m.repo.groupingFacts.mock.calls[0] as [Record<string, unknown>];
      expect(arg).not.toHaveProperty("cursor");
      expect(arg).not.toHaveProperty("limit");
    });
  });

  it("counts BEFORE it fetches, and refuses an over-broad filter with the number", () => {
    // A truncated grouping still claims to be exhaustive, which is the one answer worse than a
    // refusal. The count is one cheap aggregate; the alternative is reading the whole table
    // before anyone notices it was too large.
    m.repo.countMatching.mockResolvedValueOnce(ADMIN_SKILL_GROUPS_MAX_CANDIDATES + 1);
    return m.service.groups({}).then(
      () => expect.unreachable("should have refused"),
      (err: unknown) => {
        expect((err as { status?: number }).status).toBe(400);
        expect(String((err as Error).message)).toContain(
          String(ADMIN_SKILL_GROUPS_MAX_CANDIDATES + 1),
        );
        expect(m.repo.groupingFacts).not.toHaveBeenCalled();
      },
    );
  });

  it("batches on tier and family and anchor, and reports what is still WORK", async () => {
    const out = await m.service.groups({});
    // c1 + c2 share tier/family/anchor("wood"); c3 is its own group.
    expect(out.total_groups).toBe(2);
    const wood = out.groups.find((g) => g.anchor === "wood");
    expect(wood?.candidates).toBe(2);
    // c2 is `approved_create` — decided. Only c1 is still work.
    expect(wood?.undecided).toBe(1);
  });

  it("UNIONS the group's job domains rather than summing per-candidate counts", async () => {
    // c1 has {jd_1, jd_2} and c2 has {jd_2, jd_3}. Summing per-candidate counts gives 4; the
    // union is 3. A batch is by construction candidates from related trades, so the overlap is
    // the normal case, not an edge one.
    const out = await m.service.groups({});
    expect(out.groups.find((g) => g.anchor === "wood")?.source_domains).toBe(3);
  });

  it("sums its totals FROM the groups, so the headline cannot contradict the breakdown", async () => {
    const out = await m.service.groups({});
    expect(out.total_candidates).toBe(out.groups.reduce((n, g) => n + g.candidates, 0));
    expect(out.total_undecided).toBe(out.groups.reduce((n, g) => n + g.undecided, 0));
    expect(out.total_candidates).toBe(GROUPING_FACTS.length);
  });

  it("says in band that a group is derived, not stored", async () => {
    // There is no group id in any table. A consumer that wanted to persist one learns from the
    // response itself that there is nothing to reconcile against.
    const out = await m.service.groups({});
    expect(out.grouping_basis).toBe("groups_are_derived_not_stored");
    expect(out.tier_basis).toBe("review_tier_is_derived_not_stored");
  });

  it("returns members sorted, so identical requests render identically", async () => {
    const out = await m.service.groups({});
    for (const g of out.groups) expect(g.candidate_ids).toEqual([...g.candidate_ids].sort());
  });

  it("emits nothing — a read is not a state change", async () => {
    await m.service.groups({});
    expect(m.events.emit).not.toHaveBeenCalled();
    expect(m.repo.recordDecision).not.toHaveBeenCalled();
  });
});

describe("the audit read", () => {
  it("serves the spine AND the row, because either alone misleads", async () => {
    // The spine says what happened and cannot have been edited; the row says what the candidate
    // NOW is. An auditor needs to see the two agree — and if they ever do not, that is the
    // finding, which a response carrying one of them could never surface.
    const out = await m.service.audit(CANDIDATE_ID);
    expect(out.candidate_id).toBe(CANDIDATE_ID);
    expect(out.entries).toHaveLength(1);
    expect(out.entries[0]?.action_code).toBe("skill_candidate_approved_create");
    expect(out.current.status).toBeDefined();
    expect(out.current).toHaveProperty("approved_job_domain_ids");
    expect(out.current).toHaveProperty("approved_requirement");
  });

  it("carries no values — the spine is value-free by construction", async () => {
    // WHO did WHAT and WHEN. The reason and the proposed label live on the row, which the detail
    // read serves; two copies of one fact are two things that can disagree.
    const out = await m.service.audit(CANDIDATE_ID);
    for (const entry of out.entries) {
      expect(Object.keys(entry).sort()).toEqual([
        "action_code",
        "admin_id",
        "event_id",
        "occurred_at",
      ]);
    }
  });

  it("states that no entry here means a skill was created", async () => {
    const out = await m.service.audit(CANDIDATE_ID);
    expect(out.corpus_effect).toBe("decision_recorded_no_corpus_write");
  });

  it("404s an unknown candidate rather than serving an empty history", async () => {
    // An empty trail for a candidate that does not exist reads as "nothing ever happened to it",
    // which is a different and false claim.
    m.repo.findCandidate.mockResolvedValueOnce(undefined);
    await expect(m.service.audit(CANDIDATE_ID)).rejects.toMatchObject({ status: 404 });
  });

  it("emits nothing, and writes nothing", async () => {
    await m.service.audit(CANDIDATE_ID);
    expect(m.events.emit).not.toHaveBeenCalled();
    expect(m.repo.recordDecision).not.toHaveBeenCalled();
    expect(m.repo.withTransaction).not.toHaveBeenCalled();
  });
});

describe("the MAP picker's skill lookup", () => {
  it("REPORTS eligibility rather than filtering the ineligible out", async () => {
    // A reviewer searching for a skill they remember and finding nothing cannot tell "no such
    // skill" from "deprecated" from "that one is match vocabulary" — three situations needing
    // three different actions.
    const out = await m.service.searchSkills({ q: "weld", limit: 20 });
    expect(out.skills).toHaveLength(3);
    const byId = new Map(out.skills.map((sk) => [sk.skill_id, sk]));
    expect(byId.get("skill_arc_welding")?.mappable).toBe(true);
    expect(byId.get("skill_arc_welding")?.not_mappable_reason).toBeNull();
    expect(byId.get("skill_old_welding")?.mappable).toBe(false);
    expect(byId.get("mskill_welder")?.mappable).toBe(false);
  });

  it("gives the reason, and names match vocabulary as match vocabulary", async () => {
    const out = await m.service.searchSkills({ q: "weld", limit: 20 });
    const byId = new Map(out.skills.map((sk) => [sk.skill_id, sk]));
    expect(byId.get("mskill_welder")?.not_mappable_reason).toContain("Match vocabulary");
    expect(byId.get("skill_old_welding")?.not_mappable_reason).toContain("Deprecated");
  });

  it("agrees with the WRITE about what is mappable", async () => {
    // Two definitions of "mappable" would let the picker present a choice that always 400s. The
    // service's decision path refuses exactly these two, so the picker must flag exactly these
    // two — asserted by running the write against each and comparing.
    const out = await m.service.searchSkills({ q: "weld", limit: 20 });
    for (const skill of out.skills) {
      m.repo.findStatus.mockResolvedValueOnce({ candidate_id: CANDIDATE_ID, status: "needs_review" });
      m.repo.findCorpusSkill.mockResolvedValueOnce({
        skill_id: skill.skill_id,
        status: skill.status as "active" | "deprecated",
        kind: skill.kind as "attribute" | "match_skill",
      });
      const err = await m.service
        .decide(ADMIN_ID, CANDIDATE_ID, { ...ALIAS, resulting_skill_id: "skill_arc_welding" }, CTX)
        .then(() => null)
        .catch((e: unknown) => e);
      const writeAccepted = err === null;
      expect(writeAccepted, `${skill.skill_id} picker=${skill.mappable} write=${writeAccepted}`).toBe(
        skill.mappable,
      );
    }
  });

  it("over-fetches by one to answer `truncated` honestly", async () => {
    // Without the extra row, "exactly `limit` results" and "more than `limit` results" are the
    // same response, and the console cannot tell the reviewer to type more.
    m.repo.searchCorpusSkills.mockResolvedValueOnce([...CORPUS_SKILLS]);
    const out = await m.service.searchSkills({ q: "weld", limit: 2 });
    expect(m.repo.searchCorpusSkills).toHaveBeenCalledWith("weld", 3);
    expect(out.skills).toHaveLength(2);
    expect(out.truncated).toBe(true);
  });

  it("echoes the term, so a stale response is not read as a newer keystroke's answer", async () => {
    const out = await m.service.searchSkills({ q: "weld", limit: 20 });
    expect(out.q).toBe("weld");
  });

  it("creates nothing and emits nothing", async () => {
    await m.service.searchSkills({ q: "weld", limit: 20 });
    expect(m.events.emit).not.toHaveBeenCalled();
    expect(m.repo.withTransaction).not.toHaveBeenCalled();
  });
});