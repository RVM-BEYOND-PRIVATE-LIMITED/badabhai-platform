/**
 * `pnpm db:discover:skills` — the skill discovery DRY RUN. READ-ONLY, ₹0.
 *
 *   pnpm db:discover:skills                          # full dry run over every source
 *   pnpm db:discover:skills --label cnc-sweep        # name the run (goes in the run id)
 *   pnpm db:discover:skills --sources=job_domain_alias,unresolved_phrase
 *   pnpm db:discover:skills --include-rejected       # emit rows for what the classifier refused
 *   pnpm db:discover:skills --attestation-floor 2    # queue only clusters seen in >=2 domains
 *   pnpm db:discover:skills --top 100                # size of the review sample in the report
 *   pnpm db:discover:skills --out .scratch/run       # where the artifacts land
 *   pnpm db:discover:skills --derive-heads           # dump the occupation-head lexicon only
 *
 * ===========================================================================
 * THERE IS NO `--apply`, AND THAT IS THE DESIGN
 * ===========================================================================
 * This runner reads. It writes files. It has no INSERT, no UPDATE, and no code path that
 * reaches `skill`, `skill_alias`, `job_domain_skill`, `skill_candidate` or anything else —
 * `assertNoMutationVerbs` in the guardrail test asserts that against this file's own source,
 * so the claim is checked rather than promised.
 *
 * Persisting candidates into `skill_candidate` is a separate runner, gated on migration 0093
 * being applied and on the owner's authorization. Keeping the two apart means the measurement
 * that answers "how big is this problem?" can be run today, repeatedly, by anyone, against
 * production, with no possibility of changing it.
 *
 * ===========================================================================
 * ₹0, AND THAT IS MEASURED RATHER THAN ASSERTED
 * ===========================================================================
 * No provider is contacted. Every similarity this run computes is lexical, over functions
 * that already ship. The report still PRICES the two AI stages it deliberately did not run —
 * the embeddings a semantic pass would need, and the label/description proposal — so the
 * spend decision is made against measured counts instead of a guess. See
 * `skill-discovery-run.ts` for where those rates come from.
 *
 * ===========================================================================
 * WHAT THE REPORT IS FOR
 * ===========================================================================
 * One question: *"out of the job-domain aliases, how many are occupations only, how many
 * carry skill evidence, how many map to existing skills, how many are alias candidates, how
 * many are genuinely missing skills, and how many need a human?"* Every number in the output
 * is a count of rows this process actually read, and the provenance header records the
 * database, the role, and whether that role could see through RLS — because a zero from a
 * role without BYPASSRLS is not evidence of anything.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import { config } from "dotenv";
import { sql as dsql } from "drizzle-orm";

import { createDbClient } from "./client";
import { CORPUS_FINGERPRINT_SQL, toFingerprint } from "./corpus-fingerprint";
import { provenance } from "./evidence-provenance";
import { enforceOpsGuard, hostClass } from "./ops-guard";
import {
  deriveOccupationHeads,
  headLexiconFingerprint,
  type HeadLexicon,
} from "./skill-discovery-heads";
import { buildExistingSkillIndex, type ExistingSkillRow } from "./skill-discovery-match";
import {
  buildDiscoveryPlan,
  prioritize,
  tierCounts,
  type DiscoveryPlan,
  type DiscoverySourceRow,
} from "./skill-discovery-plan";
import {
  discoveryInputFingerprint,
  discoveryRunId,
  estimateEmbeddingCost,
  estimateExtractionCost,
  estimateReviewWorkload,
} from "./skill-discovery-run";
import type { SkillCandidateSourceType } from "./skill-discovery-candidate";

config({ path: "../../.env" });
config();

const SCRIPT = "discover:skills";

/** Every source the pipeline knows how to read. `--sources` selects a subset. */
const ALL_SOURCES: readonly SkillCandidateSourceType[] = [
  "job_domain_alias",
  "job_domain_label",
  "unresolved_phrase",
];

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

function write(path: string, body: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, body, "utf8");
}

// ===========================================================================
// Reads — every one of them a SELECT
// ===========================================================================

interface OccupationTextRow {
  readonly job_domain_id: string;
  readonly text: string;
}

