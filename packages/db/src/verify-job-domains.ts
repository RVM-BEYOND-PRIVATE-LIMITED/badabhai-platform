/**
 * Job-domain catalog verifier (migration 0066) — the DEPLOY GATE.
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

/**
 * The empty-catalog PRECONDITION, extracted so it can be unit-tested.
 *
 * Returns the failure message when the catalog is empty, or `null` when it is not.
 *
 * WHY THIS IS NOT A `Check`. Every entry in `checks` counts BAD ROWS, and the reporting
 * loop reads `count === 0` as "nothing wrong → PASS" unconditionally. An empty catalog is
 * the exact inversion of that convention: the finding IS the zero. Pushed through as a
 * check it printed `PASS  catalog is empty` and exited 0 — and because an unseeded table
 * also yields 0 for every OTHER check, the script then reported "all structural checks
 * passed" against a database with no catalog at all. That is the single failure this
 * deploy gate exists to catch, and it silently inverted into a pass.
 *
 * Keeping it as a separate, non-`Check` predicate is what stops that regression, so the
 * shape here is load-bearing: if a future edit moves this back into `checks`, the count-is-
 * zero convention re-inverts it. `verify-job-domains.test.ts` pins BOTH directions.
 */
export function catalogEmptyFailure(domainCount: number): string | null {
  if (domainCount > 0) return null;
  return (
    `[${SCRIPT}] FAIL  catalog is empty — no job_domain rows. ` +
    "Run `pnpm db:seed:domains --apply` first."
  );
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

    // PRECONDITION, deliberately NOT a `checks` entry — see `catalogEmptyFailure` above
    // for why the shape matters. Returns immediately: on an empty table the remaining
    // checks are not merely redundant, they are actively misleading.
    const emptyFailure = catalogEmptyFailure(domains);
    if (emptyFailure !== null) {
      console.error(emptyFailure);
      process.exitCode = 1;
      return;
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

    // ── Retrieval surface (migration 0067) ───────────────────────────────────────────
    // `text_norm` and `is_searchable` are written by `pnpm db:normalize:aliases`, never by
    // the seeder. Every check below counts BAD ROWS, per the convention above.

    // Un-normalized aliases are invisible to L0 (exact) and L2 (trigram) retrieval. Like
    // the embedding check this is a known intermediate state right after a seed, not a
    // defect — but it means the two FREE retrieval layers return nothing and every turn
    // falls through to a paid embedding call, so it is loud.
    checks.push({
      name: "aliases with no text_norm",
      level: "warn",
      detail: "invisible to L0/L2 retrieval — run `pnpm db:normalize:aliases --apply`",
      count: await one(dsql`SELECT count(*) AS n FROM "job_domain_alias" WHERE "text_norm" IS NULL`),
    });

    // A row cannot be searchable without the key retrieval searches ON. The runner clears
    // this pair, so a non-zero count means something wrote `is_searchable` directly.
    checks.push({
      name: "searchable aliases with no text_norm",
      level: "fail",
      detail: "is_searchable was set without a normalized key — retrieval would never match them",
      count: await one(
        dsql`SELECT count(*) AS n FROM "job_domain_alias" WHERE "is_searchable" AND "text_norm" IS NULL`,
      ),
    });

    // THE UNIQUE-INDEX INVARIANT, asserted independently of the index itself. The index is
    // PARTIAL on `is_searchable`, so it can only reject a duplicate at write time; this
    // proves the dedupe pass actually elected ONE winner per normalized form. If the
    // runner's `row_number()` partition and the index's `NULLS NOT DISTINCT` grouping ever
    // disagree, this is the check that says so.
    checks.push({
      name: "duplicate (job_domain_id, text_norm, lang) among searchable aliases",
      level: "fail",
      detail: "the dedupe pass elected more than one winner — re-run `db:normalize:aliases --apply`",
      count: await one(dsql`
        SELECT coalesce(sum(c - 1), 0) AS n FROM (
          SELECT count(*) AS c FROM "job_domain_alias"
           WHERE "is_searchable"
           GROUP BY "job_domain_id", "text_norm", "lang"
          HAVING count(*) > 1
        ) d
      `),
    });

    // A searchable alias on a domain a worker may not hold. `is_searchable` is a
    // MATERIALIZED projection — it goes stale the moment a domain is deprecated, and
    // nothing recomputes it automatically.
    checks.push({
      name: "searchable aliases on non-selectable or inactive domains",
      level: "fail",
      detail: "stale is_searchable — a worker could be matched to a bucket or a retired domain",
      count: await one(dsql`
        SELECT count(*) AS n FROM "job_domain_alias" a
          JOIN "job_domain" d ON d."job_domain_id" = a."job_domain_id"
         WHERE a."is_searchable" AND NOT (d."selectable" AND d."status" = 'active')
      `),
    });

    // The F4 fix, asserted. All 436 ISCO unit groups are seeded `selectable` alongside
    // 3,449 NCO occupations; the 370 with selectable NCO children must not compete with
    // their own children in one shortlist. The 66 UNSHADOWED units stay searchable,
    // because for those the unit group IS the leaf.
    checks.push({
      name: "searchable aliases on SHADOWED ISCO unit groups",
      level: "fail",
      detail:
        "mixed granularity — the shortlist would offer both an ISCO unit and its own NCO children",
      count: await one(dsql`
        SELECT count(*) AS n FROM "job_domain_alias" a
          JOIN "job_domain" d ON d."job_domain_id" = a."job_domain_id"
         WHERE a."is_searchable" AND d."source" = 'isco08'
           AND EXISTS (
             SELECT 1 FROM "job_domain" c
              WHERE c."parent_job_domain_id" = d."job_domain_id"
                AND c."selectable" AND c."status" = 'active'
           )
      `),
    });

    // A selectable domain with aliases but NO searchable one is unreachable by retrieval —
    // the same class of silent coverage hole as "selectable with zero aliases" above, but
    // introduced by the normalization pass rather than by the corpus.
    //
    // SCOPED TO FULLY-NORMALIZED DOMAINS, and that scoping is the point. Without it this
    // check fires on the ordinary post-seed state: straight after `db:seed:domains` every
    // `text_norm` is NULL, so all 3,515 domains have no searchable alias and the documented
    // `db:migrate && db:seed:domains && db:verify:domains` chain exits 1 — turning the
    // deploy gate red for a state the deploy is supposed to pass through. The "aliases with
    // no text_norm" WARN above is what reports that state; this FAIL is reserved for a
    // domain the normalizer HAS processed and still left unreachable, which is a real defect.
    checks.push({
      name: "normalized selectable domains with aliases but none searchable",
      level: "fail",
      detail: "unreachable by retrieval — the normalization pass excluded every alias they have",
      count: await one(dsql`
        SELECT count(*) AS n FROM "job_domain" d
         WHERE d."selectable" AND d."status" = 'active'
           AND NOT EXISTS (
             SELECT 1 FROM "job_domain_alias" a
              WHERE a."job_domain_id" = d."job_domain_id" AND a."text_norm" IS NULL
           )
           AND NOT (
             d."source" = 'isco08'
             AND EXISTS (
               SELECT 1 FROM "job_domain" c
                WHERE c."parent_job_domain_id" = d."job_domain_id"
                  AND c."selectable" AND c."status" = 'active'
             )
           )
           AND EXISTS (SELECT 1 FROM "job_domain_alias" a WHERE a."job_domain_id" = d."job_domain_id")
           AND NOT EXISTS (
             SELECT 1 FROM "job_domain_alias" a
              WHERE a."job_domain_id" = d."job_domain_id" AND a."is_searchable"
           )
      `),
    });

    // Embeddings. NOT a failure — an unembedded catalog is the expected state straight
    // after seeding — but retrieval returns NOTHING until it is fixed, so it is loud.
    // Scoped to SEARCHABLE aliases since 0067: those are the rows the ANN index actually
    // covers (it is partial on `is_searchable`). Counting every selectable-domain alias
    // instead would report thousands of rows that retrieval was never going to read —
    // a warning nobody can act on is a warning everybody learns to ignore.
    const unembeddedSearchable = await one(dsql`
      SELECT count(*) AS n FROM "job_domain_alias"
       WHERE "embedding" IS NULL AND "is_searchable"
    `);
    checks.push({
      name: "searchable aliases with no embedding",
      level: "warn",
      detail: "L3 vector retrieval cannot see these — run `pnpm db:embed:domains --only-selectable`",
      count: unembeddedSearchable,
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

    // The retrieval surface as actually built (migration 0067). Printed rather than
    // checked: there is no single correct value, and the useful signal is the SHAPE —
    // searchable aliases far below `aliases`, and searchable domains close to
    // `selectable (active)` minus the shadowed ISCO units.
    const searchableAliases = await one(
      dsql`SELECT count(*) AS n FROM "job_domain_alias" WHERE "is_searchable"`,
    );
    const searchableDomains = await one(
      dsql`SELECT count(DISTINCT "job_domain_id") AS n FROM "job_domain_alias" WHERE "is_searchable"`,
    );

    console.log(`[${SCRIPT}] catalog:`);
    console.log(`  domains                    = ${domains}`);
    console.log(`  selectable (active)        = ${selectable}`);
    console.log(`  aliases                    = ${aliases}`);
    console.log(`  crosswalked to a role      = ${crosswalked}`);
    console.log(`  searchable aliases         = ${searchableAliases}`);
    console.log(`  searchable domains         = ${searchableDomains}`);
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

// Only run when EXECUTED, never when imported — `verify-job-domains.test.ts` imports
// `catalogEmptyFailure` above, and without this guard that import runs `main()`, which
// requires DATABASE_URL and calls `process.exit(1)` when it is absent. Locally that is
// invisible because the repo-root .env supplies one; CI has no .env, so the import
// killed the whole vitest process. Same guard, same reason, as `bootstrap-admin.ts`.
if (process.argv[1] && /verify-job-domains/.test(process.argv[1])) {
  main().catch((err) => {
    // nosemgrep: javascript.lang.security.audit.unsafe-formatstring.unsafe-formatstring -- `SCRIPT` is a module-level string constant declared in this file, never input. This is the CLI's terminal error line; no user- or worker-supplied value reaches the template.
    console.error(`[${SCRIPT}] failed:`, err);
    process.exit(1);
  });
}
