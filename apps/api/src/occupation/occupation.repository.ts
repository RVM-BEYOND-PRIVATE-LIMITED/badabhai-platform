/**
 * Data access for occupation retrieval — the catalogue load, the version sentinel, and
 * layer L2.
 *
 * WHAT IS NOT HERE, DELIBERATELY. Layer L3 (vector ANN) already exists as
 * `SkillsRepository.nearestDomains`, complete with the ANN-first CTE, the measured
 * overfetch bounds and the partial-index predicate that took a rewrite to get right.
 * `OccupationService` calls that method. Writing a second copy here would be a second
 * embedder-shaped mistake: two queries against one index, drifting apart, only one of them
 * covered by the EXPLAIN-plan test.
 *
 * Layers L0 and L1 are not here either — they are served from the in-process snapshot
 * (`OccupationIndexService`) and never touch Postgres. That is the entire point of them.
 *
 * PRIVACY: reads public reference data. The one method that receives worker text is
 * `trigramCandidates`, which passes it as a bound parameter and never logs it.
 */
import { createHash } from "node:crypto";

import { Inject, Injectable } from "@nestjs/common";
import { sql } from "drizzle-orm";
import type { Database } from "@badabhai/db";

import { DATABASE } from "../database/database.module";
import type { IndexAliasRow, IndexDomainRow } from "./occupation-index";

/**
 * How similar a word has to be before pg_trgm will return it at all.
 *
 * DELIBERATELY BELOW THE DEFAULT of 0.6. The default is tuned for "did the user typo a
 * known string"; this is tuned for "generate candidates and let calibration decide". The
 * L2 anchor table maps a raw 0.35 onto a confidence of 0.30 — well under
 * `DISAMBIGUATE_FLOOR` — so a weak hit is already destined to be discarded. Leaving the
 * threshold at 0.6 would mean those anchors describe scores the database can never emit,
 * and the calibration curve below 0.6 would be decorative.
 *
 * It is a floor on NOISE, not on acceptance: nothing is auto-pinned from L2 alone at these
 * scores, and the ceiling on how many candidates come back is the LIMIT, not the threshold.
 */
const TRIGRAM_THRESHOLD = 0.3;

export interface TrigramCandidate {
  readonly jobDomainId: string;
  /** `word_similarity` of the best-matching alias for this domain, in [0,1]. */
  readonly rawScore: number;
}

@Injectable()
export class OccupationRepository {
  constructor(@Inject(DATABASE) private readonly db: Database) {}

  /**
   * A cheap value that changes whenever the catalogue does.
   *
   * WHAT IT CATCHES: new or deleted aliases (the counts move), a re-seed (`job_domain`
   * carries `updated_at` and the seeder upserts), and a `db:normalize:aliases` run (the
   * searchable count moves as `is_searchable` is recomputed).
   *
   * WHAT IT DOES NOT CATCH, stated rather than glossed: an in-place `UPDATE` of an alias's
   * `text` with no other change. `job_domain_alias` has no `updated_at`, and adding one
   * that nothing writes would be a column pretending to a guarantee it does not offer —
   * the same defect as `question_pack.content_hash`. Every supported path to changing alias
   * text goes through the seeder, which touches `job_domain.updated_at`. A hand-edited row
   * is picked up by the next scheduled refresh regardless, within 15 minutes.
   */
  async catalogVersion(): Promise<string> {
    const rows = await this.db.execute(sql`
      SELECT
        (SELECT count(*) FROM job_domain_alias)                        AS alias_total,
        (SELECT count(*) FROM job_domain_alias WHERE is_searchable)    AS alias_searchable,
        (SELECT count(*) FROM job_domain WHERE selectable AND status = 'active') AS domain_active,
        (SELECT max(updated_at) FROM job_domain)                       AS domain_touched,
        (SELECT max(created_at) FROM job_domain_alias)                 AS alias_created,
        (SELECT count(*) FROM profiling_family_binding)                AS bindings
    `);
    const r = (rows as unknown as Array<Record<string, unknown>>)[0] ?? {};
    return [
      r.alias_total,
      r.alias_searchable,
      r.domain_active,
      r.domain_touched instanceof Date ? r.domain_touched.toISOString() : String(r.domain_touched),
      r.alias_created instanceof Date ? r.alias_created.toISOString() : String(r.alias_created),
      r.bindings,
    ].join(":");
  }

