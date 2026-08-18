/**
 * CORPUS FINGERPRINT — what an evaluation was actually measured against.
 *
 * ── THE BUG THIS REPLACES ──
 *
 * `promote-skills.ts` proved an evaluation was current by comparing its `recorded_at`
 * against one timestamp:
 *
 *     corpusChangedAt = SELECT max(embedded_at) FROM skill_alias WHERE embedding IS NOT NULL
 *
 * That is the entire freshness signal, and it only moves when a VECTOR is written. It is
 * blind to every other way the corpus can change what retrieval returns:
 *
 *   - `text_norm` filled           (the Phase 8 write: 131 rows, embedded_at untouched)
 *   - `is_searchable` elected      (the NEXT step: 129 rows, embedded_at untouched)
 *   - an alias added or deleted    (a DELETE cannot raise a max())
 *   - `skill.status` promoted      (retrieval filters on it)
 *   - a `job_domain_skill` edge    (retrieval joins through it)
 *   - a domain alias normalized    (domain resolution runs BEFORE skill retrieval)
 *
 * The comment above the old check says it exists because a stale record once made the gate
 * "report PASS on evidence that could not have seen the regression". The same failure was
 * reachable through any of the six changes above, and election — the very next authorized
 * mutation — is one of them.
 *
 * ── WHY A FINGERPRINT AND NOT A BETTER TIMESTAMP ──
 *
 * A timestamp answers "was this recorded after the last change we know about?". A
 * fingerprint answers "was this recorded against THIS corpus?". The second question has no
 * clock skew, no ordering subtlety, and no dependence on remembering to touch an
 * `updated_at` in every future writer. Equality or it is not fresh.
 *
 * The cost is that records written before fingerprinting existed can never prove currency.
 * That is correct and deliberate: EXP-P8-BASELINE cannot prove it describes today's corpus,
 * because it does not carry the evidence to do so. It stays valid as EVIDENCE of the state
 * it measured; it simply cannot clear a freshness gate. Historical records are never
 * rewritten to add a fingerprint — backfilling one would be fabricating the very proof the
 * field exists to provide.
 *
 * PRIVACY: reference catalogue only. Digests of ids, labels and flags; no worker data.
 */
import { sql as dsql } from "drizzle-orm";

/** Component digests. A change to any one of them changes what retrieval can return. */
export interface CorpusFingerprint {
  /** `skill_alias`: identity, text, normalization, searchability, vector provenance. */
  readonly skill_alias: string;
  /** `skill`: id + status. Retrieval filters `s.status = 'active'`. */
  readonly skill: string;
  /** `job_domain_skill`: the canonical path's join, including edge status. */
  readonly job_domain_skill: string;
  /** `job_domain`: status + selectable, which gate domain resolution. */
  readonly job_domain: string;
  /** `job_domain_alias`: domain resolution runs BEFORE skill retrieval, so it is in scope. */
  readonly job_domain_alias: string;
  /** Counts, carried because a digest tells you THAT something moved, not what. */
  readonly counts: CorpusCounts;
}

export interface CorpusCounts {
  readonly skill_alias_rows: number;
  readonly skill_alias_normalized: number;
  readonly skill_alias_searchable: number;
  readonly skill_alias_embedded: number;
  readonly skills_total: number;
  readonly skills_active: number;
  readonly job_domain_skill_active_edges: number;
  readonly job_domain_alias_rows: number;
  readonly job_domain_alias_searchable: number;
  readonly job_domain_alias_embedded: number;
}

/**
 * The separator is an explicit `chr(1)`, never a literal control character in the source.
 *
 * A previous checksum in this package carried an invisible U+0001 between two quotes that
 * read as `''`. Behaviour was identical — `chr(1)` IS U+0001 — but the constant produced a
 * different digest from a hand-typed copy of the same SQL, and an hour went into chasing a
 * corruption that had not happened. The second such bug in this package; both are now
 * caught by a source-hygiene test.
 *
 * `'~'` stands in for NULL so a NULL and the literal string are distinguishable, and
 * `md5(embedding::text)` keeps 768-float vectors out of the aggregate while staying
 * sensitive to any change in them.
 */
