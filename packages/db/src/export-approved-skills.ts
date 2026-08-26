/**
 * `pnpm db:export:approved-skills` — approved candidates -> a gated corpus batch. READ-ONLY, ₹0.
 *
 *   pnpm db:export:approved-skills --run <run_id>              # from the database
 *   pnpm db:export:approved-skills --from-file <candidates.jsonl>
 *   pnpm db:export:approved-skills --run <id> --out <dir>
 *
 * ===========================================================================
 * THERE IS NO `--apply`, AND THERE IS NOT GOING TO BE ONE
 * ===========================================================================
 * This runner reads decisions and writes FILES. The accepted file it produces is the input to
 * `db:seed:domain-skills`, and between the two sits a HUMAN COMMIT — the review gate that has
 * worked in this repository since `generate-domain-skills.ts`, and the reason `git blame`
 * carries the signature on every taxonomy row forever after.
 *
 * Giving this runner an `--apply` would collapse "an admin approved a candidate" into "a skill
 * exists", and those are different claims with different evidence behind them. The admin
 * decided about a PHRASE; the corpus gates decide whether the resulting record is structurally
 * valid and semantically sound; the seeder decides nothing and only writes. Merging the three
 * would mean an approval in a web form could mint an immutable, never-reused `skill_id` with no
 * diff anyone reviewed.
 *
 * ===========================================================================
 * BOTH GATES RUN, AND A BLOCK IS A NORMAL OUTCOME
 * ===========================================================================
 *   1. `validateTaxonomyCorpus`  STRUCTURAL — well-formed ids, no alias owned twice, no label
 *                                that collides with a shipped one, no forbidden characters.
 *   2. `taxonomyQualityVerdict`  SEMANTIC — two approvals that mean the same thing, a concept
 *                                fragmented across trades, a seniority rung wearing a skill's
 *                                clothes. A batch can pass gate 1 completely and fail gate 2.
 *
 * On BLOCK the accepted file is not written and any stale one is REMOVED, exactly as the
 * taxonomy ingest does — an operator must never find `accepted-skills.jsonl` sitting where the
 * instructions say to look, with nothing indicating it is superseded by a failure.
 *
 * ===========================================================================
 * WHY IT READS FROM A FILE AS WELL AS THE DATABASE
 * ===========================================================================
 * Migration 0093 is authored and NOT applied. `--from-file` takes the `candidates.jsonl` a
 * discovery run already writes, so the whole approval path — convert, gate, refuse, report —
 * is exercisable and testable today, before any DDL. It is not a workaround kept around for
 * convenience: a reviewer working from a committed artifact is a legitimate mode, and it is the
 * one the Phase-5 dry run uses.
 *
 * PRIVACY: alias text only, from candidates whose worker-derived sources were pseudonymized
 * upstream and stripped of digits/'@'/URLs by the classifier before they became sources.
 */
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import { config } from "dotenv";
import { sql as dsql } from "drizzle-orm";

import { createDbClient } from "./client";
import { provenance } from "./evidence-provenance";
import { enforceOpsGuard, hostClass } from "./ops-guard";
import {
  applicableConvergenceGroups,
  exportApprovedCandidates,
  toCorpus,
  type ExportedBatch,
} from "./skill-discovery-export";
import { analyzeTaxonomyQuality, taxonomyQualityVerdict } from "./taxonomy-quality-gate";
import { validateTaxonomyCorpus } from "./taxonomy-corpus";
import type { SkillCandidateRecord } from "./skill-discovery-candidate";

config({ path: "../../.env" });
config();

const SCRIPT = "export:approved-skills";

function arg(name: string): string | undefined {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  if (hit !== undefined) return hit.slice(name.length + 3);
  const idx = process.argv.indexOf(`--${name}`);
  const next = idx >= 0 ? process.argv[idx + 1] : undefined;
  return next !== undefined && !next.startsWith("--") ? next : undefined;
}

function write(path: string, body: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, body, "utf8");
}

/**
 * Read reviewed candidates for one run from the database.
 *
 * SELECTS EVERY REVIEWED STATUS, not just the approvals — see `exportApprovedCandidates`, which
 * needs the rejected and deferred counts to report what a reviewer actually did.
 */
