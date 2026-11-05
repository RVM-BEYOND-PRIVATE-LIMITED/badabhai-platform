import "reflect-metadata";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  createDbClient,
  payers,
  payerMembers,
  payerOrgs,
  type Database,
  type DbClient,
} from "@badabhai/db";
import type { ServerConfig } from "@badabhai/config";
import { and, eq, inArray } from "drizzle-orm";
import { PayerOrgMembersService } from "../payer-portal/payer-org-members.service";
import { PiiCryptoService } from "../common/pii-crypto.service";
import type { RequestContext } from "../common/request-context";
import { PayerAuthService } from "../payer-portal/payer-auth.service";
import { PayersRepository } from "../payers/payers.repository";
import { PayerOrgsRepository } from "../payers/payer-orgs.repository";
import { PayerTenantScopeService } from "../payers/payer-tenant-scope.service";
import { AdminPayerLoginsService } from "./admin-payer-logins.service";

/**
 * #2563 review BLOCKER — the status an admin-created login actually holds.
 *
 * The first implementation left `payers.status` at the schema DEFAULT `'pending'`. Both sign-in
 * doors refuse a pending account, so every admin-created login was unusable — and the unit tests
 * missed it because their fixtures said `status: "active"`. This test runs against a REAL
 * Postgres with the REAL default: `createOrGet` inserts without a status, the admin service must
 * activate it, and the real password door must then mint a session.
 *
 * HOW TO RUN
 *   pnpm db:migrate
 *   RUN_DB_TESTS=1 pnpm --filter @badabhai/api run test payer-login-management.db
 */
const RUN = process.env.RUN_DB_TESTS === "1";
const DATABASE_URL =
  process.env.E2E_DATABASE_URL ??
  process.env.DATABASE_URL ??
  "postgresql://badabhai:badabhai@localhost:5432/badabhai";

