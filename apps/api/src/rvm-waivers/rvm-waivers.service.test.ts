import { NotFoundException, ServiceUnavailableException } from "@nestjs/common";
import { describe, expect, it, vi } from "vitest";
import type { RvmApplicantWaiverRow } from "@badabhai/db";
import {
  RvmWaiversService,
  WaiverCompanyNotFoundError,
  WaiverPostingNotFoundError,
  type SetWaiverInput,
} from "./rvm-waivers.service";

/**
 * #2750 item 5 — the placement team's waivers: who may change what, idempotent by state, one
 * transaction for the row, its event and (for an admin) its audit row, encrypted staff names, and
 * the switch and the missing table answered as 404 and 503.
 */

const COMPANY = "c0000000-0000-4000-8000-000000000001";
const TENANT = "c0000000-0000-4000-8000-0000000000aa";
const POSTING = "p0000000-0000-4000-8000-000000000001";
const STAFF = "5a000000-0000-4000-8000-000000000001";
const ADMIN = "ad000000-0000-4000-8000-000000000001";
const CTX = { correlationId: "corr", requestId: "req" } as never;

function row(over: Partial<RvmApplicantWaiverRow> = {}): RvmApplicantWaiverRow {
  return {
    id: "waiver-1",
    scope: "company",
    payerId: TENANT,
    jobPostingId: null,
    active: true,
    source: "campus",
    setByRef: STAFF,
    setByLabelEnc: "enc:Asha",
    reason: "Drive partner",
    createdAt: new Date("2026-11-17T06:30:00Z"),
    clearedAt: null,
    clearedByRef: null,
    clearedByLabelEnc: null,
    clearReason: null,
    ...over,
  };
}

interface Opts {
  live?: boolean;
  status?: "active" | "pending" | "suspended" | "archived" | undefined;
  tenant?: string | null;
  postingOwner?: string | undefined;
  active?: RvmApplicantWaiverRow | undefined;
  latest?: RvmApplicantWaiverRow | undefined;
  adminNameEnc?: string | null;
  txError?: unknown;
}

function harness(opts: Opts = {}) {
  const tx = { tx: true };
  const repo = {
    companyStatus: vi.fn(async () => ("status" in opts ? opts.status : "active")),
    postingOwner: vi.fn(async () => ("postingOwner" in opts ? opts.postingOwner : TENANT)),
    adminNameEnc: vi.fn(async () => opts.adminNameEnc ?? null),
    withTransaction: vi.fn(async (work: (t: unknown) => Promise<unknown>) => {
      if (opts.txError) throw opts.txError;
      return work(tx);
    }),
    lockScope: vi.fn(async () => undefined),
    findActive: vi.fn(async () => opts.active),
    findLatest: vi.fn(async () => opts.latest),
    insert: vi.fn(async (_tx: unknown, r: Record<string, unknown>) =>
      row({
        id: "waiver-new",
        scope: r.scope as "company" | "job",
        jobPostingId: r.jobPostingId as string | null,
        source: r.source as "campus" | "admin",
        setByRef: r.setByRef as string,
        setByLabelEnc: r.setByLabelEnc as string | null,
        reason: r.reason as string,
      }),
    ),
    clear: vi.fn(async (_tx: unknown, id: string, c: Record<string, unknown>) =>
      row({
        id,
        active: false,
        clearedAt: c.at as Date,
        clearedByRef: c.clearedByRef as string,
        clearedByLabelEnc: c.clearedByLabelEnc as string | null,
        clearReason: c.clearReason as string,
      }),
    ),
    audit: vi.fn(async () => undefined),
    usesOf: vi.fn(async (ids: readonly string[]) => new Map(ids.map((id) => [id, 2]))),
    list: vi.fn(async () => [] as unknown[]),
  };
  const creditRules = {
    assertLive: vi.fn(() => {
      if (opts.live === false) throw new NotFoundException();
    }),
  };
  const tenancy = {
    resolveReadOnly: vi.fn(async () =>
      opts.tenant === null ? null : { tenantKey: opts.tenant ?? TENANT },
    ),
  };
  const crypto = {
    encrypt: vi.fn((v: string) => `enc:${v}`),
    decrypt: vi.fn((v: string) => {
      if (!v.startsWith("enc:")) throw new Error("bad token");
      return v.slice(4);
    }),
  };
  const events = { emit: vi.fn(async () => undefined) };
  const service = new RvmWaiversService(
    repo as never,
    creditRules as never,
    tenancy as never,
    crypto as never,
    events as never,
  );
  return { service, repo, events, crypto, tenancy, tx };
}

const campusSet = (over: Partial<SetWaiverInput> = {}): SetWaiverInput => ({
  scope: "company",
  companyId: COMPANY,
  postingId: null,
  active: true,
  reason: "Drive partner",
  actor: { kind: "campus", staffRef: STAFF, staffLabel: "Asha" },
  ...over,
});