const CANDIDATES_SQL = (runId: string) => dsql`
  SELECT c.candidate_id::text AS candidate_id, c.run_id, c.cluster_key, c.normalized_phrase,
         c.proposed_skill_name, c.proposed_description, c.phrase_class, c.classifier_rule,
         c.occupation_heads, c.evidence_tokens, c.trade_family,
         c.source_alias_count, c.source_domain_count, c.proposed_action, c.confidence_band,
         c.confidence, c.status, c.reviewer_admin_id::text AS reviewer_admin_id,
         c.reviewed_at, c.review_reason, c.resulting_skill_id, c.embedding_status,
         c.model, c.prompt_version, c.corpus_fingerprint, c.provenance_digest, c.created_at,
         coalesce(
           (SELECT json_agg(json_build_object(
              'source_type', s.source_type, 'source_id', s.source_id,
              'original_text', s.original_text, 'normalized_text', s.normalized_text,
              'job_domain_id', s.job_domain_id))
            FROM skill_candidate_source s WHERE s.candidate_id = c.candidate_id), '[]') AS sources,
         coalesce(
           (SELECT json_agg(json_build_object(
              'skill_id', m.skill_id, 'relation', m.relation, 'score', m.score,
              'strength', m.strength, 'rank', m.rank, 'evidence_detail', m.evidence_detail)
              ORDER BY m.rank)
            FROM skill_candidate_match m WHERE m.candidate_id = c.candidate_id), '[]') AS matches
    FROM skill_candidate c
   WHERE c.run_id = ${runId}
     AND c.status IN ('approved_create', 'approved_map', 'approved_merge', 'rejected', 'deferred')`;

function readFromFile(path: string): SkillCandidateRecord[] {
  return readFileSync(path, "utf8")
    .split("\n")
    .filter((l) => l.trim() !== "")
    .map((l) => JSON.parse(l) as SkillCandidateRecord);
}

