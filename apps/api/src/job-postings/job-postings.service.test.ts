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
  status: "draft" | "open" | "closed";
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
  const svc = new JobPostingsService(
    { create, findById, update, close, list } as never,
    { emit } as never,
  );
  return { svc, emit, create, findById, update, close, list };
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
});

describe("JobPostingsService.update", () => {
  it("emits job_posting.updated with changed_fields KEYS only (no free-text values)", async () => {
    const { svc, emit } = make(row({ status: "draft", vacancyBand: "2-5" }));
    await svc.update(POSTING_ID, { role_title: "CNC Operator", vacancy_band: "11-25" }, CTX as never);

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
    await expect(
      svc.update(POSTING_ID, { role_title: "X" }, CTX as never),
    ).rejects.toBeInstanceOf(NotFoundException);
    expect(emit).not.toHaveBeenCalled();
  });

  it("409s on any edit to a closed posting (terminal) and does not emit", async () => {
    const { svc, emit } = make(row({ status: "closed" }));
    await expect(
      svc.update(POSTING_ID, { role_title: "X" }, CTX as never),
    ).rejects.toBeInstanceOf(ConflictException);
    expect(emit).not.toHaveBeenCalled();
  });

  it("409s on an open -> draft attempt is impossible via DTO; open->open publish rejected", async () => {
    // status="open" on an already-open posting is not a valid transition (only
    // draft->open is allowed via PATCH).
    const { svc, emit } = make(row({ status: "open" }));
    await expect(
      svc.update(POSTING_ID, { status: "open" }, CTX as never),
    ).rejects.toBeInstanceOf(ConflictException);
    expect(emit).not.toHaveBeenCalled();
  });

  it("rejects a no-op edit (no effective changes) without emitting", async () => {
    const { svc, emit } = make(row({ status: "draft", roleTitle: ROLE }));
    await expect(
      svc.update(POSTING_ID, { role_title: ROLE }, CTX as never),
    ).rejects.toBeInstanceOf(BadRequestException);
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
    const parsed = CreateJobPostingSchema.parse({ ...base, status: "open" } as unknown as CreateJobPostingDto);
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