/**
 * The corpus the head lexicon is derived from: every label and alias of a SELECTABLE, ACTIVE
 * domain.
 *
 * The predicate is load-bearing and is recorded in the artifact's `population_predicate`. A
 * bucket row ("Craft and Related Trades Workers") is not an occupation anybody holds, and its
 * head would teach the lexicon that "workers" is the head of a job title — which it is, but
 * only in a row that must never reach a worker's profile in the first place.
 */
const OCCUPATION_TEXT_SQL = dsql`
  SELECT d.job_domain_id, d.label_en AS text
    FROM job_domain d
   WHERE d.selectable AND d.status = 'active'
  UNION ALL
  SELECT a.job_domain_id, a.text
    FROM job_domain_alias a
    JOIN job_domain d ON d.job_domain_id = a.job_domain_id
   WHERE d.selectable AND d.status = 'active'`;

/** The shipped skill catalogue plus its aliases, for the existing-skill index. */
const EXISTING_SKILL_SQL = dsql`
  SELECT s.skill_id, s.label_en, s.status, s.kind,
         coalesce(array_agg(a.text) FILTER (WHERE a.text IS NOT NULL), '{}') AS alias_texts
    FROM skill s
    LEFT JOIN skill_alias a ON a.skill_id = s.skill_id
   WHERE s.status <> 'deprecated'
   GROUP BY s.skill_id, s.label_en, s.status, s.kind`;

/** Normalized phrases that already carry a real vector, for the ₹0 embedding accounting. */
const EMBEDDED_NORMS_SQL = dsql`
  SELECT DISTINCT text_norm FROM job_domain_alias WHERE embedding IS NOT NULL AND text_norm IS NOT NULL
  UNION
  SELECT DISTINCT text_norm FROM skill_alias      WHERE embedding IS NOT NULL AND text_norm IS NOT NULL`;

/** `jd_*` -> ISCO major code, and the major group's own label. The report's family column. */
const FAMILY_SQL = dsql`
  SELECT d.job_domain_id,
         d.isco_major_code,
         (SELECT m.label_en FROM job_domain m
           WHERE m.source = 'isco08' AND m.level = 1 AND m.source_code = d.isco_major_code
           LIMIT 1) AS major_label
    FROM job_domain d
   WHERE d.isco_major_code IS NOT NULL`;

// ===========================================================================
// main
// ===========================================================================

