/**
 * OIE O2 — what FRACTION of the canonicalizing path actually gets a canonical (Path A) scope.
 *
 *   pnpm db:report:oie-canonicalize-coverage            # report
 *   pnpm db:report:oie-canonicalize-coverage --json=<p> # + an evidence record
 *
 * ===========================================================================
 * WHY THIS RUNNER IS PART OF O2 RATHER THAN A NICE-TO-HAVE
 * ===========================================================================
 * O2 was chosen over the complete fix (O1) for exactly one reason: **its incompleteness is
 * measurable rather than assumed**. Without a way to read the fraction, "O2 covers some of the
 * traffic" is a sentence nobody can act on, and the decision that follows it — *is O1 urgent?* —
 * has no input. This is that input.
 *
 * ===========================================================================
 * THE STRUCTURE IT MEASURES
 * ===========================================================================
 * `/profile/extract` is the only route that canonicalizes, and the processor calls it from one
 * branch: `answerMap.length === 0`. The OIE branch calls `/profile/parse`, which invents no
 * canonical ids on purpose. So:
 *
 *   answer map EMPTY   -> canonicalizes. Gets a Path A scope IFF it also carries a matched,
 *                         still-selectable occupation pin.  <-- the fraction
 *   answer map PRESENT -> does not canonicalize at all, pin or no pin. O1's territory.
 *
 * The denominator is therefore sessions on the FIRST line, not all sessions — reporting
 * coverage over every session would understate O2 by counting rows it was never about.
 *
 * ===========================================================================
 * READ-ONLY
 * ===========================================================================
 * SELECTs only. No transaction, no temporary row, no flag read, nothing written. Safe to point
 * at production, which is the only place the answer exists.
 *
 * IT REPORTS WHAT IT CANNOT SEE. An extraction can be triggered with `sessionId === null` (the
 * app's "make the profile anyway" escape hatch); those reach the same branch and carry no state
 * at all, so they can never be scoped and are invisible to a `chat_sessions` query. The count of
 * `ai_jobs` with no session is reported beside the fraction rather than left out of it — a
 * denominator that silently omits a population is how a partial measure gets quoted as a total.
 */
import { config } from "dotenv";
import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { createDbClient } from "./client";
import { hostClass } from "./audit-embedding-provenance";

config({ path: join("..", "..", ".env") });

const SCRIPT = "report:oie-canonicalize-coverage";

/**
 * The pin statuses that scope canonicalization — the SAME four
 * `profile-extraction.processor.ts` enumerates in `OCCUPATION_MATCHED_STATUSES`.
 *
 * Duplicated across the package boundary rather than imported, because `packages/db` must not
 * depend on `apps/api`. `oie-canonicalize-coverage.test.ts` pins this list against the contract
 * enum in `@badabhai/ai-contracts`, which BOTH sides derive from, so the two cannot drift
 * silently — a new status fails the test on this side too.
 */
export const SCOPING_PIN_STATUSES: readonly string[] = [
  "matched_auto",
  "matched_lexical",
  "matched_llm",
  "matched_worker_confirmed",
];

export interface CoverageRow {
  /** Sessions whose extraction would take the canonicalizing (legacy) branch. */
  readonly canonicalizing: number;
  /** Of those, sessions carrying a pin at all — matched or not. */
  readonly withAnyPin: number;
  /** Of those, a pin with a MATCHED status. */
  readonly withMatchedPin: number;
  /** Of those, a matched pin whose domain is still `selectable` and `active`. */
  readonly scoped: number;
  /** Sessions that take the OIE branch, which does not canonicalize at all. */
  readonly notCanonicalizing: number;
  /** Extraction jobs with no session — same branch, no state, never scopable. */
  readonly sessionlessJobs: number;
}

/**
 * The measured fraction, plus the two ways it can mislead.
 *
 * `ofCanonicalizing` is O2's own coverage: of the extractions that DO canonicalize, how many get
 * Path A. `ofAll` is the whole-population number, and it is the one to quote when asking whether
 * O1 is urgent — because O1's entire value is the branch `ofCanonicalizing` excludes.
 */
export function fractions(r: CoverageRow): {
  ofCanonicalizing: number | null;
  ofAll: number | null;
  lostToTheOtherBranch: number;
  lostToNoPin: number;
  lostToAnUnmatchedPin: number;
  lostToADeadDomain: number;
} {
  const all = r.canonicalizing + r.notCanonicalizing + r.sessionlessJobs;
  return {
    ofCanonicalizing: r.canonicalizing === 0 ? null : r.scoped / r.canonicalizing,
    ofAll: all === 0 ? null : r.scoped / all,
    lostToTheOtherBranch: r.notCanonicalizing,
    lostToNoPin: r.canonicalizing - r.withAnyPin,
    lostToAnUnmatchedPin: r.withAnyPin - r.withMatchedPin,
    lostToADeadDomain: r.withMatchedPin - r.scoped,
  };
}

/** `n/d` as a percentage string, or the honest `n/a` when there is no denominator. */
export function pct(v: number | null): string {
  return v === null ? "n/a (no rows)" : `${(v * 100).toFixed(2)}%`;
}

/**
 * The four nested counts, in ONE query, so they describe the same instant.
 *
 * `answer_map` absent, null, or `[]` all mean "no deterministic record" to the processor
 * (`narrowAnswerRecords` of a non-array yields an empty list), so the predicate has to accept
 * all three shapes rather than only the one the current writer happens to emit.
 */
