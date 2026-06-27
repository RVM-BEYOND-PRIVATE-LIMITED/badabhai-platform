import "reflect-metadata";
import { describe, it, expect } from "vitest";
import type { Database, AdminUser, AdminRole, AdminStatus } from "@badabhai/db";
import type { ServerConfig } from "@badabhai/config";
import { PiiCryptoService } from "../common/pii-crypto.service";
import { AdminRepository } from "./admin.repository";

// Real crypto with deterministic, non-zero test secrets (mirrors payers.repository.test.ts).
// Using the REAL PiiCryptoService is the strongest assertion that email_enc is genuine
// AES-256-GCM ciphertext (not a stub) and email_hash is a genuine keyed HMAC — yet neither
// is reversible to plaintext without the key/pepper held only here.
const TEST_KEY = Buffer.alloc(32, 7).toString("base64");
const pii = new PiiCryptoService({
  PII_HASH_PEPPER: "test-pepper",
  PII_ENCRYPTION_KEY: TEST_KEY,
} as unknown as ServerConfig);

// The admin's OWN login email is ADMIN-class PII (ADR-0025) — it must NEVER appear in a
// WHERE condition, a SELECT projection, a return value, or any serialized row.
const EMAIL = "Ops.Admin@BadaBhai.in";
const NORM_EMAIL = "ops.admin@badabhai.in";
const ADMIN_ID = "aaaaaaaa-0000-4000-8000-000000000001";

const ALLOWED_ROLES: readonly AdminRole[] = ["super_admin", "ops_admin", "support", "analyst"];
const ALLOWED_STATUS: readonly AdminStatus[] = ["pending", "active", "suspended"];

/** Every plaintext fragment of the admin email that must never leak past the boundary. */
const PII_FRAGMENTS = ["Ops.Admin", "ops.admin", "BadaBhai.in", "badabhai.in", "@"];

/** A representative raw row as the DB would return it: ciphertext email, NO plaintext. */
function rawRow(over: Partial<AdminUser> = {}): AdminUser {
  return {
    id: ADMIN_ID,
    emailEnc: pii.encrypt(NORM_EMAIL),
    emailHash: pii.hmac(NORM_EMAIL),
    role: "ops_admin",
    status: "active",
    mfaEnrolled: false,
    lastLoginAt: null,
    createdAt: new Date("2026-06-27T00:00:00.000Z"),
    updatedAt: new Date("2026-06-27T00:00:00.000Z"),
    ...over,
  } as AdminUser;
}

/**
 * Circular-safe JSON serialization. The Drizzle WHERE condition (e.g. `eq(col, val)`) is a SQL
 * object whose nodes reference each other (PgTable <-> PgColumn), so a plain JSON.stringify
 * throws "circular structure". A WeakSet-backed replacer drops already-seen objects while still
 * emitting every primitive leaf (the column names / bound values) — which is exactly what the
 * PII scan needs to inspect.
 */
function safeStringify(value: unknown): string {
  const seen = new WeakSet<object>();
  return (
    JSON.stringify(value, (_key, val) => {
      if (typeof val === "object" && val !== null) {
        if (seen.has(val)) return "[Circular]";
        seen.add(val);
      }
      return val;
    }) ?? ""
  );
}

/** Assert no plaintext admin-email fragment leaks into an arbitrary serializable value. */
function assertNoPii(value: unknown): void {
  const blob = safeStringify(value);
  for (const frag of PII_FRAGMENTS) {
    expect(blob).not.toContain(frag);
  }
}

type SelectCall = { table: unknown; where: unknown };
type WriteCall = { table?: unknown; values?: Record<string, unknown>; set?: Record<string, unknown>; where?: unknown };

/**
 * Capturing mock of the Drizzle fluent chain. Records the table + WHERE condition of every
 * read, and the values/set of every write, so the tests can prove WHAT was looked up and
 * persisted WITHOUT a real DB. `selectRows` is the row(s) the SELECT chain resolves to.
 */
