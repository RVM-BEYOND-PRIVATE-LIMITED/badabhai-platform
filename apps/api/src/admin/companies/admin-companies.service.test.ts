import { randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import type { RequestContext } from "../../common/request-context";
import { ADMIN_ACTION_CODES } from "../admin-action-codes";
import { AdminCompaniesService } from "./admin-companies.service";
import type { CompanyRow } from "./admin-companies.repository";

/**
 * #2564 — the company-record contract with the database and the other services faked. What is
 * pinned here is what a DB gate cannot see:
 *
 *   - create REUSES `AdminPayerLoginsService.createLogin` and writes its company record, audit
 *     and `admin.action_performed` INSIDE that call's transaction;
 *   - archive reaches EVERY active team login (not just the founder), freezes each login's
 *     inventory, and records `previous_status` on the transition;
 *   - restore brings each login back to its previous status and un-freezes inventory only for a
 *     login that comes back usable;
 *   - the edit event carries changed field KEYS, and contact values are encrypted, never stored;
 *   - name search is UNAVAILABLE (503) with no keyring, and never a silently empty page.
 */

const TX = { tx: true } as never;
const CTX: RequestContext = { correlationId: randomUUID(), requestId: `companies-${randomUUID()}` };
const ADMIN = randomUUID();
const COMPANY = randomUUID();
const MEMBER = randomUUID();
const ORG = randomUUID();

const REASON = {
  reason_code: "details_corrected" as const,
  reason_text: "Company asked us to fix its GSTIN and billing contact",
};

function company(over: Partial<CompanyRow> = {}): CompanyRow {
  return {
    id: COMPANY,
    orgId: ORG,
    role: "employer",
    status: "active",
    previousStatus: null,
    verificationStatus: "pending",
    cities: ["Pune"],
    lastLoginAt: null,
    createdAt: new Date("2026-10-01T00:00:00.000Z"),
    ...over,
  };
}

function harness(over: { company?: CompanyRow; keyring?: boolean } = {}) {
  const repo = {
    withTransaction: vi.fn(async (work: (tx: never) => Promise<unknown>) => work(TX)),
    listCompanies: vi.fn(async () => ({
      rows: [over.company ?? company()],
      total: 1,
    })),
    findCompany: vi.fn(async () => over.company ?? company()),
    listMembers: vi.fn(async () => [
      {
        memberId: randomUUID(),
        orgId: ORG,
        payerId: MEMBER,
        orgRole: "recruiter" as const,
        memberStatus: "active" as const,
        payerStatus: "active" as const,
        lastLoginAt: null,
        invitedAt: new Date("2026-10-02T00:00:00.000Z"),
        acceptedAt: new Date("2026-10-02T00:00:00.000Z"),
      },
    ]),
    findProfile: vi.fn(async () => undefined),
    upsertProfile: vi.fn(async () => undefined),
    lockRoot: vi.fn(async () => ({ status: (over.company ?? company()).status })),
    lockLogins: vi.fn(async (ids: readonly string[]) => [...ids].sort()),
    restampDriveRequests: vi.fn(async () => undefined),
    teamLoginIds: vi.fn(async () => [MEMBER]),
    archiveLogin: vi.fn(async (id: string) => ({
      id,
      leftStatus: id === MEMBER ? ("suspended" as const) : ("active" as const),
    })),
    restoreLogin: vi.fn(async (id: string) => ({
      id,
      status: id === MEMBER ? ("suspended" as const) : ("active" as const),
    })),
    writeAudit: vi.fn(async () => undefined),
  };
  const actions = {
    suspendPayerInventory: vi.fn(async () => ({ postings: 2, jobs: 1 })),
    reinstatePayerInventory: vi.fn(async () => ({ postings: 2, jobs: 1 })),
  };
  const payerLogins = {
    createLogin: vi.fn(
      async (
        _a: unknown,
        dto: { org_name?: string },
        _c: unknown,
        hooks?: {
          withinTransaction?: (tx: never, id: string) => Promise<void>;
        },
      ) => {
        await hooks?.withinTransaction?.(TX, COMPANY);
        return {
          payer_id: COMPANY,
          login_id: dto.org_name ?? "x",
          temporary_password: "one-time",
          must_change_password: true,
        };
      },
    ),
  };
  const payers = { update: vi.fn(async () => undefined) };
  const orgs = { syncNameFromRoot: vi.fn(async () => undefined) };
  const identity = {
    resolve: vi.fn(async () => new Map([[COMPANY, "Acme Works"]])),
    discloseCompanyProfile: vi.fn(async () => ({
      gst_number: null,
      address: null,
      phone: null,
      email: null,
      contact_person: null,
    })),
  };
  const nameTokens = {
    keyring: vi.fn(() => (over.keyring === false ? null : { keys: new Map(), activeKid: "k1" })),
    queryTokens: vi.fn(() => ({
      available: true,
      perKey: [{ kid: "k1", hashes: ["h1", "h2"] }],
    })),
  };
  const sessions = { revokeAllForPayer: vi.fn(async () => undefined) };
  const pii = {
    encrypt: vi.fn((v: string) => `enc:${v}`),
    hashGstin: vi.fn((v: string) => `gst:${v}`),
  };
  const events = { emit: vi.fn(async () => ({})) };

  const service = new AdminCompaniesService(
    repo as never,
    actions as never,
    payerLogins as never,
    payers as never,
    orgs as never,
    identity as never,
    nameTokens as never,
    sessions as never,
    pii as never,
    events as never,
  );
  return {
    repo,
    actions,
    payerLogins,
    payers,
    orgs,
    identity,
    nameTokens,
    sessions,
    pii,
    events,
    service,
  };
}

const emitted = (events: { emit: ReturnType<typeof vi.fn> }) =>
  events.emit.mock.calls.map(([arg]) => arg as Record<string, unknown>);

describe("#2564 company records — create", () => {
  it("REUSES createLogin and writes the profile, reason, action inside its transaction", async () => {
    const h = harness();
    const result = await h.service.createCompany(
      { id: ADMIN, role: "ops_admin", sid: "s" } as never,
      {
        kind: "employer",
        org_name: "Acme Works",
        email: "owner@acme.test",
        reason_code: "client_request",
        reason_text: "Company signed up over the phone with the sales team",
        profile: { gst_number: "27AAPFU0939F1ZV", industry: "Machining" },
      },
      CTX,
    );

    expect(result.company_id).toBe(COMPANY);
    expect(h.payerLogins.createLogin).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        role: "employer",
        org_name: "Acme Works",
        email: "owner@acme.test",
        reason_code: "login_created",
      }),
      CTX,
      expect.objectContaining({ withinTransaction: expect.any(Function) }),
    );
    expect(h.repo.upsertProfile).toHaveBeenCalledWith(
      "employer",
      COMPANY,
      expect.objectContaining({
        industry: "Machining",
        gstNumberEnc: "enc:27AAPFU0939F1ZV",
        gstNumberHash: "gst:27AAPFU0939F1ZV",
      }),
      TX,
    );
    expect(h.repo.writeAudit).toHaveBeenCalledWith(
      TX,
      expect.objectContaining({ action: ADMIN_ACTION_CODES.company_created, companyId: COMPANY }),
    );
    expect(emitted(h.events)[0]).toMatchObject({
      event_name: "admin.action_performed",
      actor: { actor_type: "admin", actor_id: ADMIN },
      payload: { action_code: ADMIN_ACTION_CODES.company_created, target_type: "payer" },
    });
  });

  it("refuses a field belonging to the other kind (an agency field on a company)", async () => {
    const h = harness();
    await expect(
      h.service.createCompany(
        { id: ADMIN, role: "ops_admin", sid: "s" } as never,
        {
          kind: "employer",
          org_name: "Acme Works",
          email: "owner@acme.test",
          reason_code: "client_request",
          reason_text: "Company signed up over the phone with the sales team",
          profile: { agency_type: "contractor" },
        },
        CTX,
      ),
    ).rejects.toThrow("agency_type cannot be set on a company");
    expect(h.payerLogins.createLogin).not.toHaveBeenCalled();
  });

  it("a throw inside the create hook rolls the whole creation back (no login returned)", async () => {
    const h = harness();
    h.repo.upsertProfile.mockRejectedValueOnce(new Error("profile write failed"));
    await expect(
      h.service.createCompany(
        { id: ADMIN, role: "ops_admin", sid: "s" } as never,
        {
          kind: "employer",
          org_name: "Acme Works",
          phone: "+919876543210",
          reason_code: "client_request",
          reason_text: "Company signed up over the phone with the sales team",
          profile: { industry: "Machining" },
        },
        CTX,
      ),
    ).rejects.toThrow("profile write failed");
  });
});

