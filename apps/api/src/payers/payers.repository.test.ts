import "reflect-metadata";
import { describe, it, expect } from "vitest";
import type { Database, Payer } from "@badabhai/db";
import type { ServerConfig } from "@badabhai/config";
import { PiiCryptoService } from "../common/pii-crypto.service";
import { PayersRepository } from "./payers.repository";

// Real crypto with deterministic test secrets (32-byte AES key, non-zero).
const TEST_KEY = Buffer.alloc(32, 7).toString("base64");
const pii = new PiiCryptoService({
  PII_HASH_PEPPER: "test-pepper",
  PII_ENCRYPTION_KEY: TEST_KEY,
} as unknown as ServerConfig);

const EMAIL = "Hire@AcmeStaffing.example";
const ORG = "Acme Staffing";
const PHONE = "+919876500000";

/** Capturing mock of the insert(...).values(...).returning(...) chain. */
function makeDb(): { db: Database; captured: () => Record<string, unknown> } {
  let captured: Record<string, unknown> = {};
  const db = {
    insert: () => ({
      values: (v: Record<string, unknown>) => {
        captured = v;
        return { returning: async () => [{ id: "payer-1" }] };
      },
    }),
  } as unknown as Database;
  return { db, captured: () => captured };
}

describe("PayersRepository — payer PII at rest (ADR-0019 B-R2 / ADR-0004 discipline)", () => {
  it("encrypts every contact field and stores a keyed email hash — never plaintext", async () => {
    const { db, captured } = makeDb();
    const repo = new PayersRepository(db, pii);
    await repo.create({ role: "agent", email: EMAIL, orgName: ORG, phone: PHONE });
    const row = captured();

    // Ciphertext, not plaintext, for every contact field.
    expect(row.emailEnc).not.toContain("Hire");
    expect(row.orgNameEnc).not.toContain("Acme");
    expect(row.phoneEnc).not.toContain("9876500000");
    // ...but each decrypts back (round-trip), email normalized to lowercase.
    expect(pii.decrypt(row.emailEnc as string)).toBe(EMAIL.toLowerCase());
    expect(pii.decrypt(row.orgNameEnc as string)).toBe(ORG);
    expect(pii.decrypt(row.phoneEnc as string)).toBe(PHONE);

    // email_hash is the keyed HMAC of the normalized email (lookup key), not plaintext.
    expect(row.emailHash).toBe(pii.hmac(EMAIL.toLowerCase()));
    expect(row.emailHash).not.toContain("Hire");
    expect(row.phoneHash).toBe(pii.hashPhone(PHONE));

    // No plaintext PII anywhere in the persisted row.
    const blob = JSON.stringify(row);
    for (const secret of ["Hire@AcmeStaffing", "Acme Staffing", "9876500000"]) {
      expect(blob).not.toContain(secret);
    }
  });

  it("omits phone fields when no phone is supplied", async () => {
    const { db, captured } = makeDb();
    const repo = new PayersRepository(db, pii);
    await repo.create({ role: "employer", email: EMAIL, orgName: ORG });
    expect(captured().phoneEnc).toBeNull();
    expect(captured().phoneHash).toBeNull();
  });

  it("decryptContact round-trips a stored row back to the payer's own view", () => {
    const repo = new PayersRepository(makeDb().db, pii);
    const row: Payer = {
      id: "payer-1",
      role: "agent",
      emailEnc: pii.encrypt(EMAIL.toLowerCase()),
      emailHash: pii.hmac(EMAIL.toLowerCase()),
      orgNameEnc: pii.encrypt(ORG),
      orgNameLookupHash: pii.hashOrgName(ORG.toLowerCase()),
      phoneEnc: pii.encrypt(PHONE),
      phoneHash: pii.hashPhone(PHONE),
      passwordHash: null,
      passwordSetAt: null,
      passwordPepperVersion: null,
      status: "active",
      previousStatus: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    };
    expect(repo.decryptContact(row)).toEqual({
      id: "payer-1",
      role: "agent",
      status: "active",
      email: EMAIL.toLowerCase(),
      orgName: ORG,
      phone: PHONE,
    });
  });

  it("decryptContact reads null email for a phone-only row (never throws, never fabricates)", () => {
    const repo = new PayersRepository(makeDb().db, pii);
    const row = {
      id: "payer-1",
      role: "employer",
      emailEnc: null,
      emailHash: null,
      orgNameEnc: pii.encrypt(ORG),
      orgNameLookupHash: pii.hashOrgName(ORG.toLowerCase()),
      phoneEnc: pii.encrypt(PHONE),
      phoneHash: pii.hashPhone(PHONE),
      passwordHash: null,
      passwordSetAt: null,
      passwordPepperVersion: null,
      status: "pending",
      previousStatus: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    } as unknown as Payer;
    expect(repo.decryptContact(row).email).toBeNull();
  });
});

