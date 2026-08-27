/**
 * `pnpm db:persist:discovery-run` — write a dry run's candidates into the staging tables.
 *
 *   pnpm db:persist:discovery-run --dir <run-dir>                    # PLAN. Default. Writes nothing.
 *   pnpm db:persist:discovery-run --dir <run-dir> --apply \
 *        --i-am-authorised-to-write-to-production                    # writes (guarded)
 *
 * ===========================================================================
 * WHY PERSISTING IS A SEPARATE RUNNER FROM DISCOVERING
 * ===========================================================================
 * `db:discover:skills` has no write path at all, and a guardrail test asserts that against its
 * own source. That property is worth keeping: it means the measurement that answers "how big is
 * this problem?" can be run today, repeatedly, by anyone, against production, with no
 * possibility of changing it.
 *
 * Folding the write into it would cost exactly that. A runner that USUALLY does not write is a
 * different thing from a runner that CANNOT — the first one needs its flags audited every time
 * somebody reads it, and the second one does not. So the two are separate binaries reading the
 * same committed artifact, and this one is the only one with an `--apply`.
 *
 * ===========================================================================
 * IT WRITES ONLY TO THE STAGING TABLES, AND ONLY `pending` / `needs_review`
 * ===========================================================================
 * Four tables, all introduced empty by migration 0093: `skill_discovery_run`,
 * `skill_candidate`, `skill_candidate_source`, `skill_candidate_match`. It touches `skill`,
 * `skill_alias` and `job_domain_skill` NOT AT ALL — there is no statement naming them, and the
 * guardrail test checks that.
 *
 * `assertDryRunSafe` runs on the whole set before a transaction is opened, so a candidate
 * carrying a human-decided status refuses the entire run rather than being filtered out. A file
 * that somehow contains an approval has a bug whose blast radius is the production taxonomy, and
 * writing the other 6,672 rows would hide it.
 *
 * ===========================================================================
 * IDEMPOTENT ON THE NATURAL KEYS, AND IT WILL NOT OVERWRITE A DECISION
 * ===========================================================================
 *   `skill_discovery_run`     ON CONFLICT (run_id) DO UPDATE — counts and status only.
 *   `skill_candidate`         ON CONFLICT (run_id, cluster_key) DO UPDATE, and the SET clause
 *                             is guarded `WHERE skill_candidate.status IN ('pending',
 *                             'needs_review')`. Re-running a persist after a reviewer has
 *                             decided must not silently revert their decision to `pending`, and
 *                             that guard is the difference between an idempotent writer and a
 *                             destructive one.
 *   `skill_candidate_source`  ON CONFLICT (candidate_id, source_type, source_id) DO NOTHING.
 *   `skill_candidate_match`   ON CONFLICT (candidate_id, skill_id) DO UPDATE — the evidence a
 *                             re-run recomputed, which is safe because it is not a decision.
 *
 * A re-run therefore reports zero changes rather than rewriting every row with a fresh
 * `updated_at` — the same IS DISTINCT FROM discipline `seed-job-domains.ts` uses.
 *
 * ===========================================================================
 * FRESHNESS IS CHECKED, NOT ASSUMED
 * ===========================================================================
 * The run's `input_fingerprint` is recomputed from the LIVE corpus and compared. A file measured
 * against a corpus that has since moved describes a world that no longer exists, and persisting
 * it would put stale candidates in front of a reviewer with nothing saying so. `--allow-stale`
 * exists for the deliberate case (re-persisting a historical run for audit) and says so in the
 * output.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { config } from "dotenv";
import { sql as dsql } from "drizzle-orm";

import { createDbClient } from "./client";
import { CORPUS_FINGERPRINT_SQL, toFingerprint } from "./corpus-fingerprint";
import { enforceOpsGuard, hostClass } from "./ops-guard";
import { assertDryRunSafe, validateCandidate } from "./skill-discovery-candidate";
import { deriveOccupationHeads } from "./skill-discovery-heads";
import { discoveryInputFingerprint } from "./skill-discovery-run";
import type { SkillCandidateRecord } from "./skill-discovery-candidate";

config({ path: "../../.env" });
config();

const SCRIPT = "persist:discovery-run";

function arg(name: string): string | undefined {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  if (hit !== undefined) return hit.slice(name.length + 3);
  const idx = process.argv.indexOf(`--${name}`);
  const next = idx >= 0 ? process.argv[idx + 1] : undefined;
  return next !== undefined && !next.startsWith("--") ? next : undefined;
}
function flag(name: string): boolean {
  return process.argv.includes(`--${name}`);
}

/** The shape `discover-skills.ts` writes. Only the fields this runner needs are declared. */
interface DiscoveryReport {
  readonly run: {
    readonly run_id: string;
    readonly input_fingerprint: string;
    readonly config: Record<string, unknown>;
    readonly model: string | null;
    readonly prompt_version: string | null;
    readonly embedding_model: string | null;
    readonly started_at: string;
    readonly completed_at: string;
  };
  readonly census: {
    readonly source_rows: number;
    readonly normalized_unique: number;
    readonly candidates: number;
    readonly clusters: number;
  };
}

