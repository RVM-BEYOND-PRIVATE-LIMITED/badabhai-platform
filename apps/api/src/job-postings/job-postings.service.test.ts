import "reflect-metadata";
import { describe, it, expect, vi } from "vitest";
import { BadRequestException, ConflictException, NotFoundException } from "@nestjs/common";
import { JobPostingsService } from "./job-postings.service";
import {
  CreateJobPostingSchema,
  UpdateJobPostingSchema,
  type CreateJobPostingDto,
} from "./job-postings.dto";

const POSTING_ID = "33333333-3333-4333-8333-333333333333";
const CREATED_BY = "44444444-4444-4444-8444-444444444444";
const PAYER_ID = "55555555-5555-4555-8555-555555555555";
// ADR-0027 B5.x Inc 1: OWNERSHIP is the caller's ORG. ORG_A is the acting org; ORG_B is a
// DIFFERENT org used for the cross-org IDOR test. A SECOND payer in ORG_A proves shared-org.
const ORG_ID = "66666666-6666-4666-8666-666666666666"; // ORG_A
const ORG_B_ID = "77777777-7777-4777-8777-777777777777"; // a foreign org
const PAYER_ID_2 = "88888888-8888-4888-8888-888888888888"; // a 2nd member of ORG_A
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
  payerId: string | null;
  orgId: string | null;
  orgLabel: string;
  roleTitle: string;
  locationLabel: string | null;
  description: string | null;
  vacancyBand: string;
  status: "draft" | "open" | "paused" | "closed";
  createdAt: Date;
  updatedAt: Date;
  closedAt: Date | null;
};

function row(overrides: Partial<Row> = {}): Row {
  return {
    id: POSTING_ID,
    createdBy: CREATED_BY,
    payerId: null,
    orgId: null,
    orgLabel: ORG,
    roleTitle: ROLE,
    locationLabel: null,
    description: null,
    vacancyBand: "2-5",
    status: "draft",
    createdAt: new Date(),
    updatedAt: new Date(),
    closedAt: null,
    ...overrides,
  };
}