async function main(): Promise<void> {
  // mutating:false — this runner has no write path at all. The guard still runs, because a
  // READ of an unidentified database is still a read of an unknown blast radius.
  const guard = enforceOpsGuard({
    script: SCRIPT,
    connectionString: process.env.DATABASE_URL,
    mutating: false,
  });

  const startedAt = new Date();
  const label = arg("label") ?? "full";
  const outDir = arg("out") ?? join(".scratch", "skill-discovery");
  const topN = Number(arg("top") ?? 100);
  const includeRejected = flag("include-rejected");
  const attestationFloor = Number(arg("attestation-floor") ?? 1);
  const selected = (arg("sources") ?? ALL_SOURCES.join(","))
    .split(",")
    .map((s) => s.trim())
    .filter((s): s is SkillCandidateSourceType => (ALL_SOURCES as readonly string[]).includes(s));

  const { db, sql } = createDbClient(guard.connectionString, { max: 4 });

  try {
    const identity = ((await db.execute(
      dsql`SELECT current_user, (SELECT rolbypassrls FROM pg_roles WHERE rolname = current_user) AS bypassrls`,
    )) as unknown as { current_user: string; bypassrls: boolean }[])[0];
    // Fails CLOSED on an unreadable identity: `bypass_rls: false` on the artifact makes a zero
    // count unusable as evidence, which is the correct reading when we cannot prove we could see.
    const role = identity?.current_user ?? "(unknown)";
    const bypassRls = identity?.bypassrls ?? false;

    // ── the head lexicon ────────────────────────────────────────────────
    const occupationTexts = (await db.execute(OCCUPATION_TEXT_SQL)) as unknown as OccupationTextRow[];
    const lexicon = deriveOccupationHeads(occupationTexts.map((r) => r.text));

    if (flag("derive-heads")) {
      emitLexicon(outDir, lexicon, role, bypassRls, guard.connectionString, startedAt);
      return;
    }

    // ── the existing-skill index ────────────────────────────────────────
    const skillRows = (await db.execute(EXISTING_SKILL_SQL)) as unknown as {
      skill_id: string;
      label_en: string;
      status: string;
      kind: string;
      alias_texts: string[];
    }[];
    const index = buildExistingSkillIndex(
      skillRows.map(
        (r): ExistingSkillRow => ({
          skillId: r.skill_id,
          labelEn: r.label_en,
          status: r.status,
          kind: r.kind,
          aliasTexts: r.alias_texts ?? [],
        }),
      ),
    );

    // ── families ────────────────────────────────────────────────────────
    const familyRows = (await db.execute(FAMILY_SQL)) as unknown as {
      job_domain_id: string;
      isco_major_code: string;
      major_label: string | null;
    }[];
    const familyById = new Map(
      familyRows.map((r) => [r.job_domain_id, r.major_label ?? `isco_${r.isco_major_code}`]),
    );

    // ── sources ─────────────────────────────────────────────────────────
    const sources = await readSources(db, selected);

    // ── fingerprints ────────────────────────────────────────────────────
    const [rawCorpus] = (await db.execute(CORPUS_FINGERPRINT_SQL)) as unknown as Record<string, unknown>[];
    const corpus = toFingerprint(rawCorpus as Record<string, unknown>);
    const runConfig = { sources: selected, includeRejected, maxMatches: 5, attestationFloor };
    const inputFingerprint = discoveryInputFingerprint(corpus, lexicon, runConfig);
    const runId = discoveryRunId(startedAt.toISOString(), label);

    // ── the plan ────────────────────────────────────────────────────────
    const plan = buildDiscoveryPlan({
      runId,
      createdAt: startedAt.toISOString(),
      corpusFingerprint: inputFingerprint,
      sources,
      lexicon,
      index,
      familyOf: (id) => familyById.get(id) ?? null,
      options: { includeRejected, maxMatches: 5, attestationFloor },
    });

    // ── cost, measured against what the run actually produced ───────────
    const embeddedNorms = new Set(
      ((await db.execute(EMBEDDED_NORMS_SQL)) as unknown as { text_norm: string }[]).map(
        (r) => r.text_norm,
      ),
    );
    const embedding = estimateEmbeddingCost(
      plan.phrases.map((p) => p.normalized),
      embeddedNorms,
    );
    const extraction = estimateExtractionCost(plan.candidates);
    const workload = estimateReviewWorkload(plan.census);

    // ── artifacts ───────────────────────────────────────────────────────
    const prov = provenance({
      source: `pnpm db:discover:skills --label ${label}`,
      target: hostClass(guard.connectionString),
      readOnly: true,
      role,
      bypassRls,
      populationPredicate:
        "job_domain_alias + job_domain.label_en of domains WHERE selectable AND status='active'; " +
        "unresolved_phrase WHERE status='open'",
      measuredAt: startedAt,
    });

    const report = {
      provenance: prov,
      run: {
        run_id: runId,
        status: "completed",
        input_fingerprint: inputFingerprint,
        head_lexicon_fingerprint: headLexiconFingerprint(lexicon),
        head_lexicon_size: lexicon.heads.size,
        config: runConfig,
        model: null,
        prompt_version: null,
        embedding_model: null,
        started_at: startedAt.toISOString(),
        completed_at: new Date().toISOString(),
      },
      corpus_counts: corpus.counts,
      census: plan.census,
      cost: { embedding, extraction, actual_spend_inr: 0 },
      review_workload: workload,
      review_tiers: tierCounts(plan.candidates),
      weak_collisions_sample: plan.weak_collisions.slice(0, 25),
    };

    const runDir = join(outDir, runId);
    write(join(runDir, "report.json"), `${JSON.stringify(report, null, 2)}\n`);
    write(
      join(runDir, "candidates.jsonl"),
      `${plan.candidates.map((c) => JSON.stringify(c)).join("\n")}\n`,
    );
    write(
      join(runDir, "review-queue.jsonl"),
      `${prioritize(plan.candidates)
        .slice(0, topN)
        .map((c) => JSON.stringify(c))
        .join("\n")}\n`,
    );
    write(join(runDir, "phrases.jsonl"), `${plan.phrases.map((p) => JSON.stringify(p)).join("\n")}\n`);

    printReport(plan, report, runDir);
  } finally {
    await sql.end();
  }
}

