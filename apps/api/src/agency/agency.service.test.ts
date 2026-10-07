import "reflect-metadata";
import { describe, it, expect, vi } from "vitest";
import { BadRequestException, ForbiddenException, NotFoundException } from "@nestjs/common";
import type { JobPayType, JobStatus } from "@badabhai/db";
import { TRADE_FORM_KINDS_ALL } from "@badabhai/types";
import { AgencyService } from "./agency.service";
import { CreateAgencyJobSchema, UpdateAgencyJobSchema } from "./agency.dto";
import { MatchSkillsService } from "../match/match-skills.service";
import type { MatchConfigService } from "../match/match-config.service";
import type { WorkerSkillsRepository } from "../match/worker-skills.repository";

const PAYER_A = "11111111-1111-4111-8111-111111111111";
const PAYER_B = "22222222-2222-4222-8222-222222222222";
const JOB_ID = "33333333-3333-4333-8333-333333333333";
const WORKER_ID = "44444444-4444-4444-8444-444444444444";
const INVITE_ID = "55555555-5555-4555-8555-555555555555";
const CTX = { correlationId: "66666666-6666-4666-8666-666666666666", requestId: "req-1" };

// Free-text / identity values that must NEVER appear in an emitted payload.
const TITLE = "CNC Operator — Night Shift";
const CITY = "Pune";

type JobRow = {
  id: string;
  payerId: string | null;
  tradeKey: string;
  title: string;
  city: string;
  area: string | null;
  payMin: number | null;
  payMax: number | null;
  minExperienceYears: number | null;
  maxExperienceYears: number | null;
  neededBy: "immediate" | "soon" | "flexible" | null;
  description: string | null;
  shift: "day" | "night" | "rotational" | null;
  benefits: string[] | null;
  requirements: string[] | null;
  // #1648 — what the ₹ band MEANS. Same reasoning as `status` below: the real union, not
  // a local narrowing, so the fixture can express every state production can hold.
  payType: JobPayType | null;
  // Migration 0131 — the display role. NULL for every job nobody picked one for.
  roleKind: string | null;
  // ADR-0050 C4 — the explicit match pick. `[]` = "not chosen yet".
  matchSkillIds: string[];
  // #1202 — mirrors the real `JobStatus` union rather than a narrowed copy of it. A local
  // narrowing is how a test file stops being able to express the states production can hold.
  status: JobStatus;
  applicantsReceived: number;
  createdAt: Date;
  updatedAt: Date;
};