export const CORPUS_FINGERPRINT_SQL = dsql`
  SELECT
    (SELECT md5(coalesce(string_agg(
        "id"::text || chr(1) || "skill_id" || chr(1) || "text" || chr(1) ||
        coalesce("text_norm", '~') || chr(1) || coalesce("lang", '~') || chr(1) ||
        "source" || chr(1) || "is_searchable"::text || chr(1) ||
        coalesce("embedding_model", '~') || chr(1) ||
        coalesce("embedded_at"::text, '~') || chr(1) ||
        coalesce(md5("embedding"::text), '~'),
        '|' ORDER BY "id"), ''))
     FROM "skill_alias")                                          AS skill_alias,
    (SELECT md5(coalesce(string_agg(
        "skill_id" || chr(1) || coalesce("status", '~'),
        '|' ORDER BY "skill_id"), ''))
     FROM "skill")                                                AS skill,
    (SELECT md5(coalesce(string_agg(
        "job_domain_id" || chr(1) || "skill_id" || chr(1) || coalesce("status", '~'),
        '|' ORDER BY "job_domain_id", "skill_id"), ''))
     FROM "job_domain_skill")                                     AS job_domain_skill,
    (SELECT md5(coalesce(string_agg(
        "job_domain_id" || chr(1) || coalesce("status", '~') || chr(1) || "selectable"::text,
        '|' ORDER BY "job_domain_id"), ''))
     FROM "job_domain")                                           AS job_domain,
    (SELECT md5(coalesce(string_agg(
        "id"::text || chr(1) || "job_domain_id" || chr(1) ||
        coalesce("text_norm", '~') || chr(1) || "is_searchable"::text || chr(1) ||
        coalesce("embedding_model", '~') || chr(1) ||
        coalesce(md5("embedding"::text), '~'),
        '|' ORDER BY "id"), ''))
     FROM "job_domain_alias")                                     AS job_domain_alias,
    (SELECT count(*)::int FROM "skill_alias")                                             AS skill_alias_rows,
    (SELECT count("text_norm")::int FROM "skill_alias")                                   AS skill_alias_normalized,
    (SELECT count(*) FILTER (WHERE "is_searchable")::int FROM "skill_alias")              AS skill_alias_searchable,
    (SELECT count("embedding")::int FROM "skill_alias")                                   AS skill_alias_embedded,
    (SELECT count(*)::int FROM "skill")                                                   AS skills_total,
    (SELECT count(*) FILTER (WHERE "status" = 'active')::int FROM "skill")                AS skills_active,
    (SELECT count(*) FILTER (WHERE "status" = 'active')::int FROM "job_domain_skill")     AS job_domain_skill_active_edges,
    (SELECT count(*)::int FROM "job_domain_alias")                                        AS job_domain_alias_rows,
    (SELECT count(*) FILTER (WHERE "is_searchable")::int FROM "job_domain_alias")         AS job_domain_alias_searchable,
    (SELECT count("embedding")::int FROM "job_domain_alias")                              AS job_domain_alias_embedded
`;

/** Shape the raw row into a `CorpusFingerprint`. Exported so a caller can test it dry. */
export function toFingerprint(raw: Record<string, unknown>): CorpusFingerprint {
  const s = (k: string): string => String(raw[k] ?? "");
  const n = (k: string): number => Number(raw[k] ?? 0);
  return {
    skill_alias: s("skill_alias"),
    skill: s("skill"),
    job_domain_skill: s("job_domain_skill"),
    job_domain: s("job_domain"),
    job_domain_alias: s("job_domain_alias"),
    counts: {
      skill_alias_rows: n("skill_alias_rows"),
      skill_alias_normalized: n("skill_alias_normalized"),
      skill_alias_searchable: n("skill_alias_searchable"),
      skill_alias_embedded: n("skill_alias_embedded"),
      skills_total: n("skills_total"),
      skills_active: n("skills_active"),
      job_domain_skill_active_edges: n("job_domain_skill_active_edges"),
      job_domain_alias_rows: n("job_domain_alias_rows"),
      job_domain_alias_searchable: n("job_domain_alias_searchable"),
      job_domain_alias_embedded: n("job_domain_alias_embedded"),
    },
  };
}

/** The five component names, in report order. Counts are diagnostics, not identity. */
export const FINGERPRINT_COMPONENTS = [
  "skill_alias",
  "skill",
  "job_domain_skill",
  "job_domain",
  "job_domain_alias",
] as const;
export type FingerprintComponent = (typeof FINGERPRINT_COMPONENTS)[number];

/**
 * Which components differ. Empty means the two describe the same corpus.
 *
 * Deliberately compares ONLY the digests. Counts are carried for humans — two corpora with
 * equal digests necessarily have equal counts, and comparing counts as well would let a
 * mismatch be reported twice.
 */
export function fingerprintDiff(
  a: CorpusFingerprint | null | undefined,
  b: CorpusFingerprint | null | undefined,
): FingerprintComponent[] {
  if (!a || !b) return [...FINGERPRINT_COMPONENTS];
  return FINGERPRINT_COMPONENTS.filter((c) => a[c] !== b[c]);
}

