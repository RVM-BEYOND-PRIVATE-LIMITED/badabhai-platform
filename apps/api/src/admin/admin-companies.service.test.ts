import { describe, expect, it, vi } from "vitest";
import { ConflictException, NotFoundException } from "@nestjs/common";
import type { ServerConfig } from "@badabhai/config";
import { PiiCryptoService } from "../common/pii-crypto.service";
import { AdminCompaniesService } from "./admin-companies.service";
import { AdminCompaniesRepository } from "./admin-companies.repository";
import { PayersRepository } from "../payers/payers.repository";
import { PayerOrgsRepository } from "../payers/payer-orgs.repository";
import type { AuthenticatedAdmin } from "./admin-auth.guard";
import type { AdminCreateCompanyDto, AdminUpdateCompanyDto } from "./admin-companies.dto";

const TEST_KEY = Buffer.alloc(32, 7).toString("base64");
const pii = new PiiCryptoService({
  PII_HASH_PEPPER: "test-pepper",
  PII_ENCRYPTION_KEY: TEST_KEY,
} as unknown as ServerConfig);

const ANCHOR = "66666666-6666-4666-8666-666666666666";
const MEMBER = "77777777-7777-4777-8777-777777777777";
const ADMIN = {
  id: "aaaaaaaa-0000-4000-8000-000000000001",
  role: "super_admin",
} as unknown as AuthenticatedAdmin;
const CTX = { correlationId: "c", requestId: "r" } as never;

function make(opts: {
  resolve?: { orgId: string | null; anchorPayerId: string; memberPayerIds: string[] };
  payer?: Record<string, unknown> | undefined;
  profile?: Record<string, unknown> | null;
  members?: Record<string, unknown>[];
  counts?: { total?: number };
  rows?: Record<string, unknown>[];
  identity?: Map<string, string | null> | null;
  permitted?: boolean;
} = {}) {
  const resolve =
    opts.resolve ?? { orgId: "org-1", anchorPayerId: ANCHOR, memberPayerIds: [ANCHOR, MEMBER] };
  const repo = {
    withTransaction: vi.fn().mockImplementation(async (work: (tx: unknown) => Promise<unknown>) => work({})),
    resolveCompany: vi.fn().mockResolvedValue(resolve),
    countCompanies: vi.fn().mockResolvedValue(opts.counts?.total ?? 0),
    listCompanies: vi.fn().mockResolvedValue(opts.rows ?? []),
    balancesByPayer: vi.fn().mockResolvedValue(new Map()),
    postingCountsByPayer: vi.fn().mockResolvedValue(new Map()),
    memberCountsByOrg: vi.fn().mockResolvedValue(new Map()),
    lastPaymentByPayer: vi.fn().mockResolvedValue(new Map()),
    findEmployerProfile: vi.fn().mockResolvedValue(opts.profile === undefined ? null : opts.profile),
    findAgencyProfile: vi.fn().mockResolvedValue(null),
    upsertEmployerProfile: vi.fn().mockResolvedValue({ payerId: ANCHOR }),
    upsertAgencyProfile: vi.fn().mockResolvedValue({ payerId: ANCHOR }),
    statusesByPayer: vi.fn().mockResolvedValue(new Map()),
    archiveLogins: vi.fn().mockResolvedValue([]),
    restoreLogins: vi.fn().mockResolvedValue([]),
    archivePostings: vi.fn().mockResolvedValue({ postings: 0 }),
    restorePostings: vi.fn().mockResolvedValue({ postings: 0 }),
    archiveJobs: vi.fn().mockResolvedValue({ jobs: 0, jobIds: [] }),
    restoreJobs: vi.fn().mockResolvedValue({ jobs: 0, jobIds: [] }),
    archiveTwins: vi.fn().mockResolvedValue({ postings: 0 }),
    restoreTwins: vi.fn().mockResolvedValue({ postings: 0 }),
    writeAuditReason: vi.fn().mockResolvedValue(undefined),
    writeConflictAudit: vi.fn().mockResolvedValue(undefined),
  };
  const payers = {
    findById: vi.fn().mockResolvedValue(opts.payer ?? null),
    findByEmail: vi.fn().mockResolvedValue(undefined),
    findByPhone: vi.fn().mockResolvedValue([]),
    createOrGet: vi.fn().mockResolvedValue({ id: ANCHOR, created: true }),
    activate: vi.fn().mockResolvedValue({ id: ANCHOR }),
    setTemporaryPassword: vi.fn().mockResolvedValue({ id: ANCHOR }),
    update: vi.fn().mockResolvedValue({ id: ANCHOR }),
    updateLoginEmail: vi.fn().mockResolvedValue({ id: ANCHOR }),
    decryptContact: vi.fn().mockImplementation((row: Record<string, unknown>) => ({
      id: row.id,
      role: row.role,
      status: row.status,
      email: null,
      orgName: "Acme",
      phone: null,
    })),
  };
  const orgs = {
    ensureSoloOrg: vi.fn().mockResolvedValue({ orgId: "org-1", orgRole: "owner" }),
    listMembers: vi.fn().mockResolvedValue(opts.members ?? []),
    findOrgById: vi.fn().mockResolvedValue({ id: "org-1", rootPayerId: ANCHOR }),
  };
  const identity = {
    isPermitted: vi.fn().mockReturnValue(opts.permitted ?? true),
    resolve: vi.fn().mockResolvedValue(opts.identity === undefined ? new Map() : opts.identity),
  };
  const events = { emit: vi.fn().mockResolvedValue(undefined) };
  const svc = new AdminCompaniesService(
    repo as unknown as AdminCompaniesRepository,
    payers as unknown as PayersRepository,
    orgs as unknown as PayerOrgsRepository,
    { revokeAllForPayer: vi.fn().mockResolvedValue(0) } as never,
    identity as never,
    events as never,
    pii,
    { grantQuietly: vi.fn().mockResolvedValue(undefined) } as never,
    { notify: vi.fn().mockResolvedValue(undefined) } as never,
  );
  return { svc, repo, payers, orgs, identity, events };
}