describe("RvmWaiversService.set — who and what", () => {
  it("off everywhere: 404 before anything is read", async () => {
    const h = harness({ live: false });
    await expect(h.service.set(campusSet(), CTX)).rejects.toBeInstanceOf(NotFoundException);
    expect(h.repo.companyStatus).not.toHaveBeenCalled();
    expect(h.repo.withTransaction).not.toHaveBeenCalled();
  });

  it.each([
    ["an unknown company", { status: undefined }],
    ["a suspended company", { status: "suspended" as const }],
    ["an archived company", { status: "archived" as const }],
    ["a company with no tenant", { tenant: null }],
  ])("%s is the neutral not-found, nothing written", async (_label, o) => {
    const h = harness(o);
    await expect(h.service.set(campusSet(), CTX)).rejects.toBeInstanceOf(
      WaiverCompanyNotFoundError,
    );
    expect(h.repo.withTransaction).not.toHaveBeenCalled();
  });

  it("a job waiver on another company's posting (or none) is not found, nothing written", async () => {
    for (const postingOwner of ["someone-else", undefined]) {
      const h = harness({ postingOwner });
      await expect(
        h.service.set(campusSet({ scope: "job", postingId: POSTING }), CTX),
      ).rejects.toBeInstanceOf(WaiverPostingNotFoundError);
      expect(h.repo.withTransaction).not.toHaveBeenCalled();
    }
  });

  it("the company is stored as its TENANT key, read-only", async () => {
    const h = harness({ tenant: TENANT });
    await h.service.set(campusSet(), CTX);
    expect(h.tenancy.resolveReadOnly).toHaveBeenCalledWith(COMPANY);
    expect(h.repo.findActive).toHaveBeenCalledWith(h.tx, "company", TENANT, null);
  });
});

describe("RvmWaiversService.set — state, events and names", () => {
  it("sets a company waiver: the row, its event on the same transaction, the name encrypted", async () => {
    const h = harness();
    const out = await h.service.set(campusSet(), CTX);
    expect(out).toMatchObject({ active: true, changed: true });
    expect(out.waiver).toMatchObject({
      waiverId: "waiver-new",
      setByLabel: "Asha",
      source: "campus",
      waivedOpens: 2,
    });
    expect(h.repo.lockScope).toHaveBeenCalledWith(h.tx, "company", TENANT);
    expect(h.repo.insert).toHaveBeenCalledWith(h.tx, {
      scope: "company",
      tenant: TENANT,
      jobPostingId: null,
      source: "campus",
      setByRef: STAFF,
      setByLabelEnc: "enc:Asha",
      reason: "Drive partner",
    });
    const event = (h.events.emit.mock.calls[0] as unknown[])[0] as Record<string, unknown>;
    expect(event).toMatchObject({
      event_name: "payer.rvm_waiver_set",
      actor: { actor_type: "system", actor_id: null },
      subject: { subject_type: "payer", subject_id: TENANT },
      payload: {
        waiver_id: "waiver-new",
        payer_id: TENANT,
        scope: "company",
        job_posting_id: null,
        source: "campus",
      },
      idempotencyKey: "payer.rvm_waiver_set:waiver-new",
      tx: h.tx,
    });
    // A Campus change is audited by the Campus call itself, not here.
    expect(h.repo.audit).not.toHaveBeenCalled();
  });

  it("a job waiver locks and stores its posting", async () => {
    const h = harness();
    await h.service.set(campusSet({ scope: "job", postingId: POSTING }), CTX);
    expect(h.repo.lockScope).toHaveBeenCalledWith(h.tx, "job", POSTING);
    expect(h.repo.insert).toHaveBeenCalledWith(
      h.tx,
      expect.objectContaining({ scope: "job", jobPostingId: POSTING }),
    );
  });

  it("setting an active waiver again writes nothing and answers changed: false", async () => {
    const h = harness({ active: row() });
    const out = await h.service.set(campusSet({ reason: "A new reason" }), CTX);
    expect(out).toMatchObject({ active: true, changed: false, waiver: { waiverId: "waiver-1" } });
    expect(h.repo.insert).not.toHaveBeenCalled();
    expect(h.events.emit).not.toHaveBeenCalled();
  });

  it("clears an active waiver: who and why on the same row, its event", async () => {
    const h = harness({ active: row() });
    const out = await h.service.set(
      campusSet({ active: false, reason: "Drive over", actor: { kind: "campus", staffRef: STAFF, staffLabel: "Ravi" } }),
      CTX,
    );
    expect(out).toMatchObject({
      active: false,
      changed: true,
      waiver: { active: false, clearedByLabel: "Ravi", clearReason: "Drive over" },
    });
    expect(h.repo.clear).toHaveBeenCalledWith(
      h.tx,
      "waiver-1",
      expect.objectContaining({ clearedByRef: STAFF, clearedByLabelEnc: "enc:Ravi" }),
    );
    expect((h.events.emit.mock.calls[0] as unknown[])[0]).toMatchObject({
      event_name: "payer.rvm_waiver_cleared",
      idempotencyKey: "payer.rvm_waiver_cleared:waiver-1",
    });
  });

  it("clearing when none is active writes nothing and answers the newest one (or none)", async () => {
    const cleared = row({ active: false, clearedAt: new Date(), clearedByRef: STAFF });
    const h = harness({ latest: cleared });
    expect(await h.service.set(campusSet({ active: false }), CTX)).toMatchObject({
      active: false,
      changed: false,
      waiver: { waiverId: "waiver-1", active: false },
    });
    expect(h.repo.clear).not.toHaveBeenCalled();
    expect(h.events.emit).not.toHaveBeenCalled();
    const never = harness();
    expect(await never.service.set(campusSet({ active: false }), CTX)).toEqual({
      active: false,
      changed: false,
      waiver: null,
    });
  });

  it("an admin: the stored name ciphertext is copied, the audit row and the event name the admin", async () => {
    const h = harness({ adminNameEnc: "enc:Meera" });
    const out = await h.service.set(campusSet({ actor: { kind: "admin", adminId: ADMIN } }), CTX);
    expect(out.waiver).toMatchObject({ source: "admin", setByRef: ADMIN, setByLabel: "Meera" });
    expect(h.crypto.encrypt).not.toHaveBeenCalled();
    expect(h.repo.audit).toHaveBeenCalledWith(h.tx, {
      adminId: ADMIN,
      action: "rvm_waiver_changed",
      waiverId: "waiver-new",
      metadata: {
        change: "set",
        scope: "company",
        payer_id: TENANT,
        job_posting_id: null,
        reason_text: "Drive partner",
      },
    });
    expect((h.events.emit.mock.calls[0] as unknown[])[0]).toMatchObject({
      actor: { actor_type: "admin", actor_id: ADMIN },
      payload: { source: "admin" },
    });
  });

  it("a missing table is a 503, never a guessed success", async () => {
    const h = harness({ txError: Object.assign(new Error("no table"), { code: "42P01" }) });
    await expect(h.service.set(campusSet(), CTX)).rejects.toBeInstanceOf(
      ServiceUnavailableException,
    );
  });

  it("any other database error propagates as itself", async () => {
    const boom = new Error("deadlock");
    const h = harness({ txError: boom });
    await expect(h.service.set(campusSet(), CTX)).rejects.toBe(boom);
  });
});

