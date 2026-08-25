/**
 * Can the shipped vernacular aliases actually be retrieved on the path production uses?
 * READ-ONLY, and **zero AI spend**.
 *
 * ===========================================================================
 * WHY THIS EXISTS
 * ===========================================================================
 * D6-0 shipped 22 owner-ratified Hindi aliases on 2026-07-16. "The rows exist and are embedded"
 * was treated as delivery. It is not: `skill_alias` retrieval is SCOPED, and both live call
 * sites scope to a single legacy slug —
 * `job-postings.service.ts` `LEGACY_ANCHOR_SKILL_DOMAIN = "cnc-machining"` and
 * `config.py` `skill_canonicalize_default_domain = "cnc-machining"` — until per-label domain
 * resolution (TAX-6) lands. The 22 aliases are spread across eight slugs, so most of them are
 * outside the only scope that gets queried.
 *
 * ===========================================================================
 * HOW IT MEASURES WITHOUT PAYING
 * ===========================================================================
 * The obvious way to test "would this phrase retrieve its skill" is to embed the phrase — a
 * paid call. Unnecessary here: every alias ALREADY has its own stored vector, and that vector
 * is the best case for its own phrase (cosine 1.0 against itself). Using it as the query is
 * strictly the most favourable input, so a MISS under these conditions is a definitive miss —
 * a real worker's paraphrase can only do worse.
 *
 * That makes this runnable any time, for free, which matters: `config.py` instructs a re-sweep
 * "on any corpus/model change", and the paid sweep is what nobody ran after 2026-07-16.
 *
 *   pnpm db:audit:anchor-path [--domain=<slug>] [--json=<out>]
 */
import { writeFileSync } from "node:fs";

import { sql as dsql } from "drizzle-orm";
import { config } from "dotenv";

import { ratifiedWedgeAliases } from "@badabhai/taxonomy";

import { createDbClient } from "./client";
import { provenance } from "./evidence-provenance";
import { hostClass } from "./ops-guard";
import { deterministicAliasId } from "./skill-alias-id";

config({ path: "../../.env" });
config();

const SCRIPT = "audit:anchor-path";

/** The slug both live call sites default to. Not a guess — see the header. */
const ANCHOR = "cnc-machining";

/**
 * `skill_canonicalize_floor`. Read for reporting; this audit never proposes changing it.
 * A miss at or above it is the dangerous kind: it would be ASSIGNED, not left unresolved.
 */
const FLOOR = 0.75;

function arg(n: string): string | undefined {
  return process.argv.find((x) => x.startsWith(`--${n}=`))?.slice(n.length + 3);
}

export interface AnchorProbe {
  readonly alias: string;
  readonly wanted: string;
  readonly got: string | null;
  readonly score: number | null;
  readonly via: string | null;
  readonly correct: boolean;
  /** A wrong answer at or above the floor — an assignment the worker never earned. */
  readonly misassignedAboveFloor: boolean;
}