const CREATE: AdminCreateCompanyDto = {
  kind: "employer",
  org_name: "Acme Staffing",
  email: "hire@acme.example",
  industry: "Fabrication",
  reason_code: "company_created",
  reason_text: "Client called to set up hiring for their new plant",
};

describe("admin companies list (#2564 B10)", () => {
  it("keys every predicate by the resolved org and rolls team members into one row", async () => {
    const { svc, repo } = make({
      rows: [
        {
          orgId: "org-1",
          anchorPayerId: ANCHOR,
          kind: "employer",
          status: "active",
          verification: "pending",
          anchorCreatedAt: new Date(),
          orgCreatedAt: new Date(),
        },
      ],
      counts: { total: 1 },
    });
    const out = await svc.listCompanies(ADMIN, { page: 1, pageSize: 50, sort: "newest" }, CTX);
    expect(out.total).toBe(1);
    expect(out.items).toHaveLength(1);
    expect(out.items[0]).toMatchObject({ anchor_payer_id: ANCHOR, kind: "employer" });
    // The timeline aggregates read the ORG's member set, not the anchor alone.
    expect(repo.balancesByPayer).toHaveBeenCalledWith(expect.arrayContaining([ANCHOR, MEMBER]));
    expect(repo.postingCountsByPayer).toHaveBeenCalledWith(expect.arrayContaining([ANCHOR, MEMBER]));
  });

  it("hashes the search client-side (no plaintext reaches the query)", async () => {
    const { svc, repo } = make();
    await svc.listCompanies(
      ADMIN,
      { page: 1, pageSize: 50, sort: "newest", search: "Sharma Trading" },
      CTX,
    );
    const filter = (repo.listCompanies as ReturnType<typeof vi.fn>).mock.calls[0]![0];
    expect(filter.searchWords).toHaveLength(2);
    expect(filter.searchWords.every((h: unknown) => typeof h === "string")).toBe(true);
    // GST search hashes the normalized GSTIN; city passes through for ILIKE.
    expect(typeof filter.searchGstHash).toBe("string");
    expect(filter.searchCity).toBe("Sharma Trading");
  });
});

describe("admin companies detail (#2564 B10)", () => {
  function detailSetup() {
    return make({
      payer: {
        id: ANCHOR,
        role: "employer",
        status: "active",
        createdAt: new Date("2026-09-01T00:00:00.000Z"),
      },
      profile: {
        gstNumberEnc: pii.encrypt("27AABCS1234F1Z5"),
        city: "Pune",
        contactNameEnc: pii.encrypt("Ramesh Sharma"),
        website: "https://acme.example",
        industry: "Fabrication",
        verificationStatus: "verified",
      },
      identity: new Map([
        [ANCHOR, "Acme Staffing"],
        [`${ANCHOR}:gst`, "27AABCS1234F1Z5"],
        [`${ANCHOR}:address`, null],
        [`${ANCHOR}:contact`, "Ramesh Sharma"],
        [`${ANCHOR}:email`, "hire@acme.example"],
        [`${ANCHOR}:phone`, null],
      ]),
    });
  }

  it("serves the record with decrypted profile PII behind read_identity", async () => {
    const { svc } = detailSetup();
    const out = await svc.getCompany(ADMIN, ANCHOR, CTX);
    expect(out.anchor_payer_id).toBe(ANCHOR);
    expect(out.org_name).toBe("Acme Staffing");
    expect(out.profile).toMatchObject({ city: "Pune", contact_name: "Ramesh Sharma" });
    expect(out.email).toBe("hire@acme.example");
  });

  it("is faceless without read_identity — the identical record, no PII", async () => {
    const { svc } = make({
      payer: { id: ANCHOR, role: "employer", status: "active", createdAt: new Date() },
      profile: null,
      identity: null,
    });
    const out = await svc.getCompany(ADMIN, ANCHOR, CTX);
    expect(out.org_name).toBeUndefined();
    expect(out.email).toBeNull();
    expect(out.profile.contact_name).toBeNull();
  });

  it("404s on an unknown payer", async () => {
    const { svc } = make({ payer: undefined });
    await expect(svc.getCompany(ADMIN, "nope", CTX)).rejects.toBeInstanceOf(NotFoundException);
  });
});

