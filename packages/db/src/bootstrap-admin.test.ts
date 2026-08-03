import { describe, it, expect } from "vitest";
import { PgDialect } from "drizzle-orm/pg-core";
import type { SQL } from "drizzle-orm";
import type { Database } from "./client";
import { base32Encode, findAnySuperAdmin, normalizeEmail } from "./bootstrap-admin";

const dialect = new PgDialect();

/**
 * ADR-0038 — the first-super-admin bootstrap. These cover the three parts that can be
 * wrong in a way nobody notices until the platform has no way in:
 *   - the email normalizer, which produces the LOGIN KEY for the root account (get it
 *     wrong and the CLI creates an account nobody can authenticate as — with no second
 *     chance, because it then refuses to run again);
 *   - the base32 encoder, which produces a TOTP seed shown exactly once (a wrong alphabet
 *     yields a seed no authenticator accepts and that nothing can recover);
 *   - the one-time gate's predicate, which is the whole security property.
 */

describe("normalizeEmail — this becomes the root account's login key", () => {
  it("trims and lowercases, so a pasted address still matches the API's lookup", () => {
    // The API hashes the trimmed+lowercased form. A stray space or a capital here writes a
    // hash the login path can never reproduce.
    expect(normalizeEmail("  Ops@Example.COM  ")).toBe("ops@example.com");
  });

  it("REJECTS anything that is not plausibly an address, rather than storing it", () => {
    for (const bad of ["", "   ", "ops", "ops@", "@example.com", "ops@example", "a b@c.com"]) {
      expect(() => normalizeEmail(bad)).toThrow();
    }
  });

  it("never echoes a rejected address back unquoted (it lands in logs and shells)", () => {
    // JSON.stringify keeps the value visibly delimited, so an operator can SEE the stray
    // whitespace or quote that caused the rejection instead of guessing.
    expect(() => normalizeEmail("ops@")).toThrow(/"ops@"/);
  });
});

describe("base32Encode — the TOTP seed is shown once and never recoverable", () => {
  it("matches the RFC 4648 test vectors (no padding)", () => {
    // If this drifts, the CLI prints a seed no authenticator accepts and the admin is
    // locked out of a second factor the DB says they enrolled.
    expect(base32Encode(Buffer.from("f"))).toBe("MY");
    expect(base32Encode(Buffer.from("fo"))).toBe("MZXQ");
    expect(base32Encode(Buffer.from("foo"))).toBe("MZXW6");
    expect(base32Encode(Buffer.from("foob"))).toBe("MZXW6YQ");
    expect(base32Encode(Buffer.from("fooba"))).toBe("MZXW6YTB");
    expect(base32Encode(Buffer.from("foobar"))).toBe("MZXW6YTBOI");
  });

  it("emits ONLY RFC 4648 alphabet characters — never 0/1/8/9 or padding", () => {
    const out = base32Encode(Buffer.from(Array.from({ length: 64 }, (_, i) => i)));
    expect(out).toMatch(/^[A-Z2-7]+$/);
    expect(out).not.toContain("=");
  });
});

describe("the one-time gate — role only, status NEVER", () => {
  it("matches a super_admin in ANY status (a suspended root still blocks a second)", async () => {
    let captured: unknown;
    const db = {
      select: () => ({
        from: () => ({
          where: (w: unknown) => {
            captured = w;
            return { limit: async () => [] };
          },
        }),
      }),
    } as unknown as Database;

    await findAnySuperAdmin(db);

    const q = dialect.sqlToQuery(captured as SQL);
    expect(q.params).toContain("super_admin");
    // THE SECURITY PROPERTY. If this predicate ever gains a status filter, then
    // "suspend the super_admin, then bootstrap a new one" becomes privilege escalation
    // for anyone with shell access — the exact population the gate exists to bound.
    for (const status of ["active", "pending", "suspended"]) {
      expect(q.params).not.toContain(status);
    }
    expect(q.sql).not.toContain("status");
  });
});