describe("#2564 company records — edit", () => {
  it("a rename goes through the one payer writer AND syncs the org copy", async () => {
    const h = harness();
    await h.service.updateCompany(
      { id: ADMIN, role: "ops_admin", sid: "s" } as never,
      COMPANY,
      { ...REASON, changes: { org_name: "Acme Precision Works" } },
      CTX,
    );
    expect(h.payers.update).toHaveBeenCalledWith(COMPANY, { orgName: "Acme Precision Works" }, TX);
    expect(h.orgs.syncNameFromRoot).toHaveBeenCalledWith(COMPANY, TX);
    const companyEvent = emitted(h.events).find((e) => e.event_name === "payer.company_updated");
    expect(companyEvent?.payload).toEqual({ payer_id: COMPANY, changed_fields: ["org_name"] });
  });

  it("contact fields are ENCRYPTED before the write and never appear in the event", async () => {
    const h = harness();
    await h.service.updateCompany(
      { id: ADMIN, role: "ops_admin", sid: "s" } as never,
      COMPANY,
      {
        ...REASON,
        changes: {
          gst_number: "27aapfu0939f1zv",
          phone: "+919876543210",
          email: "billing@acme.test",
          contact_person: "Ramesh Kumar",
        },
      },
      CTX,
    );
    expect(h.repo.upsertProfile).toHaveBeenCalledWith(
      "employer",
      COMPANY,
      expect.objectContaining({
        gstNumberEnc: "enc:27aapfu0939f1zv",
        gstNumberHash: "gst:27aapfu0939f1zv",
        companyPhoneEnc: "enc:+919876543210",
        companyEmailEnc: "enc:billing@acme.test",
        contactPersonEnc: "enc:Ramesh Kumar",
      }),
      TX,
    );
    const event = emitted(h.events).find((e) => e.event_name === "payer.company_updated");
    const payload = JSON.stringify(event?.payload);
    for (const value of ["billing@acme.test", "Ramesh Kumar", "+919876543210", "27aapfu"]) {
      expect(payload).not.toContain(value);
    }
    expect(event?.payload).toEqual({
      payer_id: COMPANY,
      changed_fields: ["gst_number", "phone", "email", "contact_person"],
    });
  });

  it("an ARCHIVED company is read-only until restored", async () => {
    const h = harness({ company: company({ status: "archived", previousStatus: "active" }) });
    await expect(
      h.service.updateCompany(
        { id: ADMIN, role: "ops_admin", sid: "s" } as never,
        COMPANY,
        { ...REASON, changes: { org_name: "X" } },
        CTX,
      ),
    ).rejects.toThrow("Company is archived; restore it before editing");
    expect(h.repo.withTransaction).not.toHaveBeenCalled();
  });
});