/** True when both fingerprints describe the same corpus. */
export function fingerprintsMatch(
  a: CorpusFingerprint | null | undefined,
  b: CorpusFingerprint | null | undefined,
): boolean {
  return Boolean(a) && Boolean(b) && fingerprintDiff(a, b).length === 0;
}

/** A human sentence naming what moved, for a gate's detail line. */
export function describeFingerprintDrift(diff: readonly FingerprintComponent[]): string {
  if (diff.length === 0) return "corpus fingerprint matches";
  const why: Record<FingerprintComponent, string> = {
    skill_alias: "alias text/normalization/searchability/vectors",
    skill: "skill status",
    job_domain_skill: "domain->skill edges",
    job_domain: "domain status/selectability",
    job_domain_alias: "domain alias normalization/vectors",
  };
  return `corpus moved in: ${diff.map((c) => `${c} (${why[c]})`).join(", ")}`;
}

// ─────────────────────────────────────────────────────────────────────────────────────
// RETRIEVAL SEMANTICS
// ─────────────────────────────────────────────────────────────────────────────────────

/**
 * WHICH PREDICATES PRODUCTION ACTUALLY APPLIES to a skill alias, right now.
 *
 * This exists so a promotion gate can ask "is this skill reachable?" without hard-coding an
 * answer that goes stale the moment the retrieval SQL changes.
 *
 * ── WHY NOT JUST REQUIRE is_searchable ──
 *
 * Because today that would be WRONG, and confidently so. All 98 active-catalogue aliases
 * have `is_searchable = false` while no retrieval path filters on it, so they are fully
 * retrievable — measured: `fitting` and `gauge` both return rank 1 at cosine 1.0000 through
 * production's own statement. A gate requiring the flag today would block every active
 * skill for a reason that is not true yet.
 *
 * And requiring it LATER, manually, is the other half of the same trap: someone adds
 * `AND sa.is_searchable` to the repository and the gate keeps judging by the old rule, so a
 * skill passes promotion while being unreachable in production.
 *
 * So the flags below are PINNED BY A TEST against the production SQL. Adding the predicate
 * to `skills.repository.ts` fails that test until `requiresSearchable` is flipped here —
 * and flipping it automatically tightens the promotion gate in the same commit. The two
 * cannot drift.
 */
export interface RetrievalSemantics {
  /** `sa.embedding IS NOT NULL` — the ANN stage needs a vector. */
  readonly requiresEmbedding: boolean;
  /** `s.status = 'active'` — Gate A. */
  readonly requiresActiveSkill: boolean;
  /** `jds.status = 'active'` — the canonical path's edge filter. */
  readonly requiresActiveEdge: boolean;
  /** `sa.is_searchable` — NOT applied today. See the note above. */
  readonly requiresSearchable: boolean;
}

/**
 * The semantics in force on `origin/main`, verified against the SQL by
 * `corpus-fingerprint.test.ts`. Change these only together with the SQL.
 */
export const PRODUCTION_RETRIEVAL_SEMANTICS: RetrievalSemantics = {
  requiresEmbedding: true,
  requiresActiveSkill: true,
  requiresActiveEdge: true,
  requiresSearchable: false,
};

/** One alias, reduced to the facts the semantics test against. */
export interface AliasReachabilityFacts {
  readonly hasEmbedding: boolean;
  readonly isSearchable: boolean;
}

/** How many of a skill's aliases production could actually return, under `semantics`. */
export function reachableAliasCount(
  aliases: readonly AliasReachabilityFacts[],
  semantics: RetrievalSemantics = PRODUCTION_RETRIEVAL_SEMANTICS,
): number {
  return aliases.filter(
    (a) =>
      (!semantics.requiresEmbedding || a.hasEmbedding) &&
      (!semantics.requiresSearchable || a.isSearchable),
  ).length;
}

/**
 * Derive the semantics a piece of SQL actually implements.
 *
 * Used by the pin test, not at runtime: a gate that re-parsed production SQL on every run
 * would be clever and unreviewable. Here it is a fixture that makes drift a test failure.
 */
export function retrievalSemanticsFromSql(sqlText: string): Omit<RetrievalSemantics, never> {
  const s = sqlText.toLowerCase().replace(/\s+/g, " ");
  return {
    requiresEmbedding: /sa\.embedding is not null/.test(s),
    requiresActiveSkill: /s\.status = 'active'|s\.status = any/.test(s),
    requiresActiveEdge: /jds\.status = 'active'/.test(s),
    requiresSearchable: /sa\.is_searchable/.test(s),
  };
}
