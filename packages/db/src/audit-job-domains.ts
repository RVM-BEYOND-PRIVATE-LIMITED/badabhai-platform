/**
 * Reconcile the seeded `job_domain` / `job_domain_alias` tables against the corpus
 * files, ID BY ID.
 *
 * WHY THIS EXISTS SEPARATELY FROM `verify-job-domains.ts`. That script checks the
 * catalogue is STRUCTURALLY sound — no orphan parents, no cycles, no selectable
 * non-leaf rows. It reads only the database, so it cannot answer the different question
 * "is everything that was supposed to be loaded actually loaded?". A seed that silently
 * dropped forty occupations would still be perfectly well-formed and every structural
 * check would pass. That is not hypothetical: the first NCO-2015 parse lost 22 real
 * occupations to a two-column PDF layout, and nothing in the pipeline noticed.
 *
 * Counts are not enough either — 4,071 rows in the files and 4,071 in the table can
 * still be 4,071 DIFFERENT rows. So this diffs the id SETS both ways (missing / extra)
 * for domains, parents, selectable flags, levels and aliases.
 *
 * It goes through `resolveJobDomainCorpus`, the same loader the seed uses, so the two
 * can never disagree about which files exist or how an id is derived.
 *
 * READ-ONLY. Exits non-zero on any discrepancy, so it can be used as a gate.
 */
import { config } from "dotenv";
import { sql } from "drizzle-orm";
import { createDbClient } from "./client";
import { resolveJobDomainCorpus } from "./job-domain-corpus";

// DATABASE_URL lives in the ROOT .env — same bootstrap as verify-job-domains.ts.
config({ path: "../../.env" });

const diff = (a: Set<string>, b: Set<string>) => [...a].filter((x) => !b.has(x));

async function main(): Promise<void> {
  const corpus = resolveJobDomainCorpus();
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("[audit:domains] DATABASE_URL is not set");
  const { db, sql: pg } = createDbClient(url, { max: 1 });
  let failures = 0;

  const report = (label: string, missing: string[], extra: string[]) => {
    if (missing.length === 0 && extra.length === 0) {
      console.log(`  PASS  ${label}`);
      return;
    }
    failures += 1;
    console.log(`  FAIL  ${label}`);
    const show = (what: string, xs: string[]) =>
      console.log(
        `          ${what} (${xs.length}): ${xs.slice(0, 10).join(", ")}${xs.length > 10 ? " …" : ""}`,
      );
    if (missing.length) show("missing from DB", missing);
    if (extra.length) show("extra in DB", extra);
  };

  try {
    const rows = (await db.execute(
      sql`SELECT job_domain_id, parent_job_domain_id, selectable, level, source FROM job_domain`,
    )) as unknown as Array<{
      job_domain_id: string;
      parent_job_domain_id: string | null;
      selectable: boolean;
      level: number;
      source: string;
    }>;

    const bySource: Record<string, number> = {};
    for (const r of corpus) bySource[r.source] = (bySource[r.source] ?? 0) + 1;
    console.log(
      `[audit:domains] corpus files = ${corpus.length} domains ${JSON.stringify(bySource)}`,
    );
    console.log(`[audit:domains] database     = ${rows.length} domains`);
    console.log("[audit:domains] id-set reconciliation:");

    const corpusIds = new Set(corpus.map((r) => r.jobDomainId));
    const dbIds = new Set(rows.map((r) => r.job_domain_id));
    report(
      "every corpus domain exists, and no others",
      diff(corpusIds, dbIds),
      diff(dbIds, corpusIds),
    );

    // A dropped parent link is the quiet one: the row is present and the tree is still
    // acyclic, so the structural verifier is happy — but the occupation has come loose
    // from its branch and no longer rolls up to anything.
    const dbParent = new Map(rows.map((r) => [r.job_domain_id, r.parent_job_domain_id]));
    report(
      "every parent pointer matches the corpus",
      corpus
        .filter((r) => (dbParent.get(r.jobDomainId) ?? null) !== (r.parentJobDomainId ?? null))
        .map((r) => r.jobDomainId),
      [],
    );

    // `selectable` decides whether a worker can be matched to the occupation at all, so
    // a flipped flag silently removes it from every future search.
    const dbSelectable = new Map(rows.map((r) => [r.job_domain_id, r.selectable]));
    report(
      "every selectable flag matches the corpus",
      corpus
        .filter((r) => dbSelectable.get(r.jobDomainId) !== Boolean(r.selectable))
        .map((r) => r.jobDomainId),
      [],
    );

    const dbLevel = new Map(rows.map((r) => [r.job_domain_id, Number(r.level)]));
    report(
      "every hierarchy level matches the corpus",
      corpus.filter((r) => dbLevel.get(r.jobDomainId) !== r.level).map((r) => r.jobDomainId),
      [],
    );

    // Aliases are compared as (domain, lowercased text) PAIRS, not as a count: they are
    // the search surface, so one missing phrase is one way a real worker stops being
    // findable.
    const aliasRows = (await db.execute(
      sql`SELECT job_domain_id, text FROM job_domain_alias`,
    )) as unknown as Array<{ job_domain_id: string; text: string }>;

    const corpusAliases = new Set<string>();
    for (const r of corpus) {
      for (const a of r.aliases ?? []) {
        corpusAliases.add(`${r.jobDomainId} ${a.text.trim().toLowerCase()}`);
      }
    }
    const dbAliases = new Set(
      aliasRows.map((r) => `${r.job_domain_id} ${r.text.trim().toLowerCase()}`),
    );

    console.log(
      `[audit:aliases] corpus files = ${corpusAliases.size} unique (domain, alias) pairs`,
    );
    console.log(`[audit:aliases] database     = ${dbAliases.size} unique (domain, alias) pairs`);
    const pretty = (k: string) => k.replace(" ", " / ");
    report(
      "every corpus alias exists, and no others",
      diff(corpusAliases, dbAliases).map(pretty),
      diff(dbAliases, corpusAliases).map(pretty),
    );

    console.log(
      failures === 0
        ? "[audit:domains] COMPLETE — the database matches the corpus exactly, id for id."
        : `[audit:domains] ${failures} DISCREPANCY GROUP(S) — the seed did not load everything.`,
    );
  } finally {
    await pg.end({ timeout: 5 });
  }

  if (failures > 0) process.exit(1);
}

void main();