  /**
   * Every occupation a worker may be matched to.
   *
   * Filtered on `selectable AND status='active'` — the SOURCE OF TRUTH — rather than on
   * `is_searchable`, which is a materialized projection refreshed by a separate runner and
   * may be stale. Aliases are filtered on `is_searchable` because there the flag carries
   * information the source columns do not (shadowing, and which duplicate won), and a
   * stale flag there costs one redundant index entry rather than a wrong match.
   */
  async loadDomains(): Promise<IndexDomainRow[]> {
    const rows = await this.db.execute(sql`
      SELECT job_domain_id, label_en, label_hi, isco_unit_code
      FROM job_domain
      WHERE selectable = true AND status = 'active'
    `);
    return (
      rows as unknown as Array<{
        job_domain_id: string;
        label_en: string;
        label_hi: string | null;
        isco_unit_code: string | null;
      }>
    ).map((r) => ({
      jobDomainId: r.job_domain_id,
      labelEn: r.label_en,
      labelHi: r.label_hi,
      iscoUnitCode: r.isco_unit_code,
    }));
  }

  /**
   * The retrieval surface: every alias that should be reachable from a worker's words.
   *
   * RETURNS `text`, NOT `text_norm`. The index normalizes what it is given, so handing it
   * the raw text means the snapshot is built under the CURRENT particle list rather than
   * whatever list was in force the last time `db:normalize:aliases` ran. A stale
   * `text_norm` would make L0 miss silently — the exact drift `normalizeOccupationText`
   * exists to prevent, reintroduced by trusting a cached copy of its own output.
   */
  async loadAliases(): Promise<IndexAliasRow[]> {
    const rows = await this.db.execute(sql`
      SELECT job_domain_id, text
      FROM job_domain_alias
      WHERE is_searchable
    `);
    return (rows as unknown as Array<{ job_domain_id: string; text: string }>).map((r) => ({
      jobDomainId: r.job_domain_id,
      text: r.text,
    }));
  }

  /** The family bindings, for resolving each occupation's family once per refresh. */
  async loadBindings(): Promise<
    Array<{
      familyId: string;
      jobDomainId: string | null;
      iscoUnitCode: string | null;
      iscoMinorCode: string | null;
      iscoSubmajorCode: string | null;
      iscoMajorCode: string | null;
      isUniversal: boolean;
    }>
  > {
    const rows = await this.db.execute(sql`
      SELECT family_id, job_domain_id, isco_unit_code, isco_minor_code,
             isco_submajor_code, isco_major_code, is_universal
      FROM profiling_family_binding
    `);
    return (
      rows as unknown as Array<{
        family_id: string;
        job_domain_id: string | null;
        isco_unit_code: string | null;
        isco_minor_code: string | null;
        isco_submajor_code: string | null;
        isco_major_code: string | null;
        is_universal: boolean;
      }>
    ).map((r) => ({
      familyId: r.family_id,
      jobDomainId: r.job_domain_id,
      iscoUnitCode: r.isco_unit_code,
      iscoMinorCode: r.isco_minor_code,
      iscoSubmajorCode: r.isco_submajor_code,
      iscoMajorCode: r.isco_major_code,
      isUniversal: r.is_universal,
    }));
  }

  /**
   * The families' vernacular labels — the chip's fallback when an occupation has no
   * vernacular name of its own.
   *
   * Only 348 of 2,156 blue-collar occupations own an alias that is not just their English
   * title, and `job_domain.label_hi` is NULL for every row in the catalogue. The families
   * are where the Hindi actually lives (all 101 have `label_hi`, enforced by
   * `db:verify:packs`), and a chip is a family-level choice anyway.
   */
  async loadFamilyLabels(): Promise<Map<string, string | null>> {
    const rows = await this.db.execute(sql`
      SELECT family_id, label_hi FROM profiling_family
    `);
    return new Map(
      (rows as unknown as Array<{ family_id: string; label_hi: string | null }>).map((r) => [
        r.family_id,
        r.label_hi,
      ]),
    );
  }

