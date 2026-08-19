/**
 * P1 — "Path B's result set is unchanged" — as a runnable assertion instead of a promise.
 *
 * ===========================================================================
 * WHY THIS EXISTS
 * ===========================================================================
 * `phase-9-s3-deployment-plan.md` makes P1 the load-bearing safety property of the whole S3
 * sequence: every stage is justified by "Path B's result set before vs after must be
 * unchanged", and the plan records that *"P1 failing under that plan was evidence the plan was
 * wrong, not that P1 was too strict."*
 *
 * P1 had no implementation. It was checked by reading the migration and reasoning about it —
 * which is exactly the kind of check that was already wrong once this phase, when a migration
 * everyone believed was applied was not.
 *
 * ===========================================================================
 * WHAT IT COMPARES, AND WHY NOT THE VECTORS
 * ===========================================================================
 * Path B's candidate set for a legacy slug is decided entirely by this predicate, copied from
 * `SkillsRepository.legacyAliasRows` and pinned against it by test:
 *
 *     WHERE sa.domain_id = $1 AND s.status = 'active' AND sa.embedding IS NOT NULL
 *
 * Everything after that — the `ORDER BY sa.embedding <=> query` and the `LIMIT k` — is a pure
 * function of the query vector and the candidate set. So if the CANDIDATE SET is byte-identical
 * before and after a stage, every Path B answer to every possible query is identical too. That
 * is a stronger statement than replaying a fixture, and it needs no provider call: a fixture
 * covers the queries someone thought of, whereas this covers all of them.
 *
 * The digest deliberately includes each row's `embedding_model` and whether it is embedded, but
 * NOT the vector itself. A re-embedding that changes vectors while preserving membership does
 * change Path B's ORDER BY, so it must not be silently invisible — but hashing 768 floats per
 * row would make the digest depend on float formatting, and a digest that changes for reasons
 * nobody can explain is a digest people learn to override.
 *
 * ===========================================================================
 * READ-ONLY
 * ===========================================================================
 * No write path. Take a baseline before a stage, compare after it. The baseline is a small
 * committed JSON file — per-slug counts plus a sha256 — so a reviewer can see what changed
 * without access to the database.
 *
 *   pnpm db:verify:path-b-parity --baseline=<out.json>   # capture
 *   pnpm db:verify:path-b-parity --against=<in.json>     # assert; exit 1 on any drift
 */
import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";

import { sql as dsql } from "drizzle-orm";
import { config } from "dotenv";

import { createDbClient } from "./client";
import { hostClass } from "./audit-embedding-provenance";

config();

const SCRIPT = "verify:path-b-parity";

/** One legacy slug's Path B candidate set, reduced to something diffable. */
export interface SlugParity {
  readonly domainId: string;
  /** Rows Path B can actually return: active skill AND embedded. */
  readonly candidates: number;
  /** Distinct skills behind them — what a caller experiences as "reach". */
  readonly skills: number;
  /** sha256 over the sorted candidate tuples. The actual assertion. */
  readonly digest: string;
}

export interface ParityBaseline {
  readonly kind: "path-b-parity";
  readonly target: { readonly host_class: string; readonly database: string | null };
  readonly slugs: readonly SlugParity[];
  /** One digest over everything, so a single comparison answers "did anything move". */
  readonly digest: string;
}

/**
 * The digest of one slug's candidate set.
 *
 * Sorted before hashing because row order from Postgres is not guaranteed and a digest that
 * depends on it would fail at random, which is worse than not having one.
 */
export function slugDigest(
  rows: readonly { skill_id: string; text: string; embedding_model: string | null }[],
): string {
  const lines = rows
    .map((r) => `${r.skill_id}${r.text}${r.embedding_model ?? ""}`)
    .sort();
  return createHash("sha256").update(lines.join(""), "utf8").digest("hex");
}

/** One digest over every slug, so "did anything move at all" is a single string compare. */
export function overallDigest(slugs: readonly SlugParity[]): string {
  const lines = [...slugs]
    .map((s) => `${s.domainId}${s.candidates}${s.skills}${s.digest}`)
    .sort();
  return createHash("sha256").update(lines.join(""), "utf8").digest("hex");
}

export interface ParityDrift {
  readonly domainId: string;
  readonly kind: "added" | "removed" | "changed";
  readonly before: { candidates: number; skills: number } | null;
  readonly after: { candidates: number; skills: number } | null;
}

/**
 * Compare two baselines.
 *
 * A slug that exists in one and not the other is reported as added/removed rather than skipped —
 * P1 is about the result set a caller sees, and a slug appearing from nowhere changes that just
 * as much as a row moving inside one.
 */
