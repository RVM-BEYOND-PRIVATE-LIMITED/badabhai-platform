/**
 * Canonical-label candidate AUDIT — is each of the 119 labels actually fit to be an alias?
 *
 *   pnpm db:audit:labels --run [--include-provisional] [--out <dir>]
 *
 * ===========================================================================
 * WHAT THIS IS FOR, AND WHAT THE EXPERIMENT DID NOT ESTABLISH
 * ===========================================================================
 * `EXP-P8-CANONICAL-LABEL` measured that adding every skill's own `label_en` would fix GP-04,
 * break nothing, and lift seven correct-but-unassignable cases over the floor. That is a
 * statement about RETRIEVAL SCORES on 113 fixture queries. It is emphatically NOT a statement
 * that all 119 labels belong in the taxonomy.
 *
 * The fixture touches 65 of 131 reachable skills, so roughly half the candidates were never
 * exercised by any query in that experiment — their score impact is simply unmeasured. A
 * label can also be perfectly harmless to Recall@1 and still be wrong to ingest: a duplicate
 * the unique index will reject, a string another skill already owns, or a phrase so generic it
 * will start matching everything the moment a real worker types near it.
 *
 * This audit answers the ingestion question with no provider calls at all, because the
 * question is lexical and structural rather than semantic.
 *
 * ===========================================================================
 * THE CONSTRAINT THAT ACTUALLY DECIDES AN INSERT
 * ===========================================================================
 *   skill_alias_skill_norm_lang_uq
 *     UNIQUE (skill_id, text_norm, lang) NULLS NOT DISTINCT WHERE is_searchable
 *
 * So duplication is judged on `text_norm` — the output of `normalizeOccupationText` — and NOT
 * on raw text or on any normalizer this file invents. The candidate-simulation harness used
 * its own lighter fold, which is fine for cosine bookkeeping and wrong for predicting an
 * insert: it treats "Bench fitting" and "bench-fitting" as distinct while the database does
 * not. Every candidate the two normalizers disagree about is reported explicitly, because
 * each one is a row the experiment counted that the database would refuse.
 *
 * ===========================================================================
 * WHY CROSS-SKILL DUPLICATES ARE A FINDING AND NOT A CONSTRAINT VIOLATION
 * ===========================================================================
 * The unique index is partitioned by `skill_id`, so two different skills may hold the same
 * alias text and the insert succeeds. That is precisely the hazard: identical text on two
 * skills makes the tie-break arbitrary, and in a shared domain it puts two candidates at
 * indistinguishable distance from the same query. GP-04 was a near-miss version of this. It
 * is reported at two severities — same-domain, which is a live retrieval collision, and
 * cross-domain, which is only a latent one.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { config } from "dotenv";

import { normalizeOccupationText } from "@badabhai/profiling-lexicon";

import { createDbClient } from "./client";
import { DEFAULT_CACHE_DIR, cacheKey } from "./taxonomy-embed-cache";
import { EMBEDDING_MODEL, cosine, normalizeAliasText } from "./taxonomy-alias-experiment";
import { PRE_PROMOTION_SKILL_STATUSES, PRODUCTION_SKILL_STATUSES, evalArg } from "./taxonomy-retrieval-eval";

config({ path: "../../.env" });

const SCRIPT = "audit:labels";

/**
 * A label is called GENERIC when even its MOST distinctive token is already shared by this
 * many distinct skills' aliases.
 *
 * Taking the minimum across tokens is deliberate: a label is only as specific as its
 * sharpest word. "Quality control" is generic because both `quality` and `control` are
 * everywhere; "Refrigerant leak detection" survives because `refrigerant` is not. The value
 * is a review trigger, not a rejection — the audit reports, a reviewer decides.
 */
export const GENERIC_MIN_DF = 8;

/**
 * Cosine at which a candidate label is close enough to another skill's alias to be called a
 * potential competitor.
 *
 * Anchored on measurement rather than taste: the closest cross-skill alias pair in this
 * corpus sits at 0.8473 ("fastener tightening" vs "torque tightening", the pair behind the
 * DC-18 ground-truth dispute). A threshold above that would declare the corpus's own worst
 * known collision acceptable, so it sits just below.
 */
