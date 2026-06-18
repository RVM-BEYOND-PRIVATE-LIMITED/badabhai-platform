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
      phoneEnc: pii.encrypt(PHONE),
      phoneHash: pii.hashPhone(PHONE),
      orgNameEnc: pii.encrypt(ORG),
      status: "active",
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
});