// ===========================================================================
// Source readers — one SELECT each, no joins beyond what the predicate needs
// ===========================================================================

async function readSources(
  db: ReturnType<typeof createDbClient>["db"],
  selected: readonly SkillCandidateSourceType[],
): Promise<DiscoverySourceRow[]> {
  const rows: DiscoverySourceRow[] = [];

  if (selected.includes("job_domain_alias")) {
    const r = (await db.execute(dsql`
      SELECT a.id::text AS id, a.text, a.job_domain_id
        FROM job_domain_alias a
        JOIN job_domain d ON d.job_domain_id = a.job_domain_id
       WHERE d.selectable AND d.status = 'active'`)) as unknown as {
      id: string;
      text: string;
      job_domain_id: string;
    }[];
    for (const x of r) {
      rows.push({
        source_type: "job_domain_alias",
        source_id: x.id,
        original_text: x.text,
        job_domain_id: x.job_domain_id,
      });
    }
  }

  if (selected.includes("job_domain_label")) {
    const r = (await db.execute(dsql`
      SELECT job_domain_id, label_en
        FROM job_domain
       WHERE selectable AND status = 'active'`)) as unknown as {
      job_domain_id: string;
      label_en: string;
    }[];
    for (const x of r) {
      rows.push({
        source_type: "job_domain_label",
        source_id: x.job_domain_id,
        original_text: x.label_en,
        job_domain_id: x.job_domain_id,
      });
    }
  }

  if (selected.includes("unresolved_phrase")) {
    // REAL WORKER LANGUAGE, and the only source here that carries any. It is already
    // PSEUDONYMIZED at rest (SG-1, `unresolved_phrase` stores pseudonymized text only) and
    // the table has no `worker_id`, so reading it cannot re-identify anyone. The classifier
    // refuses digits, '@' and URLs on top of that.
    const r = (await db.execute(dsql`
      SELECT id::text AS id, phrase, job_domain_id
        FROM unresolved_phrase
       WHERE status = 'open'`)) as unknown as {
      id: string;
      phrase: string;
      job_domain_id: string | null;
    }[];
    for (const x of r) {
      rows.push({
        source_type: "unresolved_phrase",
        source_id: x.id,
        original_text: x.phrase,
        job_domain_id: x.job_domain_id,
      });
    }
  }

  return rows;
}

// ===========================================================================
// Output
// ===========================================================================

function emitLexicon(
  outDir: string,
  lexicon: HeadLexicon,
  role: string,
  bypassRls: boolean,
  connectionString: string,
  startedAt: Date,
): void {
  const heads = [...lexicon.heads.values()].sort((a, b) => b.texts - a.texts || a.token.localeCompare(b.token));
  const rejected = [...lexicon.rejected.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([token, texts]) => ({ token, texts }));
  const artifact = {
    provenance: provenance({
      source: "pnpm db:discover:skills --derive-heads",
      target: hostClass(connectionString),
      readOnly: true,
      role,
      bypassRls,
      populationPredicate: "job_domain.label_en + job_domain_alias.text WHERE selectable AND status='active'",
      measuredAt: startedAt,
    }),
    fingerprint: headLexiconFingerprint(lexicon),
    source_texts: lexicon.sourceTexts,
    accepted: heads.length,
    rejected: rejected.length,
    heads,
    rejected_candidates: rejected,
  };
  const path = join(outDir, "occupation-heads.json");
  write(path, `${JSON.stringify(artifact, null, 2)}\n`);
  console.log(`[${SCRIPT}] head lexicon: ${heads.length} accepted, ${rejected.length} rejected`);
  console.log(`[${SCRIPT}] fingerprint  = ${artifact.fingerprint}`);
  console.log(`[${SCRIPT}] written      -> ${path}`);
}