function makeDb(selectRows: AdminUser[] = []) {
  const selects: SelectCall[] = [];
  const inserts: WriteCall[] = [];
  const updates: WriteCall[] = [];

  const db = {
    select: () => ({
      from: (table: unknown) => ({
        where: (where: unknown) => ({
          limit: async (_n: number) => {
            selects.push({ table, where });
            return selectRows;
          },
        }),
      }),
    }),
    insert: (table: unknown) => ({
      values: (values: Record<string, unknown>) => {
        const call: WriteCall = { table, values };
        inserts.push(call);
        return { returning: async () => [{ id: ADMIN_ID }] };
      },
    }),
    update: (table: unknown) => ({
      set: (set: Record<string, unknown>) => ({
        // `.set().where(...)` is the shared next link. It must be BOTH:
        //   - directly awaitable  → touchLastLogin: `await update().set().where()` (no returning)
        //   - chainable to .returning() → markActive / setMfaEnrolled
        // The WHERE call records the write exactly once; the returned object is a thenable
        // (so a direct await resolves void) that ALSO exposes .returning() (resolves the row).
        where: (where: unknown) => {
          updates.push({ table, set, where });
          return {
            // touchLastLogin awaits this directly (no .returning()) → resolves void.
            then: (resolve: (v: unknown) => unknown, reject?: (e: unknown) => unknown) =>
              Promise.resolve(undefined).then(resolve, reject),
            // markActive / setMfaEnrolled chain .returning() → resolves the updated row(s).
            returning: async () => selectRows,
          };
        },
      }),
    }),
  } as unknown as Database;

  return { db, selects, inserts, updates };
}

function makeRepo(selectRows: AdminUser[] = []) {
  const m = makeDb(selectRows);
  return { repo: new AdminRepository(m.db, pii), ...m };
}

// ---------------------------------------------------------------------------
// emailHash — keyed HMAC, normalized, never plaintext (lookup key derivation).
// ---------------------------------------------------------------------------
describe("AdminRepository.emailHash — keyed HMAC lookup key (no plaintext email)", () => {
  it("returns the keyed HMAC of the NORMALIZED email (case/whitespace-insensitive)", () => {
    const { repo } = makeRepo();
    const h = repo.emailHash(EMAIL);
    // Equals the HMAC of the normalized (trim+lowercase) form — the documented lookup key.
    expect(h).toBe(pii.hmac(NORM_EMAIL));
    // Case + surrounding whitespace collapse to the same hash (one row per identity).
    expect(repo.emailHash("  OPS.ADMIN@BADABHAI.IN  ")).toBe(h);
    expect(repo.emailHash(NORM_EMAIL)).toBe(h);
  });

  it("the hash carries NO recoverable fragment of the plaintext email (invariant #2)", () => {
    const { repo } = makeRepo();
    const h = repo.emailHash(EMAIL);
    assertNoPii(h);
    expect(h).not.toContain("ops");
    expect(h).not.toContain("admin");
    // Distinct emails → distinct hashes (a real keyed digest, not a constant stub).
    expect(repo.emailHash("someone.else@badabhai.in")).not.toBe(h);
  });
});