export const COVERAGE_SQL = `
WITH s AS (
  SELECT
    COALESCE(jsonb_typeof(cs.conversation_state -> 'answer_map') = 'array'
             AND jsonb_array_length(cs.conversation_state -> 'answer_map') > 0, false) AS has_answers,
    cs.conversation_state -> 'occupation'                     AS pin,
    cs.conversation_state #>> '{occupation,match_status}'     AS pin_status,
    cs.conversation_state #>> '{occupation,job_domain_id}'    AS pin_domain
  FROM chat_sessions cs
)
SELECT
  count(*) FILTER (WHERE NOT has_answers)::int AS canonicalizing,
  count(*) FILTER (WHERE NOT has_answers AND jsonb_typeof(pin) = 'object')::int AS with_any_pin,
  count(*) FILTER (WHERE NOT has_answers AND pin_status = ANY($1::text[]))::int AS with_matched_pin,
  count(*) FILTER (
    WHERE NOT has_answers
      AND pin_status = ANY($1::text[])
      AND EXISTS (SELECT 1 FROM job_domain d
                  WHERE d.job_domain_id = pin_domain AND d.selectable = true AND d.status = 'active')
  )::int AS scoped,
  count(*) FILTER (WHERE has_answers)::int AS not_canonicalizing
FROM s`;

/**
 * Extraction jobs with no session at all — the population `chat_sessions` cannot show.
 *
 * `ai_jobs` has no `session_id` COLUMN; the id lives in `input_ref->>'session_id'`, which is
 * where `findActiveExtractionForSession` reads it and what `ai_jobs_extraction_session_idx`
 * indexes. A missing KEY and a JSON `null` are both "no session" to the processor, so both are
 * counted.
 */
export const SESSIONLESS_SQL = `
SELECT count(*)::int AS n
FROM ai_jobs
WHERE job_type = 'profile_extraction' AND (input_ref ->> 'session_id') IS NULL`;

export function render(r: CoverageRow): string[] {
  const f = fractions(r);
  return [
    `[${SCRIPT}] READ-ONLY — SELECTs only, nothing written.`,
    "",
    "  Sessions, by which branch their extraction takes:",
    `    canonicalizing (empty answer map)   ${r.canonicalizing}`,
    `    NOT canonicalizing (OIE branch)     ${r.notCanonicalizing}`,
    `    extraction jobs with NO session     ${r.sessionlessJobs}  (same branch, no state to scope from)`,
    "",
    "  Of the canonicalizing sessions:",
    `    carry a pin object                  ${r.withAnyPin}`,
    `    ...whose status is MATCHED          ${r.withMatchedPin}`,
    `    ...whose domain is still selectable ${r.scoped}   <- O2 scopes these to Path A`,
    "",
    `  O2 coverage of the canonicalizing path : ${pct(f.ofCanonicalizing)}`,
    `  O2 coverage of ALL extractions         : ${pct(f.ofAll)}`,
    "",
    "  Where the rest goes — this is the input to 'is O1 urgent?':",
    `    to the OIE branch, which never canonicalizes  ${f.lostToTheOtherBranch}   <- ONLY O1 reaches these`,
    `    no session at all                             ${r.sessionlessJobs}   <- no fix reaches these`,
    `    no pin on the session                         ${f.lostToNoPin}`,
    `    a pin, but an unmatched one                   ${f.lostToAnUnmatchedPin}`,
    `    a matched pin on a dead domain                ${f.lostToADeadDomain}`,
    "",
    "  Note: this measures whether a canonical SCOPE is sent, not whether canonicalization ran.",
    "  The pass itself is behind SKILL_CANONICALIZE_ENABLED, which is off by default.",
  ];
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const jsonArg = argv.find((a) => a.startsWith("--json="));
  const url = process.env["DATABASE_URL"];
  if (!url) throw new Error(`[${SCRIPT}] DATABASE_URL is not set`);

  const { sql } = createDbClient(url, { max: 1 });
  try {
    const [c] = (await sql.unsafe(COVERAGE_SQL, [SCOPING_PIN_STATUSES as string[]])) as unknown as {
      canonicalizing: number;
      with_any_pin: number;
      with_matched_pin: number;
      scoped: number;
      not_canonicalizing: number;
    }[];
    const [s] = (await sql.unsafe(SESSIONLESS_SQL)) as unknown as { n: number }[];
    if (c === undefined || s === undefined) throw new Error(`[${SCRIPT}] no rows returned`);

    const row: CoverageRow = {
      canonicalizing: c.canonicalizing,
      withAnyPin: c.with_any_pin,
      withMatchedPin: c.with_matched_pin,
      scoped: c.scoped,
      notCanonicalizing: c.not_canonicalizing,
      sessionlessJobs: s.n,
    };
    for (const line of render(row)) console.log(line);

    if (jsonArg) {
      const path = jsonArg.slice("--json=".length);
      if (existsSync(path)) {
        // Same rule as every other evidence artifact here: a measurement is never overwritten.
        console.error(`  refusing to overwrite ${path} — evidence is never replaced.`);
        process.exit(1);
      }
      writeFileSync(
        path,
        `${JSON.stringify(
          { kind: "oie-canonicalize-coverage", target: hostClass(url), counts: row, fractions: fractions(row) },
          null,
          2,
        )}\n`,
        "utf8",
      );
      console.log(`  evidence written to ${path}`);
    }
  } finally {
    await sql.end();
  }
}

if (require.main === module) {
  main().catch((e: unknown) => {
    const err = e as { message?: string; cause?: { message?: string } };
    console.error(err?.message ?? String(e));
    if (err?.cause?.message) console.error(`  cause: ${err.cause.message}`);
    process.exit(1);
  });
}