/** The attestation histogram, low breadths first, tail folded — a readable console summary. */
function topAttestation(hist: Readonly<Record<string, number>>): Record<string, number> {
  const out: Record<string, number> = {};
  let tail = 0;
  for (const [k, v] of Object.entries(hist)) {
    if (Number(k) <= 5) out[k] = v;
    else tail += v;
  }
  if (tail > 0) out["6+"] = tail;
  return out;
}

function pct(n: number, total: number): string {
  return total === 0 ? "0.0%" : `${((n / total) * 100).toFixed(1)}%`;
}

function printReport(plan: DiscoveryPlan, report: Record<string, unknown>, runDir: string): void {
  const c = plan.census;
  const cost = report["cost"] as {
    embedding: { to_embed: number; reused: number; estimated_inr: number };
    extraction: { candidates: number; estimated_inr: number; model: string };
  };
  const workload = report["review_workload"] as { estimated_hours: number; assumption: string };

  console.log("");
  console.log(`  ${"=".repeat(76)}`);
  console.log(`  SKILL DISCOVERY DRY RUN — ${plan.run_id}`);
  console.log(`  ${"=".repeat(76)}`);
  console.log("");
  console.log(`  SOURCES`);
  console.log(`    source rows read              ${c.source_rows}`);
  for (const [t, n] of Object.entries(c.by_source_type)) console.log(`      ${t.padEnd(26)}${n}`);
  console.log(`    distinct normalized phrases   ${c.normalized_unique}`);
  console.log("");
  console.log(`  DISPOSITION (distinct phrases, ${c.normalized_unique} = 100%)`);
  for (const [d, n] of Object.entries(c.by_disposition)) {
    console.log(`    ${d.padEnd(30)}${String(n).padStart(6)}   ${pct(n, c.normalized_unique)}`);
  }
  console.log("");
  console.log(`  DEDUPLICATION`);
  console.log(`    phrases entering clustering   ${c.clustered_phrases}`);
  console.log(`    clusters formed               ${c.clusters}`);
  console.log(`    duplicates absorbed           ${c.duplicates_absorbed}`);
  console.log(`    weak collisions (escalated)   ${c.weak_collisions}`);
  console.log(`    attestation floor             ${c.attestation_floor} domain(s)`);
  console.log(`    clusters below the floor      ${c.below_attestation_floor}   (excluded from the queue, counted here)`);
  console.log(`    clusters by domain breadth    ${JSON.stringify(topAttestation(c.clusters_by_attestation))}`);
  console.log("");
  console.log(`  HUMAN DECISIONS PRODUCED`);
  console.log(`    candidates                    ${c.candidates}`);
  console.log(`      by suggested action         ${JSON.stringify(c.candidates_by_action)}`);
  console.log(`      by confidence band          ${JSON.stringify(c.candidates_by_band)}`);
  console.log(`      by review tier              ${JSON.stringify(report["review_tiers"])}`);
  console.log(
    `    REDUCTION                     ${c.source_rows} source rows -> ${c.candidates} decisions ` +
      `(${pct(c.candidates, c.source_rows)})`,
  );
  console.log("");
  console.log(`  COST`);
  console.log(`    actual spend this run         Rs 0 (no provider was contacted)`);
  console.log(
    `    embeddings                    ${cost.embedding.reused} reused, ${cost.embedding.to_embed} missing ` +
      `-> est. Rs ${cost.embedding.estimated_inr}`,
  );
  console.log(
    `    extraction (${cost.extraction.model})  ${cost.extraction.candidates} calls -> est. Rs ${cost.extraction.estimated_inr}`,
  );
  console.log(`    review workload               est. ${workload.estimated_hours} h`);
  console.log("");
  console.log(`  ARTIFACTS -> ${runDir}`);
  console.log(`    report.json  candidates.jsonl  review-queue.jsonl  phrases.jsonl`);
  console.log("");
  console.log(`  NOTHING WAS WRITTEN TO THE DATABASE. This runner has no write path.`);
  console.log("");
}

if (require.main === module) {
  main().catch((error: unknown) => {
    console.error(`[${SCRIPT}]`, error instanceof Error ? error.message : error);
    process.exit(1);
  });
}
