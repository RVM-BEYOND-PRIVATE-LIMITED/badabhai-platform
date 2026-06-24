import "reflect-metadata";
import { describe, it, expect, vi } from "vitest";
import { BadRequestException, ForbiddenException, NotFoundException } from "@nestjs/common";
import { AgencyService } from "./agency.service";
import { CreateAgencyJobSchema, UpdateAgencyJobSchema } from "./agency.dto";

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
  status: "open" | "closed";
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
}) {
  const emit = vi.fn().mockResolvedValue(undefined);

  const jobsRepo = {
    create: vi
      .fn()
      .mockImplementation((input: Partial<JobRow>, status: "open" | "closed") =>
        Promise.resolve(jobRow({ ...input, status })),
      ),
    findOwnedById: vi.fn().mockResolvedValue(opts?.ownedJob),
    listOwned: vi.fn().mockResolvedValue(opts?.ownedJob ? [opts.ownedJob] : []),
    updateOwned: vi
      .fn()
      .mockImplementation((id: string, _p: string, patch: Partial<JobRow>) =>
        Promise.resolve(jobRow({ ...opts?.ownedJob, ...patch, id })),
      ),
    closeOwnedIfOpen: vi
      .fn()
      .mockImplementation((id: string) =>
        Promise.resolve(jobRow({ ...opts?.ownedJob, id, status: "closed" })),
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

  const svc = new AgencyService(
    jobsRepo as never,
    invitesRepo as never,
    consent as never,
    { emit } as never,
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

  it("rejects an edit on a closed job", async () => {
    const { svc } = make({ ownedJob: jobRow({ status: "closed" }) });
    const dto = UpdateAgencyJobSchema.parse({ title: "X" });
    await expect(svc.updateJob(PAYER_A, JOB_ID, dto, CTX)).rejects.toBeInstanceOf(
      BadRequestException,
    );
  });
});

describe("AgencyService.closeJob / pauseJob (pause==close, Phase-1)", () => {
  it("closeJob emits job.closed (terminal)", async () => {
    const { svc, emit } = make({ ownedJob: jobRow() });
    await svc.closeJob(PAYER_A, JOB_ID, CTX);
    const evt = firstEmit(emit);
    expect(evt.event_name).toBe("job.closed");
    expect(evt.payload.status).toBe("closed");
    expect(evt.payload.previous_status).toBe("open");
  });

  it("pauseJob sets status=closed (Reach stops serving) and emits job.updated[status]", async () => {
    const { svc, emit } = make({ ownedJob: jobRow() });
    const view = await svc.pauseJob(PAYER_A, JOB_ID, CTX);
    expect(view.status).toBe("closed");
    const evt = firstEmit(emit);
    expect(evt.event_name).toBe("job.updated");
    expect(evt.payload.changed_fields).toEqual(["status"]);
  });
});

describe("AgencyService.createInvite (faceless mint)", () => {
  it("mints an opaque code and emits agency_invite.created (no PII)", async () => {
    const { svc, emit } = make();
    const res = await svc.createInvite(PAYER_A, "spring_drive", CTX);
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
    await svc.createInvite(PAYER_A, "spring_drive", CTX as never);
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