describe("admin companies create (#2564 B10)", () => {
  it("creates payer + org + profile + temp password in one transaction, then grants + notifies", async () => {
    const { svc, repo, payers, events } = make();
    const out = await svc.createCompany(ADMIN, CREATE, CTX);
    expect(out).toMatchObject({ org_id: "org-1", anchor_payer_id: ANCHOR, must_change_password: true });
    expect(out.temporary_password).toBeTruthy();
    expect(repo.withTransaction).toHaveBeenCalledTimes(1);
    const names = events.emit.mock.calls.map((c) => (c[0] as { event_name: string }).event_name);
    expect(names).toEqual(
      expect.arrayContaining(["payer.activated", "payer.created", "admin.action_performed"]),
    );
    expect(payers.setTemporaryPassword).toHaveBeenCalled();
  });

  it("a taken email 409s with a SEPARATE value-free conflict audit (rolled-back tx leaves a trace)", async () => {
    const { svc, repo, events } = make();
    svc["payers"].findByEmail = vi.fn().mockResolvedValue({ id: "other" });
    await expect(svc.createCompany(ADMIN, CREATE, CTX)).rejects.toBeInstanceOf(ConflictException);
    expect(repo.writeConflictAudit).toHaveBeenCalledWith(
      ADMIN.id,
      "other",
      "company_create_conflict",
    );
    expect(events.emit).not.toHaveBeenCalled();
  });
});

describe("admin companies edit (#2564 B10)", () => {
  function editSetup() {
    return make({
      payer: { id: ANCHOR, role: "employer", status: "active" },
      profile: {
        gstNumberEnc: null,
        city: null,
        contactNameEnc: null,
        website: null,
        industry: null,
        companySize: null,
        hiringLocations: [],
        agencyType: null,
        serviceLocations: [],
        operatingCities: [],
        recruiterCount: null,
        sourceChannels: [],
        verificationStatus: "pending",
      },
    });
  }

  it("diffs the request and emits the CHANGED KEYS only (never values)", async () => {
    const { svc, events } = editSetup();
    const dto: AdminUpdateCompanyDto = {
      city: "Pune",
      verification: "verified",
      reason_code: "company_profile_updated",
      reason_text: "Verified the company GST certificate on the phone call today",
    };
    const out = await svc.updateCompany(ADMIN, ANCHOR, dto, CTX);
    expect(out.changed).toBe(true);
    expect(out.changed_fields).toEqual(["city", "verification_status"]);
    const names = events.emit.mock.calls.map((c) => (c[0] as { event_name: string }).event_name);
    expect(names).toContain("payer.profile_updated");
    expect(names).toContain("admin.action_performed");
    const profileEvt = events.emit.mock.calls.find(
      (c) => (c[0] as { event_name: string }).event_name === "payer.profile_updated",
    )![0] as { payload: Record<string, unknown> };
    expect(profileEvt.payload.changed_fields).toEqual(["city", "verification_status"]);
  });

  it("an empty diff is a 400 — no audit row for a change that did not happen", async () => {
    const { svc, events } = editSetup();
    await expect(
      svc.updateCompany(
        ADMIN,
        ANCHOR,
        {
          reason_code: "company_profile_updated",
          reason_text: "No changes but a written reason anyway here",
        },
        CTX,
      ),
    ).rejects.toThrow("No effective changes to apply");
    expect(events.emit).not.toHaveBeenCalled();
  });

  it("a taken email 409s without writing", async () => {
    const { svc, events } = editSetup();
    svc["payers"].findByEmail = vi.fn().mockResolvedValue({ id: "other" });
    await expect(
      svc.updateCompany(
        ADMIN,
        ANCHOR,
        {
          email: "taken@acme.example",
          reason_code: "company_profile_updated",
          reason_text: "Change the login email to the new contact person address",
        },
        CTX,
      ),
    ).rejects.toBeInstanceOf(ConflictException);
    expect(events.emit).not.toHaveBeenCalled();
  });
});