describe("#2564 company records — archive / restore", () => {
  it("archive reaches the founder AND every active team login, freezing each inventory", async () => {
    const h = harness();
    const result = await h.service.archiveCompany(
      { id: ADMIN, role: "ops_admin", sid: "s" } as never,
      COMPANY,
      { reason_code: "inactive", reason_text: "Company confirmed it has stopped hiring" },
      CTX,
    );

    expect(result.changed).toBe(true);
    expect(h.repo.archiveLogin).toHaveBeenCalledTimes(2);
    expect(h.actions.suspendPayerInventory).toHaveBeenCalledTimes(2);
    expect(h.actions.suspendPayerInventory).toHaveBeenCalledWith(MEMBER, TX);
    const names = emitted(h.events).map((e) => e.event_name);
    expect(names).toEqual(
      expect.arrayContaining([
        "payer.archived",
        "payer.inventory_suspended",
        "admin.action_performed",
      ]),
    );
    const memberArchive = emitted(h.events).find(
      (e) =>
        e.event_name === "payer.archived" &&
        (e.payload as { payer_id: string }).payer_id === MEMBER,
    );
    expect(memberArchive?.payload).toEqual({
      payer_id: MEMBER,
      previous_status: "suspended",
      new_status: "archived",
    });
    // Sessions are ended AFTER the commit, for every login that actually moved.
    expect(h.sessions.revokeAllForPayer).toHaveBeenCalledTimes(2);
  });

  it("archiving an already-archived company is a no-op: no write, no event, no sweep", async () => {
    const h = harness({ company: company({ status: "archived", previousStatus: "active" }) });
    const result = await h.service.archiveCompany(
      { id: ADMIN, role: "ops_admin", sid: "s" } as never,
      COMPANY,
      { reason_code: "inactive", reason_text: "Company confirmed it has stopped hiring" },
      CTX,
    );
    expect(result.changed).toBe(false);
    expect(h.repo.withTransaction).not.toHaveBeenCalled();
    expect(h.events.emit).not.toHaveBeenCalled();
    expect(h.sessions.revokeAllForPayer).not.toHaveBeenCalled();
  });

  it("restore returns each login to its previous status; only a usable one gets its inventory back", async () => {
    const h = harness({ company: company({ status: "archived", previousStatus: "active" }) });
    const result = await h.service.restoreCompany(
      { id: ADMIN, role: "ops_admin", sid: "s" } as never,
      COMPANY,
      {
        reason_code: "archived_in_error",
        reason_text: "The archive was applied to the wrong company",
      },
      CTX,
    );

    expect(result.changed).toBe(true);
    // Founder comes back active → inventory reinstated; the member comes back suspended → not.
    expect(h.actions.reinstatePayerInventory).toHaveBeenCalledTimes(1);
    expect(h.actions.reinstatePayerInventory).toHaveBeenCalledWith(COMPANY, TX);
    const restored = emitted(h.events).filter((e) => e.event_name === "payer.restored");
    expect(restored.map((e) => (e.payload as { new_status: string }).new_status)).toEqual([
      "active",
      "suspended",
    ]);
  });

  it("restoring a live company is a no-op", async () => {
    const h = harness();
    const result = await h.service.restoreCompany(
      { id: ADMIN, role: "ops_admin", sid: "s" } as never,
      COMPANY,
      {
        reason_code: "archived_in_error",
        reason_text: "The archive was applied to the wrong company",
      },
      CTX,
    );
    expect(result.changed).toBe(false);
    expect(h.repo.withTransaction).not.toHaveBeenCalled();
  });
});