export const COMPETITOR_THRESHOLD = 0.84;

/**
 * Key for the alias-vector lookup.
 *
 * One definition, because the three call sites previously inlined the same template and one
 * of them carried a stray control character — the lookup then missed every time while every
 * input looked correct. A separator that cannot occur in a skill_id or an alias keeps the
 * two fields unambiguous.
 */
export function aliasVectorKey(skillId: string, text: string): string {
  return `${skillId}\u0000${text}`;
}

export type Severity = "BLOCK" | "REVIEW" | "INFO";

export interface Finding {
  code: string;
  severity: Severity;
  detail: string;
}

export interface CandidateAudit {
  skill_id: string;
  label: string;
  lang: "en" | "hi";
  text_norm: string;
  /** Domains where this skill is reachable — the scope any collision would act in. */
  domains: string[];
  findings: Finding[];
  /** Highest severity across findings; "OK" when there are none. */
  verdict: "BLOCK" | "REVIEW" | "OK";
}

export interface AliasRow {
  skill_id: string;
  text: string;
  lang: string | null;
  text_norm: string | null;
  is_searchable: boolean;
}

export interface SkillRow {
  skill_id: string;
  label_en: string | null;
  status: string;
}

const worst = (f: readonly Finding[]): CandidateAudit["verdict"] => {
  if (f.some((x) => x.severity === "BLOCK")) return "BLOCK";
  if (f.some((x) => x.severity === "REVIEW")) return "REVIEW";
  return "OK";
};

/** Distinct skills whose alias text_norm contains each token. The genericness evidence. */
export function tokenDocumentFrequency(aliases: readonly AliasRow[]): Map<string, number> {
  const perToken = new Map<string, Set<string>>();
  for (const a of aliases) {
    const norm = a.text_norm ?? normalizeOccupationText(a.text);
    for (const t of new Set(norm.split(" ").filter((x) => x !== ""))) {
      const s = perToken.get(t) ?? new Set<string>();
      s.add(a.skill_id);
      perToken.set(t, s);
    }
  }
  return new Map([...perToken].map(([t, s]) => [t, s.size]));
}

export interface AuditInput {
  skills: readonly SkillRow[];
  aliases: readonly AliasRow[];
  /** skill_id -> domains where it has an active edge. */
  domainsBySkill: ReadonlyMap<string, string[]>;
  /** Optional: candidate label vectors, from cache only. Absent -> competitor check skipped. */
  labelVectors?: ReadonlyMap<string, number[]>;
  /** Optional: alias vectors keyed by {@link aliasVectorKey}. */
  aliasVectors?: ReadonlyMap<string, number[]>;
  genericMinDf?: number;
}

/**
 * Audit every skill whose `label_en` is not already one of its aliases.
 *
 * Candidacy is decided with `normalizeOccupationText`, the same function that fills
 * `text_norm`, so "already present" here means what the database means by it.
 */