async function main(): Promise<void> {
  const dir = arg("dir");
  if (dir === undefined) {
    throw new Error(
      `[${SCRIPT}] --dir <run-dir> is required. It is the directory ` +
        "`db:discover:skills` wrote (report.json + candidates.jsonl); there is no default, " +
        "because persisting 'the latest run' is how the wrong run reaches a reviewer.",
    );
  }
  const apply = flag("apply");
  const allowStale = flag("allow-stale");

  const reportPath = join(dir, "report.json");
  const candidatesPath = join(dir, "candidates.jsonl");
  for (const p of [reportPath, candidatesPath]) {
    if (!existsSync(p)) throw new Error(`[${SCRIPT}] ${p} does not exist`);
  }

  const report = JSON.parse(readFileSync(reportPath, "utf8")) as DiscoveryReport;
  const candidates: SkillCandidateRecord[] = readFileSync(candidatesPath, "utf8")
    .split("\n")
    .filter((l) => l.trim() !== "")
    .map((l) => JSON.parse(l) as SkillCandidateRecord);

  // ── refuse a bad file BEFORE a connection is opened ───────────────────────
  //
  // Both checks are hard refusals rather than filters. A file that violates its own contract is
  // not partially usable, and writing the good rows would turn a loud bug into a quiet one.
  assertDryRunSafe(candidates);
  const problems = candidates.flatMap((c) => validateCandidate(c));
  if (problems.length > 0) {
    const sample = problems.slice(0, 8).map((p) => `${p.code} — ${p.detail}`).join("\n  ");
    throw new Error(
      `[${SCRIPT}] ${problems.length} candidate validation problem(s) in ${candidatesPath}. ` +
        `Refusing the whole file.\n  ${sample}`,
    );
  }

  const guard = enforceOpsGuard({
    script: SCRIPT,
    connectionString: process.env.DATABASE_URL,
    mutating: apply,
  });
  const { db, sql } = createDbClient(guard.connectionString, { max: 4 });

  try {
    // ── freshness ─────────────────────────────────────────────────────────
    const occupationTexts = (await db.execute(dsql`
      SELECT d.label_en AS text FROM job_domain d WHERE d.selectable AND d.status = 'active'
      UNION ALL
      SELECT a.text FROM job_domain_alias a
        JOIN job_domain d ON d.job_domain_id = a.job_domain_id
       WHERE d.selectable AND d.status = 'active'`)) as unknown as { text: string }[];
    const lexicon = deriveOccupationHeads(occupationTexts.map((r) => r.text));
    const [rawCorpus] = (await db.execute(CORPUS_FINGERPRINT_SQL)) as unknown as Record<
      string,
      unknown
    >[];
    const live = discoveryInputFingerprint(
      toFingerprint(rawCorpus as Record<string, unknown>),
      lexicon,
      report.run.config,
    );
    const fresh = live === report.run.input_fingerprint;

    console.log("");
    console.log(`  ${"=".repeat(76)}`);
    console.log(`  PERSIST DISCOVERY RUN — ${apply ? "APPLY" : "PLAN (writes nothing)"}`);
    console.log(`  ${"=".repeat(76)}`);
    console.log("");
    console.log(`  target                        ${hostClass(guard.connectionString)}`);
    console.log(`  run_id                        ${report.run.run_id}`);
    console.log(`  candidates in file            ${candidates.length}`);
    console.log(`  fingerprint (file)            ${report.run.input_fingerprint}`);
    console.log(`  fingerprint (live corpus)     ${live}`);
    console.log(`  fresh                         ${fresh ? "yes" : "NO — the corpus has moved"}`);

    if (!fresh && !allowStale) {
      throw new Error(
        `[${SCRIPT}] REFUSING: this run was measured against a different corpus. Persisting it ` +
          "would put candidates in front of a reviewer that describe a state that no longer " +
          "exists, with nothing on the row saying so. Re-run db:discover:skills, or pass " +
          "--allow-stale if you are deliberately re-persisting a historical run for audit.",
      );
    }

    // ── does the target even exist? ───────────────────────────────────────
    const presence = ((await db.execute(dsql`
      SELECT count(*)::int AS present FROM information_schema.tables
       WHERE table_schema = 'public'
         AND table_name IN ('skill_discovery_run','skill_candidate','skill_candidate_source','skill_candidate_match')`)) as unknown as {
      present: number;
    }[])[0];
    // Fails CLOSED on an unreadable count: 0 of 4 stops the run rather than proceeding.
    const present = presence?.present ?? 0;
    console.log(`  staging tables present        ${present} of 4`);
    if (present < 4) {
      console.log("");
      console.log(`  MIGRATION 0093 IS NOT APPLIED to this database. Nothing can be persisted`);
      console.log(`  until it is, and applying production DDL is an owner decision. This run`);
      console.log(`  stops here having written nothing.`);
      console.log("");
      process.exitCode = 1;
      return;
    }

    // ── existing state, so the plan can say what would CHANGE ────────────
    const state = ((await db.execute(dsql`
      SELECT count(*)::int AS existing,
             count(*) FILTER (WHERE status NOT IN ('pending','needs_review'))::int AS decided
        FROM skill_candidate WHERE run_id = ${report.run.run_id}`)) as unknown as {
      existing: number;
      decided: number;
    }[])[0];
    const existing = state?.existing ?? 0;
    const decided = state?.decided ?? 0;
    console.log(`  already persisted for this run ${existing}  (of which decided: ${decided})`);
    if (decided > 0) {
      console.log("");
      console.log(`  ${decided} candidate(s) in this run already carry a HUMAN DECISION. The`);
      console.log(`  upsert below is guarded to leave them untouched — a persist must never`);
      console.log(`  revert a reviewer's decision to 'pending'.`);
    }

    if (!apply) {
      console.log("");
      console.log(`  PLAN ONLY. Re-run with --apply (plus the production-write flag) to write.`);
      console.log(`  Would insert/update: 1 run, ${candidates.length} candidates,`);
      console.log(
        `                       ${candidates.reduce((n, c) => n + c.sources.length, 0)} sources, ` +
          `${candidates.reduce((n, c) => n + c.matches.length, 0)} matches.`,
      );
      console.log("");
      return;
    }

    // ── the write, in ONE transaction ─────────────────────────────────────
    //
    // One transaction for the whole run: a half-persisted run is a state nobody described, and
    // a reviewer opening a queue mid-write would see a partial cluster set with no way to know
    // it was partial.
    await db.transaction(async (tx) => {
      await tx.execute(dsql`
        INSERT INTO skill_discovery_run (
          run_id, status, input_fingerprint, config_json, source_count, normalized_count,
          candidate_count, cluster_count, error_count, model, prompt_version, embedding_model,
          started_at, completed_at)
        VALUES (
          ${report.run.run_id}, 'completed', ${report.run.input_fingerprint},
          ${JSON.stringify(report.run.config)}, ${report.census.source_rows},
          ${report.census.normalized_unique}, ${report.census.candidates},
          ${report.census.clusters}, 0, ${report.run.model}, ${report.run.prompt_version},
          ${report.run.embedding_model}, ${report.run.started_at}, ${report.run.completed_at})
        ON CONFLICT (run_id) DO UPDATE SET
          status = 'completed',
          candidate_count = excluded.candidate_count,
          cluster_count = excluded.cluster_count,
          completed_at = excluded.completed_at`);

      for (const c of candidates) {
        await tx.execute(dsql`
          INSERT INTO skill_candidate (
            candidate_id, run_id, cluster_key, normalized_phrase, proposed_skill_name,
            proposed_description, phrase_class, classifier_rule, occupation_heads,
            evidence_tokens, trade_family, source_alias_count, source_domain_count,
            proposed_action, confidence_band, confidence, status, embedding_status,
            model, prompt_version, corpus_fingerprint, provenance_digest, created_at)
          VALUES (
            ${c.candidate_id}::uuid, ${c.run_id}, ${c.cluster_key}, ${c.normalized_phrase},
            ${c.proposed_skill_name}, ${c.proposed_description}, ${c.phrase_class},
            ${c.classifier_rule}, ${[...c.occupation_heads]}, ${[...c.evidence_tokens]},
            ${c.trade_family}, ${c.source_alias_count}, ${c.source_domain_count},
            ${c.proposed_action}, ${c.confidence_band}, ${c.confidence}, ${c.status},
            ${c.embedding_status}, ${c.model}, ${c.prompt_version}, ${c.corpus_fingerprint},
            ${c.provenance_digest}, ${c.created_at})
          ON CONFLICT (run_id, cluster_key) DO UPDATE SET
            proposed_action = excluded.proposed_action,
            confidence_band = excluded.confidence_band,
            confidence = excluded.confidence,
            source_alias_count = excluded.source_alias_count,
            source_domain_count = excluded.source_domain_count,
            trade_family = excluded.trade_family,
            updated_at = now()
          -- THE GUARD. A re-persist must never revert a reviewer's decision to 'pending', so a
          -- row that has left the machine-writable statuses is left exactly as it is.
          WHERE skill_candidate.status IN ('pending', 'needs_review')`);

        for (const s of c.sources) {
          await tx.execute(dsql`
            INSERT INTO skill_candidate_source (
              candidate_id, source_type, source_id, original_text, normalized_text, job_domain_id)
            VALUES (${c.candidate_id}::uuid, ${s.source_type}, ${s.source_id}, ${s.original_text},
                    ${s.normalized_text}, ${s.job_domain_id})
            ON CONFLICT (candidate_id, source_type, source_id) DO NOTHING`);
        }

        for (const m of c.matches) {
          await tx.execute(dsql`
            INSERT INTO skill_candidate_match (
              candidate_id, skill_id, relation, score, strength, rank, evidence_detail)
            VALUES (${c.candidate_id}::uuid, ${m.skill_id}, ${m.relation}, ${m.score},
                    ${m.strength}, ${m.rank}, ${m.evidence_detail})
            ON CONFLICT (candidate_id, skill_id) DO UPDATE SET
              relation = excluded.relation, score = excluded.score,
              strength = excluded.strength, rank = excluded.rank,
              evidence_detail = excluded.evidence_detail`);
        }
      }
    });

    console.log("");
    console.log(`  APPLIED. ${candidates.length} candidates persisted for ${report.run.run_id}.`);
    console.log(`  Nothing outside the four staging tables was touched.`);
    console.log("");
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
