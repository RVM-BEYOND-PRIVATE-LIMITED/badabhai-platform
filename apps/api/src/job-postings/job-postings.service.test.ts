import "reflect-metadata";
import { describe, it, expect, vi } from "vitest";
import { BadRequestException, ConflictException, NotFoundException } from "@nestjs/common";
import { fakeAiTraceRecorder } from "../ai/ai-trace-recorder.fake";
import { EventsService } from "../events/events.service";
import { JobPostingsService } from "./job-postings.service";
import { AGENCY_TWIN_READ_ONLY_MESSAGE } from "../common/agency-twin-fence";
import { TRADE_FORM_KINDS_ALL } from "@badabhai/types";
import {
  CreateJobPostingSchema,
  PayerCreateJobPostingSchema,
  UpdateJobPostingSchema,
  type CreateJobPostingDto,
} from "./job-postings.dto";

const POSTING_ID = "33333333-3333-4333-8333-333333333333";
const CREATED_BY = "44444444-4444-4444-8444-444444444444";
const PAYER_ID = "55555555-5555-4555-8555-555555555555";
const CTX = { correlationId: "22222222-2222-4222-8222-222222222222", requestId: "req-1" };

// Free-text values used in tests — NONE of these may ever appear in an emitted
// payload (the events carry the FACT, not the value).
const ORG = "Acme CNC Works Pvt Ltd";
const ROLE = "VMC Operator";
const LOCATION = "Pune, Maharashtra 411001";
const DESC = "Night shift, 2 years experience preferred, own transport.";
const FREE_TEXT = [ORG, ROLE, LOCATION, DESC];

type Row = {
  id: string;
  createdBy: string;
  orgLabel: string;
  roleTitle: string;
  locationLabel: string | null;
  description: string | null;
  vacancyBand: string;
  status: "draft" | "open" | "paused" | "closed";
  verificationStatus: "unverified" | "verified" | "rejected";
  skillPhrases: string[];
  skillIds: string[];
  /**
   * The posting's CANONICAL `jd_*` domain (migration 0076). NULL in the fixture because
   * it is NULL in production: the column is unbackfilled and no write path in this module
   * sets it. Tests that exercise the canonical canonicalization scope override it.
   */
  jobDomainId: string | null;
  untickedRelatedIds: string[];
  /** Migration 0131 — the display role. NULL for every posting nobody picked one for. */
  roleKind: string | null;
  /** ADR-0050 — 'agency_job' on a system-owned agency twin, NULL on every other posting. */
  syncSource: string | null;
  createdAt: Date;
  updatedAt: Date;
  closedAt: Date | null;
};

function row(overrides: Partial<Row> = {}): Row {
  return {
    id: POSTING_ID,
    createdBy: CREATED_BY,
    orgLabel: ORG,
    roleTitle: ROLE,
    locationLabel: null,
    description: null,
    vacancyBand: "2-5",
    status: "draft",
    verificationStatus: "unverified",
    skillPhrases: [],
    skillIds: [],
    jobDomainId: null,
    untickedRelatedIds: [],
    roleKind: null,
    syncSource: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    closedAt: null,
    ...overrides,
  };
}

/** Convert a camelCase Row to the JobPostingApi snake_case shape the service expects. */
function toApi(r: Row) {
  return {
    id: r.id,
    created_by: r.createdBy,
    payer_id: null,
    org_label: r.orgLabel,
    role_title: r.roleTitle,
    location_label: r.locationLabel,
    description: r.description,
    vacancy_band: r.vacancyBand,
    status: r.status,
    verification_status: r.verificationStatus,
    verified: r.verificationStatus === "verified",
    skill_phrases: r.skillPhrases,
    skill_ids: r.skillIds,
    job_domain_id: r.jobDomainId,
    // ADR-0036 (migration 0054) — the matchable + worker-visible fields the served
    // entity gained. The real mapper always populates these (both jsonb columns default
    // to '[]', so neither is ever null); the fixture mirrors that rather than omitting
    // them, so the service is exercised against a row shaped like a real one.
    match_skill_ids: [],
    reach_skill_ids: [],
    // #1645 — the poster's untick REQUEST, stored on the row since migration 0121. Defaults
    // '[]' in the DB, so the fixture mirrors that rather than omitting it.
    unticked_related_ids: r.untickedRelatedIds,
    city: null,
    // #1646/#1648 — the worker-visible card content. jsonb with NO default, so NULL is the
    // honest "never stated" and the fixture carries NULL, not [].
    area: null,
    min_experience_years: null,
    max_experience_years: null,
    benefits: null,
    requirements: null,
    pay_min: null,
    pay_max: null,
    pay_type: null,
    shift: null,
    needed_by: null,
    // Migration 0131 — mapped off the row like the real `toJobPostingApi`, so a create that
    // stores a role echoes it back and the created event can be asserted on it.
    role_kind: r.roleKind,
    published_at: null,
    boosted_until: null,
    created_at: r.createdAt,
    updated_at: r.updatedAt,
    closed_at: r.closedAt,
    sync_source: r.syncSource,
  };
}

type PostingApi = ReturnType<typeof toApi>;

function make(existing?: Row, opts: { events?: unknown } = {}) {
  const emit = vi.fn().mockResolvedValue(undefined);
  // #1928 — A TRANSACTION THAT BEHAVES LIKE ONE. A posting written on the `tx` handed to the
  // `withTransaction` callback is returned at once but PERSISTS only when the callback
  // resolves; a throw discards it, as a ROLLBACK would. A write with NO executor autocommits,
  // which is what `create` did before #1928 — so "no posting survives a failed emit" fails
  // against a service that writes the row outside the transaction.
  const TX = { executor: "job-postings-test-tx" };
  const persisted: PostingApi[] = [];
  let pending: PostingApi[] | null = null;
  const stage = (posting: PostingApi, tx?: unknown): Promise<PostingApi> => {
    if (tx === undefined) persisted.push(posting);
    else if (tx === TX && pending !== null) pending.push(posting);
    else throw new Error("posting written on an executor that is not the open transaction");
    return Promise.resolve(posting);
  };
  const withTransaction = vi.fn(async (work: (tx: unknown) => Promise<unknown>) => {
    pending = [];
    try {
      const out = await work(TX);
      persisted.push(...pending);
      return out;
    } finally {
      pending = null;
    }
  });
  const create = vi
    .fn()
    .mockImplementation((input: Partial<Row>, tx?: unknown) => stage(toApi(row(input)), tx));
  const findById = vi.fn().mockResolvedValue(existing ? toApi(existing) : undefined);
  const update = vi
    .fn()
    .mockImplementation((id: string, patch: Partial<Row>) =>
      Promise.resolve(existing ? toApi(row({ ...existing, ...patch, id })) : undefined),
    );
  const close = vi
    .fn()
    .mockImplementation((id: string, _prev: "draft" | "open", closedAt: Date) =>
      Promise.resolve(
        existing ? toApi(row({ ...existing, id, status: "closed", closedAt })) : undefined,
      ),
    );
  const list = vi.fn().mockResolvedValue([]);
  // Payer owner-scoped repo methods (default: the row IS owned; tests override
  // findByIdAndPayer with undefined to exercise the not-owned / no-oracle path).
  const findByIdAndPayer = vi.fn().mockResolvedValue(existing ? toApi(existing) : undefined);
  const listByPayer = vi.fn().mockResolvedValue([]);
  const updateOwned = vi
    .fn()
    .mockImplementation((id: string, _payerId: string, patch: Partial<Row>) =>
      Promise.resolve(existing ? toApi(row({ ...existing, ...patch, id })) : undefined),
    );
  const closeOwned = vi
    .fn()
    .mockImplementation((id: string, _payerId: string, _prev: "draft" | "open", closedAt: Date) =>
      Promise.resolve(
        existing ? toApi(row({ ...existing, id, status: "closed", closedAt })) : undefined,
      ),
    );
  // Owner + status-guarded transition (B1): only transitions when the existing row's status
  // matches `fromStatus` (mirrors the DB WHERE guard); otherwise undefined → the service 409s.
  const transitionOwned = vi
    .fn()
    .mockImplementation(
      (id: string, _payerId: string, fromStatus: Row["status"], toStatus: Row["status"]) =>
        Promise.resolve(
          existing && existing.status === fromStatus
            ? toApi(row({ ...existing, id, status: toStatus }))
            : undefined,
        ),
    );
  const canonicalize = vi
    .fn()
    .mockResolvedValue({ status: "unresolved", skill_id: null, score: null, ai_metadata: null });
  // Typed to `AiCostRecorder.record`'s real signature so `mock.calls[n][i]` stays checked —
  // an untyped `vi.fn()` makes every argument assertion below silently `any`.
  const recordAiCost = vi.fn(
    async (
      _meta: unknown,
      _taskType: string,
      _aiJobId: string | null,
      _correlationId: string,
      _requestId: string,
    ) => {},
  );
  const traces = fakeAiTraceRecorder();
  const materializeReach = vi.fn().mockResolvedValue({
    jobPostingId: "posting",
    matchSkillIds: [],
    reachSkillIds: [],
    appliedUntickedIds: [],
    reachTotal: 0,
    reachTier1: 0,
    reachTier2: 0,
    zeroReach: true,
  });
  const resolveForPublish = vi.fn().mockResolvedValue({
    postedSkillIds: [],
    reachSkillIds: [],
    appliedUntickedIds: [],
  });
  const opsWiden = vi.fn().mockResolvedValue({});
  const svc = new JobPostingsService(
    {
      withTransaction,
      create,
      findById,
      update,
      close,
      list,
      findByIdAndPayer,
      listByPayer,
      updateOwned,
      closeOwned,
      transitionOwned,
    } as never,
    // #1928: a test can pass the REAL EventsService (over a fake events repository) to prove
    // the transaction reaches the events insert; every other test counts calls on `emit`.
    (opts.events ?? { emit }) as never,
    // TAX-6: AiService stub — canonicalize returns UNRESOLVED unless a test overrides.
    { canonicalizeSkill: canonicalize } as never,
    // #745: one `ai.cost_recorded` per canonicalized phrase. Stubbed so a test can count
    // the fan-out — a 3-skill posting must produce 3 records, not 1.
    { record: recordAiCost } as never,
    // 0083: the trace recorder, as the SHARED fake rather than a stub — it reproduces the
    // real recorder's short-circuits, so `traces.dropped` below is a claim about production
    // behaviour (payer spend has no worker, so no trace is ever stored) rather than about
    // this double.
    traces.recorder,
    // ADR-0036 moment ③. These cases exercise the ops/payer lifecycle, not reach; a
    // resolving stub keeps `materializeIfNeeded` inert. Reach materialization has its
    // own coverage in `apps/api/src/match/`.
    { materialize: materializeReach, opsWiden } as never,
    // #1645 — closed-set + cap validation for `match_skill_ids` AT CREATE. Resolves by
    // default so the lifecycle cases stay about the lifecycle; the create-path cases
    // override it to assert that an unknown id 400s on the form rather than at publish.
    { resolveForPublish: resolveForPublish } as never,
  );
  return {
    svc,
    emit,
    opsWiden,
    TX,
    persisted,
    stage,
    withTransaction,
    resolveForPublish,
    canonicalize,
    recordAiCost,
    traces,
    materializeReach,
    create,
    findById,
    update,
    close,
    list,
    findByIdAndPayer,
    listByPayer,
    updateOwned,
    closeOwned,
    transitionOwned,
  };
}

