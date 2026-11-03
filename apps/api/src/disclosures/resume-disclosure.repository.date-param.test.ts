import { describe, expect, it } from "vitest";
import { PgDialect } from "drizzle-orm/pg-core";
import type { SQL } from "drizzle-orm";
import type { Database } from "@badabhai/db";
import { ResumeDisclosureRepository } from "./resume-disclosure.repository";

/**
 * 2026-11-03 — the shared weekly cap's RAW statement must never bind a JS `Date`. In a raw `sql`
 * template no column encoder runs, and the postgres-js driver this client uses refuses a `Date`
 * parameter, so `countDistinctPayersSince` 500'd every résumé request that got past consent —
 * found end-to-end the first time a payer could unlock a consented worker (the all-candidates
 * search). This pins the bound parameters themselves, without a database.
 */
describe("ResumeDisclosureRepository.countDistinctPayersSince — parameter binding", () => {
  it("binds the instant as ISO text (cast in SQL), never as a Date object", async () => {
    let captured: SQL | undefined;
    const tx = {
      execute: async (statement: SQL) => {
        captured = statement;
        return [{ count: 2 }];
      },
    };
    const repo = new ResumeDisclosureRepository({} as Database);
    const since = new Date("2026-10-27T13:17:37.000Z");
    const count = await repo.countDistinctPayersSince(tx as never, "face2000-0000-4000-8000-0000000000b8", since);

    expect(count).toBe(2);
    const query = new PgDialect().sqlToQuery(captured!);
    expect(query.params.some((p) => p instanceof Date)).toBe(false);
    expect(query.params).toContain("2026-10-27T13:17:37.000Z");
    expect(query.sql).toMatch(/::timestamptz/);
  });
});