export function auditCanonicalLabels(input: AuditInput): CandidateAudit[] {
  const { skills, aliases, domainsBySkill } = input;
  const genericMinDf = input.genericMinDf ?? GENERIC_MIN_DF;

  const aliasBySkill = new Map<string, AliasRow[]>();
  for (const a of aliases) {
    const l = aliasBySkill.get(a.skill_id) ?? [];
    l.push(a);
    aliasBySkill.set(a.skill_id, l);
  }
  // text_norm -> the distinct skills that already own it.
  const ownersByNorm = new Map<string, Set<string>>();
  for (const a of aliases) {
    const n = a.text_norm ?? normalizeOccupationText(a.text);
    const s = ownersByNorm.get(n) ?? new Set<string>();
    s.add(a.skill_id);
    ownersByNorm.set(n, s);
  }
  const df = tokenDocumentFrequency(aliases);

  const out: CandidateAudit[] = [];
  for (const s of skills) {
    if (s.label_en === null || s.label_en.trim() === "") continue;
    const norm = normalizeOccupationText(s.label_en);
    const own = aliasBySkill.get(s.skill_id) ?? [];
    const ownNorms = new Set(own.map((a) => a.text_norm ?? normalizeOccupationText(a.text)));

    // Not a candidate at all: the database already considers this label present.
    if (ownNorms.has(norm)) continue;

    const domains = domainsBySkill.get(s.skill_id) ?? [];
    const findings: Finding[] = [];

    // ── the two normalizers disagreeing is itself a finding ──────────────
    const loose = new Set(own.map((a) => normalizeAliasText(a.text)));
    if (loose.has(normalizeAliasText(s.label_en))) {
      findings.push({
        code: "NORMALIZER_DISAGREEMENT",
        severity: "INFO",
        detail:
          "the experiment's lighter fold considered this label already present; text_norm does not. " +
          "Counted as a candidate by the simulation either way — recorded so the two agree on paper.",
      });
    }

    // ── would the unique index reject the insert? ────────────────────────
    // Same skill, same text_norm, same lang, still searchable.
    const clash = own.find(
      (a) => (a.text_norm ?? normalizeOccupationText(a.text)) === norm && (a.lang ?? "en") === "en" && a.is_searchable,
    );
    if (clash !== undefined) {
      findings.push({
        code: "UNIQUE_INDEX_COLLISION",
        severity: "BLOCK",
        detail: `(skill_id, text_norm, lang)=(${s.skill_id}, ${norm}, en) already exists as "${clash.text}"`,
      });
    }

    // ── another skill already owns this exact normalized text ────────────
    const owners = [...(ownersByNorm.get(norm) ?? new Set<string>())].filter((id) => id !== s.skill_id);
    if (owners.length > 0) {
      const shared = owners.filter((o) => (domainsBySkill.get(o) ?? []).some((d) => domains.includes(d)));
      if (shared.length > 0) {
        findings.push({
          code: "CROSS_SKILL_DUPLICATE_SAME_DOMAIN",
          severity: "BLOCK",
          detail:
            `"${norm}" is already an alias of ${shared.join(", ")}, reachable in the same domain. ` +
            "Two skills at identical text means the winner is decided by tie-break, not by meaning.",
        });
      } else {
        findings.push({
          code: "CROSS_SKILL_DUPLICATE",
          severity: "REVIEW",
          detail: `"${norm}" is already an alias of ${owners.join(", ")} (no shared domain today)`,
        });
      }
    }

    // ── genericness ──────────────────────────────────────────────────────
    const tokens = norm.split(" ").filter((t) => t !== "");
    const dfs = tokens.map((t) => df.get(t) ?? 0);
    const sharpest = dfs.length === 0 ? 0 : Math.min(...dfs);
    if (tokens.length > 0 && sharpest >= genericMinDf) {
      findings.push({
        code: "GENERIC_LABEL",
        severity: "REVIEW",
        detail:
          `every token is widespread — the most distinctive (${tokens[dfs.indexOf(sharpest)] ?? "?"}) ` +
          `already appears in aliases of ${sharpest} distinct skills`,
      });
    }
    // A label that enumerates two skills is not a phrase anyone types. "Deburring / finishing"
    // as one alias matches neither "deburring" nor "finishing" as well as either would alone,
    // and the honest remedy is two aliases rather than one compound — a reviewer's call.
    const compound = /\s\/\s|\s&\s|,| and /i.exec(s.label_en);
    if (compound !== null) {
      findings.push({
        code: "COMPOUND_LABEL",
        severity: "REVIEW",
        detail:
          `the label enumerates more than one concept (matched ${JSON.stringify(compound[0])}); ` +
          "as a single alias it represents neither half well. Consider splitting into separate aliases.",
      });
    }
    if (tokens.length === 1) {
      findings.push({
        code: "SINGLE_TOKEN_LABEL",
        severity: "REVIEW",
        detail: `a one-word alias ("${norm}") matches broadly; GP-04 was lost to the bare token "turning"`,
      });
    }

    out.push({
      skill_id: s.skill_id,
      label: s.label_en,
      lang: "en",
      text_norm: norm,
      domains,
      findings,
      verdict: worst(findings),
    });
  }
  return out;
}

/**
 * Would this label outrank another skill's existing aliases inside a shared domain?
 *
 * Vector-based, and therefore only run where a vector is already in the local cache. A miss
 * is reported as NOT_ASSESSED rather than passed over: "no finding" and "not looked at" are
 * different claims, and collapsing them would let an unaudited candidate read as a clean one.
 */