/** Deep-scan any emitted payload for forbidden free-text values. */
function assertNoFreeText(payload: Record<string, unknown>): void {
  const serialized = JSON.stringify(payload);
  for (const text of FREE_TEXT) {
    expect(serialized).not.toContain(text);
  }
}

/**
 * #745 — skill_embedding spend reaches the ledger.
 *
 * The defect this locks: `AiCostRecorder` swallows emit failures by design, so an
 * uninstrumented surface does not raise — it produces an empty result for
 * `SELECT ... WHERE task_type = 'skill_embedding'`, which reads as "no spend" rather than
 * "not instrumented". Only a test that COUNTS the records can tell those apart.
 */
describe("JobPostingsService — one cost record per embed (#745)", () => {
  const THREE_SKILLS = ["welding", "vmc operation", "fanuc control"];

  it("records ONE ai.cost_recorded per phrase — a 3-skill posting is 3 billable embeds", async () => {
    const { svc, recordAiCost, canonicalize } = make();
    canonicalize.mockResolvedValue({
      status: "matched",
      skill_id: "skill_welding",
      score: 0.91,
      ai_metadata: { ai_call_id: "call-1", model_name: "text-embedding-004", real_call: true },
    });

    await svc.create(
      { created_by: CREATED_BY, org_label: ORG, role_title: ROLE, skills: THREE_SKILLS },
      CTX as never,
    );

    // The fan-out is the whole point: a per-POSTING record would report 1 and under-count
    // this surface by the number of skills on every posting ever created.
    expect(recordAiCost).toHaveBeenCalledTimes(3);
    for (const call of recordAiCost.mock.calls) {
      expect(call[1]).toBe("skill_embedding");
      // No `ai_jobs` row backs an inline posting write — null is the honest job id.
      expect(call[2]).toBeNull();
    }
  });

  it("records the embed even when the phrase does NOT resolve — a miss costs the same", async () => {
    // Ledgering only the matches would under-count exactly the phrases the vocabulary is
    // worst at, which are the ones that justify growing it.
    const { svc, recordAiCost } = make(); // default stub returns `unresolved`
    await svc.create(
      { created_by: CREATED_BY, org_label: ORG, role_title: ROLE, skills: THREE_SKILLS },
      CTX as never,
    );
    expect(recordAiCost).toHaveBeenCalledTimes(3);
    expect(recordAiCost.mock.calls[0]![1]).toBe("skill_embedding");
  });

  it("passes null metadata straight through when the ai-service is unreachable", async () => {
    // `canonicalizeSkill` resolves null on an unreachable service. `record` no-ops on null,
    // so nothing is emitted — an absent record, never a fabricated ₹0 one.
    const { svc, recordAiCost, canonicalize } = make();
    canonicalize.mockResolvedValue(null);
    await svc.create(
      { created_by: CREATED_BY, org_label: ORG, role_title: ROLE, skills: THREE_SKILLS },
      CTX as never,
    );
    expect(recordAiCost).toHaveBeenCalledTimes(3);
    for (const call of recordAiCost.mock.calls) expect(call[0]).toBeNull();
  });

  it("makes no cost call at all when the posting carries no skills", async () => {
    const { svc, recordAiCost } = make();
    await svc.create({ created_by: CREATED_BY, org_label: ORG, role_title: ROLE }, CTX as never);
    expect(recordAiCost).not.toHaveBeenCalled();
  });
});

describe("JobPostingsService.create", () => {
  it("creates as draft and emits job_posting.created with correct flags", async () => {
    const { svc, emit, create } = make();
    await svc.create(
      {
        created_by: CREATED_BY,
        org_label: ORG,
        role_title: ROLE,
        location_label: LOCATION,
        description: DESC,
        vacancy_band: "6-10",
      },
      CTX as never,
    );

    // status forced to draft regardless of input shape.
    expect(create.mock.calls[0]![0]).toMatchObject({ status: "draft" });

    expect(emit).toHaveBeenCalledOnce();
    const arg = emit.mock.calls[0]![0];
    expect(arg.event_name).toBe("job_posting.created");
    expect(arg.actor).toEqual({ actor_type: "ops", actor_id: CREATED_BY });
    expect(arg.subject).toEqual({ subject_type: "job_posting", subject_id: POSTING_ID });
    expect(arg.payload).toEqual({
      job_posting_id: POSTING_ID,
      vacancy_band: "6-10",
      status: "draft",
      created_by: CREATED_BY,
      has_location: true,
      has_description: true,
      // Migration 0131 — no role picked on this create, so the event says so explicitly.
      role_kind: null,
    });
    assertNoFreeText(arg.payload);
  });

  it("sets has_location/has_description false when omitted", async () => {
    const { svc, emit } = make();
    await svc.create(
      { created_by: CREATED_BY, org_label: ORG, role_title: ROLE, vacancy_band: "1" },
      CTX as never,
    );
    const arg = emit.mock.calls[0]![0];
    expect(arg.payload.has_location).toBe(false);
    expect(arg.payload.has_description).toBe(false);
    assertNoFreeText(arg.payload);
  });

  it("derives the band from a raw vacancies count and stores/events ONLY the band", async () => {
    const { svc, emit, create } = make();
    await svc.create(
      { created_by: CREATED_BY, org_label: ORG, role_title: ROLE, vacancies: 7 },
      CTX as never,
    );

    // 7 -> "6-10" persisted; the raw integer is never written.
    const storeArg = create.mock.calls[0]![0];
    expect(storeArg.vacancyBand).toBe("6-10");
    expect("vacancies" in storeArg).toBe(false);

    // ...and only the derived band is evented — never the raw count.
    const arg = emit.mock.calls[0]![0];
    expect(arg.payload.vacancy_band).toBe("6-10");
    expect(JSON.stringify(arg.payload)).not.toContain("vacancies");
    expect(JSON.stringify(arg.payload)).not.toContain(":7");
    assertNoFreeText(arg.payload);
  });
});

/**
 * #1928 — THE POSTING ROW AND ITS `job_posting.created` COMMIT TOGETHER, OR NEITHER DOES.
 *
 * The insert used to commit on its own, and the emit ran after it outside any transaction. An
 * emit that threw (`createEvent` rejecting the payload, or a failed `events` insert) left a
 * committed posting with no `job_posting.created` on the spine. The chat publish saw the throw,
 * released its claim, and a retry created a SECOND posting.
 *
 * `make()`'s repository fake models a transaction (see there). These cases run both create
 * surfaces, because both go through the one `insertAndEmit` chokepoint and both inherit the
 * atomicity. The real-Postgres proof, through the chat publish, is the #1928 block in
 * `job-posting-chat.repository.db.test.ts`.
 */
