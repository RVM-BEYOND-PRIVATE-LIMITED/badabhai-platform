import { describe, it, expect } from "vitest";
import { workers } from "@badabhai/db";
import { AdminIdentityRepository } from "./admin-identity.repository";
import { captureQueries, expectColumnsAbsent } from "./testing/query-capture";

const W1 = "11111111-0000-4000-8000-000000000001";
const W2 = "22222222-0000-4000-8000-000000000002";

/**
 * The one repository under admin/** that touches a name column. Its projection is the entire
 * boundary, so it is asserted against the SQL the repository actually renders — not against
 * fixture rows, which would pass no matter what the query selected.
 */
describe("the identity projection is (id, one name column) and nothing else", () => {
  it("workers: full_name only — never the phone ciphertext, hash, or the photo key", async () => {
    const c = captureQueries();
    await new AdminIdentityRepository(c.db).workerNames([W1, W2]);
    expect(c.sql()).toContain("full_name");
    expectColumnsAbsent(c, ["phone_e164", "phone_hash", "photo_storage_key"]);
  });

  it("payers: org_name_enc only — never the email/phone ciphertext or their keyed hashes", async () => {
    const c = captureQueries();
    await new AdminIdentityRepository(c.db).payerOrgNames([W1]);
    expect(c.sql()).toContain("org_name_enc");
    expectColumnsAbsent(c, ["email_enc", "email_hash", "phone_enc", "phone_hash"]);
  });

  it("admin_users: name_enc only — never the email or the TOTP SEED", async () => {
    // `mfa_secret_enc` is the one column whose disclosure is a permanent second-factor bypass.
    const c = captureQueries();
    await new AdminIdentityRepository(c.db).adminNames([W1]);
    expect(c.sql()).toContain("name_enc");
    expectColumnsAbsent(c, ["email_enc", "email_hash", "mfa_secret_enc"]);
  });

  it("these assertions are CAPABLE of failing — the projection really is captured", async () => {
    // Guards the guard: an earlier local copy of this helper swallowed bare Drizzle columns in a
    // try/catch, which made every "must not be selected" assertion vacuously true.
    const c = captureQueries();
    c.db.select({ leak: workers.phoneHash } as never);
    expect(c.sql()).toContain("phone_hash");
    expect(() => expectColumnsAbsent(c, ["phone_hash"])).toThrow(/must never be selected/);
  });
});

describe("it is a LOOKUP by id, never a search", () => {
  it("the ids are BOUND parameters, not interpolated into SQL", async () => {
    const c = captureQueries();
    await new AdminIdentityRepository(c.db).workerNames([W1, W2]);
    expect(c.params).toContain(W1);
    expect(c.params).toContain(W2);
  });

  it("an EMPTY id set issues no query at all", async () => {
    // Drizzle renders `inArray(col, [])` as a false predicate, but the round trip is still a
    // round trip on every empty page — and, more to the point, a query with no ids is a query
    // with no purpose.
    for (const call of ["workerNames", "payerOrgNames", "adminNames"] as const) {
      const c = captureQueries();
      await expect(new AdminIdentityRepository(c.db)[call]([])).resolves.toEqual([]);
      expect(c.statements, call).toEqual([]);
    }
  });
});
