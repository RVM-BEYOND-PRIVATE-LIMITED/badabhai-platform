import { describe, expect, it } from "vitest";
import { PgDialect } from "drizzle-orm/pg-core";
import type { SQL } from "drizzle-orm";
import type { Database } from "@badabhai/db";
import { ApplicantProfileFactsRepository } from "./applicant-profile-facts.repository";

/**
 * #2736 — the batched facts read behind payer applicant rows. Structural tests: the
 * captured SQL is compiled and asserted on its text and bound parameters, the
 * house pattern (`match-feed.repository.test.ts`). What is NOT provable here is
 * Postgres agreeing; the shape is pinned here, the values in
 * `applicant-profile-facts.test.ts`.
 *
 * The load-bearing claims:
 *  - ONE statement per table (six), never per worker — the page's size never multiplies
 *    the query count.
 *  - The profile read resolves the CURRENT profile (`CURRENT_PROFILE_ORDER`), the same
 *    row the worker's own page shows — never recency alone.
 *  - The projection is faceless: no name, phone, email, address, employer or licence
 *    column, and no free-text field (certificate names/issuers, training, institutes).
 */
const dialect = new PgDialect();
const W1 = "11111111-1111-4111-8111-111111111111";
const W2 = "22222222-2222-4222-8222-222222222222";

interface Executed {
  sql: string;
  params: unknown[];
}

function makeDb() {
  const statements: Executed[] = [];
  const db = {
    execute: (stmt: unknown) => {
      const q = dialect.sqlToQuery(stmt as SQL);
      statements.push({ sql: q.sql.replace(/\s+/g, " "), params: q.params });
      return Promise.resolve([]);
    },
  } as unknown as Database;
  return { repo: new ApplicantProfileFactsRepository(db), statements };
}

describe("listForWorkers — one batched read, faceless projection", () => {
  it("an empty page issues no query", async () => {
    const { repo, statements } = makeDb();
    await expect(repo.listForWorkers([])).resolves.toEqual([]);
    expect(statements).toHaveLength(0);
  });

  it("reads six statements, each keyed to the page's workers", async () => {
    const { repo, statements } = makeDb();
    await repo.listForWorkers([W1, W2]);
    expect(statements).toHaveLength(6);
    for (const { params } of statements) {
      expect(params.flat()).toEqual(expect.arrayContaining([W1, W2]));
    }
  });

  it("resolves the current profile per worker, never recency alone", async () => {
    const { repo, statements } = makeDb();
    await repo.listForWorkers([W1]);
    const profile = statements.find((s) => s.sql.includes("FROM worker_profiles wp"))!;
    expect(profile, "a profile statement").toBeDefined();
    // DISTINCT ON per worker with the shared CURRENT_PROFILE_ORDER tail (profile_status
    // first — a placeholder row must never win — then recency), the same rule the live
    // path and the reach signal read use.
    expect(profile.sql).toContain("DISTINCT ON");
    expect(profile.sql).toContain("profile_status");
  });

  it("projects no identity, contact, employer or free-text column", async () => {
    const { repo, statements } = makeDb();
    await repo.listForWorkers([W1]);
    const all = statements.map((s) => s.sql.toLowerCase()).join("\n");
    // Table names (`worker_certificates`) are fine — the certificate read is a COUNT(*).
    // What must never appear is a free-text or identity COLUMN.
    for (const forbidden of [
      "full_name",
      "phone",
      "email",
      "address",
      "employer",
      "licence",
      "photo",
      "issuer",
      "institute",
      "provider",
      "training",
      "work_done",
    ]) {
      expect(all, `no statement may project ${forbidden}`).not.toContain(forbidden);
    }
  });

  it("counts certificates and takes the max industry months — never the rows", async () => {
    const { repo, statements } = makeDb();
    await repo.listForWorkers([W1]);
    const certs = statements.find((s) => s.sql.includes("worker_certificates"))!;
    expect(certs.sql).toMatch(/count\(/i);
    const industry = statements.find((s) => s.sql.includes("worker_industry_tenure"))!;
    expect(industry.sql).toMatch(/max\(/i);
  });
});
