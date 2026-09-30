import { drizzle } from "drizzle-orm/postgres-js";
import { PgDialect } from "drizzle-orm/pg-core";
import type { Database } from "@badabhai/db";
import { describe, expect, it } from "vitest";

import { codeTakenStatement, insertResumeQrLinkStatement } from "./referral-link.repository";

/**
 * #1800 — the two statements behind the résumé-QR mint, read off the COMPILED SQL (no database;
 * the `resume-import.repository.query.test.ts` technique). Every service test fakes the
 * repository, so these are the only tests that would notice the conflict target or a code space
 * silently dropping out.
 */

const db = drizzle.mock() as unknown as Database;
const OWNER = "55555555-5555-4555-8555-555555555555";
const CODE = "abcdef012345";

describe("insertResumeQrLinkStatement — the get-or-create insert", () => {
  const compiled = insertResumeQrLinkStatement(db, { code: CODE, ownerWorkerId: OWNER }).toSQL();

  it("DO NOTHING on the per-owner partial unique index — the target AND its predicate", () => {
    // A partial unique index is inferred only when the ON CONFLICT repeats its predicate. Without
    // the WHERE, Postgres finds no matching index and every mint fails (42P10); with a different
    // predicate, likewise. It must be exactly migration 0129's.
    expect(compiled.sql).toMatch(
      /on conflict \("owner_worker_id"\) where "referral_links"\."kind" = 'resume_qr' AND "referral_links"\."owner_worker_id" IS NOT NULL do nothing/,
    );
    // NOT a targetless DO NOTHING: that would also swallow a CODE collision, which must raise
    // (23505) so the service retries with a fresh code rather than re-reading a row that is not
    // this worker's.
    expect(compiled.sql).not.toMatch(/on conflict do nothing/);
  });

  it("writes kind resume_qr, organic, for the owner — and nothing that could pay anyone", () => {
    expect(compiled.params).toContain("resume_qr");
    expect(compiled.params).toContain("organic");
    expect(compiled.params).toContain(OWNER);
    expect(compiled.params).toContain(CODE);
    // No agent axis: `referral_links_single_owner_chk` would refuse both, and an agent id is the
    // commission axis this kind never has. The owner is the ONLY id the statement carries.
    const uuids = compiled.params.filter(
      (p) => typeof p === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-/.test(p),
    );
    expect(uuids).toEqual([OWNER]);
  });

  it("returns the row, so the service can tell a mint from a lost race", () => {
    expect(compiled.sql).toMatch(/returning /);
  });
});

describe("codeTakenStatement — one namespace across three tables", () => {
  const compiled = new PgDialect().sqlToQuery(codeTakenStatement(CODE));

  it.each(["referral_links", "invites", "agency_invites"])("probes %s by code", (table) => {
    expect(compiled.sql).toContain(`from "${table}" where "${table}"."code" = $`);
  });

  it("binds the code as a parameter, never inlined into the SQL text", () => {
    expect(compiled.sql).not.toContain(CODE);
    expect(compiled.params).toEqual([CODE, CODE, CODE]);
  });

  it("answers ONE boolean named `taken` — any hit is a collision", () => {
    expect(compiled.sql).toMatch(/exists .* or exists .* or exists .*\) as "taken"$/s);
  });
});