  /**
   * The NEGATIVE CACHE probe: has this phrase already been recorded as reaching nothing?
   *
   * The plan's caching table names `unresolved_phrase` as the negative cache, with "ops sets
   * `status='resolved'`" as its only invalidation. So an OPEN row in the `occupation` scope
   * means "known miss, nobody has authored an alias for it yet" — and rediscovering that
   * with a trigram scan plus possibly an ANN probe is pure waste on a phrase workers repeat.
   *
   * MATCHED ON THE NORMALIZED FORM, which is why `OccupationService.recordUnresolved` writes
   * the normalized form. Matching raw text would miss "Silai ka kaam!" against a stored
   * "silai", and the cache would never hit for the same phrase said twice — a cache that
   * silently never hits looks exactly like a cache that is working.
   *
   * `status` is checked, not just the row's existence: once ops resolves a phrase the queue
   * keeps the row for its count history, and a resolved row must stop suppressing anything.
   */
  async isKnownUnresolved(phraseNorm: string): Promise<boolean> {
    const rows = await this.db.execute(sql`
      SELECT 1 FROM unresolved_phrase
      WHERE scope = 'occupation' AND status = 'open' AND phrase = ${phraseNorm}
      LIMIT 1
    `);
    return (rows as unknown as unknown[]).length > 0;
  }

  /**
   * Layer L2 — trigram similarity over the normalized alias text.
   *
   * `word_similarity(query, target)` is ASYMMETRIC and that is why it is used: it asks how
   * well the query matches the best-matching *word sequence inside* the target. A worker
   * says "welding"; the alias is "Welder, Gas Cutting Operations". The short query must be
   * allowed to match a fragment of a long alias without being penalised for the rest of it.
   *
   * ── THIS QUERY DOES NOT USE A TRIGRAM INDEX, AND THAT IS MEASURED, NOT ASSUMED ──
   *
   * An earlier version of this comment claimed `%>` was chosen so GIN could serve it. That
   * is false, and EXPLAIN says so. Against the seeded catalogue (9,121 aliases, 5,086
   * searchable):
   *
   *     text_norm %  q   Bitmap Index Scan on ..._text_norm_trgm_idx    3.5 ms
   *     q <% text_norm   Index Only Scan on the unique index + Filter  22.9 ms
   *     q %> text_norm   identical to the above                        22.9 ms
   *
   * The word-similarity operators (`<%`, `%>`) are served by NEITHER the existing GIN index
   * nor a GiST `gist_trgm_ops` index built specifically to test it — with a GiST index
   * present the plan is unchanged, and with seq/index/index-only scans all disabled the
   * planner still reaches for the unique index rather than either trigram index.
   *
   * ── THE FILTER AND THE SCORE MUST RUN IN THE SAME DIRECTION ──
   *
   * `<%`, NOT `%>`. They are commutators of each other, so this is not a stylistic choice:
   *
   *     A <% B   is   word_similarity(A, B) > threshold
   *     A %> B   is   word_similarity(B, A) > threshold
   *
   * The SELECT ranks on `word_similarity(queryNorm, text_norm)`, so the WHERE must admit
   * rows on the SAME expression or it filters by one measure and ranks by another. As first
   * merged this used `%>`, which asks whether the ALIAS matches a fragment of the WORKER'S
   * SENTENCE — the reverse of the question this layer exists to ask. Measured on the seeded
   * catalogue, aliases admitted at the same threshold:
   *
   *     query           %> (as merged)   <% (correct)   dropped by %>
   *     silai                        9             74             65
   *     welding                     19            186            168
   *     bijli                        5             44             39
   *     kharad                       7              8              2
   *
   * and the reason, in one pair of numbers:
   *
   *     word_similarity('welding', 'welder gas cutting operations') = 0.5000
   *     word_similarity('welder gas cutting operations', 'welding') = 0.1875
   *
   * L2 was running, returning rows, and scoring them correctly — while discarding ~90% of
   * the candidates it should have considered. Nothing failed; the layer was just quietly
   * bad at its job.
   *
   * ── WHY NOT JUST USE `%`, WHICH IS INDEXED AND 6x FASTER ──
   *
   * `%` divides by the union of both trigram sets, so a short query against a long official
   * title scores low — the multi-word Hinglish phrase is precisely the case it drops, and
   * that case is the reason this layer exists. A 6x speedup that loses the inputs the layer
   * was built for is not a speedup.
   *
   * ── THE OPEN RISK, STATED ──
   *
   * The plan's performance criterion is "L2 trigram ≤ 15 ms at 30k aliases". This is 23 ms
   * at 5k. It is comfortably inside the ≤400 ms per-turn budget today and L2 only runs when
   * L0 and L1 both miss, but that criterion will NOT be met by scaling this query as-is.
   * Phase 9 owns performance calibration; the fallback if it becomes hot is a two-stage
   * pass — an index-served `%` prefilter UNIONed with a bounded `<%` pass over a narrowed
   * candidate set — never a silent switch to `%` alone.
   *
   * Deduped to the best alias per domain by `max`, for the same reason L3 dedupes: a domain
   * with forty aliases would otherwise fill the shortlist with itself.
   */
  async trigramCandidates(queryNorm: string, k: number): Promise<TrigramCandidate[]> {
    const rows = await this.db.transaction(async (tx) => {
      // `SET LOCAL` needs a transaction — outside one it warns and does nothing, and a
      // plain `SET` would leak into the next user of this pooled connection. Not a bound
      // parameter: `SET` does not accept them. The value is a module constant.
      await tx.execute(
        sql`SET LOCAL pg_trgm.word_similarity_threshold = ${sql.raw(String(TRIGRAM_THRESHOLD))}`,
      );
      return tx.execute(sql`
        SELECT a.job_domain_id,
               max(word_similarity(${queryNorm}, a.text_norm)) AS score
        FROM job_domain_alias a
        JOIN job_domain d ON d.job_domain_id = a.job_domain_id
        WHERE a.is_searchable
          AND ${queryNorm} <% a.text_norm
          AND d.selectable = true AND d.status = 'active'
        GROUP BY a.job_domain_id
        ORDER BY score DESC
        LIMIT ${k}
      `);
    });
    return (
      rows as unknown as Array<{ job_domain_id: string; score: string | number }>
    ).map((r) => ({ jobDomainId: r.job_domain_id, rawScore: Number(r.score) }));
  }
}

