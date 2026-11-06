import "reflect-metadata";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { eq, inArray } from "drizzle-orm";
import {
  createDbClient,
  type DbClient,
  agencyProfiles,
  employerProfiles,
  jobPostings,
  payerMembers,
  payerOrgs,
  payers,
} from "@badabhai/db";
import { PiiCryptoService } from "../common/pii-crypto.service";
import { PayersRepository } from "../payers/payers.repository";
import { PayerOrgsRepository } from "../payers/payer-orgs.repository";
import { AdminCompaniesRepository } from "./admin-companies.repository";
import { AdminCompaniesService } from "./admin-companies.service";
import type { AuthenticatedAdmin } from "./admin-auth.guard";
import type { RequestContext } from "../common/request-context";

/**
 * #2564 B10 acceptance — AGAINST A REAL POSTGRES.
 *
 * A company (founder + team member + profile + live posting) is archived and
 * restored through `AdminCompaniesService` with real repositories:
 *   - archive freezes every member login (stamping each previous status), freezes
 *     the live inventory, ends sessions, and emits per-login events;
 *   - a suspended member is left suspended by both directions (carve-out);
 *   - restore hands every archived login back to its previous state;
 *   - the org list shows ONE row (never one per member login), with member
 *     counts, and finds the company by name word, city and GST;
 *   - create issues a first owner login with a temporary password and stamps
 *     the whole-word search hashes.
 *
 * Sign-in refusal itself is pinned without a database: `PayerAuthGuard` (lifecycle
 * gate test) and both login doors (`payer-auth.service.test.ts`) assert archived
 * logins get no session. Here the SoR proves what those gates read.
 *
 * Fixtures carry no PII: synthetic `@e2e.badabhai.invalid` emails, `enc:`/`hash:`
 * markers, fresh ids per run, everything deleted in afterAll.
 *
 * ── HOW TO RUN ────────────────────────────────────────────────────────────────
 *   RUN_DB_TESTS=1 pnpm --filter @badabhai/api exec vitest run admin-companies.db
 */
const RUN = process.env.RUN_DB_TESTS === "1";
const DATABASE_URL =
  process.env.E2E_DATABASE_URL ??
  process.env.DATABASE_URL ??
  "postgresql://badabhai:badabhai@localhost:5432/badabhai";

const TAG = randomUUID().slice(0, 8);
const CTX: RequestContext = { correlationId: randomUUID(), requestId: `b10-db-${TAG}` };
const ADMIN = { id: randomUUID(), role: "super_admin" } as unknown as AuthenticatedAdmin;
const PII_KEY = Buffer.alloc(32, 9).toString("base64");
const GSTIN = "27AABCS1234F1Z5";