export function competitorFindings(
  audits: readonly CandidateAudit[],
  aliases: readonly AliasRow[],
  domainsBySkill: ReadonlyMap<string, string[]>,
  labelVectors: ReadonlyMap<string, number[]>,
  aliasVectors: ReadonlyMap<string, number[]>,
  threshold = COMPETITOR_THRESHOLD,
): Map<string, Finding[]> {
  const byDomain = new Map<string, AliasRow[]>();
  for (const a of aliases) {
    for (const d of domainsBySkill.get(a.skill_id) ?? []) {
      const l = byDomain.get(d) ?? [];
      l.push(a);
      byDomain.set(d, l);
    }
  }
  const out = new Map<string, Finding[]>();
  for (const c of audits) {
    const lv = labelVectors.get(c.skill_id);
    if (lv === undefined) {
      out.set(c.skill_id, [
        {
          code: "COMPETITOR_NOT_ASSESSED",
          severity: "INFO",
          detail: "no cached vector for this label; semantic competition was not evaluated",
        },
      ]);
      continue;
    }
    const hits: string[] = [];
    for (const d of c.domains) {
      for (const a of byDomain.get(d) ?? []) {
        if (a.skill_id === c.skill_id) continue;
        const av = aliasVectors.get(aliasVectorKey(a.skill_id, a.text));
        if (av === undefined) continue;
        const sim = cosine(lv, av);
        if (sim >= threshold) hits.push(`${sim.toFixed(4)} vs ${a.skill_id} "${a.text}" in ${d}`);
      }
    }
    out.set(
      c.skill_id,
      hits.length === 0
        ? []
        : [
            {
              code: "POTENTIAL_TOP_COMPETITOR",
              severity: "REVIEW",
              detail: `sits within ${threshold} cosine of another skill's alias: ${hits.slice(0, 3).join("; ")}`,
            },
          ],
    );
  }
  return out;
}

export interface CorpusDelta {
  rows_added: number;
  by_lang: Record<string, number>;
  skills_touched: number;
  domains_touched: number;
  texts_to_embed: number;
  /** At the corpus embedder's batch size, not one-per-request like the eval harness. */
  provider_requests_at_batch_100: number;
}

export function corpusDelta(approved: readonly CandidateAudit[]): CorpusDelta {
  const domains = new Set<string>();
  for (const c of approved) for (const d of c.domains) domains.add(d);
  const byLang: Record<string, number> = {};
  for (const c of approved) byLang[c.lang] = (byLang[c.lang] ?? 0) + 1;
  return {
    rows_added: approved.length,
    by_lang: byLang,
    skills_touched: new Set(approved.map((c) => c.skill_id)).size,
    domains_touched: domains.size,
    texts_to_embed: approved.length,
    provider_requests_at_batch_100: Math.ceil(approved.length / 100),
  };
}