describe("#1928 — create commits the posting row and job_posting.created atomically", () => {
  const OPS_DTO = {
    created_by: CREATED_BY,
    org_label: ORG,
    role_title: ROLE,
    vacancy_band: "2-5" as const,
  };
  const PAYER_DTO = { org_label: ORG, role_title: ROLE, vacancy_band: "2-5" as const };
  type Svc = ReturnType<typeof make>["svc"];
  const SURFACES: [string, (svc: Svc) => Promise<{ id: string }>][] = [
    ["ops create", (svc) => svc.create(OPS_DTO, CTX as never)],
    ["payer createForPayer", (svc) => svc.createForPayer(PAYER_ID, PAYER_DTO, CTX as never)],
  ];

  it.each(SURFACES)(
    "%s: an emit that throws AFTER the insert persists no posting, and the error reaches the caller",
    async (_surface, run) => {
      const d = make();
      d.emit.mockRejectedValueOnce(new Error("events insert failed"));

      await expect(run(d.svc)).rejects.toThrow("events insert failed");
      // The insert DID run. This is the after-the-insert case the issue names, not a refusal
      // before it, so an empty store means the row was rolled back, not never written.
      expect(d.create).toHaveBeenCalledOnce();
      expect(d.emit).toHaveBeenCalledOnce();
      expect(d.persisted).toEqual([]);
    },
  );

  it.each(SURFACES)(
    "%s: the event rides the SAME transaction as the row, and both persist on success",
    async (_surface, run) => {
      const d = make();
      const created = await run(d.svc);

      expect(d.withTransaction).toHaveBeenCalledOnce();
      expect(d.create.mock.calls[0]![1]).toBe(d.TX);
      expect(d.emit).toHaveBeenCalledOnce();
      expect(d.emit.mock.calls[0]![0].event_name).toBe("job_posting.created");
      expect(d.emit.mock.calls[0]![0].tx).toBe(d.TX);
      expect(d.persisted.map((p) => p.id)).toEqual([created.id]);
    },
  );

  it("through the REAL EventsService: the transaction is the events insert's executor, and a failed insert persists no posting", async () => {
    const insert = vi.fn(
      async (_event: unknown, _key?: string | null, _executor?: unknown): Promise<boolean> => {
        throw new Error("could not write to the events table");
      },
    );
    const events = new EventsService({ insert } as never, { NODE_ENV: "test" } as never);
    const d = make(undefined, { events });

    await expect(d.svc.createForPayer(PAYER_ID, PAYER_DTO, CTX as never)).rejects.toThrow(
      "could not write to the events table",
    );
    expect(insert).toHaveBeenCalledOnce();
    // `EmitParams.tx` reached `EventsRepository.insert`, so the event row is written on the
    // posting's transaction rather than standalone on the injected db.
    expect(insert.mock.calls[0]![2]).toBe(d.TX);
    expect(d.persisted).toEqual([]);
  });

  it("through the REAL EventsService: a payload createEvent() rejects after the insert persists no posting", async () => {
    const insert = vi.fn(async (): Promise<boolean> => true);
    const events = new EventsService({ insert } as never, { NODE_ENV: "test" } as never);
    const d = make(undefined, { events });
    // A stored value the event registry does not accept, e.g. a role added to the column
    // before the event enum learned it. The row exists, then building its event throws.
    d.create.mockImplementationOnce((input: Partial<Row>, tx?: unknown) =>
      d.stage({ ...toApi(row(input)), role_kind: "not_a_registered_role" }, tx),
    );

    await expect(d.svc.createForPayer(PAYER_ID, PAYER_DTO, CTX as never)).rejects.toThrow();
    expect(d.create).toHaveBeenCalledOnce();
    expect(insert).not.toHaveBeenCalled();
    expect(d.persisted).toEqual([]);
  });

  it("opens the transaction only AFTER the ai-service fan-out and the closed-set check, so no transaction is held across a network call", async () => {
    const d = make();
    await d.svc.createForPayer(
      PAYER_ID,
      { ...PAYER_DTO, skills: ["welding"], match_skill_ids: ["mskill_welding"] },
      CTX as never,
    );

    const opened = d.withTransaction.mock.invocationCallOrder[0]!;
    expect(opened).toBeDefined();
    // canonicalize is an ai-service round trip (up to the client timeout per phrase), and the
    // cost record is a write of its own. Neither may run while the posting's transaction is open.
    expect(d.canonicalize.mock.invocationCallOrder[0]!).toBeLessThan(opened);
    expect(d.recordAiCost.mock.invocationCallOrder[0]!).toBeLessThan(opened);
    expect(d.resolveForPublish.mock.invocationCallOrder[0]!).toBeLessThan(opened);
  });
});

describe("CreateJobPostingSchema vacancy intake (band XOR raw count)", () => {
  const base = { created_by: CREATED_BY, org_label: ORG, role_title: ROLE };

  it("accepts a pre-chosen vacancy_band (existing callers unchanged)", () => {
    expect(CreateJobPostingSchema.safeParse({ ...base, vacancy_band: "6-10" }).success).toBe(true);
  });

  it("accepts a raw vacancies count", () => {
    expect(CreateJobPostingSchema.safeParse({ ...base, vacancies: 7 }).success).toBe(true);
  });

  it("rejects neither vacancy_band nor vacancies", () => {
    expect(CreateJobPostingSchema.safeParse({ ...base }).success).toBe(false);
  });

  it("rejects BOTH vacancy_band and vacancies", () => {
    expect(
      CreateJobPostingSchema.safeParse({ ...base, vacancy_band: "6-10", vacancies: 7 }).success,
    ).toBe(false);
  });

  it("rejects a non-positive / non-integer vacancies", () => {
    expect(CreateJobPostingSchema.safeParse({ ...base, vacancies: 0 }).success).toBe(false);
    expect(CreateJobPostingSchema.safeParse({ ...base, vacancies: -3 }).success).toBe(false);
    expect(CreateJobPostingSchema.safeParse({ ...base, vacancies: 2.5 }).success).toBe(false);
  });
});

describe("UpdateJobPostingSchema vacancy intake", () => {
  it("accepts a raw vacancies count on update", () => {
    expect(UpdateJobPostingSchema.safeParse({ vacancies: 12 }).success).toBe(true);
  });

  it("rejects BOTH vacancy_band and vacancies on update", () => {
    expect(UpdateJobPostingSchema.safeParse({ vacancy_band: "11-25", vacancies: 12 }).success).toBe(
      false,
    );
  });
});

describe("JobPostingsService.update", () => {
  it("emits job_posting.updated with changed_fields KEYS only (no free-text values)", async () => {
    const { svc, emit } = make(row({ status: "draft", vacancyBand: "2-5" }));
    await svc.update(
      POSTING_ID,
      { role_title: "CNC Operator", vacancy_band: "11-25" },
      CTX as never,
    );

    const arg = emit.mock.calls[0]![0];
    expect(arg.event_name).toBe("job_posting.updated");
    expect(arg.actor).toEqual({ actor_type: "ops", actor_id: CREATED_BY });
    expect(arg.subject).toEqual({ subject_type: "job_posting", subject_id: POSTING_ID });
    expect(arg.payload.changed_fields).toEqual(["role_title", "vacancy_band"]);
    expect(arg.payload.vacancy_band).toBe("11-25");
    expect(arg.payload.status).toBe("draft");
    // KEYS only — never the new values.
    assertNoFreeText(arg.payload);
    expect(arg.payload.changed_fields).not.toContain("CNC Operator");
  });

  it("derives the band from a raw vacancies count on update (stores/events band only)", async () => {
    const { svc, emit, update } = make(row({ status: "draft", vacancyBand: "2-5" }));
    await svc.update(POSTING_ID, { vacancies: 7 }, CTX as never);

    // 7 -> "6-10" patched; never the raw integer.
    const patch = update.mock.calls[0]![1];
    expect(patch.vacancyBand).toBe("6-10");
    expect("vacancies" in patch).toBe(false);

    const arg = emit.mock.calls[0]![0];
    expect(arg.payload.changed_fields).toEqual(["vacancy_band"]);
    expect(arg.payload.vacancy_band).toBe("6-10");
    expect(JSON.stringify(arg.payload)).not.toContain(":7");
  });

  it("publishes draft -> open via status, with vacancy_band null when band unchanged", async () => {
    const { svc, emit } = make(row({ status: "draft", vacancyBand: "2-5" }));
    await svc.update(POSTING_ID, { status: "open" }, CTX as never);

    const arg = emit.mock.calls[0]![0];
    expect(arg.payload.changed_fields).toEqual(["status"]);
    expect(arg.payload.status).toBe("open");
    expect(arg.payload.vacancy_band).toBeNull();
  });

  it("404s when the posting is missing and does not emit", async () => {
    const { svc, emit } = make(undefined);
    await expect(svc.update(POSTING_ID, { role_title: "X" }, CTX as never)).rejects.toBeInstanceOf(
      NotFoundException,
    );
    expect(emit).not.toHaveBeenCalled();
  });

  it("409s on any edit to a closed posting (terminal) and does not emit", async () => {
    const { svc, emit } = make(row({ status: "closed" }));
    await expect(svc.update(POSTING_ID, { role_title: "X" }, CTX as never)).rejects.toBeInstanceOf(
      ConflictException,
    );
    expect(emit).not.toHaveBeenCalled();
  });

  it("409s on an open -> draft attempt is impossible via DTO; open->open publish rejected", async () => {
    // status="open" on an already-open posting is not a valid transition (only
    // draft->open is allowed via PATCH).
    const { svc, emit } = make(row({ status: "open" }));
    await expect(svc.update(POSTING_ID, { status: "open" }, CTX as never)).rejects.toBeInstanceOf(
      ConflictException,
    );
    expect(emit).not.toHaveBeenCalled();
  });

  it("rejects a no-op edit (no effective changes) without emitting", async () => {
    const { svc, emit } = make(row({ status: "draft", roleTitle: ROLE }));
    await expect(svc.update(POSTING_ID, { role_title: ROLE }, CTX as never)).rejects.toBeInstanceOf(
      BadRequestException,
    );
    expect(emit).not.toHaveBeenCalled();
  });
});

describe("JobPostingsService.close", () => {
  it("closes a draft posting and emits previous_status=draft", async () => {
    const { svc, emit } = make(row({ status: "draft" }));
    await svc.close(POSTING_ID, CTX as never);

    const arg = emit.mock.calls[0]![0];
    expect(arg.event_name).toBe("job_posting.closed");
    expect(arg.actor).toEqual({ actor_type: "ops", actor_id: CREATED_BY });
    expect(arg.subject).toEqual({ subject_type: "job_posting", subject_id: POSTING_ID });
    expect(arg.payload).toEqual({
      job_posting_id: POSTING_ID,
      previous_status: "draft",
      status: "closed",
    });
    assertNoFreeText(arg.payload);
  });

  it("closes an open posting and emits previous_status=open", async () => {
    const { svc, emit } = make(row({ status: "open" }));
    await svc.close(POSTING_ID, CTX as never);
    expect(emit.mock.calls[0]![0].payload.previous_status).toBe("open");
  });

  it("404s when the posting is missing and does not emit", async () => {
    const { svc, emit } = make(undefined);
    await expect(svc.close(POSTING_ID, CTX as never)).rejects.toBeInstanceOf(NotFoundException);
    expect(emit).not.toHaveBeenCalled();
  });

  it("409s when the posting is already closed and does not emit", async () => {
    const { svc, emit } = make(row({ status: "closed" }));
    await expect(svc.close(POSTING_ID, CTX as never)).rejects.toBeInstanceOf(ConflictException);
    expect(emit).not.toHaveBeenCalled();
  });
});