describe("#2746 PR 6 — archive / restore lock every login first and re-stamp the drive requests last", () => {
  const reason = {
    reason_code: "inactive" as const,
    reason_text: "Company confirmed it has stopped hiring",
  };
  const admin = { id: ADMIN, role: "ops_admin", sid: "s" } as never;
  type Harness = ReturnType<typeof harness>;
  const order = (fn: { mock: { invocationCallOrder: number[] } }) => fn.mock.invocationCallOrder;
  const lastOther = (h: Harness) =>
    Math.max(
      ...[
        h.repo.archiveLogin,
        h.repo.restoreLogin,
        h.repo.writeAudit,
        h.actions.suspendPayerInventory,
        h.actions.reinstatePayerInventory,
        h.events.emit,
      ].flatMap(order),
    );

  it("archive: locks every login in id order right after the root, before any write (migration re-check F1)", async () => {
    const h = harness();
    await h.service.archiveCompany(admin, COMPANY, reason, CTX);
    expect(h.repo.lockLogins).toHaveBeenCalledWith([COMPANY, MEMBER], TX);
    const locked = order(h.repo.lockLogins)[0]!;
    expect(locked).toBeGreaterThan(order(h.repo.lockRoot)[0]!);
    expect(locked).toBeLessThan(Math.min(...order(h.repo.archiveLogin)));
  });

  it("archive: re-stamps each archived login's drive requests AFTER the inventory freeze, the events and the audit row", async () => {
    const h = harness();
    await h.service.archiveCompany(admin, COMPANY, reason, CTX);
    expect(h.repo.restampDriveRequests.mock.calls).toEqual([
      [TX, COMPANY],
      [TX, MEMBER],
    ]);
    expect(Math.min(...order(h.repo.restampDriveRequests))).toBeGreaterThan(
      Math.max(...order(h.actions.suspendPayerInventory)),
    );
    expect(Math.min(...order(h.repo.restampDriveRequests))).toBeGreaterThan(lastOther(h));
  });

  it("restore: the same order", async () => {
    const h = harness({ company: company({ status: "archived" }) });
    await h.service.restoreCompany(admin, COMPANY, reason, CTX);
    expect(h.repo.lockLogins).toHaveBeenCalledWith([COMPANY, MEMBER], TX);
    expect(order(h.repo.lockLogins)[0]!).toBeLessThan(Math.min(...order(h.repo.restoreLogin)));
    expect(h.repo.restampDriveRequests.mock.calls).toEqual([
      [TX, COMPANY],
      [TX, MEMBER],
    ]);
    expect(Math.min(...order(h.repo.restampDriveRequests))).toBeGreaterThan(lastOther(h));
  });

  it("an edit of the verification re-stamps last; an edit of anything else does not", async () => {
    const h = harness();
    await h.service.updateCompany(
      admin,
      COMPANY,
      { changes: { verification_status: "verified" }, ...reason } as never,
      CTX,
    );
    expect(h.repo.restampDriveRequests).toHaveBeenCalledWith(TX, COMPANY);
    expect(order(h.repo.restampDriveRequests)[0]!).toBeGreaterThan(lastOther(h));
    const other = harness();
    await other.service.updateCompany(
      admin,
      COMPANY,
      { changes: { website: "https://acme.example" }, ...reason } as never,
      CTX,
    );
    expect(other.repo.restampDriveRequests).not.toHaveBeenCalled();
  });
});

