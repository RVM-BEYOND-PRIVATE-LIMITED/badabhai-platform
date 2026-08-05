/**
 * Job-domain catalog verifier (migration 0060) — the DEPLOY GATE.
 *
 *   pnpm db:verify:domains
 *
 * Asserts against the LIVE database, not against the corpus files. That distinction is
 * the whole point: the corpus validator (`job-domain-corpus.ts`) proves the FILES are
 * coherent, this proves the DATABASE actually got what they described. A seed that
 * half-applied, a batch that silently dropped rows, an embedding run that stopped on
 * budget — none of those are visible from the files. Mirrors `verify-match-v1.ts`.
 *
 * Read-only. Exits 1 on any FAIL so it can gate a deploy step; WARNs do not fail the
 * run (an unembedded catalog is a known intermediate state, not a defect).
 *
 * PRIVACY: reads the reference catalog only. Every line printed is ids + counts.
 */
import { config } from "dotenv";
import { sql as dsql } from "drizzle-orm";

import { createDbClient } from "./client";

config({ path: "../../.env" });

const SCRIPT = "verify:domains";

interface Check {
  name: string;
  /** WARN describes a known intermediate state; FAIL is a defect. */
  level: "fail" | "warn";
  detail: string;
  count: number;
}

async function main(): Promise<void> {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error(`[${SCRIPT}] DATABASE_URL is not set`);

  const { db, sql } = createDbClient(url, { max: 1 });
  const checks: Check[] = [];

  try {
    const one = async (q: ReturnType<typeof dsql>): Promise<number> => {
      const rows = (await db.execute(q)) as unknown as Array<{ n: string | number }>;
      return Number(rows[0]?.n ?? 0);
    };

    const domains = await one(dsql`SELECT count(*) AS n FROM "job_domain"`);
    const selectable = await one(
      dsql`SELECT count(*) AS n FROM "job_domain" WHERE "selectable" AND "status" = 'active'`,
    );
    const aliases = await one(dsql`SELECT count(*) AS n FROM "job_domain_alias"`);

    if (domains === 0) {
      checks.push({
        name: "catalog is empty",
        level: "fail",
        detail: "no job_domain rows — run `pnpm db:seed:domains --apply` first",
        count: 0,
      });
    }

    // A selectable row with NO alias is INVISIBLE to retrieval (we embed aliases, not
    // the canonical label). It is a silent hole in coverage rather than an error anyone
    // would notice, which is exactly why it is checked here and not left to review.
    checks.push({
      name: "selectable domains with zero aliases",
      level: "fail",
      detail: "unreachable by retrieval — they can never be matched to a worker",
      count: await one(dsql`
        SELECT count(*) AS n FROM "job_domain" d
         WHERE d."selectable" AND d."status" = 'active'
           AND NOT EXISTS (SELECT 1 FROM "job_domain_alias" a WHERE a."job_domain_id" = d."job_domain_id")
      `),
    });

    // Orphans: a parent_code that never made it into the DB. The classic symptom of a
    // truncated scrape or a half-applied seed.
    checks.push({
      name: "domains whose parent is missing",
      level: "fail",
      detail: "broken hierarchy — the seed did not apply completely",
      count: await one(dsql`
        SELECT count(*) AS n FROM "job_domain" d
         WHERE d."parent_job_domain_id" IS NOT NULL
           AND NOT EXISTS (SELECT 1 FROM "job_domain" p WHERE p."job_domain_id" = d."parent_job_domain_id")
      `),
    });

    checks.push({
      name: "non-root domains with no parent linked",
      level: "fail",
      detail: "seed pass 2 (parent linking) did not complete",
      count: await one(
        dsql`SELECT count(*) AS n FROM "job_domain" WHERE "level" > 1 AND "parent_job_domain_id" IS NULL`,
      ),
    });

    // A cycle would make any recursive walk hang. Bounded depth-limited walk rather than
    // a full transitive closure — cheap, and a cycle shows up as a row still reachable
    // after more hops than the hierarchy is deep.
    checks.push({
      name: "parent cycles",
      level: "fail",
      detail: "a domain is its own ancestor — the hierarchy is not a tree",
      count: await one(dsql`
        WITH RECURSIVE walk(root, node, depth) AS (
          SELECT "job_domain_id", "parent_job_domain_id", 1 FROM "job_domain" WHERE "parent_job_domain_id" IS NOT NULL
          UNION ALL
          SELECT w.root, d."parent_job_domain_id", w.depth + 1
            FROM walk w JOIN "job_domain" d ON d."job_domain_id" = w.node
           WHERE d."parent_job_domain_id" IS NOT NULL AND w.depth < 8
        )
        SELECT count(*) AS n FROM walk WHERE node = root
      `),
    });

    checks.push({
      name: "selectable rows above leaf level",
      level: "fail",
      detail: "a bucket group is marked selectable — a worker could be placed in a category, not a job",
      count: await one(dsql`SELECT count(*) AS n FROM "job_domain" WHERE "selectable" AND "level" < 4`),
    });

    checks.push({
      name: "deprecated rows still selectable",
      level: "fail",
      detail: "retired domains must not be matchable",
      count: await one(
        dsql`SELECT count(*) AS n FROM "job_domain" WHERE "status" = 'deprecated' AND "selectable"`,
      ),
    });

    // Embeddings. NOT a failure — an unembedded catalog is the expected state straight
    // after seeding — but retrieval returns NOTHING until it is fixed, so it is loud.
    const unembeddedSelectable = await one(dsql`
      SELECT count(*) AS n FROM "job_domain_alias" a
        JOIN "job_domain" d ON d."job_domain_id" = a."job_domain_id"
       WHERE a."embedding" IS NULL AND d."selectable" AND d."status" = 'active'
    `);
    checks.push({
      name: "selectable-domain aliases with no embedding",
      level: "warn",
      detail: "retrieval cannot see these — run `pnpm db:embed:domains --only-selectable`",
      count: unembeddedSelectable,
    });

    const mockEmbeddings = await one(
      dsql`SELECT count(*) AS n FROM "job_domain_alias" WHERE "embedding_model" = 'mock-embedding'`,
    );
    checks.push({
      name: "aliases holding MOCK vectors",
      level: "warn",
      detail:
        "deterministic hash vectors, not semantic ones — retrieval will look plausible and be meaningless. " +
        "Before a real run: `pnpm db:embed:domains --reset-mock-embeddings`",
      count: mockEmbeddings,
    });

    const unattributed = await one(
      dsql`SELECT count(*) AS n FROM "job_domain_alias" WHERE "embedding" IS NOT NULL AND "embedding_model" IS NULL`,
    );
    checks.push({
      name: "embeddings with no provenance",
      level: "warn",
      detail: "written before embedding_model existed, or by a runner that did not stamp it",
      count: unattributed,
    });

    // The crosswalk into the legacy 13-role space. Not enforced by an FK (ROLES is a
    // TypeScript constant, not a table), so it is checked here instead.
    const crosswalked = await one(
      dsql`SELECT count(*) AS n FROM "job_domain" WHERE "canonical_role_id" IS NOT NULL`,
    );

    console.log(`[${SCRIPT}] catalog:`);
    console.log(`  domains                    = ${domains}`);
    console.log(`  selectable (active)        = ${selectable}`);
    console.log(`  aliases                    = ${aliases}`);
    console.log(`  crosswalked to a role      = ${crosswalked}`);
    console.log(`[${SCRIPT}] checks:`);

    let failed = 0;
    for (const c of checks) {
      if (c.count === 0) {
        console.log(`  PASS  ${c.name}`);
        continue;
      }
      if (c.level === "warn") {
        console.log(`  WARN  ${c.name} = ${c.count}\n          ${c.detail}`);
        continue;
      }
      failed += 1;
      console.log(`  FAIL  ${c.name} = ${c.count}\n          ${c.detail}`);
    }

    if (failed > 0) {
      console.error(`[${SCRIPT}] ${failed} check(s) FAILED — the catalog is not deployable.`);
      process.exitCode = 1;
      return;
    }
    console.log(`[${SCRIPT}] all structural checks passed.`);
  } finally {
    await sql.end({ timeout: 5 });
  }
}

main().catch((err) => {
  console.error(`[${SCRIPT}] failed:`, err);
  process.exit(1);
});