describe("JobPostingsService.pauseForPayer / resumeForPayer (B1)", () => {
  const PAYER = "aaaaaaaa-0000-4000-8000-000000000001";

  it("pauses an OPEN posting (open -> paused) and emits a PII-free job_posting.paused (payer actor)", async () => {
    const { svc, emit, transitionOwned } = make(row({ status: "open" }));
    const res = await svc.pauseForPayer(POSTING_ID, PAYER, CTX as never);
    expect(res.status).toBe("paused");
    expect(transitionOwned).toHaveBeenCalledWith(POSTING_ID, PAYER, "open", "paused");
    const arg = emit.mock.calls[0]![0];
    expect(arg.event_name).toBe("job_posting.paused");
    expect(arg.actor).toEqual({ actor_type: "payer", actor_id: PAYER });
    expect(arg.subject).toEqual({ subject_type: "job_posting", subject_id: POSTING_ID });
    expect(arg.payload).toEqual({
      job_posting_id: POSTING_ID,
      previous_status: "open",
      status: "paused",
    });
    assertNoFreeText(arg.payload);
  });

  it("resumes a PAUSED posting (paused -> open) and emits job_posting.resumed", async () => {
    const { svc, emit, transitionOwned } = make(row({ status: "paused" }));
    const res = await svc.resumeForPayer(POSTING_ID, PAYER, CTX as never);
    expect(res.status).toBe("open");
    expect(transitionOwned).toHaveBeenCalledWith(POSTING_ID, PAYER, "paused", "open");
    const arg = emit.mock.calls[0]![0];
    expect(arg.event_name).toBe("job_posting.resumed");
    expect(arg.payload).toEqual({
      job_posting_id: POSTING_ID,
      previous_status: "paused",
      status: "open",
    });
    assertNoFreeText(arg.payload);
  });

  it("409s when pausing a non-open posting (draft) and does not emit", async () => {
    const { svc, emit } = make(row({ status: "draft" }));
    await expect(svc.pauseForPayer(POSTING_ID, PAYER, CTX as never)).rejects.toBeInstanceOf(
      ConflictException,
    );
    expect(emit).not.toHaveBeenCalled();
  });

  it("409s when resuming a non-paused posting (open) and does not emit", async () => {
    const { svc, emit } = make(row({ status: "open" }));
    await expect(svc.resumeForPayer(POSTING_ID, PAYER, CTX as never)).rejects.toBeInstanceOf(
      ConflictException,
    );
    expect(emit).not.toHaveBeenCalled();
  });

  it("404s (no-oracle) when the posting is unknown OR another payer's, and does not emit", async () => {
    const { svc, emit } = make(undefined); // findByIdAndPayer → undefined (not-found OR foreign)
    await expect(svc.pauseForPayer(POSTING_ID, PAYER, CTX as never)).rejects.toBeInstanceOf(
      NotFoundException,
    );
    expect(emit).not.toHaveBeenCalled();
  });
});

describe("JobPostingsService.getOne / list", () => {
  it("404s on a missing posting", async () => {
    const { svc } = make(undefined);
    await expect(svc.getOne(POSTING_ID)).rejects.toBeInstanceOf(NotFoundException);
  });

  it("passes the status filter through to the repository", async () => {
    const { svc, list } = make();
    await svc.list({ status: "open" });
    expect(list).toHaveBeenCalledWith("open");
  });
});

// ---------------------------------------------------------------------------
// DTO guards (Zod) — length caps on all four free-text fields, and the
// worker-visible screen on role_title + description only (org_label and
// location_label stay unscreened). The full screen matrix lives in
// `job-postings.dto.test.ts` (#1823 B3).
// ---------------------------------------------------------------------------
describe("CreateJobPostingSchema PII + length guards", () => {
  const base = {
    created_by: CREATED_BY,
    org_label: ORG,
    role_title: ROLE,
    vacancy_band: "1" as const,
  };

  it("rejects a phone number in the description", () => {
    const r = CreateJobPostingSchema.safeParse({
      ...base,
      description: "Call the supervisor at 9876543210 to apply.",
    });
    expect(r.success).toBe(false);
  });

  it("rejects an email in the description", () => {
    const r = CreateJobPostingSchema.safeParse({
      ...base,
      description: "Send your details to hr@acme.example.com",
    });
    expect(r.success).toBe(false);
  });

  it("ALLOWS a long digit run in org_label (machine model / job code — not screened)", () => {
    const r = CreateJobPostingSchema.safeParse({
      ...base,
      org_label: "Haas VF-2SS 1234567890 Line",
    });
    expect(r.success).toBe(true);
  });

  it("ALLOWS a pincode-like digit run in location_label (not screened)", () => {
    const r = CreateJobPostingSchema.safeParse({
      ...base,
      location_label: "MIDC Bhosari 411026",
    });
    expect(r.success).toBe(true);
  });

  it("rejects an over-length org_label (>200)", () => {
    const r = CreateJobPostingSchema.safeParse({ ...base, org_label: "a".repeat(201) });
    expect(r.success).toBe(false);
  });

  it("rejects an over-length description (>2000)", () => {
    const r = CreateJobPostingSchema.safeParse({ ...base, description: "a".repeat(2001) });
    expect(r.success).toBe(false);
  });

  it("ignores a client-supplied status (not part of the create schema)", () => {
    const parsed = CreateJobPostingSchema.parse({
      ...base,
      status: "open",
    } as unknown as CreateJobPostingDto);
    expect("status" in parsed).toBe(false);
  });
});