describe("#2564 company records — list and search", () => {
  const listDto = {
    sort: "newest" as const,
    page: 1,
    page_size: 25,
  };

  it("lists one row per organisation with its team nested and the disclosed name", async () => {
    const h = harness();
    const page = await h.service.listCompanies(
      { id: ADMIN, role: "ops_admin", sid: "s" } as never,
      listDto,
      CTX,
    );
    expect(page.items).toHaveLength(1);
    expect(page.items[0]).toMatchObject({
      id: COMPANY,
      org_id: ORG,
      org_name: "Acme Works",
      member_count: 1,
      members: [{ payer_id: MEMBER, org_role: "recruiter" }],
    });
    expect(page.name_search_available).toBe(true);
    expect(page.total_pages).toBe(1);
  });

  it("name search is REFUSED with 503 when the token keys are unset — never a silent empty list", async () => {
    const h = harness({ keyring: false });
    h.nameTokens.queryTokens.mockReturnValue({ available: false } as never);
    await expect(
      h.service.listCompanies(
        { id: ADMIN, role: "ops_admin", sid: "s" } as never,
        { ...listDto, name: "acme" },
        CTX,
      ),
    ).rejects.toThrow("Company name search is unavailable");
    expect(h.repo.listCompanies).not.toHaveBeenCalled();
  });

  it("a name with no usable word is a 400, not an unfiltered page", async () => {
    const h = harness();
    h.nameTokens.queryTokens.mockReturnValue({
      available: true,
      perKey: [{ kid: "k1", hashes: [] }],
    } as never);
    await expect(
      h.service.listCompanies(
        { id: ADMIN, role: "ops_admin", sid: "s" } as never,
        { ...listDto, name: "a" },
        CTX,
      ),
    ).rejects.toThrow("at least two letters");
    expect(h.repo.listCompanies).not.toHaveBeenCalled();
  });

  it("a GST filter is hashed before it reaches SQL (the GSTIN itself never does)", async () => {
    const h = harness();
    await h.service.listCompanies(
      { id: ADMIN, role: "ops_admin", sid: "s" } as never,
      { ...listDto, gst: "27AAPFU0939F1ZV" },
      CTX,
    );
    expect(h.pii.hashGstin).toHaveBeenCalledWith("27AAPFU0939F1ZV");
    expect(h.repo.listCompanies).toHaveBeenCalledWith(
      expect.objectContaining({ gstHash: "gst:27AAPFU0939F1ZV" }),
      "newest",
      0,
      25,
    );
  });

  it("an undisclosed name is ABSENT, not null (the three-state contract)", async () => {
    const h = harness();
    h.identity.resolve.mockResolvedValueOnce(null as never);
    const page = await h.service.listCompanies(
      { id: ADMIN, role: "support", sid: "s" } as never,
      listDto,
      CTX,
    );
    expect(page.items[0]).not.toHaveProperty("org_name");
  });
});