async function main(): Promise<void> {
  const fromFile = arg("from-file");
  const runId = arg("run");
  const outDir = arg("out") ?? join(".scratch", "approved-exports");

  if (fromFile === undefined && runId === undefined) {
    throw new Error(
      `[${SCRIPT}] one of --run <run_id> or --from-file <candidates.jsonl> is required. ` +
        "There is no default scope: exporting 'whatever is approved' across every run would " +
        "mix decisions taken against different corpus fingerprints into one batch.",
    );
  }

  const startedAt = new Date();
  let candidates: SkillCandidateRecord[];
  let target = "repository-only (no database)";
  let role: string | null = null;
  let bypassRls: boolean | undefined;

  if (fromFile !== undefined) {
    if (!existsSync(fromFile)) throw new Error(`[${SCRIPT}] ${fromFile} does not exist`);
    candidates = readFromFile(fromFile);
  } else {
    // mutating:false — this runner has no write path. The guard still runs: a READ of an
    // unidentified database is still a read of an unknown blast radius.
    const guard = enforceOpsGuard({
      script: SCRIPT,
      connectionString: process.env.DATABASE_URL,
      mutating: false,
    });
    const { db, sql } = createDbClient(guard.connectionString, { max: 2 });
    try {
      const identity = ((await db.execute(
        dsql`SELECT current_user, (SELECT rolbypassrls FROM pg_roles WHERE rolname = current_user) AS bypassrls`,
      )) as unknown as { current_user: string; bypassrls: boolean }[])[0];
      role = identity?.current_user ?? "(unknown)";
      bypassRls = identity?.bypassrls ?? false;
      target = hostClass(guard.connectionString);
      candidates = (await db.execute(
        CANDIDATES_SQL(runId as string),
      )) as unknown as SkillCandidateRecord[];
    } finally {
      await sql.end();
    }
  }

  const batch = exportApprovedCandidates(candidates);
  const corpus = toCorpus(batch);

  // GATE 1 — STRUCTURAL. `existingSkillIds` is left at its default (`SKILL_CORPUS`), so an
  // approval whose minted id collides with a shipped one is refused HERE rather than at seed
  // time. `domains: []` is correct and not a shortcut: this batch carries no edges by design
  // (see `toCorpus`), so there is no `EDGE_UNKNOWN_DOMAIN` check to disable.
  const structural = validateTaxonomyCorpus(corpus.skills, corpus.edges, { domains: corpus.domains });

  // GATE 2 — SEMANTIC. The validator's output is PASSED IN rather than recomputed, so the gate
  // reasons about exactly the problem set printed below. No attribution scope: every record in
  // this batch is accountable, which is the stricter posture `seed-domain-skills.ts` also takes.
  // Convergence groups are SCOPED to the ones this batch can honestly be asked about, and the
  // skipped ones are named in the manifest. See `applicableConvergenceGroups` for why the two
  // obvious alternatives (disable the check, or pad the corpus) are both worse.
  const convergence = applicableConvergenceGroups(corpus);
  const quality = analyzeTaxonomyQuality(corpus.skills, corpus.edges, {
    domains: corpus.domains,
    problems: structural,
    groups: convergence.applied,
  });
  const verdict = taxonomyQualityVerdict(quality);

  const blocked = structural.length > 0 || verdict.verdict === "BLOCK";

  const runDir = join(outDir, runId ?? "from-file");
  const acceptedPath = join(runDir, "accepted-skills.jsonl");
  const blockedPath = join(runDir, "blocked-skills.jsonl");

  if (blocked) {
    // A prior PASSING run's artifact must not survive a subsequent BLOCK. Leaving it is the
    // worst outcome available: the operator finds `accepted-skills.jsonl` exactly where the
    // instructions say to look, with nothing indicating it is stale.
    rmSync(acceptedPath, { force: true });
  }

  const lines = batch.skills.map((s) => JSON.stringify(s)).join("\n");
  write(blocked ? blockedPath : acceptedPath, lines === "" ? "" : `${lines}\n`);

  const manifest = {
    provenance: provenance({
      source: `pnpm db:export:approved-skills ${runId !== undefined ? `--run ${runId}` : `--from-file ${fromFile ?? ""}`}`,
      target,
      readOnly: true,
      role,
      ...(bypassRls !== undefined ? { bypassRls } : {}),
      populationPredicate:
        "skill_candidate WHERE run_id = $1 AND status IN (approved_create, approved_map, approved_merge, rejected, deferred)",
      measuredAt: startedAt,
    }),
    run_id: runId ?? null,
    from_file: fromFile ?? null,
    verdict: blocked ? "BLOCK" : "PASS",
    counts: batch.counts,
    structural_problems: structural,
    quality_verdict: verdict,
    // The narrowing, stated. A convergence group whose trades are not in this batch cannot be
    // asked about; recording which ones were skipped is what stops a green run from implying
    // they passed.
    convergence_groups_applied: convergence.applied.map((g) => g.group),
    convergence_groups_skipped: convergence.skipped,
    convergence_skip_reason:
      convergence.skipped.length === 0
        ? null
        : "the group names job domains this batch does not touch, so every concept in it could " +
          "only ever report ABSENT (CONVERGENCE_GROUP_UNKNOWN_DOMAIN)",
    refusals: batch.refusals,
    // THE AUDIT LINK, and the reason this file exists rather than just the jsonl: it is what
    // answers "which admin decision, in which run, produced this skill_id" after the accepted
    // file has been committed and the candidate rows have moved on.
    provenance_map: batch.provenance,
  };
  write(join(runDir, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);

  print(batch, structural, verdict, blocked, runDir);
  if (blocked) process.exitCode = 1;
}

function print(
  batch: ExportedBatch,
  structural: readonly string[],
  verdict: ReturnType<typeof taxonomyQualityVerdict>,
  blocked: boolean,
  runDir: string,
): void {
  const c = batch.counts;
  console.log("");
  console.log(`  ${"=".repeat(76)}`);
  console.log(`  APPROVED-CANDIDATE EXPORT — ${blocked ? "BLOCK" : "PASS"}`);
  console.log(`  ${"=".repeat(76)}`);
  console.log("");
  console.log(`  DECISIONS READ`);
  console.log(`    approved_create               ${c.approved_create}`);
  console.log(`    approved_map                  ${c.approved_map}`);
  console.log(`    approved_merge                ${c.approved_merge}   (produces no corpus record — see the module header)`);
  console.log(`    rejected                      ${c.rejected}`);
  console.log(`    deferred                      ${c.deferred}`);
  console.log("");
  console.log(`  CORPUS RECORDS PRODUCED`);
  console.log(`    new canonical skills          ${c.exported_skills}`);
  console.log(`    alias records                 ${c.exported_aliases}`);
  console.log(`    refused before the gates      ${c.refused}`);
  for (const r of batch.refusals.slice(0, 10)) {
    console.log(`      ${r.cluster_key}: ${r.code}`);
  }
  console.log("");
  console.log(`  GATES`);
  console.log(`    structural problems           ${structural.length}`);
  for (const p of structural.slice(0, 10)) console.log(`      ${p}`);
  console.log(`    quality verdict               ${verdict.verdict}`);
  console.log("");
  console.log(`  ARTIFACTS -> ${runDir}`);
  console.log(`    ${blocked ? "blocked-skills.jsonl" : "accepted-skills.jsonl"}  manifest.json`);
  console.log("");
  if (blocked) {
    console.log(`  BLOCKED. Nothing to commit. Fix the findings above and re-run.`);
  } else {
    console.log(`  NEXT: review the diff, COMMIT accepted-skills.jsonl into data/taxonomy/,`);
    console.log(`        then pnpm db:seed:domain-skills (dry run first). This runner wrote`);
    console.log(`        nothing to the database and never will.`);
  }
  console.log("");
}

if (require.main === module) {
  main().catch((e: unknown) => {
    console.error(e instanceof Error ? e.message : e);
    process.exit(1);
  });
}