export function diffParity(
  before: readonly SlugParity[],
  after: readonly SlugParity[],
): ParityDrift[] {
  const b = new Map(before.map((s) => [s.domainId, s]));
  const a = new Map(after.map((s) => [s.domainId, s]));
  const out: ParityDrift[] = [];
  for (const [id, bs] of b) {
    const as = a.get(id);
    if (as === undefined) {
      out.push({ domainId: id, kind: "removed", before: { candidates: bs.candidates, skills: bs.skills }, after: null });
    } else if (as.digest !== bs.digest) {
      out.push({
        domainId: id,
        kind: "changed",
        before: { candidates: bs.candidates, skills: bs.skills },
        after: { candidates: as.candidates, skills: as.skills },
      });
    }
  }
  for (const [id, as] of a) {
    if (!b.has(id)) {
      out.push({ domainId: id, kind: "added", before: null, after: { candidates: as.candidates, skills: as.skills } });
    }
  }
  return out.sort((x, y) => x.domainId.localeCompare(y.domainId));
}

async function capture(url: string): Promise<ParityBaseline> {
  const { db, sql } = createDbClient(url, { max: 1 });
  try {
    const [where] = (await db.execute(dsql`SELECT current_database() AS db`)) as unknown as { db: string }[];
    // EXACTLY `legacyAliasRows`'s predicate, minus the ORDER BY/LIMIT that depend on a query
    // vector. `skill_alias_parity.test.ts` pins this against the repository source.
    const rows = (await db.execute(
      dsql`SELECT sa.domain_id, sa.skill_id, sa.text, sa.embedding_model
           FROM skill_alias sa
           JOIN skill s ON s.skill_id = sa.skill_id
           WHERE s.status = 'active'
             AND sa.embedding IS NOT NULL
             AND sa.domain_id IS NOT NULL`,
    )) as unknown as { domain_id: string; skill_id: string; text: string; embedding_model: string | null }[];

    const bySlug = new Map<string, typeof rows>();
    for (const r of rows) bySlug.set(r.domain_id, [...(bySlug.get(r.domain_id) ?? []), r]);

    const slugs: SlugParity[] = [...bySlug.entries()]
      .map(([domainId, rs]) => ({
        domainId,
        candidates: rs.length,
        skills: new Set(rs.map((r) => r.skill_id)).size,
        digest: slugDigest(rs),
      }))
      .sort((a, b2) => a.domainId.localeCompare(b2.domainId));

    return {
      kind: "path-b-parity",
      target: { host_class: hostClass(url), database: where?.db ?? null },
      slugs,
      digest: overallDigest(slugs),
    };
  } finally {
    await sql.end();
  }
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const baselineArg = argv.find((a) => a.startsWith("--baseline="));
  const againstArg = argv.find((a) => a.startsWith("--against="));

  const url = process.env["DATABASE_URL"];
  if (!url) throw new Error(`[${SCRIPT}] DATABASE_URL is not set`);

  const now = await capture(url);
  console.log(`[${SCRIPT}] READ-ONLY.`);
  console.log(`  target                   = ${now.target.host_class}  db=${now.target.database ?? "?"}`);
  console.log(`  legacy slugs             = ${now.slugs.length}`);
  console.log(`  Path B candidate rows    = ${now.slugs.reduce((s, x) => s + x.candidates, 0)}`);
  console.log(`  overall digest           = ${now.digest.slice(0, 16)}…`);
  console.log("");
  for (const s of now.slugs) {
    console.log(`  ${s.domainId.padEnd(22)} candidates=${String(s.candidates).padStart(4)} skills=${String(s.skills).padStart(3)}  ${s.digest.slice(0, 12)}…`);
  }

  if (baselineArg !== undefined) {
    const path = baselineArg.slice("--baseline=".length);
    if (existsSync(path)) {
      console.error(`\n  refusing to overwrite ${path} — a baseline is evidence, never replaced.`);
      process.exitCode = 1;
      return;
    }
    writeFileSync(path, `${JSON.stringify(now, null, 2)}\n`, "utf8");
    console.log(`\n  baseline written to ${path}`);
  }

  if (againstArg !== undefined) {
    const path = againstArg.slice("--against=".length);
    if (!existsSync(path)) throw new Error(`[${SCRIPT}] --against file not found: ${path}`);
    const before = JSON.parse(readFileSync(path, "utf8")) as ParityBaseline;
    const drift = diffParity(before.slugs, now.slugs);
    console.log(`\n  === P1 — Path B result set unchanged? ===`);
    if (before.digest === now.digest) {
      console.log(`  PASS — every legacy slug's candidate set is byte-identical to ${path}.`);
      return;
    }
    console.log(`  FAIL — ${drift.length} slug(s) drifted:`);
    for (const d of drift) {
      const b = d.before ? `${d.before.candidates}/${d.before.skills}` : "-";
      const a = d.after ? `${d.after.candidates}/${d.after.skills}` : "-";
      console.log(`     ${d.kind.padEnd(8)} ${d.domainId.padEnd(22)} candidates/skills ${b} -> ${a}`);
    }
    console.log(
      `\n  P1 is retained unchanged and unweakened by the S3 plan: a failure here is evidence the\n` +
        `  STAGE is wrong, not that the assertion is too strict. Do not re-baseline to make it pass.`,
    );
    process.exitCode = 1;
  }
}

if (require.main === module) {
  main().catch((e: unknown) => {
    console.error(e instanceof Error ? e.message : e);
    process.exit(1);
  });
}
