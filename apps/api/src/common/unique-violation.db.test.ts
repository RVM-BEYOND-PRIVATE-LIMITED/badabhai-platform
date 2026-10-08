import "reflect-metadata";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ConflictException } from "@nestjs/common";
import { eq, inArray, sql } from "drizzle-orm";
import { adminUsers, createDbClient, payers, type DbClient } from "@badabhai/db";
import type { ServerConfig } from "@badabhai/config";

import { AdminRepository } from "../admin/admin.repository";
import { AgencyKycRepository } from "../agency/agency-kyc.repository";
import { AgencyKycService } from "../agency/agency-kyc.service";
import { defaultModeResolver } from "../payers/payer-tenant-scope.test-support";
import { isUniqueViolation, sqlStateOf } from "./db-error";
import { PiiCryptoService } from "./pii-crypto.service";

/**
 * Unique violations against a REAL Postgres, through the REAL drizzle driver (#1811).
 *
 * Every unit test of these paths once mocked a bare `{ code: "23505" }` — and every one passed
 * while production 500'd, because drizzle 0.45 wraps the driver error in a `DrizzleQueryError`
 * whose own `code` is undefined. A mock can only repeat what its author believes the driver
 * throws; this file asks the driver.
 *
 * It also pins the second half of the admin defect, which no mock could show: a unique violation
 * raised INSIDE a transaction aborts it, so the old catch-then-`refreshInvite` shape failed with
 * 25P02 even once the classifier matched. The CONTROL test proves that hazard is real; the admin
 * tests prove `ON CONFLICT DO NOTHING` sidesteps it.
 *
 * ── HOW TO RUN ──────────────────────────────────────────────────────────────────────────
 *   pnpm db:migrate
 *   RUN_DB_TESTS=1 pnpm --filter @badabhai/api run test unique-violation.db
 */

const RUN = process.env.RUN_DB_TESTS === "1";
const DATABASE_URL =
  process.env.E2E_DATABASE_URL ??
  process.env.DATABASE_URL ??
  "postgresql://badabhai:badabhai@localhost:5432/badabhai";

const pii = new PiiCryptoService({
  PII_HASH_PEPPER: "unique-violation-db-test-pepper",
  PII_ENCRYPTION_KEY: Buffer.alloc(32, 11).toString("base64"),
} as unknown as ServerConfig);

/** Values unique to this run, so a re-run against a dirty local database cannot collide. */
const TAG = randomUUID().slice(0, 8);
const inviteFields = () => ({
  inviteTokenHash: pii.hmac(`token-${randomUUID()}`),
  inviteExpiresAt: new Date(Date.now() + 48 * 60 * 60 * 1000),
});