describe("RvmWaiversService.list", () => {
  it("off everywhere: 404", async () => {
    const h = harness({ live: false });
    await expect(h.service.list({ limit: 10 })).rejects.toBeInstanceOf(NotFoundException);
  });

  it("an unknown company is an empty page, nothing read", async () => {
    const h = harness({ tenant: null });
    expect(await h.service.list({ companyId: COMPANY, limit: 10 })).toEqual({
      waivers: [],
      nextCursor: null,
    });
    expect(h.repo.list).not.toHaveBeenCalled();
  });

  it("pages newest first: one extra row read means a next cursor; names decrypted", async () => {
    const h = harness();
    const rows = [
      { ...row({ id: "a0000000-0000-4000-8000-000000000001" }), waivedOpens: 1 },
      { ...row({ id: "a0000000-0000-4000-8000-000000000002", setByLabelEnc: "garbled" }), waivedOpens: 0 },
    ];
    h.repo.list.mockResolvedValue(rows);
    const page = await h.service.list({ companyId: COMPANY, limit: 1 });
    expect(h.repo.list).toHaveBeenCalledWith({
      tenant: TENANT,
      includeCleared: false,
      after: null,
      limit: 2,
    });
    expect(page.waivers).toHaveLength(1);
    expect(page.waivers[0]).toMatchObject({ setByLabel: "Asha", waivedOpens: 1 });
    expect(page.nextCursor).not.toBeNull();

    h.repo.list.mockResolvedValue([rows[1]!]);
    const next = await h.service.list({ cursor: page.nextCursor!, limit: 1 });
    expect(h.repo.list).toHaveBeenLastCalledWith(
      expect.objectContaining({
        after: { createdAt: "2026-11-17T06:30:00.000Z", id: "a0000000-0000-4000-8000-000000000001" },
      }),
    );
    // A name that cannot be decrypted shows as none, never as an error.
    expect(next.waivers[0]!.setByLabel).toBeNull();
    expect(next.nextCursor).toBeNull();
  });
});