function make(existing?: Row) {
  const emit = vi.fn().mockResolvedValue(undefined);
  const create = vi.fn().mockImplementation((input: Partial<Row>) => Promise.resolve(row(input)));
  const findById = vi.fn().mockResolvedValue(existing);
  const update = vi
    .fn()
    .mockImplementation((id: string, patch: Partial<Row>) =>
      Promise.resolve(row({ ...existing, ...patch, id })),
    );
  const close = vi
    .fn()
    .mockImplementation((id: string, _prev: "draft" | "open", closedAt: Date) =>
      Promise.resolve(row({ ...existing, id, status: "closed", closedAt })),
    );
  const list = vi.fn().mockResolvedValue([]);
  // Payer ORG-scoped repo methods (ADR-0027 B5.x Inc 1). Default: the row IS in the org;
  // tests override findByIdAndOrg with undefined to exercise the other-org / no-oracle path.
  const findByIdAndOrg = vi.fn().mockResolvedValue(existing);
  const listByOrg = vi.fn().mockResolvedValue([]);
  const updateOwned = vi
    .fn()
    .mockImplementation((id: string, _orgId: string, patch: Partial<Row>) =>
      Promise.resolve(row({ ...existing, ...patch, id })),
    );
  const closeOwned = vi
    .fn()
    .mockImplementation((id: string, _orgId: string, _prev: "draft" | "open", closedAt: Date) =>
      Promise.resolve(row({ ...existing, id, status: "closed", closedAt })),
    );
  // Org + status-guarded transition (B1; ADR-0027 B5.x Inc 3): only transitions when the
  // existing row's status matches `fromStatus` (mirrors the DB WHERE guard); otherwise
  // undefined → the service 409s. Ownership is now keyed on org_id (2nd arg), not payer_id.
  const transitionOwned = vi
    .fn()
    .mockImplementation(
      (id: string, _orgId: string, fromStatus: Row["status"], toStatus: Row["status"]) =>
        Promise.resolve(
          existing && existing.status === fromStatus
            ? row({ ...existing, id, status: toStatus })
            : undefined,
        ),
    );
  const svc = new JobPostingsService(
    {
      create,
      findById,
      update,
      close,
      list,
      findByIdAndOrg,
      listByOrg,
      updateOwned,
      closeOwned,
      transitionOwned,
    } as never,
    { emit } as never,
  );
  return {
    svc,
    emit,
    create,
    findById,
    update,
    close,
    list,
    findByIdAndOrg,
    listByOrg,
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

describe("JobPostingsService.pauseForPayer / resumeForPayer (B1 → ADR-0027 B5.x Inc 3 org-owned)", () => {
  // Ownership is the caller's ORG (2nd arg); the acting session payer (3rd arg) is the event
  // actor only. The DB transition + the ownership pre-read both key on org_id.
  it("pauses an OPEN posting (open -> paused) keyed on ORG + emits a PII-free job_posting.paused (payer actor)", async () => {
    const { svc, emit, transitionOwned, findByIdAndOrg } = make(row({ status: "open" }));
    const res = await svc.pauseForPayer(POSTING_ID, ORG_ID, PAYER_ID, CTX as never);
    expect(res.status).toBe("paused");
    // Ownership pre-read + the transition are BOTH org-scoped; the actor stays the payer.
    expect(findByIdAndOrg).toHaveBeenCalledWith(POSTING_ID, ORG_ID);
    expect(transitionOwned).toHaveBeenCalledWith(POSTING_ID, ORG_ID, "open", "paused");
    const arg = emit.mock.calls[0]![0];
    expect(arg.event_name).toBe("job_posting.paused");
    expect(arg.actor).toEqual({ actor_type: "payer", actor_id: PAYER_ID });
    expect(arg.subject).toEqual({ subject_type: "job_posting", subject_id: POSTING_ID });
    expect(arg.payload).toEqual({
      job_posting_id: POSTING_ID,
      previous_status: "open",
      status: "paused",
    });
    assertNoFreeText(arg.payload);
  });

  it("resumes a PAUSED posting (paused -> open) keyed on ORG + emits job_posting.resumed", async () => {
    const { svc, emit, transitionOwned } = make(row({ status: "paused" }));
    const res = await svc.resumeForPayer(POSTING_ID, ORG_ID, PAYER_ID, CTX as never);
    expect(res.status).toBe("open");
    expect(transitionOwned).toHaveBeenCalledWith(POSTING_ID, ORG_ID, "paused", "open");
    const arg = emit.mock.calls[0]![0];
    expect(arg.event_name).toBe("job_posting.resumed");
    expect(arg.actor).toEqual({ actor_type: "payer", actor_id: PAYER_ID });
    expect(arg.payload).toEqual({
      job_posting_id: POSTING_ID,
      previous_status: "paused",
      status: "open",
    });
    assertNoFreeText(arg.payload);
  });

  it("shared-org: a SECOND member of ORG_A can pause the org's posting (ownership is org, not payer)", async () => {
    const { svc, transitionOwned } = make(row({ status: "open" }));
    // PAYER_ID_2 is a different member of ORG_A; the transition still keys on ORG_ID.
    const res = await svc.pauseForPayer(POSTING_ID, ORG_ID, PAYER_ID_2, CTX as never);
    expect(res.status).toBe("paused");
    expect(transitionOwned).toHaveBeenCalledWith(POSTING_ID, ORG_ID, "open", "paused");
  });

  it("409s when pausing a non-open posting (draft) and does not emit", async () => {
    const { svc, emit } = make(row({ status: "draft" }));
    await expect(svc.pauseForPayer(POSTING_ID, ORG_ID, PAYER_ID, CTX as never)).rejects.toBeInstanceOf(
      ConflictException,
    );
    expect(emit).not.toHaveBeenCalled();
  });

  it("409s when resuming a non-paused posting (open) and does not emit", async () => {
    const { svc, emit } = make(row({ status: "open" }));
    await expect(svc.resumeForPayer(POSTING_ID, ORG_ID, PAYER_ID, CTX as never)).rejects.toBeInstanceOf(
      ConflictException,
    );
    expect(emit).not.toHaveBeenCalled();
  });

  it("404s (no-oracle) when the posting is unknown OR another ORG's, and does not emit", async () => {
    // findByIdAndOrg → undefined (not-found OR foreign-org): the ownership pre-read 404s before
    // the transition. Using ORG_B_ID as the caller proves cross-org IDOR is closed.
    const { svc, emit, transitionOwned } = make(undefined);
    await expect(svc.pauseForPayer(POSTING_ID, ORG_B_ID, PAYER_ID, CTX as never)).rejects.toBeInstanceOf(
      NotFoundException,
    );
    expect(transitionOwned).not.toHaveBeenCalled();
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
// DTO guards (Zod) — PII heuristic on description ONLY, length caps on all four
// free-text fields. These are D3 defense-in-depth (the events are PII-free by
// construction); they reject obvious leaks at the boundary.
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
// PAYER self-serve surface (ADR-0019 / ADR-0022 module 9 → ADR-0027 B5.x Inc 1) —
// OWNERSHIP is the caller's ORG (org-scoped CRUD). Any org member shares the org's
// postings; create stamps BOTH org_id (the new key) + payer_id (rollback / CHECK); the
// event actor stays the acting payer (opaque); no-oracle 404 for unknown OR other-org.
// Signature: (id?, orgId, [payerId], dto?, ctx?).
// ---------------------------------------------------------------------------
describe("JobPostingsService — payer self-serve, ORG-scoped (*ForPayer)", () => {
  it("createForPayer stamps BOTH org_id AND payer_id, keeps created_by = the payer, status=draft", async () => {
    const { svc, create } = make();
    await svc.createForPayer(
      ORG_ID,
      PAYER_ID,
      { org_label: ORG, role_title: ROLE, vacancy_band: "2-5" },
      CTX as never,
    );
    // The row is created with org_id = the session org (ownership) AND payer_id =
    // created_by = the session payer (rollback + the org_id_when_payer CHECK); status draft.
    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({
        orgId: ORG_ID,
        payerId: PAYER_ID,
        createdBy: PAYER_ID,
        status: "draft",
      }),
    );
  });

  it("createForPayer emits job_posting.created with the PAYER actor, payload PII-free (no payer_id/org_id)", async () => {
    const { svc, emit } = make();
    await svc.createForPayer(
      ORG_ID,
      PAYER_ID,
      { org_label: ORG, role_title: ROLE, location_label: LOCATION, vacancies: 7 },
      CTX as never,
    );
    const arg = emit.mock.calls[0]![0] as Record<string, unknown>;
    expect(arg.event_name).toBe("job_posting.created");
    expect(arg.actor).toEqual({ actor_type: "payer", actor_id: PAYER_ID });
    const payload = arg.payload as Record<string, unknown>;
    // created_by carries the opaque payer id; NEITHER payer_id NOR org_id is a payload key.
    expect(payload.created_by).toBe(PAYER_ID);
    expect(payload).not.toHaveProperty("payer_id");
    expect(payload).not.toHaveProperty("org_id");
    assertNoFreeText(payload); // org/role/location free text never leaves the row
  });

  it("listForPayer + getOneForPayer scope to the session ORG (not the payer)", async () => {
    const { svc, listByOrg, findByIdAndOrg } = make(row({ orgId: ORG_ID } as Partial<Row>));
    await svc.listForPayer(ORG_ID, { status: "open" });
    expect(listByOrg).toHaveBeenCalledWith(ORG_ID, "open");
    await svc.getOneForPayer(POSTING_ID, ORG_ID);
    expect(findByIdAndOrg).toHaveBeenCalledWith(POSTING_ID, ORG_ID);
  });

  it("getOneForPayer 404s (no-oracle) for an unknown OR another ORG's posting", async () => {
    const { svc, findByIdAndOrg } = make();
    findByIdAndOrg.mockResolvedValueOnce(undefined); // not found OR other-org — same result
    await expect(svc.getOneForPayer(POSTING_ID, ORG_ID)).rejects.toBeInstanceOf(NotFoundException);
  });

  it("updateForPayer reads + writes ORG-scoped and emits the acting PAYER actor", async () => {
    const existing = row({ status: "draft", orgId: ORG_ID } as Partial<Row>);
    const { svc, emit, findByIdAndOrg, updateOwned, update } = make(existing);
    await svc.updateForPayer(
      POSTING_ID,
      ORG_ID,
      PAYER_ID,
      { role_title: "CNC Operator" },
      CTX as never,
    );
    expect(findByIdAndOrg).toHaveBeenCalledWith(POSTING_ID, ORG_ID);
    expect(updateOwned).toHaveBeenCalledWith(
      POSTING_ID,
      ORG_ID,
      expect.objectContaining({ roleTitle: "CNC Operator" }),
    );
    // The ops (unscoped) update path is NEVER used by the payer surface.
    expect(update).not.toHaveBeenCalled();
    const arg = emit.mock.calls[0]![0] as Record<string, unknown>;
    // Actor is the acting payer (opaque), even though ownership is the org.
    expect(arg.actor).toEqual({ actor_type: "payer", actor_id: PAYER_ID });
  });

  it("updateForPayer 404s (no-oracle) for an other-org posting BEFORE any write", async () => {
    const { svc, findByIdAndOrg, updateOwned } = make();
    findByIdAndOrg.mockResolvedValueOnce(undefined);
    await expect(
      svc.updateForPayer(POSTING_ID, ORG_ID, PAYER_ID, { role_title: "X" }, CTX as never),
    ).rejects.toBeInstanceOf(NotFoundException);
    expect(updateOwned).not.toHaveBeenCalled();
  });

  it("closeForPayer reads + closes ORG-scoped and emits the acting PAYER actor", async () => {
    const existing = row({ status: "open", orgId: ORG_ID } as Partial<Row>);
    const { svc, emit, closeOwned, close } = make(existing);
    await svc.closeForPayer(POSTING_ID, ORG_ID, PAYER_ID, CTX as never);
    expect(closeOwned).toHaveBeenCalledWith(POSTING_ID, ORG_ID, "open", expect.any(Date));
    expect(close).not.toHaveBeenCalled(); // never the ops (unscoped) close
    const arg = emit.mock.calls[0]![0] as Record<string, unknown>;
    expect(arg.event_name).toBe("job_posting.closed");
    expect(arg.actor).toEqual({ actor_type: "payer", actor_id: PAYER_ID });
  });

  it("closeForPayer 404s (no-oracle) for an other-org posting BEFORE any write", async () => {
    const { svc, findByIdAndOrg, closeOwned } = make();
    findByIdAndOrg.mockResolvedValueOnce(undefined);
    await expect(
      svc.closeForPayer(POSTING_ID, ORG_ID, PAYER_ID, CTX as never),
    ).rejects.toBeInstanceOf(NotFoundException);
    expect(closeOwned).not.toHaveBeenCalled();
  });

  it("closeForPayer 409s when the org row was already closed (concurrent close)", async () => {
    const existing = row({ status: "open", orgId: ORG_ID } as Partial<Row>);
    const { svc, closeOwned } = make(existing);
    closeOwned.mockResolvedValueOnce(undefined); // guarded update found nothing to close
    await expect(
      svc.closeForPayer(POSTING_ID, ORG_ID, PAYER_ID, CTX as never),
    ).rejects.toBeInstanceOf(ConflictException);
  });
});

// ---------------------------------------------------------------------------
// ADR-0027 B5.x Inc 1 — cross-org IDOR + shared-org tenancy. The org_id in the WHERE is
// the SINGLE authorization boundary: a member of org A can never see/mutate org B's row
// (identical neutral 404, no leak of B's data), and two DIFFERENT members of the SAME
// org both manage the org's postings (shared-org).
// ---------------------------------------------------------------------------
describe("JobPostingsService — cross-org IDOR (org A cannot touch org B's posting)", () => {
  // The stored row belongs to ORG_ID (org A). Every ORG-scoped repo method is org-filtered,
  // so when the CALLER's org is ORG_B_ID the guarded read/write resolves undefined — the
  // service maps that to the SAME neutral 404 as a genuinely unknown id (no oracle).
  const bRow = row({ orgId: ORG_ID, payerId: PAYER_ID, status: "open" } as Partial<Row>);

  it("get: member of org B reading org A's posting gets the neutral 404 (never A's data)", async () => {
    const { svc, findByIdAndOrg } = make(bRow);
    // The org-scoped read for ORG_B_ID finds nothing (row is ORG_ID's).
    findByIdAndOrg.mockResolvedValueOnce(undefined);
    await expect(svc.getOneForPayer(POSTING_ID, ORG_B_ID)).rejects.toBeInstanceOf(NotFoundException);
    // The org-scope was applied at the data layer with the CALLER's org, not the row's.
    expect(findByIdAndOrg).toHaveBeenCalledWith(POSTING_ID, ORG_B_ID);
  });

  it("update: member of org B updating org A's posting gets the neutral 404, no write", async () => {
    const { svc, findByIdAndOrg, updateOwned } = make(bRow);
    findByIdAndOrg.mockResolvedValueOnce(undefined);
    await expect(
      svc.updateForPayer(POSTING_ID, ORG_B_ID, PAYER_ID_2, { role_title: "X" }, CTX as never),
    ).rejects.toBeInstanceOf(NotFoundException);
    expect(updateOwned).not.toHaveBeenCalled(); // never reaches the write
  });

  it("pause/close: member of org B closing org A's posting gets the neutral 404, no write", async () => {
    const { svc, findByIdAndOrg, closeOwned } = make(bRow);
    findByIdAndOrg.mockResolvedValueOnce(undefined);
    await expect(
      svc.closeForPayer(POSTING_ID, ORG_B_ID, PAYER_ID_2, CTX as never),
    ).rejects.toBeInstanceOf(NotFoundException);
    expect(closeOwned).not.toHaveBeenCalled();
  });
});

describe("JobPostingsService — shared-org (two members of the SAME org manage the org's postings)", () => {
  // The row belongs to ORG_ID. BOTH PAYER_ID (owner) and PAYER_ID_2 (recruiter) act within
  // ORG_ID, so the SAME org-scoped read/write succeeds for either — the payer differs only
  // as the (opaque) event actor, never as the ownership key.
  it("both members see the org's posting (get succeeds for either, org-scoped identically)", async () => {
    const shared = row({ orgId: ORG_ID, status: "open" } as Partial<Row>);
    const { svc, findByIdAndOrg } = make(shared);
    const asOwner = await svc.getOneForPayer(POSTING_ID, ORG_ID);
    const asRecruiter = await svc.getOneForPayer(POSTING_ID, ORG_ID);
    expect(asOwner.id).toBe(POSTING_ID);
    expect(asRecruiter.id).toBe(POSTING_ID);
    // Both reads used the SAME org key (ORG_ID) — not either payer id.
    expect(findByIdAndOrg).toHaveBeenNthCalledWith(1, POSTING_ID, ORG_ID);
    expect(findByIdAndOrg).toHaveBeenNthCalledWith(2, POSTING_ID, ORG_ID);
  });

  it("a DIFFERENT member (recruiter) can update the org's posting; actor is that recruiter", async () => {
    const shared = row({ orgId: ORG_ID, status: "draft" } as Partial<Row>);
    const { svc, emit, updateOwned } = make(shared);
    // PAYER_ID_2 (a 2nd member of ORG_ID) edits a posting created by PAYER_ID.
    await svc.updateForPayer(
      POSTING_ID,
      ORG_ID,
      PAYER_ID_2,
      { role_title: "CNC Operator" },
      CTX as never,
    );
    expect(updateOwned).toHaveBeenCalledWith(
      POSTING_ID,
      ORG_ID,
      expect.objectContaining({ roleTitle: "CNC Operator" }),
    );
    const arg = emit.mock.calls[0]![0] as Record<string, unknown>;
    // Ownership is the shared org; the ACTOR is whoever acted (the 2nd member).
    expect(arg.actor).toEqual({ actor_type: "payer", actor_id: PAYER_ID_2 });
  });
});