describe.skipIf(!RUN)("unique violations against a real database (#1811)", () => {
  let client: DbClient;
  let admins: AdminRepository;
  const adminIds: string[] = [];
  const payerIds: string[] = [];

  async function seedPendingAdmin(email: string): Promise<string> {
    const row = await admins.createUnlessEmailTaken({ role: "analyst", email, ...inviteFields() });
    expect(row).toBeDefined();
    adminIds.push(row!.id);
    return row!.id;
  }

  async function seedAgency(label: string): Promise<string> {
    const [row] = await client.db
      .insert(payers)
      .values({
        role: "agent",
        emailEnc: pii.encrypt(`${label}-${TAG}@example.test`),
        emailHash: pii.hmac(`${label}-${TAG}@example.test`),
        orgNameEnc: pii.encrypt(`Agency ${label}`),
      })
      .returning({ id: payers.id });
    payerIds.push(row!.id);
    return row!.id;
  }

  beforeAll(() => {
    client = createDbClient(DATABASE_URL, { max: 1 });
    admins = new AdminRepository(client.db, pii);
  });

  afterAll(async () => {
    if (adminIds.length) await client.db.delete(adminUsers).where(inArray(adminUsers.id, adminIds));
    // agency_kyc rows go with their payer (ON DELETE CASCADE).
    if (payerIds.length) await client.db.delete(payers).where(inArray(payers.id, payerIds));
    await client.sql.end({ timeout: 5 });
  });

  it("a real duplicate insert is classified through drizzle's wrapper", async () => {
    const email = `wrap-${TAG}@example.test`;
    await seedPendingAdmin(email);

    const err = await client.db
      .insert(adminUsers)
      .values({
        role: "analyst",
        emailEnc: pii.encrypt(email),
        emailHash: admins.emailHash(email),
        ...inviteFields(),
      })
      .then(
        () => null,
        (e: unknown) => e,
      );

    expect(sqlStateOf(err)).toBe("23505");
    expect(isUniqueViolation(err)).toBe(true);
  });

  it("CONTROL: a caught 23505 still poisons its transaction — why the admin invite cannot catch one", async () => {
    const email = `control-${TAG}@example.test`;
    await seedPendingAdmin(email);

    let afterCatch: unknown;
    await client.db
      .transaction(async (tx) => {
        const dup = await tx
          .insert(adminUsers)
          .values({
            role: "analyst",
            emailEnc: pii.encrypt(email),
            emailHash: admins.emailHash(email),
            ...inviteFields(),
          })
          .then(
            () => null,
            (e: unknown) => e,
          );
        expect(isUniqueViolation(dup)).toBe(true);
        afterCatch = await tx.execute(sql`select 1`).then(
          () => null,
          (e: unknown) => e,
        );
      })
      .catch(() => undefined); // the COMMIT of an aborted transaction fails too

    expect(sqlStateOf(afterCatch)).toBe("25P02");
  });

  it("re-inviting a PENDING admin refreshes the token inside the same transaction", async () => {
    const email = `pending-${TAG}@example.test`;
    const id = await seedPendingAdmin(email);
    const fresh = inviteFields();

    const refreshed = await admins.withTransaction(async (tx) => {
      const created = await admins.createUnlessEmailTaken(
        { role: "ops_admin", email, ...fresh },
        tx,
      );
      expect(created).toBeUndefined();
      return admins.refreshInvite(admins.emailHash(email), { role: "ops_admin", ...fresh }, tx);
    });

    expect(refreshed).toEqual({ id });
    const [row] = await client.db
      .select({ role: adminUsers.role, inviteTokenHash: adminUsers.inviteTokenHash })
      .from(adminUsers)
      .where(eq(adminUsers.id, id));
    expect(row).toEqual({ role: "ops_admin", inviteTokenHash: fresh.inviteTokenHash });
  });

  it("an ACTIVE admin's email is taken: no insert, no refresh — the service's 409", async () => {
    const email = `active-${TAG}@example.test`;
    const id = await seedPendingAdmin(email);
    await admins.markActive(id);

    const outcome = await admins.withTransaction(async (tx) => {
      const fresh = inviteFields();
      const created = await admins.createUnlessEmailTaken(
        { role: "super_admin", email, ...fresh },
        tx,
      );
      const refreshed = await admins.refreshInvite(
        admins.emailHash(email),
        { role: "super_admin", ...fresh },
        tx,
      );
      return { created, refreshed };
    });

    expect(outcome).toEqual({ created: undefined, refreshed: undefined });
    const [row] = await client.db
      .select({ role: adminUsers.role, status: adminUsers.status })
      .from(adminUsers)
      .where(eq(adminUsers.id, id));
    expect(row).toEqual({ role: "analyst", status: "active" });
  });

  it("a PAN already backing one agency is a neutral 409 for a second, not a 500", async () => {
    const svc = new AgencyKycService(
      new AgencyKycRepository(client.db),
      pii,
      { emit: async () => undefined } as never,
      {} as never,
      defaultModeResolver(), // ADR-0053: the default mode keys each agency to itself
    );
    const dto = {
      pan: `PAN${TAG}`,
      bank_account: "123456789012",
      ifsc: "HDFC0001234",
      account_holder_name: "Test Holder",
    };

    await expect(svc.submit(await seedAgency("a"), dto)).resolves.toMatchObject({
      status: "pending",
    });
    await expect(svc.submit(await seedAgency("b"), dto)).rejects.toBeInstanceOf(ConflictException);
  });
});