describe("UpdateJobPostingSchema status guard", () => {
  it("rejects status='closed' via PATCH (close is a separate endpoint)", () => {
    const r = UpdateJobPostingSchema.safeParse({ status: "closed" });
    expect(r.success).toBe(false);
  });

  it("rejects status='draft' via PATCH (no reopen / un-publish)", () => {
    const r = UpdateJobPostingSchema.safeParse({ status: "draft" });
    expect(r.success).toBe(false);
  });

  it("accepts status='open' (publish)", () => {
    const r = UpdateJobPostingSchema.safeParse({ status: "open" });
    expect(r.success).toBe(true);
  });

  it("rejects an empty patch", () => {
    const r = UpdateJobPostingSchema.safeParse({});
    expect(r.success).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// PAYER self-serve surface (ADR-0019 / ADR-0022 module 9) — owner-scoped CRUD,
// session payer stamped as owner, payer event actor, no-oracle 404.
// ---------------------------------------------------------------------------
describe("JobPostingsService — payer self-serve (*ForPayer)", () => {
  it("createForPayer stamps the SESSION payer as owner AND created_by, status=draft", async () => {
    const { svc, create, TX } = make();
    await svc.createForPayer(
      PAYER_ID,
      { org_label: ORG, role_title: ROLE, vacancy_band: "2-5" },
      CTX as never,
    );
    // The row is created with payerId = createdBy = the session payer; status draft — on the
    // transaction its `job_posting.created` rides (#1928).
    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({ payerId: PAYER_ID, createdBy: PAYER_ID, status: "draft" }),
      TX,
    );
  });

  it("createForPayer emits job_posting.created with the PAYER actor, payload PII-free + payer-free", async () => {
    const { svc, emit } = make();
    await svc.createForPayer(
      PAYER_ID,
      { org_label: ORG, role_title: ROLE, location_label: LOCATION, vacancies: 7 },
      CTX as never,
    );
    const arg = emit.mock.calls[0]![0] as Record<string, unknown>;
    expect(arg.event_name).toBe("job_posting.created");
    expect(arg.actor).toEqual({ actor_type: "payer", actor_id: PAYER_ID });
    const payload = arg.payload as Record<string, unknown>;
    // created_by carries the opaque payer id; there is NO payer_id payload key.
    expect(payload.created_by).toBe(PAYER_ID);
    expect(payload).not.toHaveProperty("payer_id");
    assertNoFreeText(payload); // org/role/location free text never leaves the row
  });

  it("listForPayer + getOneForPayer scope to the session payer", async () => {
    const { svc, listByPayer, findByIdAndPayer } = make(row({ payerId: PAYER_ID } as Partial<Row>));
    await svc.listForPayer(PAYER_ID, { status: "open" });
    expect(listByPayer).toHaveBeenCalledWith(PAYER_ID, "open");
    await svc.getOneForPayer(POSTING_ID, PAYER_ID);
    expect(findByIdAndPayer).toHaveBeenCalledWith(POSTING_ID, PAYER_ID);
  });

  it("getOneForPayer 404s (no-oracle) for an unknown OR another payer's posting", async () => {
    const { svc, findByIdAndPayer } = make();
    findByIdAndPayer.mockResolvedValueOnce(undefined); // not found OR not owned — same result
    await expect(svc.getOneForPayer(POSTING_ID, PAYER_ID)).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });

  it("updateForPayer reads + writes owner-scoped and emits the PAYER actor", async () => {
    const existing = row({ status: "draft", payerId: PAYER_ID } as Partial<Row>);
    const { svc, emit, findByIdAndPayer, updateOwned, update } = make(existing);
    await svc.updateForPayer(POSTING_ID, PAYER_ID, { role_title: "CNC Operator" }, CTX as never);
    expect(findByIdAndPayer).toHaveBeenCalledWith(POSTING_ID, PAYER_ID);
    expect(updateOwned).toHaveBeenCalledWith(
      POSTING_ID,
      PAYER_ID,
      expect.objectContaining({ roleTitle: "CNC Operator" }),
    );
    // The ops (unscoped) update path is NEVER used by the payer surface.
    expect(update).not.toHaveBeenCalled();
    const arg = emit.mock.calls[0]![0] as Record<string, unknown>;
    expect(arg.actor).toEqual({ actor_type: "payer", actor_id: PAYER_ID });
  });

  it("updateForPayer 404s (no-oracle) for a not-owned posting BEFORE any write", async () => {
    const { svc, findByIdAndPayer, updateOwned } = make();
    findByIdAndPayer.mockResolvedValueOnce(undefined);
    await expect(
      svc.updateForPayer(POSTING_ID, PAYER_ID, { role_title: "X" }, CTX as never),
    ).rejects.toBeInstanceOf(NotFoundException);
    expect(updateOwned).not.toHaveBeenCalled();
  });

  it("closeForPayer reads + closes owner-scoped and emits the PAYER actor", async () => {
    const existing = row({ status: "open", payerId: PAYER_ID } as Partial<Row>);
    const { svc, emit, closeOwned, close } = make(existing);
    await svc.closeForPayer(POSTING_ID, PAYER_ID, CTX as never);
    expect(closeOwned).toHaveBeenCalledWith(POSTING_ID, PAYER_ID, "open", expect.any(Date));
    expect(close).not.toHaveBeenCalled(); // never the ops (unscoped) close
    const arg = emit.mock.calls[0]![0] as Record<string, unknown>;
    expect(arg.event_name).toBe("job_posting.closed");
    expect(arg.actor).toEqual({ actor_type: "payer", actor_id: PAYER_ID });
  });

  it("closeForPayer 404s (no-oracle) for a not-owned posting BEFORE any write", async () => {
    const { svc, findByIdAndPayer, closeOwned } = make();
    findByIdAndPayer.mockResolvedValueOnce(undefined);
    await expect(svc.closeForPayer(POSTING_ID, PAYER_ID, CTX as never)).rejects.toBeInstanceOf(
      NotFoundException,
    );
    expect(closeOwned).not.toHaveBeenCalled();
  });

  it("closeForPayer 409s when the owned row was already closed (concurrent close)", async () => {
    const existing = row({ status: "open", payerId: PAYER_ID } as Partial<Row>);
    const { svc, closeOwned } = make(existing);
    closeOwned.mockResolvedValueOnce(undefined); // guarded update found nothing to close
    await expect(svc.closeForPayer(POSTING_ID, PAYER_ID, CTX as never)).rejects.toBeInstanceOf(
      ConflictException,
    );
  });
});

describe("TAX-6 — job-side skill canonicalization (shared id space, ADR-0030)", () => {
  const SKILLS = ["VMC operator", "Fanuc", "VMC operator"]; // dup on purpose

  it("create canonicalizes each phrase and stores DEDUPED vector-assigned ids + the raw phrases", async () => {
    const { svc, create, canonicalize } = make();
    canonicalize
      .mockResolvedValueOnce({ status: "matched", skill_id: "skill_milling", score: 0.9 })
      .mockResolvedValueOnce({ status: "matched", skill_id: "skill_fanuc", score: 0.88 })
      .mockResolvedValueOnce({ status: "matched", skill_id: "skill_milling", score: 0.9 });
    await svc.create(
      {
        created_by: CREATED_BY,
        org_label: ORG,
        role_title: ROLE,
        vacancy_band: "2-5",
        skills: SKILLS,
      } as never,
      CTX as never,
    );
    expect(canonicalize).toHaveBeenCalledTimes(3);
    expect(canonicalize).toHaveBeenCalledWith(
      { phrase: "VMC operator", domain_id: "cnc-machining", lang: "en" },
      CTX,
    );
    // BL-19: ONE trace for the whole fan-out. Every phrase carries the WRITE'S ctx, so a
    // 3-skill posting is three calls under one correlation id rather than three orphans.
    for (const call of canonicalize.mock.calls) expect(call[1]).toEqual(CTX);
    const values = create.mock.calls[0]![0] as Record<string, unknown>;
    expect(values.skillPhrases).toEqual(SKILLS); // poster text kept verbatim
    expect(values.skillIds).toEqual(["skill_milling", "skill_fanuc"]); // deduped, store-assigned only
  });

  it("UNRESOLVED phrases store NO id (SG-3: never free text into matchable fields)", async () => {
    const { svc, create, canonicalize } = make();
    canonicalize.mockResolvedValue({ status: "unresolved", skill_id: null, score: null });
    await svc.create(
      {
        created_by: CREATED_BY,
        org_label: ORG,
        role_title: ROLE,
        vacancy_band: "1",
        skills: ["kharad"],
      } as never,
      CTX as never,
    );
    const values = create.mock.calls[0]![0] as Record<string, unknown>;
    expect(values.skillPhrases).toEqual(["kharad"]);
    expect(values.skillIds).toEqual([]); // no id invented for a miss
  });

  it("an AI-service outage NEVER blocks the posting (best-effort: ids empty, phrases kept)", async () => {
    const { svc, create, canonicalize } = make();
    canonicalize.mockRejectedValue(new Error("ai-service down"));
    await svc.create(
      {
        created_by: CREATED_BY,
        org_label: ORG,
        role_title: ROLE,
        vacancy_band: "1",
        skills: ["milling"],
      } as never,
      CTX as never,
    );
    const values = create.mock.calls[0]![0] as Record<string, unknown>;
    expect(values.skillIds).toEqual([]);
    expect(values.skillPhrases).toEqual(["milling"]); // raw phrase survives (status quo)
  });

  it("update with changed skills re-canonicalizes, patches ids, and emits changed_fields [skills] — names only", async () => {
    const existing = row({ status: "open" } as Partial<Row>);
    const { svc, update, emit, canonicalize } = make(existing);
    canonicalize.mockResolvedValueOnce({
      status: "matched",
      skill_id: "skill_turning",
      score: 0.91,
    });
    await svc.update(POSTING_ID, { skills: ["lathe operation"] } as never, CTX as never);
    const patch = update.mock.calls[0]![1] as Record<string, unknown>;
    expect(patch.skillPhrases).toEqual(["lathe operation"]);
    expect(patch.skillIds).toEqual(["skill_turning"]);
    const arg = emit.mock.calls[0]![0] as { payload: { changed_fields: string[] } };
    expect(arg.payload.changed_fields).toContain("skills");
    // The PHRASE/id values never ride the spine — field NAMES only.
    expect(JSON.stringify(arg)).not.toContain("lathe operation");
    expect(JSON.stringify(arg)).not.toContain("skill_turning");
  });

  it("resending IDENTICAL phrases while stored ids are empty re-canonicalizes (outage backfill, #226 M3)", async () => {
    // Created during an ai-service outage: phrases stored, ids []. Re-PATCHing the SAME
    // skills must be a valid retry (previously 400 'no effective changes' — ids were
    // unbackfillable forever without editing the phrases).
    const existing = row({
      status: "open",
      skillPhrases: ["milling"],
      skillIds: [],
    } as Partial<Row>);
    const { svc, update, canonicalize } = make(existing);
    canonicalize.mockResolvedValueOnce({
      status: "matched",
      skill_id: "skill_milling",
      score: 0.9,
    });
    await svc.update(POSTING_ID, { skills: ["milling"] } as never, CTX as never);
    const patch = update.mock.calls[0]![1] as Record<string, unknown>;
    expect(patch.skillIds).toEqual(["skill_milling"]); // backfilled on retry
  });

  it("resending identical phrases when ids are ALREADY stored is still a no-op 400", async () => {
    const existing = row({
      status: "open",
      skillPhrases: ["milling"],
      skillIds: ["skill_milling"],
    } as Partial<Row>);
    const { svc, canonicalize } = make(existing);
    await expect(
      svc.update(POSTING_ID, { skills: ["milling"] } as never, CTX as never),
    ).rejects.toThrow(/no effective changes/i);
    expect(canonicalize).not.toHaveBeenCalled(); // no wasted round-trips on a true no-op
  });

  // ── Phase 1.5 canonicalizer cutover — which DOMAIN the fan-out anchors to ──
  //
  // Migration 0076 gave `job_postings` its first real domain column and demoted the
  // hardcoded "cnc-machining" anchor to a transitional fallback. Both arms are pinned
  // because the fallback is not dead code: `job_domain_id` is NULLABLE with no backfill,
  // so it is NULL for every posting that exists today and for every posting this API
  // creates. Deleting the fallback would not "use the canonical domain" — it would stop
  // canonicalizing skills on 100% of postings, silently, with no error anywhere.

  it("a posting WITH a canonical job_domain_id canonicalizes against it, not the legacy anchor", async () => {
    const existing = row({ status: "open", jobDomainId: "jd_nco_7223_0100" } as Partial<Row>);
    const { svc, canonicalize } = make(existing);
    canonicalize.mockResolvedValueOnce({
      status: "matched",
      skill_id: "skill_turning",
      score: 0.91,
    });
    await svc.update(POSTING_ID, { skills: ["lathe operation"] } as never, CTX as never);

    // EXACTLY ONE domain rides the contract — sending both is a 400 on the far side.
    expect(canonicalize).toHaveBeenCalledWith(
      { phrase: "lathe operation", job_domain_id: "jd_nco_7223_0100", lang: "en" },
      CTX,
    );
    const sent = canonicalize.mock.calls[0]![0] as Record<string, unknown>;
    expect(sent).not.toHaveProperty("domain_id");
  });

  it("a posting with a NULL job_domain_id still uses the transitional legacy anchor", async () => {
    // The state of every row in production. If this regresses to "no domain", the
    // canonicalizer rejects the call and every posting loses its skill ids.
    const existing = row({ status: "open", jobDomainId: null } as Partial<Row>);
    const { svc, canonicalize } = make(existing);
    canonicalize.mockResolvedValueOnce({ status: "matched", skill_id: "skill_x", score: 0.9 });
    await svc.update(POSTING_ID, { skills: ["lathe operation"] } as never, CTX as never);

    expect(canonicalize).toHaveBeenCalledWith(
      { phrase: "lathe operation", domain_id: "cnc-machining", lang: "en" },
      CTX,
    );
    const sent = canonicalize.mock.calls[0]![0] as Record<string, unknown>;
    expect(sent).not.toHaveProperty("job_domain_id");
  });

  it("the payer edit path reads the domain from the CALLER'S OWN posting, never the body", async () => {
    // Authorization discipline: the domain comes from the owner-scoped read
    // (`findByIdAndPayer`), so a payer cannot canonicalize against someone else's trade
    // by putting an id in the request body — the DTO has no such field at all.
    const existing = row({ status: "open", jobDomainId: "jd_nco_7212_0301" } as Partial<Row>);
    const { svc, canonicalize } = make(existing);
    canonicalize.mockResolvedValueOnce({ status: "matched", skill_id: "skill_weld", score: 0.9 });
    await svc.updateForPayer(
      POSTING_ID,
      PAYER_ID,
      { skills: ["gas welding"], job_domain_id: "jd_attacker_supplied" } as never,
      CTX as never,
    );

    expect(canonicalize).toHaveBeenCalledWith(
      { phrase: "gas welding", job_domain_id: "jd_nco_7212_0301", lang: "en" },
      CTX,
    );
  });

  it("CREATE has no posting yet, so it anchors to the legacy domain (unchanged)", async () => {
    // Pinned separately from the update path: neither create DTO accepts a domain and
    // nothing in this module writes the column, so create can only ever take the
    // fallback. When the payer flow starts capturing a domain, THIS is the test that
    // should change.
    const { svc, canonicalize } = make();
    await svc.create(
      { created_by: CREATED_BY, org_label: ORG, role_title: ROLE, skills: ["milling"] } as never,
      CTX as never,
    );
    expect(canonicalize).toHaveBeenCalledWith(
      { phrase: "milling", domain_id: "cnc-machining", lang: "en" },
      CTX,
    );
  });
});

describe("JobPostingsService — ops verification (job_posting.verification_updated)", () => {
  it("verify sets verification_status='verified', flips `verified`, and emits the transition", async () => {
    const d = make(row({ verificationStatus: "unverified" }));

    const result = await d.svc.verify(POSTING_ID, CTX as never);

    expect(result.verification_status).toBe("verified");
    expect(result.verified).toBe(true);
    expect(d.update).toHaveBeenCalledWith(
      POSTING_ID,
      expect.objectContaining({ verificationStatus: "verified" }),
    );
    const ev = d.emit.mock.calls.at(-1)![0];
    expect(ev.event_name).toBe("job_posting.verification_updated");
    expect(ev.subject).toMatchObject({ subject_type: "job_posting", subject_id: POSTING_ID });
    expect(ev.payload).toMatchObject({
      job_posting_id: POSTING_ID,
      verification_status: "verified",
      previous_status: "unverified",
    });
    // PII-free: no free-text value ever rides the payload.
    const payloadStr = JSON.stringify(ev.payload);
    for (const t of FREE_TEXT) expect(payloadStr).not.toContain(t);
  });

  it("reject sets verification_status='rejected' and emits the transition", async () => {
    const d = make(row({ verificationStatus: "unverified" }));

    const result = await d.svc.reject(POSTING_ID, CTX as never);

    expect(result.verification_status).toBe("rejected");
    expect(result.verified).toBe(false);
    const ev = d.emit.mock.calls.at(-1)![0];
    expect(ev.payload).toMatchObject({
      verification_status: "rejected",
      previous_status: "unverified",
    });
  });

  it("is IDEMPOTENT: re-verifying an already-verified posting writes nothing and emits nothing", async () => {
    const d = make(row({ verificationStatus: "verified" }));

    const result = await d.svc.verify(POSTING_ID, CTX as never);

    expect(result.verification_status).toBe("verified");
    expect(d.update).not.toHaveBeenCalled();
    expect(d.emit).not.toHaveBeenCalled();
  });

  it("404s an unknown posting", async () => {
    const d = make(); // findById → undefined

    await expect(d.svc.verify(POSTING_ID, CTX as never)).rejects.toBeInstanceOf(NotFoundException);
    expect(d.emit).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// #1645 / #1646 / #1648 — the create path used to accept 7 keys and answer 201.
//
// The payer app has been sending city, pay_min, pay_max, shift, needed_by,
// match_skill_ids and unticked_related_ids in the same body since Matching V1, and Zod
// stripped all seven. With `match_skill_ids` gone the row's `match_skill_ids` stayed [],
// so at publish `materializeIfNeeded` saw an empty list, returned early, `job_reach` got
// no rows, and THE POSTING REACHED NO WORKER — while the company saw a success state and
// a live posting. #1646 adds the card content (area / experience / benefits /
// requirements) that no route could write at all, and #1648 the pay-type claim.
// ---------------------------------------------------------------------------
describe("#1645/#1646/#1648 — create persists everything the payer sent", () => {
  /** Exactly the body the Flutter payer client builds (http_payer_api_client.dart). */
  const PAYER_BODY = {
    org_label: ORG,
    role_title: ROLE,
    vacancy_band: "2-5" as const,
    city: "Pune",
    area: "Chakan",
    pay_min: 18000,
    pay_max: 25000,
    pay_type: "in_hand" as const,
    min_experience_years: 2,
    max_experience_years: 5,
    shift: "night" as const,
    needed_by: "immediate" as const,
    benefits: ["PF + ESI"],
    requirements: ["Fanuc control"],
    match_skill_ids: ["mskill_vmc_operator"],
    unticked_related_ids: ["mskill_cnc_turner"],
  };

  it("the payer create SCHEMA no longer strips a single field the app sends", () => {
    const parsed = PayerCreateJobPostingSchema.safeParse(PAYER_BODY);
    expect(parsed.success).toBe(true);
    // Key-for-key, not a spot check: the bug was silent STRIPPING, so what matters is
    // that nothing the client sent went missing between the body and the parsed DTO.
    expect(Object.keys(parsed.data!).sort()).toEqual(Object.keys(PAYER_BODY).sort());
  });

  it("writes every one of them to the row (the P0: they reached no column before)", async () => {
    const d = make();
    await d.svc.createForPayer(PAYER_ID, PAYER_BODY as never, CTX as never);

    const stored = d.create.mock.calls[0]![0] as Record<string, unknown>;
    expect(stored).toMatchObject({
      city: "Pune",
      area: "Chakan",
      payMin: 18000,
      payMax: 25000,
      payType: "in_hand",
      minExperienceYears: 2,
      maxExperienceYears: 5,
      shift: "night",
      neededBy: "immediate",
      benefits: ["PF + ESI"],
      requirements: ["Fanuc control"],
      matchSkillIds: ["mskill_vmc_operator"],
      untickedRelatedIds: ["mskill_cnc_turner"],
    });
    // The RESOLVED reach set is still never written by a create: a draft reaches nobody,
    // and `reach_skill_ids` belongs to `PublishReachService` alone (Policy 10).
    expect("reachSkillIds" in stored).toBe(false);
  });

  it("a create carrying match_skill_ids is what makes the posting MATERIALIZE at publish", async () => {
    // The whole causal chain of #1645 in one test: create stores the ids, the publish
    // PATCH carries NO skills of its own, and the reach is still materialized from what
    // the row has been holding since the create. Before this batch the stored list was
    // empty, `materializeIfNeeded` returned early, and `job_reach` got no rows.
    const draft = row({ status: "draft", untickedRelatedIds: ["mskill_cnc_turner"] });
    const d = make(draft);
    d.findByIdAndPayer.mockResolvedValue({
      ...toApi(draft),
      payer_id: PAYER_ID,
      match_skill_ids: ["mskill_vmc_operator"],
    });
    d.updateOwned.mockResolvedValue({
      ...toApi(row({ status: "open", untickedRelatedIds: ["mskill_cnc_turner"] })),
      payer_id: PAYER_ID,
      match_skill_ids: ["mskill_vmc_operator"],
    });

    await d.svc.updateForPayer(POSTING_ID, PAYER_ID, { status: "open" }, CTX as never);

    expect(d.materializeReach).toHaveBeenCalledTimes(1);
    const [postingId, input] = d.materializeReach.mock.calls[0]! as [
      string,
      { matchSkillIds: string[]; untickedIds: string[]; trigger: string },
    ];
    expect(postingId).toBe(POSTING_ID);
    expect(input.matchSkillIds).toEqual(["mskill_vmc_operator"]);
    expect(input.trigger).toBe("publish");
    // AND THE UNTICKS SURVIVED create -> publish. This PATCH sent none; before 0121 they
    // existed only as a PATCH body value, so a create-time untick evaporated and the reach
    // silently widened past what the payer chose.
    expect(input.untickedIds).toEqual(["mskill_cnc_turner"]);
  });

  it("MUTATION CHECK: with no stored match skills the publish materializes an EMPTY set", async () => {
    // The inverse of the test above, and what makes it evidence rather than a coincidence.
    // A posting with no skills reaches nobody: `materialize` still runs once on a publish
    // (so the E13 zero-reach alert fires) but with an EMPTY list. Nothing invents skills.
    const draft = row({ status: "draft" });
    const d = make(draft);
    d.findByIdAndPayer.mockResolvedValue({ ...toApi(draft), payer_id: PAYER_ID });
    d.updateOwned.mockResolvedValue({ ...toApi(row({ status: "open" })), payer_id: PAYER_ID });

    await d.svc.updateForPayer(POSTING_ID, PAYER_ID, { status: "open" }, CTX as never);

    const [, input] = d.materializeReach.mock.calls[0]! as [string, { matchSkillIds: string[] }];
    expect(input.matchSkillIds).toEqual([]);
  });

  it("400s an unknown match skill id AT CREATE, not at publish", async () => {
    // Closed-set membership lives in `MatchSkillsService` (the vocabulary and the runtime
    // cap live there, not in a second Zod copy). Running it at create means a typo is a
    // 400 on the form the payer is looking at, rather than a 400 at publish against a
    // draft they have already moved on from.
    const d = make();
    d.resolveForPublish.mockRejectedValue(new BadRequestException("unknown match skill id(s)"));

    await expect(
      d.svc.createForPayer(
        PAYER_ID,
        { ...PAYER_BODY, match_skill_ids: ["mskill_not_a_real_skill"] } as never,
        CTX as never,
      ),
    ).rejects.toBeInstanceOf(BadRequestException);
    // ...and NOTHING was written. A create that cannot name valid skills must not leave a
    // half-built posting behind.
    expect(d.create).not.toHaveBeenCalled();
    expect(d.emit).not.toHaveBeenCalled();
  });

  it("a create that names no skills does not call the resolver at all", async () => {
    // Vacuity guard for the test above: if `resolveForPublish` ran unconditionally, the
    // rejection case would prove nothing about `match_skill_ids` being the trigger.
    const d = make();
    await d.svc.createForPayer(
      PAYER_ID,
      { org_label: ORG, role_title: ROLE, vacancy_band: "1" } as never,
      CTX as never,
    );
    expect(d.resolveForPublish).not.toHaveBeenCalled();
    expect(d.create).toHaveBeenCalledOnce();
  });

  it("omitted fields store NULL, never a fabricated default (pay_type especially)", async () => {
    const d = make();
    await d.svc.createForPayer(
      PAYER_ID,
      { org_label: ORG, role_title: ROLE, vacancy_band: "1" } as never,
      CTX as never,
    );
    const stored = d.create.mock.calls[0]![0] as Record<string, unknown>;
    // `pay_type` is the one that matters most: NULL means "the poster did not state it"
    // and the card then shows the band with NO pay-type pill. Defaulting it to `gross`
    // would make the platform assert a net-vs-gross claim nobody made — which is the
    // dishonesty #1648 exists to end, not a convenience.
    expect(stored.payType).toBeNull();
    expect(stored.city).toBeNull();
    expect(stored.area).toBeNull();
    // jsonb with no DB default: NULL is honest absence, distinguishable from an empty list.
    expect(stored.benefits).toBeNull();
    expect(stored.requirements).toBeNull();
    // The two skill columns DO default to [] in the DB, so the insert mirrors that.
    expect(stored.matchSkillIds).toEqual([]);
    expect(stored.untickedRelatedIds).toEqual([]);
  });

  it("the ops create takes the same fields — one entity, not two create paths", async () => {
    const d = make();
    await d.svc.create({ ...PAYER_BODY, created_by: CREATED_BY } as never, CTX as never);
    expect(d.create.mock.calls[0]![0]).toMatchObject({
      city: "Pune",
      payType: "in_hand",
      matchSkillIds: ["mskill_vmc_operator"],
      benefits: ["PF + ESI"],
    });
  });
});

describe("#1646/#1648 — the update path reports the new fields as changed KEYS", () => {
  it("emits area / experience / pay_type / benefits / requirements as keys, never values", async () => {
    const current = row({ status: "open" });
    const d = make(current);
    d.update.mockResolvedValue(toApi(row({ status: "open" })));

    await d.svc.update(
      POSTING_ID,
      {
        area: "Chakan",
        min_experience_years: 2,
        max_experience_years: 5,
        pay_type: "gross",
        benefits: ["Canteen"],
        requirements: ["ITI"],
      } as never,
      CTX as never,
    );

    const arg = d.emit.mock.calls[0]![0];
    expect(arg.event_name).toBe("job_posting.updated");
    expect([...arg.payload.changed_fields].sort()).toEqual(
      ["area", "benefits", "experience", "pay_type", "requirements"].sort(),
    );
    // ONE key for the whole experience window, exactly as `pay_band` is one key for
    // pay_min+pay_max: the window is a single editorial act, and two keys would tell a
    // reader which END of the range the payer moved.
    expect(arg.payload.changed_fields).not.toContain("min_experience_years");
    // The screened free text itself never enters the payload.
    expect(JSON.stringify(arg.payload)).not.toContain("Chakan");
    expect(JSON.stringify(arg.payload)).not.toContain("Canteen");
    assertNoFreeText(arg.payload);
  });

  it("rejects a ONE-SIDED pay edit that would invert the stored band", async () => {
    // The DTO refines can only compare two values that arrived together. A patch carrying
    // `pay_max` alone has to be checked against the ROW, and the service is the only place
    // that can see it.
    const current = row({ status: "open" });
    const d = make(current);
    d.findById.mockResolvedValue({ ...toApi(current), pay_min: 20000, pay_max: 30000 });

    await expect(
      d.svc.update(POSTING_ID, { pay_max: 15000 } as never, CTX as never),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(d.update).not.toHaveBeenCalled();
  });

  it("rejects a ONE-SIDED experience edit that would invert the stored window", async () => {
    const current = row({ status: "open" });
    const d = make(current);
    d.findById.mockResolvedValue({
      ...toApi(current),
      min_experience_years: 5,
      max_experience_years: 8,
    });

    await expect(
      d.svc.update(POSTING_ID, { max_experience_years: 2 } as never, CTX as never),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(d.update).not.toHaveBeenCalled();
  });

  it("a benefits list stated as EMPTY is a change from NULL (not-stated is not empty)", async () => {
    const current = row({ status: "open" });
    const d = make(current);
    d.findById.mockResolvedValue({ ...toApi(current), benefits: null });
    d.update.mockResolvedValue(toApi(row({ status: "open" })));

    await d.svc.update(POSTING_ID, { benefits: [] } as never, CTX as never);

    expect(d.update.mock.calls[0]![1]).toMatchObject({ benefits: [] });
    expect(d.emit.mock.calls[0]![0].payload.changed_fields).toContain("benefits");
  });
});


// ---------------------------------------------------------------------------
// #1652 — a PATCH could SET a field but never UNSET one. Every key was
// `<type>.optional()` and the service applied a key only when `!== undefined`, so a payer
// who set a pay band, a shift or a city by mistake could only overwrite it with a
// different wrong value. On the worker card that left a wage the employer no longer stood
// behind on screen indefinitely.
//
// Owner ruling (2026-09-22): a `clear: [...]` LIST, not an accepted `null`.
// ---------------------------------------------------------------------------
describe("#1652 — clearing a posting field", () => {
  /** A posting with every clearable field actually SET, so a clear has something to remove. */
  function populated() {
    const current = row({ status: "open" });
    const d = make(current);
    const full = {
      ...toApi(current),
      city: "Pune",
      area: "Chakan",
      pay_min: 18000,
      pay_max: 25000,
      pay_type: "in_hand" as const,
      min_experience_years: 2,
      max_experience_years: 5,
      shift: "night" as const,
      needed_by: "immediate" as const,
      benefits: ["PF + ESI"],
      requirements: ["Fanuc control"],
      description: DESC,
      location_label: LOCATION,
    };
    d.findById.mockResolvedValue(full);
    d.update.mockResolvedValue(full);
    return { d, full };
  }

  it("writes NULL for every cleared field", async () => {
    const { d } = populated();
    await d.svc.update(
      POSTING_ID,
      { clear: ["city", "shift", "pay_type", "description", "needed_by"] } as never,
      CTX as never,
    );
    expect(d.update.mock.calls[0]![1]).toMatchObject({
      city: null,
      shift: null,
      payType: null,
      description: null,
      neededBy: null,
    });
  });

  it("VACUITY GUARD: the fields it cleared were genuinely set beforehand", async () => {
    // A NULL in the patch proves nothing if the row was already NULL — the assertion
    // above would pass against an empty posting for the wrong reason.
    const { full } = populated();
    expect(full.city).not.toBeNull();
    expect(full.shift).not.toBeNull();
    expect(full.pay_type).not.toBeNull();
    expect(full.description).not.toBeNull();
    expect(full.needed_by).not.toBeNull();
  });

  it("reports the cleared fields on changed_fields, by KEY", async () => {
    const { d } = populated();
    await d.svc.update(POSTING_ID, { clear: ["city", "area", "shift"] } as never, CTX as never);
    const arg = d.emit.mock.calls[0]![0];
    expect([...arg.payload.changed_fields].sort()).toEqual(["area", "city", "shift"].sort());
    assertNoFreeText(arg.payload);
  });

  it("clearing ONE end of the pay band is legal and keeps the other end", async () => {
    // THE CASE THE ISSUE ASKS FOR, and the one the `??` ordering check would have broken:
    // a cleared field sits in the patch as an explicit null, and `patch.payMin ??
    // current.pay_min` would read it as "not supplied" and validate against the pay_min
    // that is about to disappear.
    const { d } = populated();
    await d.svc.update(POSTING_ID, { clear: ["pay_min"] } as never, CTX as never);
    const patch = d.update.mock.calls[0]![1] as Record<string, unknown>;
    expect(patch.payMin).toBeNull();
    expect("payMax" in patch).toBe(false); // untouched, still 25000
    expect(d.emit.mock.calls[0]![0].payload.changed_fields).toContain("pay_band");
  });

  it("clearing pay_min while SETTING a lower pay_max is still legal", async () => {
    // Stored band is 18000-25000. Clearing the floor and lowering the ceiling to 9000 is
    // fine — there is no floor left to violate. Under the old `??` this would have been
    // compared against 18000 and rejected.
    const { d } = populated();
    await d.svc.update(POSTING_ID, { pay_max: 9000, clear: ["pay_min"] } as never, CTX as never);
    expect(d.update.mock.calls[0]![1]).toMatchObject({ payMin: null, payMax: 9000 });
  });

  it("still rejects an edit that would invert a band it did NOT clear", async () => {
    // The mutation-proof for the test above: the ordering check must still BITE.
    const { d } = populated();
    await expect(
      d.svc.update(POSTING_ID, { pay_max: 9000 } as never, CTX as never),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(d.update).not.toHaveBeenCalled();
  });

  it("clearing a field that is ALREADY null is not a change", async () => {
    const d = make(row({ status: "open" })); // fixture has city/shift null
    await expect(
      d.svc.update(POSTING_ID, { clear: ["city"] } as never, CTX as never),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(d.update).not.toHaveBeenCalled();
    expect(d.emit).not.toHaveBeenCalled();
  });

  it("clearing benefits stores NULL, which is NOT the same as an empty list", async () => {
    // `[]` = "the poster stated no benefits"; NULL = "the poster never said". Both columns
    // have no DB default precisely so the client can tell them apart.
    const { d } = populated();
    await d.svc.update(POSTING_ID, { clear: ["benefits"] } as never, CTX as never);
    expect(d.update.mock.calls[0]![1]).toMatchObject({ benefits: null });

    const d2 = populated().d;
    await d2.svc.update(POSTING_ID, { benefits: [] } as never, CTX as never);
    expect(d2.update.mock.calls[0]![1]).toMatchObject({ benefits: [] });
  });
});

describe("#1652 — the clear CONTRACT", () => {
  it("rejects a field that is both SET and CLEARED", () => {
    const r = UpdateJobPostingSchema.safeParse({ pay_min: 5000, clear: ["pay_min"] });
    expect(r.success).toBe(false);
    expect(JSON.stringify(r.error?.issues)).toContain("both set and cleared");
  });

  it("allows setting one field while clearing a DIFFERENT one", () => {
    expect(UpdateJobPostingSchema.safeParse({ pay_min: 5000, clear: ["shift"] }).success).toBe(true);
  });

  it("rejects a name that is not a clearable column", () => {
    // Closed set, never a free string: `clear` must be unable to reach a NOT NULL column.
    for (const name of ["org_label", "role_title", "vacancy_band", "status", "reach_skill_ids"]) {
      expect(UpdateJobPostingSchema.safeParse({ clear: [name] }).success, name).toBe(false);
    }
  });

  it("rejects an EMPTY clear list (it expresses nothing)", () => {
    expect(UpdateJobPostingSchema.safeParse({ clear: [] }).success).toBe(false);
  });

  it("accepts `clear` as the ONLY key — clearing IS an edit", () => {
    expect(UpdateJobPostingSchema.safeParse({ clear: ["shift"] }).success).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Migration 0131 — the posting's ROLE (ADR-0036 addendum 2026-09-29). One of the 21 declared
// kinds, picked by the payer. DISPLAY / CLASSIFICATION ONLY: it is stored, echoed, evented by
// KEY on update and by VALUE on create (a closed, PII-free enum), and it never reaches a match
// input.
// ---------------------------------------------------------------------------
describe("migration 0131 — role_kind on the posting routes", () => {
  it("create stores the role and puts it on job_posting.created", async () => {
    const d = make();
    await d.svc.createForPayer(
      PAYER_ID,
      { org_label: ORG, role_title: ROLE, vacancy_band: "1", role_kind: "welder" } as never,
      CTX as never,
    );
    expect(d.create.mock.calls[0]![0]).toMatchObject({ roleKind: "welder" });
    const payload = d.emit.mock.calls[0]![0].payload as Record<string, unknown>;
    expect(payload.role_kind).toBe("welder");
    assertNoFreeText(payload);
  });

  it("the ops create takes it too — one entity, not two create paths", async () => {
    const d = make();
    await d.svc.create(
      {
        created_by: CREATED_BY,
        org_label: ORG,
        role_title: ROLE,
        vacancy_band: "1",
        role_kind: "fitter",
      } as never,
      CTX as never,
    );
    expect(d.create.mock.calls[0]![0]).toMatchObject({ roleKind: "fitter" });
    expect(d.emit.mock.calls[0]![0].payload.role_kind).toBe("fitter");
  });

  it("an omitted role stores NULL and events null — never a guessed role", async () => {
    const d = make();
    await d.svc.createForPayer(
      PAYER_ID,
      { org_label: ORG, role_title: ROLE, vacancy_band: "1" } as never,
      CTX as never,
    );
    expect(d.create.mock.calls[0]![0]).toMatchObject({ roleKind: null });
    expect(d.emit.mock.calls[0]![0].payload.role_kind).toBeNull();
  });

  it("is NEVER a match input — a role alone resolves no skills and stores none", async () => {
    // ADR-0036 addendum: `match_skill_ids` stays the ONLY thing a posting is matched on. A
    // role with no skills must not trigger the skill resolver or seed the match set.
    const d = make();
    await d.svc.createForPayer(
      PAYER_ID,
      { org_label: ORG, role_title: ROLE, vacancy_band: "1", role_kind: "welder" } as never,
      CTX as never,
    );
    expect(d.resolveForPublish).not.toHaveBeenCalled();
    const stored = d.create.mock.calls[0]![0] as Record<string, unknown>;
    expect(stored.matchSkillIds).toEqual([]);
    expect(stored.jobDomainId).toBeUndefined();
    expect("reachSkillIds" in stored).toBe(false);
  });

  it('an update reports changed_fields ["role_kind"] — the KEY, never the value', async () => {
    const d = make(row({ status: "open" }));
    await d.svc.update(POSTING_ID, { role_kind: "welder" } as never, CTX as never);

    expect(d.update.mock.calls[0]![1]).toMatchObject({ roleKind: "welder" });
    const arg = d.emit.mock.calls[0]![0];
    expect(arg.event_name).toBe("job_posting.updated");
    expect(arg.payload.changed_fields).toEqual(["role_kind"]);
    expect(JSON.stringify(arg.payload)).not.toContain("welder");
  });

  it("a role change is its OWN key — never reported as a match_skills change", async () => {
    // A reader of the spine must be able to tell "the reach inputs moved" from "the display
    // role moved". Folding them would make every role edit look like a reach edit.
    const d = make(row({ status: "open" }));
    await d.svc.update(POSTING_ID, { role_kind: "welder" } as never, CTX as never);
    expect(d.emit.mock.calls[0]![0].payload.changed_fields).not.toContain("match_skills");
    expect(d.materializeReach).not.toHaveBeenCalled();
  });

  it("the payer update path carries it the same way", async () => {
    const d = make(row({ status: "draft" }));
    await d.svc.updateForPayer(
      POSTING_ID,
      PAYER_ID,
      { role_kind: "cam_programmer" } as never,
      CTX as never,
    );
    expect(d.updateOwned.mock.calls[0]![2]).toMatchObject({ roleKind: "cam_programmer" });
    expect(d.emit.mock.calls[0]![0].payload.changed_fields).toEqual(["role_kind"]);
  });

  it('clear: ["role_kind"] stores NULL and reports the key', async () => {
    const d = make(row({ status: "open", roleKind: "welder" }));
    await d.svc.update(POSTING_ID, { clear: ["role_kind"] } as never, CTX as never);
    expect(d.update.mock.calls[0]![1]).toMatchObject({ roleKind: null });
    expect(d.emit.mock.calls[0]![0].payload.changed_fields).toEqual(["role_kind"]);
  });

  it("VACUITY GUARD: the clear case above started from a real role", () => {
    expect(toApi(row({ roleKind: "welder" })).role_kind).toBe("welder");
  });

  it("re-sending the SAME role is no change — 400, no write, no event", async () => {
    const d = make(row({ status: "open", roleKind: "welder" }));
    await expect(
      d.svc.update(POSTING_ID, { role_kind: "welder" } as never, CTX as never),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(d.update).not.toHaveBeenCalled();
    expect(d.emit).not.toHaveBeenCalled();
  });

  it("clearing a role that is ALREADY null is no change either", async () => {
    const d = make(row({ status: "open" }));
    await expect(
      d.svc.update(POSTING_ID, { clear: ["role_kind"] } as never, CTX as never),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(d.update).not.toHaveBeenCalled();
  });
});

describe("migration 0131 — the role_kind CONTRACT on the posting DTOs", () => {
  const BASE = { org_label: ORG, role_title: ROLE, vacancy_band: "1" };

  it.each(TRADE_FORM_KINDS_ALL)("accepts %s on create and update — all 21 are postable", (kind) => {
    expect(PayerCreateJobPostingSchema.safeParse({ ...BASE, role_kind: kind }).success).toBe(true);
    expect(UpdateJobPostingSchema.safeParse({ role_kind: kind }).success).toBe(true);
  });

  it("a parsed create keeps the role — the schema does not strip it", () => {
    const parsed = PayerCreateJobPostingSchema.parse({ ...BASE, role_kind: "welder" });
    expect(parsed.role_kind).toBe("welder");
    const ops = CreateJobPostingSchema.parse({
      ...BASE,
      created_by: CREATED_BY,
      role_kind: "welder",
    });
    expect(ops.role_kind).toBe("welder");
  });

  it("rejects anything outside the 21 — a trade key, a label, free text", () => {
    for (const bad of ["cnc_operator", "Welder", "welder ", "Ramesh 9876543210", ""]) {
      expect(PayerCreateJobPostingSchema.safeParse({ ...BASE, role_kind: bad }).success, bad).toBe(
        false,
      );
      expect(UpdateJobPostingSchema.safeParse({ role_kind: bad }).success, bad).toBe(false);
    }
  });

  it("rejects an explicit null — unsetting is `clear`, never a stray null (#1652)", () => {
    expect(PayerCreateJobPostingSchema.safeParse({ ...BASE, role_kind: null }).success).toBe(false);
    expect(UpdateJobPostingSchema.safeParse({ role_kind: null }).success).toBe(false);
  });

  it("role_kind is a clearable name, and SET + CLEAR of it is a 400", () => {
    expect(UpdateJobPostingSchema.safeParse({ clear: ["role_kind"] }).success).toBe(true);
    const both = UpdateJobPostingSchema.safeParse({ role_kind: "welder", clear: ["role_kind"] });
    expect(both.success).toBe(false);
    expect(JSON.stringify(both.error?.issues)).toContain("both set and cleared");
  });
});

describe("ADR-0050 §4.3 — the ops write fences refuse an agency TWIN with one identical 409", () => {
  const twin = () => make(row({ status: "open", syncSource: "agency_job" }));

  it.each([
    ["update", (d: ReturnType<typeof make>) => d.svc.update(POSTING_ID, { role_title: "X" } as never, CTX as never)],
    ["close", (d: ReturnType<typeof make>) => d.svc.close(POSTING_ID, CTX as never)],
    ["verify", (d: ReturnType<typeof make>) => d.svc.verify(POSTING_ID, CTX as never)],
    ["reject", (d: ReturnType<typeof make>) => d.svc.reject(POSTING_ID, CTX as never)],
    [
      "ops widen",
      (d: ReturnType<typeof make>) =>
        d.svc.opsWidenReach(POSTING_ID, ["mskill_cnc_turner"], CREATED_BY, CTX as never),
    ],
  ] as const)("%s → 409, nothing written, nothing emitted", async (_name, act) => {
    const d = twin();
    const err = await act(d).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ConflictException);
    expect((err as Error).message).toBe(AGENCY_TWIN_READ_ONLY_MESSAGE);
    expect(d.update).not.toHaveBeenCalled();
    expect(d.close).not.toHaveBeenCalled();
    expect(d.opsWiden).not.toHaveBeenCalled();
    expect(d.emit).not.toHaveBeenCalled();
  });

  it("a NATIVE posting is unaffected (vacuity guard: the same calls go through)", async () => {
    const d = make(row({ status: "open" }));
    await d.svc.verify(POSTING_ID, CTX as never);
    expect(d.update).toHaveBeenCalledTimes(1);
    await d.svc.opsWidenReach(POSTING_ID, ["mskill_cnc_turner"], CREATED_BY, CTX as never);
    expect(d.opsWiden).toHaveBeenCalledTimes(1);
  });
});
