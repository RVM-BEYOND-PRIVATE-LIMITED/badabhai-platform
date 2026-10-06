import { describe, expect, it } from "vitest";
import { PgDialect } from "drizzle-orm/pg-core";
import type { SQL } from "drizzle-orm";
import type { Database } from "@badabhai/db";
import { AdminMatchEngineRepository } from "./admin-match-engine.repository";

/**
 * The Engine view's SQL, rendered. Asserted on the QUERY, not fixture rows: what it may never
 * select (identity, company names, ciphertext), that it never writes, and that each statement
 * keeps the predicate its index serves.
 */

const dialect = new PgDialect();

function capture(rows: unknown[] = []) {
  const statements: string[] = [];
  const db = {
    execute: async (q: SQL) => {
      statements.push(dialect.sqlToQuery(q).sql);
      return rows;
    },
  } as unknown as Database;
  return { repo: new AdminMatchEngineRepository(db), statements };
}

const ID = "5eeded00-0001-4a00-8000-000000000001";
const DEMO_IDS = ["5eeded00-0001-4a00-8000-000000000009"];

async function allStatements(): Promise<string> {
  const { repo, statements } = capture();
  await repo.findLiveDemoWorker(ID, DEMO_IDS);
  await repo.listWorkerSkills(ID);
  await repo.countFunnel(ID);
  await repo.findCardPostingMeta([ID]);
  await repo.listRecentDemoWorkers(20, DEMO_IDS);
  await repo.countDemoReachForPosting(ID, DEMO_IDS);
  await repo.findPostingHeader(ID);
  return statements.join("\n");
}

describe("AdminMatchEngineRepository", () => {
  it("never selects identity, contact, company names or ciphertext", async () => {
    const sql = await allStatements();
    expect(sql).not.toMatch(/full_name|phone|whatsapp|_enc\b|org_label|org_name|email/);
  });

  it("gates every worker-returning read and the posting reach on demo worker ids (owner ruling 2026-10-06)", async () => {
    const { repo, statements } = capture();
    await repo.findLiveDemoWorker(ID, DEMO_IDS);
    await repo.listRecentDemoWorkers(5, DEMO_IDS);
    await repo.countDemoReachForPosting(ID, DEMO_IDS);
    expect(statements[0]).toMatch(/w\.id = ANY\(\$\d+::uuid\[\]\)/);
    expect(statements[1]).toMatch(/w\.id = ANY\(\$\d+::uuid\[\]\)/);
    expect(statements[2]).toMatch(/jr\.worker_id = ANY\(\$\d+::uuid\[\]\)/);
  });

  it("is read-only", async () => {
    const sql = await allStatements();
    expect(sql).not.toMatch(/\b(INSERT|UPDATE|DELETE|TRUNCATE)\b/i);
  });

  it("hides pending-deletion workers from the lookup and the picker", async () => {
    const { repo, statements } = capture();
    await repo.findLiveDemoWorker(ID, DEMO_IDS);
    await repo.listRecentDemoWorkers(5, DEMO_IDS);
    expect(statements[0]).toContain("deletion_scheduled_at IS NULL");
    expect(statements[1]).toContain("deletion_scheduled_at IS NULL");
    expect(statements[1]).toContain("ORDER BY w.created_at DESC, w.id DESC");
  });

  it("counts the funnel with the feed's own reach predicate, in one statement", async () => {
    const { repo, statements } = capture([
      { open_postings: 9, reached_direct: 2, reached_related: 3, already_actioned: 1 },
    ]);
    const counts = await repo.countFunnel(ID);
    expect(statements).toHaveLength(1);
    expect(statements[0]).toContain(
      "JOIN job_postings jp ON jp.id = jr.job_posting_id AND jp.status = 'open'",
    );
    expect(statements[0]).toContain("WHERE jr.worker_id = $");
    expect(counts).toEqual({
      openPostings: 9,
      reachedDirect: 2,
      reachedRelated: 3,
      alreadyActioned: 1,
    });
  });

  it("skips the meta read entirely for an empty feed", async () => {
    const { repo, statements } = capture();
    expect((await repo.findCardPostingMeta([])).size).toBe(0);
    expect(statements).toHaveLength(0);
  });
});