// ───────────────────────────────────────────────────────────────────────────
// CLI
// ───────────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const argv = process.argv;
  const statuses = argv.includes("--include-provisional")
    ? PRE_PROMOTION_SKILL_STATUSES
    : PRODUCTION_SKILL_STATUSES;
  const outDir = evalArg(argv, "--out") ?? join(__dirname, "..", "data", "taxonomy", "eval", "label-audit");

  const url = process.env.DATABASE_URL;
  if (!url) throw new Error(`[${SCRIPT}] DATABASE_URL is not set`);
  const { sql } = createDbClient(url, { max: 1 });
  try {
    const skills = (await sql.unsafe(
      `SELECT DISTINCT s.skill_id, s.label_en, s.status
       FROM skill s JOIN job_domain_skill jds ON jds.skill_id = s.skill_id AND jds.status='active'
       WHERE s.status = ANY($1::text[]) ORDER BY s.skill_id`,
      [statuses],
    )) as unknown as SkillRow[];

    const aliases = (await sql.unsafe(
      `SELECT sa.skill_id, sa.text, sa.lang, sa.text_norm, sa.is_searchable
       FROM skill_alias sa JOIN skill s ON s.skill_id = sa.skill_id
       WHERE s.status = ANY($1::text[])`,
      [statuses],
    )) as unknown as AliasRow[];

    const edges = (await sql.unsafe(
      `SELECT jds.job_domain_id, jds.skill_id
       FROM job_domain_skill jds JOIN skill s ON s.skill_id = jds.skill_id
       WHERE jds.status='active' AND s.status = ANY($1::text[])`,
      [statuses],
    )) as unknown as { job_domain_id: string; skill_id: string }[];
    const domainsBySkill = new Map<string, string[]>();
    for (const e of edges) {
      const l = domainsBySkill.get(e.skill_id) ?? [];
      l.push(e.job_domain_id);
      domainsBySkill.set(e.skill_id, l);
    }

    const audits = auditCanonicalLabels({ skills, aliases, domainsBySkill });

    // Vectors: CACHE ONLY. This audit never calls the provider.
    const cacheFile = join(DEFAULT_CACHE_DIR, "vectors.json");
    const cached: Record<string, number[]> = existsSync(cacheFile)
      ? (JSON.parse(readFileSync(cacheFile, "utf8")) as Record<string, number[]>)
      : {};
    const labelVectors = new Map<string, number[]>();
    for (const c of audits) {
      const v = cached[cacheKey(EMBEDDING_MODEL, c.label)];
      if (v !== undefined) labelVectors.set(c.skill_id, v);
    }
    // Competition is measured against the alias vectors ALREADY IN THE DATABASE, not against
    // the cache. The cache only ever held labels and fixture queries, so a cache-based
    // comparison silently had almost nothing to compare with and returned a clean bill of
    // health for candidates it had never actually examined. pgvector does the work here; no
    // provider call is involved either way.
    let assessed = 0;
    for (const c of audits) {
      const lv = labelVectors.get(c.skill_id);
      if (lv === undefined || c.domains.length === 0) {
        c.findings.push({
          code: "COMPETITOR_NOT_ASSESSED",
          severity: "INFO",
          detail:
            lv === undefined
              ? "no cached vector for this label; semantic competition was not evaluated"
              : "skill has no active domain edge; nothing to compete with",
        });
        c.verdict = worst(c.findings);
        continue;
      }
      assessed += 1;
      const near = (await sql.unsafe(
        `SELECT s.skill_id, sa.text, jds.job_domain_id,
                1 - (sa.embedding <=> $1::vector) AS sim
         FROM skill_alias sa
         JOIN job_domain_skill jds ON jds.skill_id = sa.skill_id
         JOIN skill s ON s.skill_id = sa.skill_id
         WHERE jds.job_domain_id = ANY($2::text[]) AND jds.status='active'
           AND s.status = ANY($3::text[]) AND s.skill_id <> $4
           AND sa.embedding IS NOT NULL
           AND 1 - (sa.embedding <=> $1::vector) >= $5
         ORDER BY sa.embedding <=> $1::vector LIMIT 3`,
        [JSON.stringify(lv), c.domains, statuses, c.skill_id, COMPETITOR_THRESHOLD],
      )) as unknown as { skill_id: string; text: string; job_domain_id: string; sim: string }[];

      if (near.length > 0) {
        c.findings.push({
          code: "POTENTIAL_TOP_COMPETITOR",
          severity: "REVIEW",
          detail:
            `sits within ${COMPETITOR_THRESHOLD} cosine of another skill's alias in a shared domain: ` +
            near.map((n) => `${Number(n.sim).toFixed(4)} ${n.skill_id} "${n.text}" (${n.job_domain_id})`).join("; "),
        });
      }
      c.verdict = worst(c.findings);
    }

    const dfAll = tokenDocumentFrequency(aliases);
    const sharpest = audits.map((c) => {
      const toks = c.text_norm.split(" ").filter((t) => t !== "");
      return toks.length === 0 ? 0 : Math.min(...toks.map((t) => dfAll.get(t) ?? 0));
    });
    const pctl = (p: number): number => {
      const v = [...sharpest].sort((a, b) => a - b);
      return v.length === 0 ? 0 : (v[Math.min(v.length - 1, Math.floor(p * v.length))] ?? 0);
    };

    const counts = new Map<string, number>();
    for (const c of audits) for (const f of c.findings) counts.set(f.code, (counts.get(f.code) ?? 0) + 1);
    const approved = audits.filter((c) => c.verdict === "OK");
    const delta = corpusDelta(approved);

    console.log(`[${SCRIPT}] candidates (label_en absent under text_norm) = ${audits.length}`);
    console.log(`  BLOCK  = ${audits.filter((c) => c.verdict === "BLOCK").length}`);
    console.log(`  REVIEW = ${audits.filter((c) => c.verdict === "REVIEW").length}`);
    console.log(`  OK     = ${approved.length}`);
    console.log(`  findings by code:`);
    for (const [code, n] of [...counts].sort((a, b) => b[1] - a[1])) console.log(`    ${code.padEnd(36)} ${n}`);
    console.log(`  proposed corpus delta if ONLY the OK set is ingested:`);
    console.log(`    rows ${delta.rows_added} · skills ${delta.skills_touched} · domains ${delta.domains_touched}`);
    console.log(`    embeds ${delta.texts_to_embed} texts = ${delta.provider_requests_at_batch_100} request(s) at batch 100`);
    console.log(`  label vectors from cache = ${labelVectors.size}/${audits.length}; competition assessed for ${assessed}`);
    console.log(`  genericness evidence (distinct skills sharing a label's SHARPEST token):`);
    const maxDf = Math.max(0, ...sharpest);
    console.log(`    p50 ${pctl(0.5)} · p90 ${pctl(0.9)} · max ${maxDf} · threshold ${GENERIC_MIN_DF}`);
    if (maxDf < GENERIC_MIN_DF) {
      // Zero GENERIC_LABEL findings would otherwise read as "no label is generic", when what
      // it actually means is that the check cannot fire. 295 aliases across 131 skills is
      // ~2.3 aliases per skill, so almost no token is shared widely enough to trip a
      // threshold calibrated for a mature corpus.
      console.log(
        `    NOTE: the check is INERT on this corpus — the highest observed value (${maxDf}) is ` +
          `below the threshold (${GENERIC_MIN_DF}), so GENERIC_LABEL cannot fire. Zero findings ` +
          `here is not evidence that the labels are specific. Recalibrate once the alias corpus grows.`,
      );
    }
    const ranked = audits
      .map((c, i) => ({ skill_id: c.skill_id, label: c.label, df: sharpest[i] ?? 0 }))
      .sort((a, b) => b.df - a.df)
      .slice(0, 10);
    console.log(`    broadest candidates regardless of threshold:`);
    for (const r of ranked) console.log(`      df=${r.df}  ${r.skill_id.padEnd(40)} "${r.label}"`);

    mkdirSync(outDir, { recursive: true });
    const manifest = {
      generated_from: "skill.label_en absent from skill_alias.text_norm",
      normalizer: "normalizeOccupationText (the function that fills text_norm)",
      skill_statuses: statuses,
      generic_min_df: GENERIC_MIN_DF,
      competitor_threshold: COMPETITOR_THRESHOLD,
      competition_assessed_for: assessed,
      sharpest_token_df: {
        p50: pctl(0.5),
        p90: pctl(0.9),
        max: Math.max(0, ...sharpest),
        check_inert: Math.max(0, ...sharpest) < GENERIC_MIN_DF,
        note:
          Math.max(0, ...sharpest) < GENERIC_MIN_DF
            ? 'GENERIC_LABEL cannot fire on this corpus; zero findings is not evidence of specificity'
            : null,
      },
      broadest_candidates: ranked,
      provider_calls: 0,
      label_vectors_from_cache: labelVectors.size,
      totals: {
        candidates: audits.length,
        block: audits.filter((c) => c.verdict === "BLOCK").length,
        review: audits.filter((c) => c.verdict === "REVIEW").length,
        ok: approved.length,
      },
      findings_by_code: Object.fromEntries(counts),
      corpus_delta_if_ok_only: delta,
      status: "NOT INGESTED — requires review and separate authorization",
      candidates: audits,
    };
    const path = join(outDir, "canonical-label-candidates.json");
    writeFileSync(path, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
    console.log(`[${SCRIPT}] manifest -> ${path}`);
  } finally {
    await sql.end({ timeout: 5 });
  }
}

if (process.argv[1] && /taxonomy-label-audit\.ts$/.test(process.argv[1])) {
  void main();
}