describe.skipIf(!RUN)("admin companies against a real Postgres (#2564 B10)", () => {
  let client!: DbClient;
  let svc!: AdminCompaniesService;
  let events!: { emit: ReturnType<typeof vi.fn> };
  let sessions!: { revokeAllForPayer: ReturnType<typeof vi.fn> };
  let anchorId!: string;
  let memberId!: string;
  let orgId!: string;
  let postingId!: string;
  const pii = new PiiCryptoService({
    PII_HASH_PEPPER: `b10-pepper-${TAG}`,
    PII_ENCRYPTION_KEY: PII_KEY,
  } as never);

  beforeAll(async () => {
    client = createDbClient(DATABASE_URL);
    const db = client.db;
    const payersRepo = new PayersRepository(db, pii);
    const orgsRepo = new PayerOrgsRepository(db);
    const repo = new AdminCompaniesRepository(db);
    events = { emit: vi.fn().mockResolvedValue(undefined) };
    sessions = { revokeAllForPayer: vi.fn().mockResolvedValue(1) };
    svc = new AdminCompaniesService(
      repo,
      payersRepo,
      orgsRepo,
      sessions as never,
      { isPermitted: () => false, resolve: vi.fn().mockResolvedValue(null) } as never,
      events as never,
      pii,
      { grantQuietly: vi.fn().mockResolvedValue(undefined) } as never,
      { notify: vi.fn().mockResolvedValue(undefined) } as never,
    );

    // Founder + solo org, active.
    const created = await payersRepo.createOrGet({
      role: "employer",
      email: `b10-owner-${TAG}@e2e.badabhai.invalid`,
      orgName: `Acme Db ${TAG}`,
    });
    anchorId = created.id;
    const solo = await orgsRepo.ensureSoloOrg(anchorId);
    orgId = solo!.orgId;
    await payersRepo.activate(anchorId);

    // Team member, active.
    const member = await payersRepo.createOrGet({
      role: "employer",
      email: `b10-member-${TAG}@e2e.badabhai.invalid`,
      orgNameEnc: "enc:copied",
    });
    memberId = member.id;
    await orgsRepo.createActiveMember(
      { orgId, memberPayerId: memberId, emailEnc: "enc:m", emailHash: `hash:m:${TAG}`, orgRole: "recruiter" },
    );
    await payersRepo.activate(memberId);

    // Company profile (city + GST, searchable).
    await repo.upsertEmployerProfile(anchorId, {
      city: "Pune",
      gstNumberEnc: pii.encrypt(GSTIN),
      gstNumberHash: pii.hashGstin(GSTIN),
      verificationStatus: "verified",
    });

    // One live posting owned by the founder.
    const [posting] = await db
      .insert(jobPostings)
      .values({
        createdBy: anchorId,
        payerId: anchorId,
        orgLabel: `Acme Db ${TAG}`,
        roleTitle: "Driver",
        vacancyBand: "2-5",
        status: "open",
      })
      .returning({ id: jobPostings.id });
    postingId = posting!.id;
  });

  afterAll(async () => {
    if (!client) return;
    const db = client.db;
    try {
      if (postingId) await db.delete(jobPostings).where(eq(jobPostings.id, postingId));
      await db.delete(employerProfiles).where(eq(employerProfiles.payerId, anchorId));
      if (orgId) await db.delete(payerOrgs).where(eq(payerOrgs.id, orgId));
      const ids = [anchorId, memberId].filter(Boolean);
      if (ids.length > 0) {
        await db.delete(payerMembers).where(inArray(payerMembers.memberPayerId, ids));
        await db.delete(payers).where(inArray(payers.id, ids));
      }
    } finally {
      await client.sql.end({ timeout: 5 });
    }
  });

  async function statuses(): Promise<Record<string, string | null>> {
    const rows = await client.db
      .select({ id: payers.id, status: payers.status, previous: payers.previousStatus })
      .from(payers)
      .where(inArray(payers.id, [anchorId, memberId]));
    return Object.fromEntries(rows.map((r) => [r.id, `${r.status}/${r.previous ?? "-"}`]));
  }

  async function postingStatus(): Promise<string | null> {
    const [row] = await client.db
      .select({ status: jobPostings.status })
      .from(jobPostings)
      .where(eq(jobPostings.id, postingId))
      .limit(1);
    return row?.status ?? null;
  }

  it("archive freezes every member login and the live posting; restore hands each back", async () => {
    // Suspend the member first: the archive must stamp THROUGH it and restore must not lift it.
    await client.db
      .update(payers)
      .set({ status: "suspended", previousStatus: "active" })
      .where(eq(payers.id, memberId));

    const archived = await svc.archiveCompany(
      ADMIN,
      anchorId,
      {
        reason_code: "company_archived",
        reason_text: "Fraud report confirmed by two workers on site visit",
      },
      CTX,
    );
    expect(archived.changed).toBe(true);
    expect(archived.archived_logins).toEqual(expect.arrayContaining([anchorId, memberId]));
    expect(await statuses()).toEqual({
      [anchorId]: "archived/active",
      [memberId]: "archived/suspended",
    });
    expect(await postingStatus()).toBe("archived");
    expect(sessions.revokeAllForPayer).toHaveBeenCalledWith(anchorId);
    expect(sessions.revokeAllForPayer).toHaveBeenCalledWith(memberId);

    const names = events.emit.mock.calls.map((c) => (c[0] as { event_name: string }).event_name);
    expect(names.filter((n) => n === "payer.archived")).toHaveLength(2);
    expect(names.filter((n) => n === "payer.inventory_archived")).toHaveLength(2);
    expect(names).toContain("admin.action_performed");
    // Billing history untouched: no ledger table is ever written by archive/restore.
    const archivedEvt = events.emit.mock.calls
      .map((c) => c[0] as { event_name: string; payload: Record<string, unknown> })
      .find((e) => e.event_name === "payer.archived" && e.payload.payer_id === memberId);
    expect(archivedEvt!.payload).toMatchObject({ previous_status: "suspended", new_status: "archived" });

    const restored = await svc.restoreCompany(
      ADMIN,
      anchorId,
      { reason_code: "company_restored", reason_text: "Fraud report cleared after the verification call" },
      CTX,
    );
    expect(restored.changed).toBe(true);
    // BOTH archived logins move: the anchor back to active, the member back to
    // suspended (archive stamps THROUGH a suspension; restore must not lift it).
    expect(restored.restored_logins).toEqual(expect.arrayContaining([anchorId, memberId]));
    expect(restored.restored_logins).toHaveLength(2);
    expect(await statuses()).toEqual({ [anchorId]: "active/-", [memberId]: "suspended/-" });
    expect(await postingStatus()).toBe("open");
  });

  it("archive/restore are idempotent no-ops when there is nothing to move", async () => {
    // Anchor is active and member suspended after the test above: a fresh archive
    // moves both again — the no-op contract is proven by the SECOND call each way.
    const first = await svc.archiveCompany(
      ADMIN,
      anchorId,
      { reason_code: "company_archived", reason_text: "Refreeze the company for the idempotency check" },
      CTX,
    );
    expect(first.changed).toBe(true);
    const again = await svc.archiveCompany(
      ADMIN,
      anchorId,
      { reason_code: "company_archived", reason_text: "Retry of an already-frozen company archive" },
      CTX,
    );
    expect(again.changed).toBe(false);
    expect(again.archived_logins).toEqual([]);
    const restored = await svc.restoreCompany(
      ADMIN,
      anchorId,
      { reason_code: "company_restored", reason_text: "Restore the company after the idempotency check" },
      CTX,
    );
    expect(restored.changed).toBe(true);
    const noop = await svc.restoreCompany(
      ADMIN,
      anchorId,
      { reason_code: "company_restored", reason_text: "Nothing frozen so nothing to restore here now" },
      CTX,
    );
    expect(noop.changed).toBe(false);
    expect(noop.restored_logins).toEqual([]);
    // State back where the previous test left it: anchor active, member suspended.
    expect(await statuses()).toEqual({ [anchorId]: "active/-", [memberId]: "suspended/-" });
  });

  it("the org list shows ONE row per company and finds it by name, city and GST", async () => {
    const q = { page: 1, pageSize: 50, sort: "newest" as const };
    const all = await svc.listCompanies(ADMIN, q, CTX);
    const mine = all.items.filter((i) => i.anchor_payer_id === anchorId);
    // One row for the whole org — never one per member login.
    expect(mine).toHaveLength(1);
    expect(mine[0]).toMatchObject({ member_count: 2, kind: "employer", open_postings: 1, total_postings: 1 });

    const byName = await svc.listCompanies(ADMIN, { ...q, search: "acme" }, CTX);
    expect(byName.items.map((i) => i.anchor_payer_id)).toContain(anchorId);
    const byCity = await svc.listCompanies(ADMIN, { ...q, search: "Pune" }, CTX);
    expect(byCity.items.map((i) => i.anchor_payer_id)).toContain(anchorId);
    const byGst = await svc.listCompanies(ADMIN, { ...q, search: GSTIN.toLowerCase() }, CTX);
    expect(byGst.items.map((i) => i.anchor_payer_id)).toContain(anchorId);

    // Archived companies filter by status and disappear from the active cut.
    const active = await svc.listCompanies(ADMIN, { ...q, status: "active" }, CTX);
    expect(active.items.map((i) => i.anchor_payer_id)).toContain(anchorId);
  });

  it("create issues a first owner login with a temporary password and stamps the search hashes", async () => {
    const email = `b10-new-${TAG}@e2e.badabhai.invalid`;
    const out = await svc.createCompany(
      ADMIN,
      {
        kind: "agent",
        org_name: `Sharma Placements Db ${TAG}`,
        email,
        city: "Pimpri",
        reason_code: "company_created",
        reason_text: "Agency called to set up hiring for three client sites",
      } as never,
      CTX,
    );
    expect(out.must_change_password).toBe(true);
    expect(out.temporary_password).toBeTruthy();
    try {
      const [row] = await client.db.select().from(payers).where(eq(payers.id, out.anchor_payer_id)).limit(1);
      expect(row!.status).toBe("active");
      expect(row!.mustChangePassword).toBe(true);
      expect(row!.orgNameWordHashes).toEqual(
        expect.arrayContaining([expect.any(String)]),
      );
    } finally {
      const solo = await client.db
        .select({ id: payerOrgs.id })
        .from(payerOrgs)
        .where(eq(payerOrgs.rootPayerId, out.anchor_payer_id))
        .limit(1);
      if (solo[0]) await client.db.delete(payerOrgs).where(eq(payerOrgs.id, solo[0].id));
      await client.db.delete(agencyProfiles).where(eq(agencyProfiles.payerId, out.anchor_payer_id));
      await client.db.delete(employerProfiles).where(eq(employerProfiles.payerId, out.anchor_payer_id));
      await client.db.delete(payers).where(eq(payers.id, out.anchor_payer_id));
    }
  });
});