describe("PayersRepository — phone signup + org lookup + passwords (#2497)", () => {
  /** Mock db with a scripted select-one result and an update captor. */
  function makeRepo(selectRows: unknown[] = []) {
    let updated: Record<string, unknown> | null = null;
    const db = {
      select: () => ({
        from: () => ({
          where: () => ({ limit: async () => selectRows }),
        }),
      }),
      update: () => ({
        set: (v: Record<string, unknown>) => {
          updated = v;
          return {
            where: () => ({ returning: async () => [{ id: "payer-1" }] }),
          };
        },
      }),
    } as unknown as Database;
    return { db, updated: () => updated };
  }

  it("create stores the org lookup hash (normalized) alongside the encrypted contacts", async () => {
    const { db, captured } = makeDb();
    const repo = new PayersRepository(db, pii);
    await repo.create({ role: "employer", email: "  Boss@Acme.com ", orgName: ORG });
    expect(captured().orgNameLookupHash).toBe(pii.hashOrgName("acme staffing"));
  });

  it("create with phone-only stores no email keys (null, never empty string)", async () => {
    let seen: Record<string, unknown> = {};
    const db = {
      insert: () => ({
        values: (v: Record<string, unknown>) => {
          seen = v;
          return { returning: async () => [{ id: "payer-1" }] };
        },
      }),
    } as unknown as Database;
    const repo = new PayersRepository(db, pii);
    await repo.create({ role: "agent", orgName: ORG, phone: PHONE });
    expect(seen.emailEnc).toBeNull();
    expect(seen.emailHash).toBeNull();
    expect(seen.phoneHash).toBe(pii.hashPhone(PHONE));
    expect(seen.orgNameLookupHash).toBe(pii.hashOrgName("acme staffing"));
  });

  it("createOrGet with neither contact fails fast (programming error, not a contactless row)", async () => {
    const repo = new PayersRepository(makeDb().db, pii);
    await expect(repo.createOrGet({ role: "employer", orgName: ORG })).rejects.toThrow(
      "at least one of email/phone",
    );
  });

  it("setPassword stores hash + pepper version + timestamp in one row write", async () => {
    const { db, updated } = makeRepo();
    const repo = new PayersRepository(db, pii);
    await repo.setPassword("payer-1", { hash: "password-v1.s.h", pepperVersion: 1 });
    expect(updated()).toMatchObject({
      passwordHash: "password-v1.s.h",
      passwordPepperVersion: 1,
    });
    expect((updated()!.passwordSetAt as unknown) instanceof Date).toBe(true);
  });

  it("ensureOrgLookupHash fills a missing hash from the decrypted org name, and no-ops when present", async () => {
    const withHash = {
      id: "payer-1",
      orgNameEnc: pii.encrypt(ORG),
      orgNameLookupHash: "org<already>",
    };
    const withoutHash = { ...withHash, orgNameLookupHash: null };
    // Present → no write at all.
    let writes = 0;
    const dbNoop = {
      update: () => ({
        set: (_v: unknown) => {
          writes++;
          return { where: async () => [] };
        },
      }),
    } as unknown as Database;
    const repoNoop = new PayersRepository(dbNoop, pii);
    await repoNoop.ensureOrgLookupHash(withHash as never);
    expect(writes).toBe(0);

    // Missing → decrypts, hashes the NORMALIZED name, and writes it back.
    const { db, updated } = makeRepo();
    const repo = new PayersRepository(db, pii);
    await repo.ensureOrgLookupHash(withoutHash as never);
    expect(updated()).toMatchObject({ orgNameLookupHash: pii.hashOrgName("acme staffing") });
  });

  it("update refreshes the org lookup hash when the org name changes (never drifts)", async () => {
    const { db, updated } = makeRepo();
    const repo = new PayersRepository(db, pii);
    await repo.update("payer-1", { orgName: "New Name Ltd" });
    expect((updated() as Record<string, unknown>).orgNameLookupHash).toBe(
      pii.hashOrgName("new name ltd"),
    );
  });

  it("findByOrgName asks for at most 2 rows (0 / 1 / many is all any caller needs)", async () => {
    let limitSeen = -1;
    const db = {
      select: () => ({
        from: () => ({
          where: () => ({
            limit: async (n: number) => {
              limitSeen = n;
              return [];
            },
          }),
        }),
      }),
    } as unknown as Database;
    const repo = new PayersRepository(db, pii);
    await repo.findByOrgName("Acme Staffing");
    expect(limitSeen).toBe(2);
  });
});