const ADMIN = { id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaa63", sid: "s", role: "ops_admin" } as const;
const CTX: RequestContext = {
  correlationId: "11111111-1111-4111-8111-111111111119",
  requestId: "req-2563-db",
};
const OWNER_EMAIL = "login-2563-owner@example.test";
const PENDING_EMAIL = "login-2563-pending@example.test";
const FOUNDER_EMAIL = "login-2563-founder@example.test";
const MEMBER_EMAIL = "login-2563-member@example.test";
const TEMP_NEW_PASSWORD = "ChangedPass7";
const FOUNDER_PASSWORD = "FounderPass7";
const MEMBER_PASSWORD = "MemberPass7";
const FOUNDER_ORG = "Founder Co 2563";

const config = {
  PAYER_LOGIN_METHOD: "email_otp",
  OTP_RESEND_COOLDOWN_SECONDS: 30,
  PAYER_PASSWORD_MAX_ATTEMPTS: 5,
  PAYER_PASSWORD_LOCKOUT_SECONDS: 900,
  PAYER_TEMP_PASSWORD_TTL_HOURS: 168,
  PAYER_ORG_TENANCY_MODE: "off",
  PII_HASH_PEPPER: "test-pepper",
  PII_ENCRYPTION_KEY: Buffer.alloc(32, 7).toString("base64"),
  SESSION_TTL_DAYS: 30,
} as unknown as ServerConfig;

const pii = new PiiCryptoService(config);

function fakeSessions() {
  return {
    create: async () => ({ token: "test-jwt", expiresInSeconds: 2592000 }),
    revokeAllForPayer: async () => 0,
    revokeAllForPayerExcept: async () => 0,
  };
}

function fakeRedis() {
  return {
    get: async () => null as string | null,
    incr: async () => 1,
    expire: async () => 1,
    del: async () => 1,
  };
}

function noopEvents() {
  return { emit: async () => undefined };
}

function fakeOtp() {
  return {
    issueAndSend: async () => ({ resendInSeconds: 30 }),
    issueWithoutDelivery: async () => ({ resendInSeconds: 30 }),
    verify: async () => undefined,
  };
}

describe.skipIf(!RUN)("payer login management — REAL default status (#2563)", () => {
  let client: DbClient;
  let db: Database;
  let payersRepo: PayersRepository;
  let orgsRepo: PayerOrgsRepository;
  let admin: AdminPayerLoginsService;
  let auth: PayerAuthService;
  let members: PayerOrgMembersService;

  beforeAll(async () => {
    client = createDbClient(DATABASE_URL, { max: 4 });
    db = client.db;
    payersRepo = new PayersRepository(db, pii);
    orgsRepo = new PayerOrgsRepository(db);
    const tenancy = new PayerTenantScopeService(config, orgsRepo);
    const sessions = fakeSessions();
    const events = noopEvents();
    const redis = fakeRedis();
    const lockStates = {
      lockStates: async (ids: string[]) => new Map(ids.map((id) => [id, false])),
      clear: async () => undefined,
    };
    const notice = { notify: async () => undefined };
    const repo = {
      withTransaction: (work: (tx: Database) => Promise<unknown>) =>
        db.transaction(work as (tx: unknown) => Promise<unknown>),
      writeAuditReason: async () => undefined,
      writeConflictAudit: async () => undefined,
    };

    admin = new AdminPayerLoginsService(
      config,
      repo as never,
      payersRepo,
      orgsRepo,
      sessions as never,
      lockStates as never,
      { resolve: async () => null } as never,
      events as never,
      pii,
      { grantQuietly: async () => undefined } as never,
      notice as never,
    );
    auth = new PayerAuthService(
      config,
      payersRepo,
      orgsRepo,
      fakeOtp() as never,
      sessions as never,
      events as never,
      pii,
      { grantQuietly: async () => undefined } as never,
      tenancy,
      { client: Promise.resolve(redis) } as never,
      notice as never,
    );
    members = new PayerOrgMembersService(
      orgsRepo,
      pii,
      events as never,
      payersRepo,
      config,
      { send: async () => undefined } as never,
    );
  });

  afterAll(async () => {
    if (!client) return;
    const ids = await db
      .select({ id: payers.id })
      .from(payers)
      .where(
        inArray(payers.emailHash, [
          pii.hmac(OWNER_EMAIL),
          pii.hmac(PENDING_EMAIL),
          pii.hmac(FOUNDER_EMAIL),
          pii.hmac(MEMBER_EMAIL),
        ]),
      );
    const idList = ids.map((r) => r.id);
    if (idList.length > 0) {
      await db.delete(payerMembers).where(inArray(payerMembers.memberPayerId, idList));
      await db.delete(payerOrgs).where(inArray(payerOrgs.rootPayerId, idList));
      await db.delete(payers).where(inArray(payers.id, idList));
    }
    await client.sql.end();
  });

  it("admin create → password login with the temp password + new_password → a session", async () => {
    const created = await admin.createLogin(
      ADMIN as never,
      {
        role: "employer",
        email: OWNER_EMAIL,
        org_name: "Acme 2563",
        reason_code: "login_created",
        reason_text: "Created for the client onboarding call",
      } as never,
      CTX,
    );

    // The schema default is `pending`; without the activation this fails.
    const row = await payersRepo.findById(created.payer_id);
    expect(row?.status).toBe("active");

    const login = await auth.loginWithPassword(
      OWNER_EMAIL,
      created.temporary_password,
      CTX,
      TEMP_NEW_PASSWORD,
    );
    expect(login).toMatchObject({ payer_id: created.payer_id, role: "employer" });
  });

  it("admin issue on a PENDING self-signup activates it and the temp password then works", async () => {
    const signup = await payersRepo.createOrGet({
      role: "employer",
      email: PENDING_EMAIL,
      orgName: "Self Signup 2563",
    });
    expect(signup.created).toBe(true);
    expect((await payersRepo.findById(signup.id))?.status).toBe("pending");

    const issued = await admin.issueTemporaryPassword(
      ADMIN as never,
      signup.id,
      {
        reason_code: "password_issued",
        reason_text: "Admin vouched for this self-signup",
      } as never,
      CTX,
    );
    expect((await payersRepo.findById(signup.id))?.status).toBe("active");

    const login = await auth.loginWithPassword(
      PENDING_EMAIL,
      issued.temporary_password,
      CTX,
      TEMP_NEW_PASSWORD,
    );
    expect(login).toMatchObject({ payer_id: signup.id, role: "employer" });
  });

  it("founder company-name login still works after a removed member logs in again", async () => {
    const founder = await payersRepo.createOrGet({
      role: "employer",
      email: FOUNDER_EMAIL,
      orgName: FOUNDER_ORG,
    });
    const founderOrg = await orgsRepo.ensureSoloOrg(founder.id);
    expect(founderOrg).not.toBeNull();
    const founderRow = await payersRepo.findById(founder.id);
    await payersRepo.setPassword(founder.id, {
      hash: pii.hashPassword(FOUNDER_PASSWORD),
      pepperVersion: 1,
    });
    await payersRepo.activate(founder.id);

    // An admin-created team member carries the founder's COPIED org name.
    const member = await payersRepo.createOrGet({
      role: "employer",
      email: MEMBER_EMAIL,
      orgNameEnc: founderRow!.orgNameEnc,
    });
    const memberRow = await payersRepo.findById(member.id);
    await orgsRepo.createActiveMember({
      orgId: founderOrg!.orgId,
      memberPayerId: member.id,
      emailEnc: memberRow!.emailEnc,
      emailHash: memberRow!.emailHash,
      orgRole: "recruiter",
    });
    await payersRepo.setPassword(member.id, {
      hash: pii.hashPassword(MEMBER_PASSWORD),
      pepperVersion: 1,
    });
    await payersRepo.activate(member.id);

    // The member's first login must NOT write the founder's company-name hash.
    await auth.loginWithPassword(MEMBER_EMAIL, MEMBER_PASSWORD, CTX);
    expect((await payersRepo.findById(member.id))?.orgNameLookupHash).toBeNull();

    const [active] = await db
      .select({ id: payerMembers.id })
      .from(payerMembers)
      .where(
        and(
          eq(payerMembers.orgId, founderOrg!.orgId),
          eq(payerMembers.memberPayerId, member.id),
        ),
      )
      .limit(1);
    await members.remove(
      { orgId: founderOrg!.orgId, orgRole: "owner" },
      founder.id,
      active!.id,
      CTX,
    );

    // Removal clears the founder's copied name; the next login heals a solo org under a
    // neutral name, and the founder's company-name sign-in still resolves to exactly one row.
    const removedRow = await payersRepo.findById(member.id);
    expect(pii.decrypt(removedRow!.orgNameEnc)).toBe("My Organisation");
    expect(removedRow!.orgNameLookupHash).toBeNull();
    await expect(auth.loginWithPassword(MEMBER_EMAIL, MEMBER_PASSWORD, CTX)).resolves.toMatchObject({
      payer_id: member.id,
    });
    await expect(auth.loginWithPassword(FOUNDER_ORG, FOUNDER_PASSWORD, CTX)).resolves.toMatchObject({
      payer_id: founder.id,
    });
  });
});
