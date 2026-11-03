import "reflect-metadata";
import { describe, expect, it } from "vitest";
import { PgDialect } from "drizzle-orm/pg-core";
import { sql, type SQL } from "drizzle-orm";
import { adminUsers, type Database } from "@badabhai/db";
import type { ServerConfig } from "@badabhai/config";
import { PiiCryptoService } from "../common/pii-crypto.service";
import { AdminRepository } from "./admin.repository";

/**
 * Migration 0144 repository writes — asserted on the RENDERED WHERE (the guard IS the
 * security property: a reset racing a suspension, a session swapping a live seed) and on the
 * exact values written (hash, never a password; ciphertext, never a name or an email).
 */

const dialect = new PgDialect();
const render = (where: unknown) => dialect.sqlToQuery(sql`${where as SQL}`);

const pii = new PiiCryptoService({
  PII_HASH_PEPPER: "test-pepper",
  PII_ENCRYPTION_KEY: Buffer.alloc(32, 7).toString("base64"),
} as unknown as ServerConfig);

const ADMIN_ID = "aaaaaaaa-0000-4000-8000-000000000001";

type Write = {
  values?: Record<string, unknown>;
  set?: Record<string, unknown>;
  where?: unknown;
  onConflict?: { target?: unknown };
};

function makeDb(returned: unknown[] = [{ id: ADMIN_ID }]) {
  const inserts: Write[] = [];
  const updates: Write[] = [];
  const db = {
    insert: () => ({
      values: (values: Record<string, unknown>) => {
        const call: Write = { values };
        inserts.push(call);
        return {
          onConflictDoNothing: (cfg: { target?: unknown }) => {
            call.onConflict = cfg;
            return { returning: async () => returned };
          },
        };
      },
    }),
    update: () => ({
      set: (set: Record<string, unknown>) => ({
        where: (where: unknown) => {
          updates.push({ set, where });
          return { returning: async () => returned };
        },
      }),
    }),
  } as unknown as Database;
  return { repo: new AdminRepository(db, pii), inserts, updates };
}

const WRITE = {
  hash: "password-v1.salt.derived",
  pepperVersion: 1,
  setAt: new Date("2026-11-03T10:00:00.000Z"),
};

describe("createActiveWithTemporaryPassword — ACTIVE, must-change, no second factor", () => {
  it("writes ciphertext email + name, the HASH, must_change=true and two-step off", async () => {
    const { repo, inserts } = makeDb();
    const out = await repo.createActiveWithTemporaryPassword({
      role: "support",
      email: "  New.Admin@BadaBhai.in ",
      name: "Asha R",
      password: WRITE,
    });
    expect(out).toEqual({ id: ADMIN_ID });
    const v = inserts[0]!.values!;
    expect(v).toMatchObject({
      role: "support",
      status: "active",
      passwordHash: WRITE.hash,
      passwordPepperVersion: 1,
      passwordSetAt: WRITE.setAt,
      mustChangePassword: true,
      mfaEnrolled: false,
      mfaEnabled: false,
    });
    expect(pii.decrypt(v.emailEnc as string)).toBe("new.admin@badabhai.in");
    expect(v.emailHash).toBe(pii.hmac("new.admin@badabhai.in"));
    expect(pii.decrypt(v.nameEnc as string)).toBe("Asha R");
    // No plaintext PII anywhere in the row written.
    const blob = JSON.stringify(v);
    for (const s of ["Asha R", "new.admin", "BadaBhai.in", "badabhai.in"])
      expect(blob).not.toContain(s);
  });

  it("a taken email → undefined via ON CONFLICT (email_hash) DO NOTHING (never a 23505)", async () => {
    const { repo, inserts } = makeDb([]);
    const out = await repo.createActiveWithTemporaryPassword({
      role: "analyst",
      email: "x@badabhai.in",
      name: "X",
      password: WRITE,
    });
    expect(out).toBeUndefined();
    expect(inserts[0]!.onConflict).toEqual({ target: adminUsers.emailHash });
  });
});

describe("setPassword — guarded on status='active', clears must_change", () => {
  it("writes hash + pepper + set_at (the caller's clock) and must_change=false", async () => {
    const { repo, updates } = makeDb([{ id: ADMIN_ID }]);
    await repo.setPassword(ADMIN_ID, WRITE);
    expect(updates[0]!.set).toEqual({
      passwordHash: WRITE.hash,
      passwordPepperVersion: 1,
      passwordSetAt: WRITE.setAt,
      mustChangePassword: false,
      updatedAt: WRITE.setAt,
    });
  });

  it("the WHERE pins the id AND status = 'active' (a suspended/pending admin gets no password)", async () => {
    const { repo, updates } = makeDb();
    await repo.setPassword(ADMIN_ID, WRITE);
    const q = render(updates[0]!.where);
    expect(q.sql).toContain('"admin_users"."id" = $1');
    expect(q.sql).toContain('"admin_users"."status" = $2');
    expect(q.params).toEqual([ADMIN_ID, "active"]);
  });

  it("returns undefined when the guard matched nothing", async () => {
    expect(await makeDb([]).repo.setPassword(ADMIN_ID, WRITE)).toBeUndefined();
  });
});

describe("two-step switch writes — guarded so a live seed is never swapped", () => {
  it("stageMfaEnrolment: writes the CIPHERTEXT + enrolled=false, only WHERE mfa_enabled = false", async () => {
    const { repo, updates } = makeDb();
    expect(await repo.stageMfaEnrolment(ADMIN_ID, "v1.ciphertext")).toBe(true);
    expect(updates[0]!.set).toMatchObject({ mfaSecretEnc: "v1.ciphertext", mfaEnrolled: false });
    const q = render(updates[0]!.where);
    expect(q.sql).toContain('"admin_users"."mfa_enabled" = $2');
    expect(q.params).toEqual([ADMIN_ID, false]);
    expect(await makeDb([]).repo.stageMfaEnrolment(ADMIN_ID, "v1.c")).toBe(false);
  });

  it("enableMfa: enrolled + enabled together, only when OFF and a seed is staged", async () => {
    const { repo, updates } = makeDb();
    expect(await repo.enableMfa(ADMIN_ID)).toBe(true);
    expect(updates[0]!.set).toMatchObject({ mfaEnrolled: true, mfaEnabled: true });
    const q = render(updates[0]!.where);
    expect(q.sql).toContain('"admin_users"."mfa_enabled" = $2');
    expect(q.sql).toContain('"admin_users"."mfa_secret_enc" is not null');
    expect(await makeDb([]).repo.enableMfa(ADMIN_ID)).toBe(false);
  });

  it("disableMfa: enabled, enrolled AND the seed cleared together, only when ON", async () => {
    const { repo, updates } = makeDb();
    expect(await repo.disableMfa(ADMIN_ID)).toBe(true);
    expect(updates[0]!.set).toMatchObject({
      mfaEnabled: false,
      mfaEnrolled: false,
      mfaSecretEnc: null,
    });
    const q = render(updates[0]!.where);
    expect(q.sql).toContain('"admin_users"."mfa_enabled" = $2');
    expect(q.params).toEqual([ADMIN_ID, true]);
    expect(await makeDb([]).repo.disableMfa(ADMIN_ID)).toBe(false);
  });
});