function jobRow(overrides: Partial<JobRow> = {}): JobRow {
  return {
    id: JOB_ID,
    payerId: PAYER_A,
    tradeKey: "cnc_operator",
    title: TITLE,
    city: CITY,
    area: null,
    payMin: null,
    payMax: null,
    minExperienceYears: null,
    maxExperienceYears: null,
    neededBy: null,
    description: null,
    shift: null,
    benefits: null,
    requirements: null,
    // #1648 — what the ₹ band MEANS. NULL is the default state for every existing row.
    payType: null,
    roleKind: null,
    matchSkillIds: [],
    status: "open",
    applicantsReceived: 0,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
}

function make(opts?: {
  ownedJob?: JobRow | undefined;
  invite?:
    | { id: string; inviterPayerId: string; invitedWorkerId: string | null; status: string }
    | undefined;
  consent?: { revokedAt: Date | null } | undefined;
  stageCounts?: { created: number; clicked: number; accepted: number };
  /** The ops route's agency-scoped read (ADR-0050). Undefined = not an agency job. */
  agencyJob?: JobRow | undefined;
  /** `match_config.max_skills_per_posting` for the REAL MatchSkillsService below. */
  maxSkillsPerPosting?: number;
}) {
  const emit = vi.fn().mockResolvedValue(undefined);

  const jobsRepo = {
    create: vi
      .fn()
      .mockImplementation((input: Partial<JobRow>, status: JobStatus) =>
        Promise.resolve(jobRow({ ...input, status })),
      ),
    findOwnedById: vi.fn().mockResolvedValue(opts?.ownedJob),
    listOwned: vi.fn().mockResolvedValue(opts?.ownedJob ? [opts.ownedJob] : []),
    updateOwned: vi
      .fn()
      .mockImplementation((id: string, _p: string, patch: Partial<JobRow>) =>
        Promise.resolve(jobRow({ ...opts?.ownedJob, ...patch, id })),
      ),
    // #1202 — the three guarded transitions. Each resolves to the row in its TARGET state,
    // mirroring the real `.returning()`; the service's own from-state guard is what the
    // tests below exercise, so an undefined-returning arm is set per-case where needed.
    closeOwnedIfLive: vi
      .fn()
      .mockImplementation((id: string) =>
        Promise.resolve(jobRow({ ...opts?.ownedJob, id, status: "closed" })),
      ),
    pauseOwnedIfOpen: vi
      .fn()
      .mockImplementation((id: string) =>
        Promise.resolve(jobRow({ ...opts?.ownedJob, id, status: "paused" })),
      ),
    resumeOwnedIfPaused: vi
      .fn()
      .mockImplementation((id: string) =>
        Promise.resolve(jobRow({ ...opts?.ownedJob, id, status: "open" })),
      ),
    // ADR-0050 (#1983) — the ops match-skill route's two repository calls.
    findAgencyJobById: vi.fn().mockResolvedValue(opts?.agencyJob),
    setMatchSkillIdsIfNotClosed: vi
      .fn()
      .mockImplementation((id: string, matchSkillIds: string[]) =>
        Promise.resolve(jobRow({ ...opts?.agencyJob, id, matchSkillIds })),
      ),
  };

  const invitesRepo = {
    create: vi
      .fn()
      .mockImplementation((input: { code: string; inviterPayerId: string; campaign?: string }) =>
        Promise.resolve({ id: INVITE_ID, code: input.code, inviterPayerId: input.inviterPayerId }),
      ),
    findByCode: vi.fn().mockResolvedValue(opts?.invite),
    setStatus: vi.fn().mockResolvedValue(undefined),
    markAccepted: vi.fn().mockResolvedValue(true),
    stageCountsForOwner: vi
      .fn()
      .mockResolvedValue(opts?.stageCounts ?? { created: 0, clicked: 0, accepted: 0 }),
  };

  const consent = {
    findLatestByWorker: vi.fn().mockResolvedValue(opts?.consent),
  };

  // The REAL MatchSkillsService (the posting form's own check), over a stubbed config: the
  // agency path must refuse exactly what the posting form refuses, so it is not stubbed here.
  const matchConfig = {
    get: async () => ({ maxSkillsPerPosting: opts?.maxSkillsPerPosting ?? 3 }),
  } as unknown as MatchConfigService;
  const matchSkills = new MatchSkillsService(matchConfig, {} as WorkerSkillsRepository);

  const svc = new AgencyService(
    jobsRepo as never,
    invitesRepo as never,
    consent as never,
    { emit } as never,
    matchSkills,
  );
  return { svc, emit, jobsRepo, invitesRepo, consent };
}

/** The first emitted event (asserts a call happened) — typed loosely for the assertions. */
function firstEmit(emit: ReturnType<typeof vi.fn>): {
  event_name: string;
  actor: { actor_type: string; actor_id: string | null };
  subject: { subject_type: string; subject_id: string };
  payload: Record<string, unknown>;
} {
  const call = emit.mock.calls[0];
  expect(call).toBeDefined();
  return call![0];
}

/** Deep-scan an emitted payload for forbidden free-text / identity-string values. */
function assertNoPiiStrings(payload: Record<string, unknown>): void {
  const serialized = JSON.stringify(payload);
  for (const text of [TITLE]) {
    expect(serialized).not.toContain(text);
  }
}

describe("AgencyService.createJob", () => {
  it("creates an OWNED open job and emits job.created with the session payer as actor", async () => {
    const { svc, emit } = make();
    const dto = CreateAgencyJobSchema.parse({
      trade_key: "cnc_operator",
      title: TITLE,
      city: CITY,
    });
    const view = await svc.createJob(PAYER_A, dto, CTX);

    expect(view.status).toBe("open");
    expect(emit).toHaveBeenCalledTimes(1);
    const evt = firstEmit(emit);
    expect(evt.event_name).toBe("job.created");
    expect(evt.actor).toEqual({ actor_type: "payer", actor_id: PAYER_A });
    expect(evt.subject).toEqual({ subject_type: "job", subject_id: JOB_ID });
    expect(evt.payload.payer_id).toBe(PAYER_A);
    expect(evt.payload.status).toBe("open");
    // PII-FREE: the title (a free-text label) never lands in the payload.
    assertNoPiiStrings(evt.payload);
    expect(JSON.stringify(evt.payload)).not.toContain(TITLE);
  });

  // ADR-0024 final addendum (2026-07-16): the four worker-visible content fields
  // pass through createJob to the repository create() — and the screened free
  // text still NEVER enters the job.created payload (ids/enums/bands only).
  it("passes description/shift/benefits/requirements through to the repository create()", async () => {
    const { svc, emit, jobsRepo } = make();
    const DESCRIPTION = "Operate and set VMC machines on the day line.";
    const dto = CreateAgencyJobSchema.parse({
      trade_key: "cnc_operator",
      title: TITLE,
      city: CITY,
      description: DESCRIPTION,
      shift: "day",
      benefits: ["PF + ESI", "Canteen"],
      requirements: ["Fanuc control", "ITI / Diploma"],
    });
    await svc.createJob(PAYER_A, dto, CTX);

    expect(jobsRepo.create).toHaveBeenCalledWith(
      expect.objectContaining({
        payerId: PAYER_A,
        description: DESCRIPTION,
        shift: "day",
        benefits: ["PF + ESI", "Canteen"],
        requirements: ["Fanuc control", "ITI / Diploma"],
      }),
      "open",
    );

    // The job.created payload keeps its EXACT key set — none of the content fields (nor
    // their values) leak into the event spine. `role_kind` (migration 0131) is the one
    // ADDITIVE key since it shipped: a closed 21-slug enum, defaulted null in the registry.
    const evt = firstEmit(emit);
    expect(Object.keys(evt.payload).sort()).toEqual(
      [
        "job_id",
        "payer_id",
        "status",
        "trade_key",
        "city",
        "pay_min",
        "pay_max",
        "min_experience_years",
        "max_experience_years",
        "role_kind",
      ].sort(),
    );
    expect(JSON.stringify(evt.payload)).not.toContain(DESCRIPTION);
    expect(JSON.stringify(evt.payload)).not.toContain("PF + ESI");
  });

  it("omitted new fields land as honest NULLs on create (never fabricated)", async () => {
    const { svc, jobsRepo } = make();
    const dto = CreateAgencyJobSchema.parse({
      trade_key: "cnc_operator",
      title: TITLE,
      city: CITY,
    });
    await svc.createJob(PAYER_A, dto, CTX);
    expect(jobsRepo.create).toHaveBeenCalledWith(
      expect.objectContaining({ description: null, shift: null, benefits: null, requirements: null }),
      "open",
    );
  });
});

describe("AgencyService — no-oracle on owned reads/edits", () => {
  it("getOwnJob throws a neutral 404 when the job is unknown OR not owned", async () => {
    // findOwnedById returns undefined for both cases (owner-scoped WHERE) → 404.
    const { svc } = make({ ownedJob: undefined });
    await expect(svc.getOwnJob(PAYER_A, JOB_ID)).rejects.toBeInstanceOf(NotFoundException);
  });

  it("updateJob throws the SAME neutral 404 for unknown-or-not-owned", async () => {
    const { svc } = make({ ownedJob: undefined });
    const dto = UpdateAgencyJobSchema.parse({ title: "New Title" });
    await expect(svc.updateJob(PAYER_A, JOB_ID, dto, CTX)).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });

  it("readOwnedById throws 403 if the repo ever returns a row owned by another payer", async () => {
    // Defense-in-depth: a (hypothetical) cross-tenant row from the repo is rejected by
    // the payer-scope chokepoint — never silently returned.
    const { svc } = make({ ownedJob: jobRow({ payerId: PAYER_B }) });
    await expect(svc.getOwnJob(PAYER_A, JOB_ID)).rejects.toBeInstanceOf(ForbiddenException);
  });
});

describe("AgencyService.updateJob", () => {
  it("emits job.updated with changed field KEYS only (never the values)", async () => {
    const { svc, emit } = make({ ownedJob: jobRow() });
    const dto = UpdateAgencyJobSchema.parse({
      title: "Updated Role Title",
      pay_min: 20000,
      pay_max: 30000,
    });
    await svc.updateJob(PAYER_A, JOB_ID, dto, CTX);

    const evt = firstEmit(emit);
    expect(evt.event_name).toBe("job.updated");
    expect(evt.payload.changed_fields).toEqual(["title", "pay_min", "pay_max"]);
    // KEYS only — the new title value must not appear in the payload.
    expect(JSON.stringify(evt.payload)).not.toContain("Updated Role Title");
  });

  // ADR-0024 final addendum: the four content fields are ADDITIVE members of the
  // JOB_CHANGED_FIELDS key enum — the event carries the KEYS, never the text.
  it("emits job.updated with the new content field KEYS only (values never leak)", async () => {
    const { svc, emit } = make({ ownedJob: jobRow() });
    const dto = UpdateAgencyJobSchema.parse({
      description: "Set and run VMC machines on the day line.",
      shift: "night",
      benefits: ["Canteen"],
      requirements: ["ITI / Diploma"],
    });
    await svc.updateJob(PAYER_A, JOB_ID, dto, CTX);

    const evt = firstEmit(emit);
    expect(evt.event_name).toBe("job.updated");
    expect(evt.payload.changed_fields).toEqual([
      "description",
      "shift",
      "benefits",
      "requirements",
    ]);
    const serialized = JSON.stringify(evt.payload);
    expect(serialized).not.toContain("Set and run VMC machines");
    expect(serialized).not.toContain("Canteen");
    expect(serialized).not.toContain("ITI / Diploma");
  });

  it("rejects an edit on a closed job", async () => {
    const { svc } = make({ ownedJob: jobRow({ status: "closed" }) });
    const dto = UpdateAgencyJobSchema.parse({ title: "X" });
    await expect(svc.updateJob(PAYER_A, JOB_ID, dto, CTX)).rejects.toBeInstanceOf(
      BadRequestException,
    );
  });
});

describe("AgencyService close / pause / resume — pause is REVERSIBLE (#1202)", () => {
  it("closeJob emits job.closed (terminal)", async () => {
    const { svc, emit } = make({ ownedJob: jobRow() });
    await svc.closeJob(PAYER_A, JOB_ID, CTX);
    const evt = firstEmit(emit);
    expect(evt.event_name).toBe("job.closed");
    expect(evt.payload.status).toBe("closed");
    expect(evt.payload.previous_status).toBe("open");
  });

  // THE BUG #1202 EXISTS FOR. This assertion used to read `toBe("closed")` — the Payer App
  // called Pause, the server wrote a terminal close, and the user lost the job with no way
  // back. The old test passed while the product was wrong, which is why it is replaced
  // rather than added to.
  it("pauseJob sets status=PAUSED, not closed — the job is recoverable", async () => {
    const { svc, emit, jobsRepo } = make({ ownedJob: jobRow() });
    const view = await svc.pauseJob(PAYER_A, JOB_ID, CTX);
    expect(view.status).toBe("paused");
    expect(jobsRepo.pauseOwnedIfOpen).toHaveBeenCalledTimes(1);
    // ...and emphatically NOT through the close path, which is what it used to do.
    expect(jobsRepo.closeOwnedIfLive).not.toHaveBeenCalled();
    const evt = firstEmit(emit);
    expect(evt.event_name).toBe("job.updated");
    expect(evt.payload.status).toBe("paused");
    expect(evt.payload.changed_fields).toEqual(["status"]);
  });

  it("resumeJob returns a paused job to open and emits job.updated[status]", async () => {
    const { svc, emit, jobsRepo } = make({ ownedJob: jobRow({ status: "paused" }) });
    const view = await svc.resumeJob(PAYER_A, JOB_ID, CTX);
    expect(view.status).toBe("open");
    expect(jobsRepo.resumeOwnedIfPaused).toHaveBeenCalledTimes(1);
    const evt = firstEmit(emit);
    expect(evt.event_name).toBe("job.updated");
    expect(evt.payload.status).toBe("open");
  });

  it("a PAUSED job can still be closed — pause must not strand it (#1202)", async () => {
    // The gap the issue did not name. While pause WAS close, only `open` ever reached
    // closeJob, so its guard accepted `open` alone. Left that way, a paused job could be
    // resumed forever but never ended.
    const { svc, emit, jobsRepo } = make({ ownedJob: jobRow({ status: "paused" }) });
    await svc.closeJob(PAYER_A, JOB_ID, CTX);
    expect(jobsRepo.closeOwnedIfLive).toHaveBeenCalledTimes(1);
    const evt = firstEmit(emit);
    expect(evt.event_name).toBe("job.closed");
    // The state it ACTUALLY left — a hardcoded "open" would put a transition on the spine
    // that never happened.
    expect(evt.payload.previous_status).toBe("paused");
  });

  it("pauseJob refuses a job that is not open, neutrally", async () => {
    for (const status of ["closed", "paused", "suspended"] as const) {
      const { svc, jobsRepo } = make({ ownedJob: jobRow({ status }) });
      await expect(svc.pauseJob(PAYER_A, JOB_ID, CTX)).rejects.toBeInstanceOf(
        BadRequestException,
      );
      expect(jobsRepo.pauseOwnedIfOpen).not.toHaveBeenCalled();
    }
  });

  it("resumeJob refuses anything that is not paused — SUSPENDED especially (ADR-0037)", async () => {
    // `suspended` is SYSTEM-owned: only the reinstate cascade may lift it. A payer resuming
    // out of suspension would defeat it, so this is a security property, not tidiness.
    for (const status of ["open", "closed", "suspended"] as const) {
      const { svc, jobsRepo } = make({ ownedJob: jobRow({ status }) });
      await expect(svc.resumeJob(PAYER_A, JOB_ID, CTX)).rejects.toBeInstanceOf(
        BadRequestException,
      );
      expect(jobsRepo.resumeOwnedIfPaused).not.toHaveBeenCalled();
    }
  });

  it("a lost race is refused rather than reported as success", async () => {
    // The repo returns undefined when its guarded WHERE matches nothing — a concurrent
    // transition, or a cross-tenant id. The service must not treat that as done.
    const { svc, jobsRepo } = make({ ownedJob: jobRow() });
    jobsRepo.pauseOwnedIfOpen.mockResolvedValueOnce(undefined);
    await expect(svc.pauseJob(PAYER_A, JOB_ID, CTX)).rejects.toBeInstanceOf(BadRequestException);
  });

  it("an unknown or unowned job is 404, never a 400 that confirms it exists", async () => {
    const { svc } = make({ ownedJob: undefined });
    await expect(svc.pauseJob(PAYER_A, JOB_ID, CTX)).rejects.toBeInstanceOf(NotFoundException);
    await expect(svc.resumeJob(PAYER_A, JOB_ID, CTX)).rejects.toBeInstanceOf(NotFoundException);
  });
});

describe("AgencyService.createInvite (faceless mint)", () => {
  it("mints an opaque code and emits agency_invite.created (no PII)", async () => {
    const { svc, emit } = make();
    const res = await svc.createInvite(PAYER_A, { campaign: "spring_drive" }, CTX);
    expect(res.code).toMatch(/^[0-9a-f]{12}$/);
    expect(res.link).toBe(`/i/${res.code}`);

    const evt = firstEmit(emit);
    expect(evt.event_name).toBe("agency_invite.created");
    expect(evt.actor).toEqual({ actor_type: "payer", actor_id: PAYER_A });
    expect(evt.payload.inviter_payer_id).toBe(PAYER_A);
    expect(evt.payload.channel).toBe("whatsapp");
    // The opaque code is a shareable secret — it must NOT be carried in the event.
    expect(JSON.stringify(evt.payload)).not.toContain(res.code);
  });
});

describe("AgencyService.recordInviteClick (no-oracle)", () => {
  it("is a neutral no-op on an unknown code (no event, identical response)", async () => {
    const { svc, emit } = make({ invite: undefined });
    const res = await svc.recordInviteClick("deadbeefdead");
    expect(res).toEqual({ ok: true });
    expect(emit).not.toHaveBeenCalled();
  });

  it("advances created -> clicked for a known code", async () => {
    const { svc, invitesRepo } = make({
      invite: { id: INVITE_ID, inviterPayerId: PAYER_A, invitedWorkerId: null, status: "created" },
    });
    await svc.recordInviteClick("abc123abc123");
    expect(invitesRepo.setStatus).toHaveBeenCalledWith(INVITE_ID, "clicked");
  });

  // ---- TD113: the stage finally has an EVENT (it previously moved a status silently) ----

  it("emits agency_invite.clicked for a known code — ids + channel ONLY, no worker handle", async () => {
    const { svc, emit } = make({
      invite: { id: INVITE_ID, inviterPayerId: PAYER_A, invitedWorkerId: null, status: "created" },
    });
    await svc.recordInviteClick("abc123abc123");
    const evt = firstEmit(emit);
    expect(evt.event_name).toBe("agency_invite.clicked");
    expect(evt.subject).toMatchObject({ subject_type: "agency_invite", subject_id: INVITE_ID });
    // A click precedes the DPDP consent gate, so NO worker identity may be recorded (#6).
    expect(Object.keys(evt.payload).sort()).toEqual(
      ["agency_invite_id", "channel", "inviter_payer_id"].sort(),
    );
    // The opaque code is a shareable bearer token — never on the spine.
    expect(JSON.stringify(evt.payload)).not.toContain("abc123abc123");
  });

  it("still emits agency_invite.clicked for an ALREADY-clicked code (a re-open is a real click)", async () => {
    const { svc, emit, invitesRepo } = make({
      invite: { id: INVITE_ID, inviterPayerId: PAYER_A, invitedWorkerId: null, status: "clicked" },
    });
    await svc.recordInviteClick("abc123abc123");
    expect(invitesRepo.setStatus).not.toHaveBeenCalled(); // no status regression
    expect(firstEmit(emit).event_name).toBe("agency_invite.clicked");
    // UNKEYED like the sibling invite.clicked: collapsing repeat opens would destroy the
    // funnel signal the event exists to provide.
    expect((emit.mock.calls[0]![0] as { idempotencyKey?: string }).idempotencyKey).toBeUndefined();
  });
});

describe("AgencyService.attributeWorkerToInvite (consent-gated, internal seam)", () => {
  it("NO-OP (no_consent) + NO event when the worker has no consent row", async () => {
    const { svc, emit, invitesRepo } = make({
      invite: { id: INVITE_ID, inviterPayerId: PAYER_A, invitedWorkerId: null, status: "clicked" },
      consent: undefined,
    });
    const res = await svc.attributeWorkerToInvite("abc123abc123", WORKER_ID);
    expect(res).toEqual({ ok: false, reason: "no_consent" });
    expect(invitesRepo.markAccepted).not.toHaveBeenCalled();
    expect(emit).not.toHaveBeenCalled();
  });

  it("NO-OP (no_consent) + NO event when the latest consent is REVOKED", async () => {
    const { svc, emit, invitesRepo } = make({
      invite: { id: INVITE_ID, inviterPayerId: PAYER_A, invitedWorkerId: null, status: "clicked" },
      consent: { revokedAt: new Date() },
    });
    const res = await svc.attributeWorkerToInvite("abc123abc123", WORKER_ID);
    expect(res).toEqual({ ok: false, reason: "no_consent" });
    expect(invitesRepo.markAccepted).not.toHaveBeenCalled();
    expect(emit).not.toHaveBeenCalled();
  });

  it("attributes + emits agency_invite.accepted ONLY with an ACTIVE consent", async () => {
    const { svc, emit, invitesRepo } = make({
      invite: { id: INVITE_ID, inviterPayerId: PAYER_A, invitedWorkerId: null, status: "clicked" },
      consent: { revokedAt: null },
    });
    const res = await svc.attributeWorkerToInvite("abc123abc123", WORKER_ID);
    expect(res).toEqual({ ok: true });
    expect(invitesRepo.markAccepted).toHaveBeenCalledWith(INVITE_ID, WORKER_ID);
    const evt = firstEmit(emit);
    expect(evt.event_name).toBe("agency_invite.accepted");
    expect(evt.payload.invited_worker_id).toBe(WORKER_ID);
    expect(evt.payload.inviter_payer_id).toBe(PAYER_A);
  });

  // ---- B4: which leg of the post-Dynamic-Links chain carried the code ----

  it("ALSO emits invite.install (kind=agency) carrying the source, on the agency subject", async () => {
    const { svc, emit } = make({
      invite: { id: INVITE_ID, inviterPayerId: PAYER_A, invitedWorkerId: null, status: "clicked" },
      consent: { revokedAt: null },
    });
    await svc.attributeWorkerToInvite("abc123abc123", WORKER_ID, "app_link");
    const install = emit.mock.calls[1]![0] as {
      event_name: string;
      subject: { subject_type: string };
      payload: Record<string, unknown>;
      idempotencyKey: string;
    };
    expect(install.event_name).toBe("invite.install");
    expect(install.subject.subject_type).toBe("agency_invite");
    expect(install.payload).toEqual({
      invite_id: INVITE_ID,
      invite_kind: "agency",
      source: "app_link",
    });
    expect(install.idempotencyKey).toBe(`invite.install:${INVITE_ID}`);
  });

  it("source DEFAULTS to 'unknown' for callers that do not supply one (invariant #8)", async () => {
    const { svc, emit } = make({
      invite: { id: INVITE_ID, inviterPayerId: PAYER_A, invitedWorkerId: null, status: "clicked" },
      consent: { revokedAt: null },
    });
    await svc.attributeWorkerToInvite("abc123abc123", WORKER_ID);
    expect((emit.mock.calls[1]![0] as { payload: { source: string } }).payload.source).toBe(
      "unknown",
    );
  });

  it("no-ops on unknown code and on already-attributed invite (no event)", async () => {
    const unknown = make({ invite: undefined, consent: { revokedAt: null } });
    expect(await unknown.svc.attributeWorkerToInvite("x", WORKER_ID)).toEqual({
      ok: false,
      reason: "unknown_code",
    });
    expect(unknown.emit).not.toHaveBeenCalled();

    const attributed = make({
      invite: {
        id: INVITE_ID,
        inviterPayerId: PAYER_A,
        invitedWorkerId: "someone",
        status: "accepted",
      },
      consent: { revokedAt: null },
    });
    expect(await attributed.svc.attributeWorkerToInvite("x", WORKER_ID)).toEqual({
      ok: false,
      reason: "already_attributed",
    });
    expect(attributed.emit).not.toHaveBeenCalled();
  });

  // markAccepted RACE-LOSS: an UNATTRIBUTED invite + ACTIVE consent passes the gate, but the
  // conditional DB write loses a race to a concurrent attribution (markAccepted -> false). This
  // locks idempotency at the DB-guard layer (agency.service.ts:364-368): a re-run after a real
  // success is a no-op — already_attributed with NO duplicate event.
  it("NO-OP (already_attributed) + NO event when markAccepted loses the write race", async () => {
    const { svc, emit, invitesRepo } = make({
      invite: { id: INVITE_ID, inviterPayerId: PAYER_A, invitedWorkerId: null, status: "clicked" },
      consent: { revokedAt: null },
    });
    invitesRepo.markAccepted.mockResolvedValueOnce(false);
    const res = await svc.attributeWorkerToInvite("abc123abc123", WORKER_ID);
    expect(res).toEqual({ ok: false, reason: "already_attributed" });
    expect(invitesRepo.markAccepted).toHaveBeenCalledWith(INVITE_ID, WORKER_ID);
    expect(emit).not.toHaveBeenCalled();
  });

  // PII-FREE + EXACT-KEYS on the agency_invite.accepted payload. The allowed schema is
  // AgencyInviteAcceptedPayload = { agency_invite_id, inviter_payer_id, invited_worker_id }
  // (all opaque UUIDs). Asserting the EXACT key set guarantees ids-only — no extra leaked field.
  it("emits agency_invite.accepted with EXACTLY the three opaque ids and no PII", async () => {
    const { svc, emit } = make({
      invite: { id: INVITE_ID, inviterPayerId: PAYER_A, invitedWorkerId: null, status: "clicked" },
      consent: { revokedAt: null },
    });
    const res = await svc.attributeWorkerToInvite("abc123abc123", WORKER_ID);
    expect(res).toEqual({ ok: true });

    const evt = firstEmit(emit);
    expect(evt.event_name).toBe("agency_invite.accepted");
    expect(Object.keys(evt.payload).sort()).toEqual(
      ["agency_invite_id", "inviter_payer_id", "invited_worker_id"].sort(),
    );
    // Mirror the createInvite PII scan: no identity free-text in the payload.
    expect(JSON.stringify(evt.payload)).not.toMatch(/phone|name|email|address/i);
  });

  // ACTOR = system/null (NEVER the agency) + idempotencyKey present. The attribution is a
  // system-recorded fact post-consent; making the agency the actor would be an oracle ("the
  // agency attributed itself"). The idempotencyKey is the dedupe key for the DB-guard layer.
  it("records the accepted event as actor=system/null (not the agency) with a dedupe key", async () => {
    const { svc, emit } = make({
      invite: { id: INVITE_ID, inviterPayerId: PAYER_A, invitedWorkerId: null, status: "clicked" },
      consent: { revokedAt: null },
    });
    await svc.attributeWorkerToInvite("abc123abc123", WORKER_ID);

    // firstEmit asserts a call happened; read the raw arg for the actor + idempotencyKey
    // fields (the loose firstEmit shape does not model idempotencyKey).
    firstEmit(emit);
    const evt = emit.mock.calls[0]![0] as {
      actor: { actor_type: string; actor_id: string | null };
      idempotencyKey?: string;
    };
    expect(evt.actor).toEqual({ actor_type: "system", actor_id: null });
    expect(evt.idempotencyKey).toBe(`agency_invite.accepted:${INVITE_ID}`);
  });
});

describe("AgencyService.referralsSummary (k-anon floor, no consent oracle)", () => {
  it("suppresses counts strictly below MIN_BUCKET to 0 and echoes the floor", async () => {
    const { svc } = make({ stageCounts: { created: 12, clicked: 4, accepted: 1 } });
    const summary = await svc.referralsSummary(PAYER_A);
    expect(summary.minBucket).toBe(AgencyService.MIN_BUCKET);
    expect(summary.created).toBe(12); // >= floor → shown
    expect(summary.clicked).toBe(0); // 4 < 5 → suppressed
    expect(summary.accepted).toBe(0); // 1 < 5 → suppressed (can't tell ONE invitee consented)
  });

  it("shows counts at or above the floor unchanged", async () => {
    const { svc } = make({ stageCounts: { created: 20, clicked: 10, accepted: 5 } });
    const summary = await svc.referralsSummary(PAYER_A);
    expect(summary).toEqual({ created: 20, clicked: 10, accepted: 5, minBucket: 5 });
  });

  // ADR-0022 Appendix C.2 #2 — horizontal authz on the invite/summary path: an agent can
  // only summarize its OWN invites (the count query is keyed on the SESSION inviter_payer_id,
  // never a foreign payer), so agent A cannot read agent B's agency_invites.
  it("scopes the summary to the SESSION payer (agent A cannot summarize agent B's invites)", async () => {
    const { svc, invitesRepo } = make({ stageCounts: { created: 20, clicked: 10, accepted: 5 } });
    await svc.referralsSummary(PAYER_A);
    expect(invitesRepo.stageCountsForOwner).toHaveBeenCalledWith(PAYER_A);
    expect(invitesRepo.stageCountsForOwner).not.toHaveBeenCalledWith(PAYER_B);
  });
});

describe("AgencyService.createInvite — mint binds to the SESSION payer (XB-A)", () => {
  it("stamps inviter_payer_id = the session payer on the row AND the event (never a body value)", async () => {
    const { svc, emit, invitesRepo } = make({});
    await svc.createInvite(PAYER_A, { campaign: "spring_drive" }, CTX as never);
    // The row is created under the session payer, not PAYER_B.
    expect(invitesRepo.create).toHaveBeenCalledWith(
      expect.objectContaining({ inviterPayerId: PAYER_A }),
    );
    expect(invitesRepo.create).not.toHaveBeenCalledWith(
      expect.objectContaining({ inviterPayerId: PAYER_B }),
    );
    // The agency_invite.created event carries the session payer (opaque), PII-free.
    const arg = emit.mock.calls[0]![0] as Record<string, unknown>;
    expect(arg.event_name).toBe("agency_invite.created");
    const payload = arg.payload as Record<string, unknown>;
    expect(payload.inviter_payer_id).toBe(PAYER_A);
    expect(JSON.stringify(payload)).not.toMatch(/phone|name|email|address/i);
  });
});


// ---------------------------------------------------------------------------
// #1647 — `description`, `shift`, `benefits` and `requirements` were WRITE-ONLY.
//
// `POST` and `PATCH` accepted and stored all four; `toJobView` mapped id/status/trade/
// title/city/area/pay/experience/neededBy/counts and stopped there. So a payer could not
// see what they had posted: the agency edit screen had to start those inputs EMPTY and
// warn that typing there would overwrite whatever was stored.
// ---------------------------------------------------------------------------
describe("#1647 — the agency job view returns the content it accepts", () => {
  const CONTENT = {
    description: "Machining shop floor role on the day line.",
    shift: "night" as const,
    benefits: ["PF + ESI", "Canteen"],
    requirements: ["Fanuc control", "ITI / Diploma"],
    payType: "in_hand" as const,
  };

  it("returns all four on a single owned read", async () => {
    const { svc } = make({ ownedJob: jobRow(CONTENT) });
    const view = await svc.getOwnJob(PAYER_A, JOB_ID);
    expect(view).toMatchObject(CONTENT);
  });

  it("returns them on the LIST read too, so the edit screen can prefill", async () => {
    const { svc } = make({ ownedJob: jobRow(CONTENT) });
    const [view] = await svc.listOwnJobs(PAYER_A);
    expect(view).toMatchObject(CONTENT);
  });

  it("returns what a PATCH just stored, so the payer sees the result of their edit", async () => {
    const { svc } = make({ ownedJob: jobRow() });
    const view = await svc.updateJob(
      PAYER_A,
      JOB_ID,
      { description: CONTENT.description, benefits: CONTENT.benefits } as never,
      CTX,
    );
    // The repo double echoes the patched row; what is asserted here is that `toJobView`
    // PROJECTS it. A one-field PATCH used to answer without showing the payer anything.
    expect(view).toHaveProperty("description");
    expect(view).toHaveProperty("benefits");
  });

  it("passes nulls through honestly — an unstated field is absent, never fabricated", async () => {
    const { svc } = make({ ownedJob: jobRow() });
    const view = await svc.getOwnJob(PAYER_A, JOB_ID);
    expect(view.description).toBeNull();
    expect(view.shift).toBeNull();
    expect(view.benefits).toBeNull();
    expect(view.requirements).toBeNull();
    // #1648 — NULL means the poster did not state a pay type. Never defaulted to `gross`.
    expect(view.payType).toBeNull();
  });

  it("the view stays FACELESS: it still never returns the owner payer_id", async () => {
    // The guard on widening a projection. Four content fields joined the view; the one
    // field that must never join it is the tenant owner (ADR-0022 / ADR-0009 §2).
    const { svc } = make({ ownedJob: jobRow(CONTENT) });
    const view = await svc.getOwnJob(PAYER_A, JOB_ID);
    expect(view).not.toHaveProperty("payerId");
    expect(view).not.toHaveProperty("payer_id");
    expect(JSON.stringify(view)).not.toContain(PAYER_A);
  });
});


// ---------------------------------------------------------------------------
// #1652 — the agency contract had the same value-or-absent shape, so an agency job's
// pay band, shift or description could be overwritten but never removed.
// ---------------------------------------------------------------------------
describe("#1652 — clearing an agency job field", () => {
  const POPULATED = {
    area: "Pimpri-Chinchwad",
    payMin: 18000,
    payMax: 25000,
    payType: "in_hand" as const,
    minExperienceYears: 2,
    maxExperienceYears: 5,
    neededBy: "immediate" as const,
    description: "Machining shop floor role on the day line.",
    shift: "night" as const,
    benefits: ["PF + ESI"],
    requirements: ["Fanuc control"],
  };

  it("writes NULL for every cleared field", async () => {
    const { svc, jobsRepo } = make({ ownedJob: jobRow(POPULATED) });
    await svc.updateJob(
      PAYER_A,
      JOB_ID,
      { clear: ["shift", "description", "pay_type", "needed_by"] } as never,
      CTX,
    );
    expect(jobsRepo.updateOwned.mock.calls[0]![2]).toMatchObject({
      shift: null,
      description: null,
      payType: null,
      neededBy: null,
    });
  });

  it("VACUITY GUARD: those fields were genuinely set beforehand", () => {
    expect(POPULATED.shift).not.toBeNull();
    expect(POPULATED.description).not.toBeNull();
    expect(POPULATED.payType).not.toBeNull();
    expect(POPULATED.neededBy).not.toBeNull();
  });

  it("reports cleared fields as changed KEYS, never values", async () => {
    const { svc, emit } = make({ ownedJob: jobRow(POPULATED) });
    await svc.updateJob(PAYER_A, JOB_ID, { clear: ["area", "shift"] } as never, CTX);
    const payload = firstEmit(emit).payload;
    expect([...(payload.changed_fields as string[])].sort()).toEqual(["area", "shift"].sort());
    assertNoPiiStrings(payload);
  });

  it("clearing pay_min while SETTING a lower pay_max is legal", async () => {
    // Stored band 18000-25000. Under the pre-#1652 `??` check the cleared null fell
    // through to 18000 and this was rejected — the check validated the row being ERASED.
    const { svc, jobsRepo } = make({ ownedJob: jobRow(POPULATED) });
    await svc.updateJob(PAYER_A, JOB_ID, { pay_max: 9000, clear: ["pay_min"] } as never, CTX);
    expect(jobsRepo.updateOwned.mock.calls[0]![2]).toMatchObject({ payMin: null, payMax: 9000 });
  });

  it("still rejects an inverted band it did NOT clear", async () => {
    const { svc, jobsRepo } = make({ ownedJob: jobRow(POPULATED) });
    await expect(
      svc.updateJob(PAYER_A, JOB_ID, { pay_max: 9000 } as never, CTX),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(jobsRepo.updateOwned).not.toHaveBeenCalled();
  });

  it("clearing an already-null field is not a change", async () => {
    const { svc, jobsRepo } = make({ ownedJob: jobRow() }); // shift null in the fixture
    await expect(
      svc.updateJob(PAYER_A, JOB_ID, { clear: ["shift"] } as never, CTX),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(jobsRepo.updateOwned).not.toHaveBeenCalled();
  });

  it("CANNOT clear a NOT NULL column — city/title/trade_key have no name in the set", () => {
    // The safety property of the closed list. `jobs.city` is NOT NULL, so "city" is absent
    // from the agency set — even though `job_postings.city` IS nullable and its own set
    // DOES include it. Same word, different table, different answer.
    for (const name of ["city", "title", "trade_key", "status"]) {
      expect(UpdateAgencyJobSchema.safeParse({ clear: [name] }).success, name).toBe(false);
    }
    // …and a genuinely nullable one is accepted, so the loop above is not vacuous.
    expect(UpdateAgencyJobSchema.safeParse({ clear: ["area"] }).success).toBe(true);
  });

  it("rejects a field that is both SET and CLEARED", () => {
    const r = UpdateAgencyJobSchema.safeParse({ shift: "day", clear: ["shift"] });
    expect(r.success).toBe(false);
    expect(JSON.stringify(r.error?.issues)).toContain("both set and cleared");
  });
});

// ---------------------------------------------------------------------------
// Migration 0131 — the agency job's display ROLE (ADR-0036 addendum 2026-09-29). A SECOND
// classifier beside `trade_key`, never a replacement: `trade_key` stays the job's matching
// classifier and is untouched by everything below.
// ---------------------------------------------------------------------------
describe("migration 0131 — role_kind on the agency job routes", () => {
  it("create stores the role, returns it on the view, and puts it on job.created", async () => {
    const { svc, emit, jobsRepo } = make();
    const dto = CreateAgencyJobSchema.parse({
      trade_key: "cnc_operator",
      title: TITLE,
      city: CITY,
      role_kind: "vmc_milling",
    });
    const view = await svc.createJob(PAYER_A, dto, CTX);

    expect(jobsRepo.create).toHaveBeenCalledWith(
      expect.objectContaining({ tradeKey: "cnc_operator", roleKind: "vmc_milling" }),
      "open",
    );
    expect(view.roleKind).toBe("vmc_milling");
    // The trade key is still the job's classifier — the role did not replace it.
    expect(view.tradeKey).toBe("cnc_operator");
    const payload = firstEmit(emit).payload;
    expect(payload.role_kind).toBe("vmc_milling");
    expect(payload.trade_key).toBe("cnc_operator");
    assertNoPiiStrings(payload);
  });

  it("an omitted role stores NULL, returns null and events null — never inferred from trade_key", async () => {
    const { svc, emit, jobsRepo } = make();
    const dto = CreateAgencyJobSchema.parse({ trade_key: "fitter", title: TITLE, city: CITY });
    const view = await svc.createJob(PAYER_A, dto, CTX);
    expect(jobsRepo.create).toHaveBeenCalledWith(
      expect.objectContaining({ roleKind: null }),
      "open",
    );
    // `fitter` IS a role kind too; a trade key that happens to spell one is still not a pick.
    expect(view.roleKind).toBeNull();
    expect(firstEmit(emit).payload.role_kind).toBeNull();
  });

  it('an update reports changed_fields ["role_kind"] — the KEY, never the value, never trade_key', async () => {
    const { svc, emit, jobsRepo } = make({ ownedJob: jobRow() });
    const view = await svc.updateJob(PAYER_A, JOB_ID, { role_kind: "welder" } as never, CTX);

    expect(jobsRepo.updateOwned.mock.calls[0]![2]).toMatchObject({ roleKind: "welder" });
    expect(jobsRepo.updateOwned.mock.calls[0]![2]).not.toHaveProperty("tradeKey");
    const evt = firstEmit(emit);
    expect(evt.event_name).toBe("job.updated");
    expect(evt.payload.changed_fields).toEqual(["role_kind"]);
    expect(JSON.stringify(evt.payload)).not.toContain("welder");
    expect(view.roleKind).toBe("welder");
  });

  it('clear: ["role_kind"] stores NULL and reports the key', async () => {
    const { svc, emit, jobsRepo } = make({ ownedJob: jobRow({ roleKind: "welder" }) });
    await svc.updateJob(PAYER_A, JOB_ID, { clear: ["role_kind"] } as never, CTX);
    expect(jobsRepo.updateOwned.mock.calls[0]![2]).toMatchObject({ roleKind: null });
    expect(firstEmit(emit).payload.changed_fields).toEqual(["role_kind"]);
  });

  it("re-sending the SAME role is no change — 400, no write, no event", async () => {
    const { svc, emit, jobsRepo } = make({ ownedJob: jobRow({ roleKind: "welder" }) });
    await expect(
      svc.updateJob(PAYER_A, JOB_ID, { role_kind: "welder" } as never, CTX),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(jobsRepo.updateOwned).not.toHaveBeenCalled();
    expect(emit).not.toHaveBeenCalled();
  });

  it("the view returns a stored role on the single read and the list", async () => {
    const { svc } = make({ ownedJob: jobRow({ roleKind: "fitter" }) });
    expect((await svc.getOwnJob(PAYER_A, JOB_ID)).roleKind).toBe("fitter");
    const [listed] = await svc.listOwnJobs(PAYER_A);
    expect(listed!.roleKind).toBe("fitter");
  });
});

describe("migration 0131 — the role_kind CONTRACT on the agency DTOs", () => {
  const BASE = { trade_key: "cnc_operator", title: TITLE, city: CITY };

  it.each(TRADE_FORM_KINDS_ALL)("accepts %s on create and update — all 21 are postable", (kind) => {
    expect(CreateAgencyJobSchema.safeParse({ ...BASE, role_kind: kind }).success).toBe(true);
    expect(UpdateAgencyJobSchema.safeParse({ role_kind: kind }).success).toBe(true);
  });

  it("rejects anything outside the 21 — a trade key that is not a role, a label, free text", () => {
    for (const bad of ["cnc_operator", "Welder", "Ramesh 9876543210", ""]) {
      expect(CreateAgencyJobSchema.safeParse({ ...BASE, role_kind: bad }).success, bad).toBe(false);
      expect(UpdateAgencyJobSchema.safeParse({ role_kind: bad }).success, bad).toBe(false);
    }
  });

  it("rejects an explicit null — unsetting is `clear` (#1652)", () => {
    expect(CreateAgencyJobSchema.safeParse({ ...BASE, role_kind: null }).success).toBe(false);
    expect(UpdateAgencyJobSchema.safeParse({ role_kind: null }).success).toBe(false);
  });

  it("role_kind is clearable (nullable column) while trade_key still is not", () => {
    expect(UpdateAgencyJobSchema.safeParse({ clear: ["role_kind"] }).success).toBe(true);
    expect(UpdateAgencyJobSchema.safeParse({ clear: ["trade_key"] }).success).toBe(false);
    const both = UpdateAgencyJobSchema.safeParse({ role_kind: "welder", clear: ["role_kind"] });
    expect(both.success).toBe(false);
  });

  it("does not make trade_key optional — the matching classifier is still required on create", () => {
    const { trade_key: _omit, ...noTrade } = BASE;
    expect(CreateAgencyJobSchema.safeParse({ ...noTrade, role_kind: "welder" }).success).toBe(false);
  });
});

// ─────────────────── ADR-0050 §6.1 step 2 (#1983) — match_skill_ids ───────────────────

const TURNER = "mskill_cnc_turner";
const VMC = "mskill_vmc_operator";
const HMC = "mskill_hmc_operator";
const MIG = "mskill_mig_welder";
const ADMIN_ID = "77777777-7777-4777-8777-777777777777";

describe("#1983 — match_skill_ids on agency job CREATE", () => {
  const BASE = { trade_key: "cnc_operator", title: TITLE, city: CITY };

  it("omitted stores [] — a shipped client that never sends it is unchanged", async () => {
    const { svc, jobsRepo } = make();
    const view = await svc.createJob(PAYER_A, CreateAgencyJobSchema.parse(BASE), CTX);
    expect(jobsRepo.create.mock.calls[0]![0].matchSkillIds).toEqual([]);
    expect(view.matchSkillIds).toEqual([]);
  });

  it("stores a valid pick (de-duplicated) and returns it on the view", async () => {
    const { svc, jobsRepo } = make();
    const dto = CreateAgencyJobSchema.parse({ ...BASE, match_skill_ids: [TURNER, VMC, TURNER] });
    const view = await svc.createJob(PAYER_A, dto, CTX);
    expect(jobsRepo.create.mock.calls[0]![0].matchSkillIds).toEqual([TURNER, VMC]);
    expect(view.matchSkillIds).toEqual([TURNER, VMC]);
  });

  it("does not put the ids on job.created (v1 schema unchanged)", async () => {
    const { svc, emit } = make();
    await svc.createJob(
      PAYER_A,
      CreateAgencyJobSchema.parse({ ...BASE, match_skill_ids: [TURNER] }),
      CTX,
    );
    expect(JSON.stringify(firstEmit(emit).payload)).not.toContain(TURNER);
  });

  it("refuses an id outside the closed vocabulary — 400, nothing written, no event", async () => {
    const { svc, jobsRepo, emit } = make();
    const dto = CreateAgencyJobSchema.parse({ ...BASE, match_skill_ids: ["mskill_not_a_skill"] });
    await expect(svc.createJob(PAYER_A, dto, CTX)).rejects.toBeInstanceOf(BadRequestException);
    expect(jobsRepo.create).not.toHaveBeenCalled();
    expect(emit).not.toHaveBeenCalled();
  });

  it("refuses more than match_config.max_skills_per_posting — the CONFIG value, not a literal", async () => {
    const dto = CreateAgencyJobSchema.parse({ ...BASE, match_skill_ids: [TURNER, VMC, HMC] });
    const capped = make({ maxSkillsPerPosting: 2 });
    await expect(capped.svc.createJob(PAYER_A, dto, CTX)).rejects.toThrow(/at most 2/);
    expect(capped.jobsRepo.create).not.toHaveBeenCalled();
    // The same three are fine under a cap of 3.
    const roomy = make({ maxSkillsPerPosting: 3 });
    await expect(roomy.svc.createJob(PAYER_A, dto, CTX)).resolves.toBeDefined();
  });
});

describe("#1983 — match_skill_ids on agency job EDIT", () => {
  it("omitted leaves the stored pick unchanged (not in the patch)", async () => {
    const { svc, jobsRepo } = make({ ownedJob: jobRow({ matchSkillIds: [TURNER] }) });
    await svc.updateJob(PAYER_A, JOB_ID, UpdateAgencyJobSchema.parse({ title: "New title" }), CTX);
    expect("matchSkillIds" in jobsRepo.updateOwned.mock.calls[0]![2]).toBe(false);
  });

  it('a changed pick is written and reported as the KEY "match_skills" — never the ids', async () => {
    const { svc, jobsRepo, emit } = make({ ownedJob: jobRow({ matchSkillIds: [TURNER] }) });
    const view = await svc.updateJob(
      PAYER_A,
      JOB_ID,
      UpdateAgencyJobSchema.parse({ match_skill_ids: [VMC, HMC] }),
      CTX,
    );
    expect(jobsRepo.updateOwned.mock.calls[0]![2].matchSkillIds).toEqual([VMC, HMC]);
    expect(view.matchSkillIds).toEqual([VMC, HMC]);
    const evt = firstEmit(emit);
    expect(evt.event_name).toBe("job.updated");
    expect(evt.payload.changed_fields).toEqual(["match_skills"]);
    expect(JSON.stringify(evt.payload)).not.toContain("mskill_");
  });

  it("the same SET in another order is no change — 400, no write, no event", async () => {
    const { svc, jobsRepo, emit } = make({ ownedJob: jobRow({ matchSkillIds: [TURNER, VMC] }) });
    await expect(
      svc.updateJob(
        PAYER_A,
        JOB_ID,
        UpdateAgencyJobSchema.parse({ match_skill_ids: [VMC, TURNER] }),
        CTX,
      ),
    ).rejects.toThrow("no effective changes to apply");
    expect(jobsRepo.updateOwned).not.toHaveBeenCalled();
    expect(emit).not.toHaveBeenCalled();
  });

  it("an unknown id or an over-cap pick is a 400 before any write", async () => {
    const { svc, jobsRepo } = make({ ownedJob: jobRow(), maxSkillsPerPosting: 1 });
    for (const ids of [["mskill_nope"], [TURNER, VMC]]) {
      await expect(
        svc.updateJob(PAYER_A, JOB_ID, UpdateAgencyJobSchema.parse({ match_skill_ids: ids }), CTX),
      ).rejects.toBeInstanceOf(BadRequestException);
    }
    expect(jobsRepo.updateOwned).not.toHaveBeenCalled();
  });

  it('clear: ["match_skill_ids"] resets to [] (never NULL) and reports the key', async () => {
    const { svc, jobsRepo, emit } = make({ ownedJob: jobRow({ matchSkillIds: [TURNER] }) });
    await svc.updateJob(
      PAYER_A,
      JOB_ID,
      UpdateAgencyJobSchema.parse({ clear: ["match_skill_ids"] }),
      CTX,
    );
    expect(jobsRepo.updateOwned.mock.calls[0]![2].matchSkillIds).toEqual([]);
    expect(firstEmit(emit).payload.changed_fields).toEqual(["match_skills"]);
  });

  it("clearing an already-empty pick is not a change", async () => {
    const { svc, emit } = make({ ownedJob: jobRow({ matchSkillIds: [] }) });
    await expect(
      svc.updateJob(
        PAYER_A,
        JOB_ID,
        UpdateAgencyJobSchema.parse({ clear: ["match_skill_ids"] }),
        CTX,
      ),
    ).rejects.toThrow("no effective changes to apply");
    expect(emit).not.toHaveBeenCalled();
  });
});

describe("#1983 — the match_skill_ids CONTRACT on the agency DTOs", () => {
  const BASE = { trade_key: "cnc_operator", title: TITLE, city: CITY };

  it("is optional on create and on edit", () => {
    expect(CreateAgencyJobSchema.safeParse(BASE).success).toBe(true);
    expect(UpdateAgencyJobSchema.safeParse({ title: "x" }).success).toBe(true);
  });

  it("rejects a non-mskill shape, an empty list and an explicit null", () => {
    for (const bad of [["skill_cnc"], ["CNC turner"], [], null]) {
      expect(CreateAgencyJobSchema.safeParse({ ...BASE, match_skill_ids: bad }).success).toBe(
        false,
      );
      expect(UpdateAgencyJobSchema.safeParse({ match_skill_ids: bad }).success).toBe(false);
    }
  });

  it("is clearable, and set + clear of it in one body is rejected", () => {
    expect(UpdateAgencyJobSchema.safeParse({ clear: ["match_skill_ids"] }).success).toBe(true);
    expect(
      UpdateAgencyJobSchema.safeParse({ match_skill_ids: [TURNER], clear: ["match_skill_ids"] })
        .success,
    ).toBe(false);
  });
});

describe("#1983 — AgencyService.opsSetMatchSkills (ops, any agency job)", () => {
  it("sets the pick, returns changed:true and emits ONE job.updated with an OPS actor", async () => {
    const { svc, emit, jobsRepo } = make({ agencyJob: jobRow({ payerId: PAYER_B }) });
    const res = await svc.opsSetMatchSkills(JOB_ID, [MIG, MIG], ADMIN_ID, CTX);
    expect(res).toEqual({ job_id: JOB_ID, match_skill_ids: [MIG], changed: true });
    expect(jobsRepo.setMatchSkillIdsIfNotClosed).toHaveBeenCalledWith(
      JOB_ID,
      [MIG],
      expect.any(Date),
    );
    expect(emit).toHaveBeenCalledTimes(1);
    const evt = firstEmit(emit);
    expect(evt.event_name).toBe("job.updated");
    expect(evt.actor).toEqual({ actor_type: "ops", actor_id: ADMIN_ID });
    expect(evt.subject).toEqual({ subject_type: "job", subject_id: JOB_ID });
    // payer_id keeps its meaning: the job's OWNING agency, not the admin.
    expect(evt.payload).toEqual({
      job_id: JOB_ID,
      payer_id: PAYER_B,
      status: "open",
      changed_fields: ["match_skills"],
    });
  });

  it("[] resets the pick to 'not chosen yet'", async () => {
    const { svc, jobsRepo } = make({ agencyJob: jobRow({ matchSkillIds: [TURNER] }) });
    const res = await svc.opsSetMatchSkills(JOB_ID, [], ADMIN_ID, CTX);
    expect(res.changed).toBe(true);
    expect(jobsRepo.setMatchSkillIdsIfNotClosed).toHaveBeenCalledWith(JOB_ID, [], expect.any(Date));
  });

  it("an unchanged set (any order) is idempotent — changed:false, no write, no event", async () => {
    const { svc, emit, jobsRepo } = make({ agencyJob: jobRow({ matchSkillIds: [TURNER, VMC] }) });
    const res = await svc.opsSetMatchSkills(JOB_ID, [VMC, TURNER], ADMIN_ID, CTX);
    expect(res).toEqual({ job_id: JOB_ID, match_skill_ids: [TURNER, VMC], changed: false });
    expect(jobsRepo.setMatchSkillIdsIfNotClosed).not.toHaveBeenCalled();
    expect(emit).not.toHaveBeenCalled();
  });

  it("a non-agency or unknown job is the neutral 404", async () => {
    const { svc, emit } = make({ agencyJob: undefined });
    await expect(svc.opsSetMatchSkills(JOB_ID, [TURNER], ADMIN_ID, CTX)).rejects.toBeInstanceOf(
      NotFoundException,
    );
    expect(emit).not.toHaveBeenCalled();
  });

  it("a closed job cannot be edited, and a close that races the write is refused the same way", async () => {
    const closed = make({ agencyJob: jobRow({ status: "closed" }) });
    await expect(
      closed.svc.opsSetMatchSkills(JOB_ID, [TURNER], ADMIN_ID, CTX),
    ).rejects.toBeInstanceOf(BadRequestException);
    const raced = make({ agencyJob: jobRow() });
    raced.jobsRepo.setMatchSkillIdsIfNotClosed.mockResolvedValueOnce(undefined);
    await expect(
      raced.svc.opsSetMatchSkills(JOB_ID, [TURNER], ADMIN_ID, CTX),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(raced.emit).not.toHaveBeenCalled();
  });

  it("applies the SAME vocabulary + cap check as the agency form and the posting form", async () => {
    const { svc, jobsRepo } = make({ agencyJob: jobRow(), maxSkillsPerPosting: 1 });
    await expect(svc.opsSetMatchSkills(JOB_ID, ["mskill_nope"], ADMIN_ID, CTX)).rejects.toThrow(
      /unknown match skill/,
    );
    await expect(svc.opsSetMatchSkills(JOB_ID, [TURNER, VMC], ADMIN_ID, CTX)).rejects.toThrow(
      /at most 1/,
    );
    expect(jobsRepo.setMatchSkillIdsIfNotClosed).not.toHaveBeenCalled();
  });
});