async function main(): Promise<void> {
  const url = process.env["DATABASE_URL"];
  if (!url) throw new Error(`[${SCRIPT}] DATABASE_URL is not set`);
  const domain = arg("domain") ?? ANCHOR;
  const wedge = ratifiedWedgeAliases();

  const { db, sql } = createDbClient(url, { max: 1 });
  try {
    await db.execute(dsql`SET SESSION CHARACTERISTICS AS TRANSACTION READ ONLY`);
    const [ro] = (await db.execute(
      dsql`SHOW default_transaction_read_only`,
    )) as unknown as Array<{ default_transaction_read_only: string }>;
    if (ro?.default_transaction_read_only !== "on") {
      throw new Error(`[${SCRIPT}] refusing to run: the session is not read-only`);
    }

    const [pool] = (await db.execute(dsql`
      SELECT count(*) AS n FROM skill_alias sa JOIN skill s ON s.skill_id = sa.skill_id
      WHERE sa.domain_id = ${domain} AND s.status = 'active' AND sa.embedding IS NOT NULL
    `)) as unknown as Array<{ n: string }>;

    console.log(`[${SCRIPT}] READ-ONLY. No embedding call — stored vectors are the queries.`);
    console.log(`  target                 = ${hostClass(url)}`);
    console.log(`  scope (legacy slug)    = ${domain}`);
    console.log(`  candidate pool         = ${pool?.n ?? "?"} rows`);
    console.log(`  floor                  = ${FLOOR}\n`);

    const probes: AnchorProbe[] = [];
    for (const w of wedge) {
      const id = deterministicAliasId(w.skillId, w.alias.text, w.alias.lang);
      // The shipped statement's shape: domain-scoped, active-only, embedded-only, cosine order.
      const top = (await db.execute(dsql`
        WITH q AS (SELECT embedding FROM skill_alias WHERE id = ${id})
        SELECT sa.skill_id, sa.text AS via,
               1 - (sa.embedding <=> (SELECT embedding FROM q)) AS score
        FROM skill_alias sa
        JOIN skill s ON s.skill_id = sa.skill_id
        WHERE sa.domain_id = ${domain}
          AND s.status = 'active'
          AND sa.embedding IS NOT NULL
        ORDER BY sa.embedding <=> (SELECT embedding FROM q)
        LIMIT 1
      `)) as unknown as Array<{ skill_id: string; via: string; score: number }>;

      const t = top[0];
      const correct = t !== undefined && t.skill_id === w.skillId;
      probes.push({
        alias: w.alias.text,
        wanted: w.skillId,
        got: t?.skill_id ?? null,
        score: t?.score ?? null,
        via: t?.via ?? null,
        correct,
        misassignedAboveFloor: !correct && t !== undefined && t.score >= FLOOR,
      });
    }

    for (const p of probes) {
      const flag = p.misassignedAboveFloor ? "   *** ABOVE FLOOR — WOULD BE ASSIGNED ***" : "";
      console.log(
        `  ${p.alias.padEnd(22)} want ${p.wanted.padEnd(28)} got ${String(p.got).padEnd(28)}` +
          ` ${p.score === null ? "  n/a" : p.score.toFixed(4)} via "${String(p.via)}"${flag}`,
      );
    }

    const hits = probes.filter((p) => p.correct).length;
    const bad = probes.filter((p) => p.misassignedAboveFloor);
    const negCeiling = Math.max(...probes.filter((p) => !p.correct).map((p) => p.score ?? 0));

    console.log(`\n  reachable on this scope        = ${hits}/${probes.length}`);
    console.log(`  wrong answers                  = ${probes.length - hits}`);
    console.log(`  …of which ABOVE the floor      = ${bad.length}   <- would be ASSIGNED`);
    console.log(`  anchor-path negative ceiling   = ${negCeiling.toFixed(4)}`);

    if (negCeiling >= FLOOR) {
      console.log(
        `\n  !! The highest WRONG answer (${negCeiling.toFixed(4)}) is at or above the ${FLOOR} floor.\n` +
          `     config.py records the calibration as "ANCHOR-path negative ceiling 0.7263 — 0.75\n` +
          `     clears all three". That is measured against a corpus WITHOUT these aliases, and it\n` +
          `     no longer holds. config.py also says "Re-sweep on any corpus/model change"; the\n` +
          `     corpus changed on 2026-07-16 and the sweep has not been re-run since 2026-07-14.\n` +
          `     This audit does NOT propose moving the floor — the floor is an owner decision.`,
      );
    }

    const out = arg("json");
    if (out !== undefined) {
      writeFileSync(
        out,
        `${JSON.stringify(
          {
            kind: "anchor-path-retrieval",
            ...provenance({
              source: "pnpm db:audit:anchor-path",
              target: hostClass(url),
              readOnly: true,
              populationPredicate: `ratifiedWedgeAliases() scored against skill_alias WHERE domain_id = '${domain}'`,
            }),
            scope: domain,
            floor: FLOOR,
            candidate_pool: Number(pool?.n ?? 0),
            reachable: hits,
            total: probes.length,
            misassigned_above_floor: bad.length,
            anchor_path_negative_ceiling: Number(negCeiling.toFixed(4)),
            probes,
          },
          null,
          2,
        )}\n`,
        "utf8",
      );
      console.log(`\n  written to ${out}`);
    }
  } finally {
    await sql.end();
  }
}

if (require.main === module) {
  main().catch((e: unknown) => {
    console.error(e instanceof Error ? e.message : e);
    process.exit(1);
  });
}