/**
 * The catalogue version as an EVENT PAYLOAD may carry it: ≤64 characters, stable, opaque.
 *
 * WHY A PROJECTION AND NOT THE VALUE ITSELF. `catalogVersion()` above is a CACHE-INVALIDATION
 * SIGNATURE, and its six-field shape is load-bearing for that job — two of those fields are ISO
 * timestamps, so the composite is structurally ~75 characters and can only grow. The event
 * contract caps `catalog_version` at 64. Those two requirements are not in tension by accident:
 * one wants to change whenever anything changes, the other wants to fit in a column and group a
 * histogram. They are different values and this is the seam between them.
 *
 * IT SHIPPED BROKEN AND ONLY A LIVE RUN FOUND IT. Passing the composite straight through made
 * `profile.occupation_unresolved` fail its own payload schema, which threw inside the event
 * emitter, which 500'd `POST /chat/message` — for EVERY worker whose trade did not resolve on
 * the first try. Every unit test passed: none of them built a real catalogue, so none of them
 * ever produced a version string longer than the fixture's.
 *
 * Opaque on purpose. A truncation of the composite would look readable while silently colliding
 * whenever two catalogues shared a prefix — which they always do, since the first three fields
 * are counts. A digest changes if any input byte changes, which is exactly the grouping key the
 * Phase 9 sweep wants.
 *
 * `unknown` for a missing version is the SAME sentinel the emitters already used, kept so a
 * degraded seam stays distinguishable from a real release rather than acquiring a fake one.
 */
export function catalogVersionForEvent(catalogVersion: string | null | undefined): string {
  if (!catalogVersion) return "unknown";
  return `cat_${createHash("sha256").update(catalogVersion).digest("hex").slice(0, 32)}`;
}