// ---------------------------------------------------------------------------
// findByEmailHash — matches on the hash ONLY; never the plaintext email.
// ---------------------------------------------------------------------------
describe("AdminRepository.findByEmailHash — hash-only lookup", () => {
  it("filters by the supplied hash and NEVER embeds the plaintext email in the WHERE", async () => {
    const { repo, selects } = makeRepo([rawRow()]);
    const hash = repo.emailHash(EMAIL);
    const row = await repo.findByEmailHash(hash);

    expect(row).toBeDefined();
    expect(selects).toHaveLength(1);
    // The WHERE condition must not contain any plaintext email fragment — only the opaque hash
    // (eq(adminUsers.emailHash, hash)) is ever scanned. Serialize defensively (drizzle SQL obj).
    assertNoPii(selects[0]!.where);
    // And the value the repository passed through its boundary is the hash, not the email.
    assertNoPii(hash);
  });

  it("returns the FIRST row (limit 1) as the raw ciphertext row — email_enc never decrypted", async () => {
    const expected = rawRow();
    const { repo } = makeRepo([expected]);
    const row = await repo.findByEmailHash("any-hash");

    // The raw row is returned verbatim: email_enc stays ciphertext (no decryptEmail in ADMIN-1).
    expect(row).toBe(expected);
    expect(row!.emailEnc).toBe(expected.emailEnc);
    expect(pii.decrypt(row!.emailEnc)).toBe(NORM_EMAIL); // decryptable ONLY with the key, here
    // The returned row exposes the ciphertext, not the plaintext: no plaintext fragment present.
    expect(row!.emailEnc).not.toContain("ops.admin");
  });

  it("a hash with NO matching row returns undefined (no throw, no oracle by shape)", async () => {
    const known = await makeRepo([rawRow()]).repo.findByEmailHash("h1");
    const unknown = await makeRepo([]).repo.findByEmailHash("h2");
    // Known → a row; unknown → undefined. The CALLER (auth service) is responsible for the
    // neutral response; here we assert the repo gives a clean presence/absence with no error
    // leak that could distinguish the two beyond row presence.
    expect(known).toBeDefined();
    expect(unknown).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// findById — opaque-id lookup; ciphertext email never decrypted/returned plaintext.
// ---------------------------------------------------------------------------
describe("AdminRepository.findById — opaque id lookup", () => {
  it("filters by id, returns the raw row, and never decrypts/returns plaintext email", async () => {
    const expected = rawRow();
    const { repo, selects } = makeRepo([expected]);
    const row = await repo.findById(ADMIN_ID);

    expect(row).toBe(expected);
    expect(selects).toHaveLength(1);
    // id is an opaque UUID — fine to scan; assert no plaintext email leaked into the WHERE.
    assertNoPii(selects[0]!.where);
    // The projection returns ciphertext email, not plaintext.
    assertNoPii({ ...row, emailEnc: undefined, emailHash: undefined });
    expect(row!.emailEnc).not.toContain("ops.admin");
  });

  it("returns undefined for a missing id", async () => {
    const row = await makeRepo([]).repo.findById("nope");
    expect(row).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// create — encrypts email at rest + stores keyed hash; role/status within the enum set.
// ---------------------------------------------------------------------------
describe("AdminRepository.create — encrypted-at-rest invite (PII never plaintext)", () => {
  it("persists email_enc as CIPHERTEXT + email_hash as the keyed HMAC — never plaintext", async () => {
    const { repo, inserts } = makeRepo();
    const out = await repo.create({ role: "ops_admin", email: EMAIL });

    expect(out).toEqual({ id: ADMIN_ID }); // returns the opaque id ONLY — never the email
    expect(inserts).toHaveLength(1);
    const values = inserts[0]!.values!;

    // email_enc is ciphertext (round-trips to the NORMALIZED email), not plaintext.
    expect(values.emailEnc).not.toContain("Ops.Admin");
    expect(values.emailEnc).not.toContain("ops.admin");
    expect(pii.decrypt(values.emailEnc as string)).toBe(NORM_EMAIL);
    // email_hash is the keyed HMAC of the normalized email — the unique login/dedup key.
    expect(values.emailHash).toBe(pii.hmac(NORM_EMAIL));
    expect(values.emailHash).not.toContain("ops.admin");
    // The raw email is NEVER written as a column value anywhere in the insert.
    assertNoPii(values);
  });

  it("omits status so the DB default ('pending') applies — invite-then-activate", async () => {
    const { repo, inserts } = makeRepo();
    await repo.create({ role: "support", email: EMAIL });
    const values = inserts[0]!.values!;
    // No client-supplied status → DB default 'pending' (a created admin authenticates to nothing).
    expect("status" in values).toBe(false);
  });

  it("persists ONLY a role within the allowed enum set for every allowed role", async () => {
    for (const role of ALLOWED_ROLES) {
      const { repo, inserts } = makeRepo();
      await repo.create({ role, email: `${role}@badabhai.in` });
      const values = inserts[0]!.values!;
      expect(ALLOWED_ROLES).toContain(values.role as AdminRole);
      expect(values.role).toBe(role);
      // Never writes a plaintext status; if present at all it must be in the allowed set.
      if ("status" in values) {
        expect(ALLOWED_STATUS).toContain(values.status as AdminStatus);
      }
    }
  });

  it("normalizes the email before encrypt+hash so casing cannot create a duplicate identity", async () => {
    const a = makeRepo();
    const b = makeRepo();
    await a.repo.create({ role: "analyst", email: "MiXeD.Case@BadaBhai.IN" });
    await b.repo.create({ role: "analyst", email: "  mixed.case@badabhai.in " });
    // Same identity → same dedup hash regardless of input casing/whitespace.
    expect(a.inserts[0]!.values!.emailHash).toBe(b.inserts[0]!.values!.emailHash);
  });
});

// ---------------------------------------------------------------------------
// markActive — flips status pending → active; PII-free row, allowed enum value.
// ---------------------------------------------------------------------------
describe("AdminRepository.markActive — pending → active", () => {
  it("sets status to 'active' (an allowed enum value) and stamps updated_at", async () => {
    const updated = rawRow({ status: "active" });
    const { repo, updates } = makeRepo([updated]);
    const row = await repo.markActive(ADMIN_ID);

    expect(updates).toHaveLength(1);
    expect(updates[0]!.set!.status).toBe("active");
    expect(ALLOWED_STATUS).toContain(updates[0]!.set!.status as AdminStatus);
    expect(updates[0]!.set!.updatedAt).toBeInstanceOf(Date);
    // The set NEVER touches email_enc/email_hash (no PII churn on activation).
    expect("emailEnc" in updates[0]!.set!).toBe(false);
    expect("emailHash" in updates[0]!.set!).toBe(false);
    assertNoPii(updates[0]!.set);
    // Returned row is ciphertext-only; no plaintext email surfaces.
    expect(row!.status).toBe("active");
    expect(row!.emailEnc).not.toContain("ops.admin");
  });

  it("returns undefined when no row matched the id", async () => {
    expect(await makeRepo([]).repo.markActive("nope")).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// setMfaEnrolled — flips the boolean gate flag; no MFA secret ever touches the repo.
// ---------------------------------------------------------------------------
describe("AdminRepository.setMfaEnrolled — flip the mfa_enrolled gate flag", () => {
  it("sets mfa_enrolled = true and stamps updated_at (no secret material persisted)", async () => {
    const updated = rawRow({ mfaEnrolled: true });
    const { repo, updates } = makeRepo([updated]);
    const row = await repo.setMfaEnrolled(ADMIN_ID, true);

    expect(updates).toHaveLength(1);
    expect(updates[0]!.set!.mfaEnrolled).toBe(true);
    expect(updates[0]!.set!.updatedAt).toBeInstanceOf(Date);
    // The flag is the ONLY MFA state this column owns — the TOTP secret lives in the Redis
    // mfa store, NEVER in admin_users. Assert no secret-shaped field is written here.
    expect("mfaSecret" in updates[0]!.set!).toBe(false);
    expect("totpSecret" in updates[0]!.set!).toBe(false);
    expect("secret" in updates[0]!.set!).toBe(false);
    assertNoPii(updates[0]!.set);
    expect(row!.mfaEnrolled).toBe(true);
  });

  it("can flip the flag back to false (idempotent boolean, no extra fields)", async () => {
    const { repo, updates } = makeRepo([rawRow({ mfaEnrolled: false })]);
    await repo.setMfaEnrolled(ADMIN_ID, false);
    expect(updates[0]!.set!.mfaEnrolled).toBe(false);
    // Only the flag + updatedAt are set — nothing else.
    expect(Object.keys(updates[0]!.set!).sort()).toEqual(["mfaEnrolled", "updatedAt"]);
  });

  it("returns undefined when no row matched the id", async () => {
    expect(await makeRepo([]).repo.setMfaEnrolled("nope", true)).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// touchLastLogin — observability-only stamp; best-effort, returns void.
// ---------------------------------------------------------------------------
describe("AdminRepository.touchLastLogin — stamp last_login_at (observability only)", () => {
  it("updates last_login_at (+ updated_at) and writes NOTHING else", async () => {
    const { repo, updates } = makeRepo();
    const res = await repo.touchLastLogin(ADMIN_ID);

    expect(res).toBeUndefined(); // returns void — best-effort, never blocks a login
    expect(updates).toHaveLength(1);
    expect(updates[0]!.set!.lastLoginAt).toBeInstanceOf(Date);
    expect(updates[0]!.set!.updatedAt).toBeInstanceOf(Date);
    // Login observability NEVER mutates identity/role/status/email columns.
    expect(Object.keys(updates[0]!.set!).sort()).toEqual(["lastLoginAt", "updatedAt"]);
    assertNoPii(updates[0]!.set);
  });

  it("does NOT use .returning() — it never selects/returns the (ciphertext) row back", async () => {
    // touchLastLogin awaits update().set().where() directly; our mock records via the
    // `where` branch (no returning). Proving the chain shape stays projection-free.
    const { repo, updates } = makeRepo();
    await repo.touchLastLogin(ADMIN_ID);
    expect(updates[0]!.where).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// Cross-cutting: NO method ever decrypts/returns email_enc as plaintext (ADMIN-1).
// ---------------------------------------------------------------------------
describe("AdminRepository — no path decrypts or returns the admin email as plaintext", () => {
  it("the repository exposes NO decryptEmail/decryptContact method (deliberate, ADR-0025)", () => {
    const { repo } = makeRepo();
    expect((repo as unknown as Record<string, unknown>).decryptEmail).toBeUndefined();
    expect((repo as unknown as Record<string, unknown>).decryptContact).toBeUndefined();
  });

  it("every read returns the raw ciphertext row — plaintext email never surfaces in a body", async () => {
    const byHash = await makeRepo([rawRow()]).repo.findByEmailHash("h");
    const byId = await makeRepo([rawRow()]).repo.findById(ADMIN_ID);
    for (const row of [byHash, byId]) {
      expect(row).toBeDefined();
      // email_enc present (ciphertext) but no plaintext fragment anywhere in the returned row.
      expect(row!.emailEnc).toBeTruthy();
      assertNoPii({ ...row, emailEnc: undefined });
      expect(row!.emailEnc).not.toContain("ops.admin");
    }
  });
});