describe("admin companies archive / restore (#2564 B10)", () => {
  function archiveSetup(statuses: Record<string, string>) {
    const d = make({
      payer: { id: ANCHOR, role: "employer", status: "active" },
    });
    d.repo.statusesByPayer.mockResolvedValue(new Map(Object.entries(statuses)));
    return d;
  }

  it("archive freezes every pending|active|suspended login and its inventory, per login", async () => {
    const d = archiveSetup({ [ANCHOR]: "active", [MEMBER]: "suspended" });
    d.repo.archiveLogins.mockResolvedValue([
      { id: ANCHOR, previousStatus: "active" },
      { id: MEMBER, previousStatus: "suspended" },
    ]);
    const out = await d.svc.archiveCompany(
      ADMIN,
      ANCHOR,
      {
        reason_code: "company_archived",
        reason_text: "Fraud report confirmed by two workers on site visit",
      },
      CTX,
    );
    expect(out.changed).toBe(true);
    expect(out.archived_logins).toEqual(expect.arrayContaining([ANCHOR, MEMBER]));
    const names = d.events.emit.mock.calls.map((c) => (c[0] as { event_name: string }).event_name);
    expect(names.filter((n) => n === "payer.archived")).toHaveLength(2);
    expect(names.filter((n) => n === "payer.inventory_archived")).toHaveLength(2);
    expect(names.filter((n) => n === "admin.action_performed")).toHaveLength(2);
    // The archived-then-suspended chain hands back 'suspended' on restore.
    const archivedEvt = d.events.emit.mock.calls.find(
      (c) =>
        (c[0] as { event_name: string }).event_name === "payer.archived" &&
        ((c[0] as { payload: { payer_id: string } }).payload.payer_id === MEMBER),
    )![0] as { payload: Record<string, unknown> };
    expect(archivedEvt.payload).toMatchObject({
      previous_status: "suspended",
      new_status: "archived",
    });
  });

  it("archive is idempotent: a fully-archived company returns changed:false with no write and no event", async () => {
    const d = archiveSetup({ [ANCHOR]: "archived" });
    const out = await d.svc.archiveCompany(
      ADMIN,
      ANCHOR,
      { reason_code: "company_archived", reason_text: "Already frozen, retry of the same request" },
      CTX,
    );
    expect(out).toMatchObject({ changed: false, archived_logins: [] });
    expect(d.repo.archiveLogins).not.toHaveBeenCalled();
    expect(d.events.emit).not.toHaveBeenCalled();
  });

  it("restore hands every archived login back and never touches suspended ones", async () => {
    const d = archiveSetup({ [ANCHOR]: "archived", [MEMBER]: "suspended" });
    d.repo.restoreLogins.mockResolvedValue([{ id: ANCHOR, status: "pending" }]);
    const out = await d.svc.restoreCompany(
      ADMIN,
      ANCHOR,
      {
        reason_code: "company_restored",
        reason_text: "Fraud report cleared after the verification call today",
      },
      CTX,
    );
    expect(out.changed).toBe(true);
    expect(out.restored_logins).toEqual([ANCHOR]);
    const names = d.events.emit.mock.calls.map((c) => (c[0] as { event_name: string }).event_name);
    expect(names).toContain("payer.restored");
  });

  it("restore is idempotent: nothing archived returns changed:false with no write and no event", async () => {
    const d = archiveSetup({ [ANCHOR]: "active" });
    const out = await d.svc.restoreCompany(
      ADMIN,
      ANCHOR,
      { reason_code: "company_restored", reason_text: "Nothing frozen so nothing to restore here" },
      CTX,
    );
    expect(out).toMatchObject({ changed: false, restored_logins: [] });
    expect(d.repo.restoreLogins).not.toHaveBeenCalled();
    expect(d.events.emit).not.toHaveBeenCalled();
  });
});

describe("admin companies members (#2564 B10)", () => {
  it("lists the org's non-removed logins, faceless", async () => {
    const { svc } = make({
      payer: { id: ANCHOR, role: "employer", status: "active" },
      members: [
        {
          id: "m1",
          memberPayerId: ANCHOR,
          orgRole: "owner",
          status: "active",
          invitedAt: new Date(),
          acceptedAt: new Date(),
        },
      ],
    });
    const out = await svc.listMembers(ANCHOR);
    expect(out).toEqual([
      {
        member_id: "m1",
        member_payer_id: ANCHOR,
        org_role: "owner",
        status: "active",
        invited_at: expect.any(Date),
        accepted_at: expect.any(Date),
      },
    ]);
  });
});
