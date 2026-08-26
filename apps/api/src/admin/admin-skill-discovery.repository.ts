import { Inject, Injectable } from "@nestjs/common";
import {
  and,
  asc,
  count,
  desc,
  eq,
  gt,
  gte,
  inArray,
  like,
  lt,
  lte,
  notInArray,
  or,
  sql,
  type SQL,
} from "drizzle-orm";
import {
  jobDomains,
  skillCandidateMatches,
  skillCandidateSources,
  skillCandidates,
  skills,
  type Database,
  type SkillCandidateAction,
  type SkillCandidateConfidenceBand,
  type SkillCandidateEmbeddingStatus,
  type SkillCandidateSourceType,
  type SkillCandidateStatus,
  type SkillKind,
  type SkillStatus,
} from "@badabhai/db";
import { DATABASE } from "../database/database.module";
import type { AdminCountBucket } from "./admin-dashboard.dto";
import type { EntityCursor } from "./admin-entities.cursor";
import type {
  AdminSkillCandidateMatchRow,
  AdminSkillCandidateSource,
  AdminSkillDiscoveryRow,
  AdminSkillDiscoverySort,
  AdminSkillMatchStrength,
  AdminSkillPhraseClass,
  AdminSkillReviewTier,
} from "./admin-skill-discovery.dto";

/**
 * DATA ACCESS ONLY for the admin SKILL DISCOVERY REVIEW surface (migration 0093 — the four
 * tables `skill_discovery_run`, `skill_candidate`, `skill_candidate_source`,
 * `skill_candidate_match`). Four reads and ONE guarded write, and nothing else lives here: no
 * ladder, no tier derivation, no densification, no audit emit. CLAUDE.md §4.
 *
 * ── THE TAXONOMY IS NOT WRITTEN FROM THIS FILE, AND CANNOT BE ───────────────────────────
 * There is no statement here against `skill`, `skill_alias` or `job_domain_skill`, and there
 * must never be one. `skill` is READ exactly once, for a label ({@link listMatches}), and that
 * read is a `select`. An approval RECORDS A DECISION on `skill_candidate` and stops; the corpus
 * write stays in the offline guarded chain that already has a human in it
 * (`approvedCandidateToCorpusSkill` -> `validateTaxonomyCorpus` -> `taxonomyQualityVerdict` -> a
 * human commit -> `db:seed:domain-skills` -> `db:promote:skills` C1..C5).
 *
 * That is why `resulting_skill_id` is only ever written here from a value the REVIEWER named for
 * an `alias`/`merge`, and never for an `approved_create`: on a create it stays NULL until the
 * chain actually mints the row and somebody backfills it, which makes the column the honest
 * answer to "did this approval ever ship?". A repository that filled it in at decision time
 * would turn that honest answer into a lie, in the one place nobody re-reads.
 *
 * ── PROVENANCE IS FROZEN, EXPRESSED AS A CLOSED `set` LIST ──────────────────────────────
 * {@link recordDecision} builds its patch from NAMED KEYS, one per column, and never spreads its
 * input. There is therefore no key path from a request body to any of the 19 `PROVENANCE_FIELDS`
 * (skill-discovery-candidate.ts:240), and adding one would be a visible edit to a list a
 * reviewer can read in ten seconds. The service still owes `assertProvenanceIntact(before,
 * after)` and must NEVER recompute a stored `provenance_digest` to "fix" a mismatch — that
 * launders exactly the lineage lie the digest exists to expose.
 *
 * ── OPTIMISTIC CONCURRENCY LIVES IN THE `WHERE`, NOT IN A PRE-READ ──────────────────────
 * Two reviewers open the same candidate; both decide. The second write must NOT win silently.
 * {@link recordDecision}'s WHERE carries `status = <expectedStatus>` — the status the reviewer
 * was actually looking at — so a racer matches ZERO rows and gets `undefined` back, which the
 * service reports as a 409 rather than overwriting the first human's authorship. A read-then-
 * write would be a TOCTOU with the same code and none of the protection; the guard belongs in
 * the statement for the reason `admin-actions.repository.ts:41-44` states it there.
 *
 * `status` is a COMPLETE concurrency token on this ladder, which is why no `updated_at`/ETag
 * token appears here: every legal transition changes `status` and `canTransition` admits no
 * self-transition, while a timestamp token is a measured trap on this stack — Postgres keeps
 * microseconds and a JS `Date` keeps milliseconds (migration 0083, reproduced at
 * admin-keyset-params.test.ts:227-257), so it would either never match or match by luck.
 *
 * ── THE 0083 TRAP IS ACUTE ON THIS TABLE, NOT THEORETICAL ───────────────────────────────
 * `skill_candidate.created_at` defaults to `now()`, which is the TRANSACTION timestamp — so
 * every candidate a single discovery run writes shares ONE `created_at`, to the microsecond. A
 * cursor minted from `row.created_at.toISOString()` (milliseconds) then sits strictly BELOW the
 * rows it describes: `created_at = $1` is false for all of them and `created_at < $1` is false
 * too, so page two comes back EMPTY and an entire run becomes unreachable through the queue. The
 * `id` tie-breaker cannot save it — both keyset terms fail.
 *
 * Hence the ai-traces device, copied deliberately (admin-ai-traces.repository.ts:140-159): the
 * sort key is rendered BY POSTGRES at microsecond precision via `to_char(... .US ...)` and
 * returned beside each row ({@link AdminSkillDiscoveryQueueRow.sortKey}), and the cursor is
 * bound back through `::text::timestamptz`. `.US` and not `.MS`: milliseconds would truncate
 * exactly as the `Date` did.
 *
 * ── NO ROW MULTIPLICATION ON THE QUEUE READ ─────────────────────────────────────────────
 * `has_strong_match` and the source-type filter are `EXISTS` subqueries, never joins. A join to
 * `skill_candidate_match` multiplies a candidate by its match count, which would put duplicate
 * rows on the page and make `limit` mean nothing — and `limit` is what the keyset cursor is
 * computed from, so the paging would be wrong as well as the page.
 *
 * They are written as `sql` fragments rather than with drizzle's `exists()` helper for a
 * testability reason worth stating: `exists()` takes a SUBQUERY BUILDER, i.e. it needs a live
 * `this.db.select(...)` at predicate-build time, and the shared SQL-shape stubs
 * (`./testing/query-capture`, `admin-keyset-params.test.ts`) hand the repository a chain object
 * that is not an `SQLWrapper`. Every value inside these fragments is interpolated, so it is a
 * BOUND PARAMETER (`$n`) and not text — the property `admin-directory.test.ts:319-324` asserts
 * by checking `c.params`, and the property BP-1 is about.
 *
 * ── WHAT THIS FILE DELIBERATELY DOES NOT COMPUTE ────────────────────────────────────────
 *   * `review_tier`. Derived by `reviewTier` (skill-discovery-plan.ts:764) from exactly two
 *     facts. The queue's `tier` FILTER is composed from those same two facts here
 *     ({@link TIER_PREDICATES}) because a filter has to be SQL; the tier VALUE on a row and the
 *     tier BREAKDOWN on the metrics tile stay the service's, from one call site. A
 *     `phrase_class IN (...)` shortcut is refused outright: it would be a second definition of
 *     `reviewTier` that disagrees with the first the moment the strong-match half matters —
 *     which is on every `OCCUPATION_ONLY` candidate that happens to have an exact surface hit.
 *   * `reviewPriority`'s weights. Its own module says not to reimplement them in SQL because
 *     they will drift, and a page sorted by them would be priority-ordered only WITHIN an
 *     arbitrary time slice.
 *   * DENSIFIED buckets. The GROUP BYs below return only the keys that HAVE rows; emitting a
 *     zero for every enum member is presentation and belongs one layer up.
 *
 * ── RLS ────────────────────────────────────────────────────────────────────────────────
 * All four tables are `.enableRLS()` + FORCE + REVOKE ALL FROM PUBLIC/anon/authenticated/
 * service_role, with ZERO policies (migration 0093). Reached through the owner connection this
 * repository is injected with, they read normally; reached through a Supabase anon or
 * service_role client they return ZERO ROWS AND NO ERROR — a silently-empty queue that is
 * indistinguishable on screen from "nothing to review". If this surface ever looks empty, that
 * is the first thing to check and the `DATABASE` token is where to check it.
 *
 * ── MIGRATION 0093 IS AUTHORED, NOT APPLIED ────────────────────────────────────────────
 * Journalled at idx 93; the migration header records 0092 as the applied head. Whether the four
 * tables exist on a given cluster is a runtime question this repo answers by hand (`--doctor`),
 * never by "merged". Nothing here requires them to exist at COMPILE time, and the SQL-shape
 * tests touch no database.
 */

// ══════════════════════════════════════════════════════════════════════════════════════════
// Repository-only row types
// ══════════════════════════════════════════════════════════════════════════════════════════

/**
 * One queue row PLUS the keyset sort key, as a PAIR rather than as a widened row.
 *
 * The shape is `AdminAiTraceListRow`'s, and the split is the point: `sortKey` is a PAGING
 * artefact, not a field of the candidate, and the wire contract
 * ({@link AdminSkillDiscoveryRow}) has no key for it — so leaking it into a response is a
 * compile error rather than a review catch. The service mints the cursor from `sortKey` and from
 * nothing else; `row.created_at` is a millisecond `Date` for DISPLAY, and using it for a cursor
 * is the 0083 bug described in the header.
 *
 * ⚠ OWED DTO CHANGE, named rather than worked around: `AdminSkillDiscoveryRow` is defined in the
 * dto as an `Omit` of the wire item, so it has no home for a sort key and this pair type has to
 * live here. It belongs beside its sibling repository-only types
 * (`AdminSkillCandidateMatchRow`, `AdminSkillCandidateTierFacts`) in
 * `admin-skill-discovery.dto.ts`.
 */
export interface AdminSkillDiscoveryQueueRow {
  row: AdminSkillDiscoveryRow;
  /** `2026-08-26T12:00:00.000600Z` — rendered by Postgres, at microsecond precision. */
  sortKey: string;
}

/**
 * Every STORED column the detail read and the record assembler need, and no derived ones.
 *
 * It carries three groups the queue row does not: the reviewer-facing extras
 * (`proposed_description`, `review_reason`), the provenance fields the response nests under
 * `provenance`, and the three that exist ONLY so the service can assemble a
 * `SkillCandidateRecord` for `validateCandidate` / `assertProvenanceIntact` — `confidence`,
 * `approved_job_domain_ids`, `approved_requirement`.
 *
 * ⚠ Also an owed dto type, for the same reason as {@link AdminSkillDiscoveryQueueRow}.
 */
export interface AdminSkillCandidateDetailRow extends AdminSkillDiscoveryRow {
  proposed_description: string | null;
  review_reason: string | null;
  classifier_rule: string;
  occupation_heads: string[];
  evidence_tokens: string[];
  embedding_status: SkillCandidateEmbeddingStatus;
  model: string | null;
  prompt_version: string | null;
  corpus_fingerprint: string;
  provenance_digest: string;
  confidence: number | null;
  approved_job_domain_ids: string[];
  approved_requirement: "required" | "preferred";
  /**
   * `created_at` AS A STRING, rendered by Postgres at microsecond precision.
   *
   * `provenanceDigest` hashes 19 fields in a declared order and `created_at` is one of them, as
   * the STRING the writer stored. Round-tripping it through a `Date` and re-serializing changes
   * the fractional-second precision, and then EVERY digest check fails — so the string can only
   * be made inside the query, which is why it is here and not in the assembler.
   *
   * ⚠ AND THE PRECISION IS LOAD-BEARING, WHICH COST A ROUND TO LEARN. This is rendered by
   * {@link AdminSkillDiscoveryRepository.PROVENANCE_CREATED_AT} at THREE fractional digits, not
   * by the six-digit cursor key beside it, because the writer (`db:persist:discovery-run`,
   * inserting `startedAt.toISOString()` — discover-skills.ts:246) hashed a three-digit string.
   * Rendering six produced `...:59.123000Z` against a digest taken over `...:59.123Z`, so
   * PROVENANCE_DIGEST_MISMATCH fired on every row and the decision path refused every
   * legitimate decision. Pinned in both directions by `skill-discovery.provenance.test.ts`.
   */
  created_at_iso: string;
}

/**
 * The two match-derived facts for ONE candidate, fetched for a whole page in one round trip.
 *
 * WHY NOT SCALAR SUBQUERIES IN THE QUEUE PROJECTION, which would make it one query: because the
 * dto draws the line exactly here — `AdminSkillDiscoveryRow` is `Omit<..., "review_tier" |
 * "has_strong_match" | "related_skill_count">`, i.e. the repository returns stored columns and
 * the service derives the rest. Honouring that keeps `has_strong_match` a fact with ONE
 * producer, which is what stops the tier from being computed two ways.
 *
 * `AdminSkillCandidateTierFacts` in the dto pairs `phrase_class` with `has_strong_match`; the
 * service assembles it from the page row's own `phrase_class` and this row. Re-reading
 * `phrase_class` here would mean joining `skill_candidate` back onto its own child aggregate to
 * fetch a column the caller is already holding.
 */
export interface AdminSkillCandidateMatchFacts {
  candidate_id: string;
  has_strong_match: boolean;
  related_skill_count: number;
}

/**
 * Per-`phrase_class` counts, split by whether the candidate has a strong match — the two facts
 * `reviewTier` reads, aggregated.
 *
 * SHAPED THIS WAY so the metrics tile's tier breakdown goes through the SAME `reviewTier` the
 * row-level one does: the service calls it twice per row (once for the strong-match half, once
 * for the other) and sums. A `GROUP BY <tier expression>` in SQL would have been a third copy of
 * the tier rule, in the layer least able to be tested against the first two.
 */
export interface AdminSkillPhraseClassTierFacts {
  phrase_class: string;
  with_strong_match: number;
  without_strong_match: number;
}

/** The raw aggregate facts behind the metrics tiles. SPARSE — densification is the service's. */
export interface AdminSkillDiscoveryMetricFacts {
  by_status: AdminCountBucket<SkillCandidateStatus>[];
  by_band: AdminCountBucket<SkillCandidateConfidenceBand>[];
  by_proposed_action: AdminCountBucket<SkillCandidateAction>[];
  by_phrase_class: AdminSkillPhraseClassTierFacts[];
  /** `min(created_at)` over the statuses the CALLER calls awaiting. `null` when none are. */
  oldest_awaiting_created_at: Date | null;
}

/** The queue's filter set, already validated and coerced by the pipe. */
export interface AdminSkillDiscoveryFilter {
  status?: SkillCandidateStatus[];
  tier?: AdminSkillReviewTier;
  band?: SkillCandidateConfidenceBand;
  proposedAction?: SkillCandidateAction;
  tradeFamily?: string;
  sourceType?: SkillCandidateSourceType;
  runId?: string;
  clusterKey?: string;
  /** Already `.trim().toLowerCase()`d by the pipe. Matched as an ANCHORED prefix. */
  phrase?: string;
  createdFrom?: Date;
  createdTo?: Date;
}

/**
 * Everything one decision writes, named column by column.
 *
 * IT IS NOT THE REQUEST BODY AND MUST NOT BECOME IT. `nextStatus` is `statusForDecision`'s
 * answer (skill-discovery-candidate.ts:153 — "the ONE place decision -> status lives"),
 * `reviewerAdminId` is `@CurrentAdmin().id` from the session, `reviewedAt` is the server clock.
 * An actor a caller can type is not an actor, and this row is the audit trail for a taxonomy
 * decision that outlives everyone in it.
 *
 * The optional five are `undefined` on the branches that must not set them — the discriminated
 * union in the dto is what makes "a `create` carrying a `resultingSkillId`" unrepresentable, and
 * {@link AdminSkillDiscoveryRepository.recordDecision} only writes a key it is given.
 */
export interface AdminSkillDecisionWrite {
  candidateId: string;
  /** The concurrency token: the status the reviewer was looking at. Goes in the WHERE. */
  expectedStatus: SkillCandidateStatus;
  nextStatus: SkillCandidateStatus;
  reviewerAdminId: string;
  reviewedAt: Date;
  reviewReason: string;
  resultingSkillId?: string;
  proposedSkillName?: string;
  proposedDescription?: string;
  approvedJobDomainIds?: string[];
  approvedRequirement?: "required" | "preferred";
}

// ══════════════════════════════════════════════════════════════════════════════════════════
// Vocabulary constants used in predicates
// ══════════════════════════════════════════════════════════════════════════════════════════

/**
 * The two `phrase_class` members and the one `strength` member `reviewTier` actually names.
 *
 * TYPED AGAINST THE UNIONS, not bare strings, so a rename in the mirrored vocabulary is a
 * compile error here rather than a filter that silently matches nothing. `phrase_class` is `text
 * NOT NULL` with NO DB CHECK (schema/skill-discovery.ts:285) — the closed set lives only in
 * TypeScript, so this is the only guard available.
 */
const PHRASE_CLASS_ACTIVITY: AdminSkillPhraseClass = "ACTIVITY_PHRASE";
const PHRASE_CLASS_AMBIGUOUS: AdminSkillPhraseClass = "AMBIGUOUS";
const STRENGTH_STRONG: AdminSkillMatchStrength = "strong";

@Injectable()
export class AdminSkillDiscoveryRepository {
  constructor(@Inject(DATABASE) private readonly db: Database) {}

  /**
   * Run `cb` inside ONE Drizzle transaction. The service uses it to commit the decision write
   * and its `admin.action_performed` event atomically — `events.emit({ ..., tx })` writes the
   * spine row on this same executor, so an emit throw rolls the decision back.
   *
   * Forgetting to pass the `tx` down is SILENT: `EmitParams.tx` is optional and the events
   * repository's executor defaults to the injected db, so an omitted `tx` compiles, passes unit
   * tests, and lands the event on a separate connection that survives a rollback. That is the H3
   * failure the atomicity test exists to prevent.
   */
  withTransaction<T>(cb: (tx: Database) => Promise<T>): Promise<T> {
    return this.db.transaction(cb as (tx: unknown) => Promise<T>);
  }

  // ─── keyset ──────────────────────────────────────────────────────────────────────────

  /**
   * The keyset predicate for one page, in the direction the caller asked for.
   *
   * DESC (`newest`): `created_at < c OR (created_at = c AND id < cid)`.
   * ASC  (`oldest`): `created_at > c OR (created_at = c AND id > cid)`.
   *
   * The `id` tie-breaker is what makes the order TOTAL, and it is doing all the work on this
   * table: one run's candidates all share one `created_at` (see the header), so at a page
   * boundary the equality branch is the ONLY branch that can be true.
   *
   * `lt`/`gt`/`eq` on the COLUMN against a `sql` cast — never a raw template holding a `Date`.
   * The two render identical SQL and differ only in the bound parameter: the template hands the
   * `Date` to postgres-js RAW, which is what made every cursor-bearing admin request 500 before
   * BP-1 while page one looked healthy (admin-keyset-params.test.ts).
   *
   * ⚠ THE CURSOR TOKEN DOES NOT CARRY THE DIRECTION. `encodeEntityCursor` writes `{c, i}` and
   * nothing else, so a token minted on a `newest` page and replayed with `sort=oldest` pages the
   * wrong way — the same rows again, ascending. The client must carry `sort` on every page-turn.
   * The dto records this as an owed cursor module for this surface.
   */
  private static keyset(sort: AdminSkillDiscoverySort, cursor: EntityCursor): SQL {
    const at = sql`${cursor.createdAt}::text::timestamptz`;
    const createdAtCol = skillCandidates.createdAt;
    const idCol = skillCandidates.candidateId;
    return sort === "oldest"
      ? or(gt(createdAtCol, at), and(eq(createdAtCol, at), gt(idCol, cursor.id)))!
      : or(lt(createdAtCol, at), and(eq(createdAtCol, at), lt(idCol, cursor.id)))!;
  }

  /**
   * The keyset sort key, rendered by POSTGRES at full microsecond precision.
   *
   * `to_char(...)` and not `::text`, because the cursor's contract is an ISO-8601 string
   * `decodeEntityCursor` can `Date.parse` — `::text` on a `timestamptz` emits Postgres's own
   * `2026-08-26 12:00:00.0006+00` form, which is not that. SELECTED, never computed in JS: by
   * the time a row reaches JS the microseconds are already gone.
   */
  private static readonly SORT_KEY = sql<string>`to_char(${skillCandidates.createdAt} at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`;

  /**
   * `created_at` RENDERED AT THE WRITER'S OWN PRECISION — THREE fractional digits, not six.
   *
   * ── THIS IS A DIFFERENT QUESTION FROM {@link SORT_KEY}, AND THE ANSWERS DIFFER ─────────
   * The cursor key asks "what orders this row?" and wants every digit Postgres kept. This asks
   * "what STRING did the writer hash?" — and the only correct answer is a byte-for-byte
   * reproduction of it, because `provenanceDigest` takes a sha256 over 19 values in a declared
   * order and `created_at` is one of them, AS THE STRING THE WRITER STORED
   * (skill-discovery-candidate.ts:271).
   *
   * The writer is `db:persist:discovery-run`, which inserts `c.created_at` — and that value is
   * `startedAt.toISOString()` (discover-skills.ts:246), i.e. ALWAYS exactly three fractional
   * digits and a `Z`. Rendering six here produced `...:59.123000Z` where the digest had been
   * taken over `...:59.123Z`, so `validateCandidate` returned PROVENANCE_DIGEST_MISMATCH on
   * EVERY candidate in the table.
   *
   * ── AND THE CONSEQUENCE IS WORSE THAN A BLOCKED DECISION ────────────────────────────────
   * It would NOT have blocked one. The decision path refuses only problems a write INTRODUCES
   * (`introducedProblems`, service.ts:774) — deliberately, so a row the pipeline already shipped
   * with a flaw is still decidable — so a mismatch present on the row BEFORE the decision is
   * filtered out as pre-existing. Every decision would have gone through, and the effect would
   * have been silent: the frozen-provenance check disabled for the entire table, permanently, by
   * a rendering choice; and `provenance_digest` — served precisely so a reader can tell that a
   * row's lineage still checks out — reporting "broken" on every row until nobody read it any
   * more. An integrity alarm that fires on everything is an integrity alarm that has been
   * switched off, and this one would have arrived switched off.
   *
   * ⚠ AND IT MUST NOT BE "FIXED" BY RECOMPUTING THE DIGEST. `provenance_digest` is served
   * precisely so a reader can tell that a row's lineage still checks out; re-deriving it on a
   * read path would launder the lie it exists to expose (dto:1268-1270). The rendering is what
   * moves, never the stored digest.
   *
   * ⚠ TRUNCATION IS NOT SILENT EITHER. A row whose `created_at` carries real microseconds could
   * only have come from a writer that did not use `toISOString()`; this renders `.123` where
   * that writer hashed `.123456`, so the digest MISMATCHES and the alarm fires — which is the
   * correct outcome, not a missed one. `admin-skill-discovery.provenance.test.ts` pins both
   * halves: the millisecond form reconciles, the microsecond form does not.
   */
  private static readonly PROVENANCE_CREATED_AT = sql<string>`to_char(${skillCandidates.createdAt} at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')`;

  // ─── EXISTS fragments ────────────────────────────────────────────────────────────────

  /**
   * "this candidate has at least one STRONG competing match" — one of the two facts `reviewTier`
   * reads, and the only one that is not a column.
   *
   * A correlated `EXISTS`, so a candidate contributes at most one row to the outer query. The
   * `strength` value is interpolated and therefore BOUND (`$n`), not inlined as text.
   */
  private static readonly HAS_STRONG_MATCH = sql`exists (
      select 1
        from ${skillCandidateMatches}
       where ${skillCandidateMatches.candidateId} = ${skillCandidates.candidateId}
         and ${skillCandidateMatches.strength} = ${STRENGTH_STRONG}
    )`;

  /** The negation, spelled out rather than wrapped, so the rendered SQL reads as it executes. */
  private static readonly HAS_NO_STRONG_MATCH = sql`not exists (
      select 1
        from ${skillCandidateMatches}
       where ${skillCandidateMatches.candidateId} = ${skillCandidates.candidateId}
         and ${skillCandidateMatches.strength} = ${STRENGTH_STRONG}
    )`;

  /**
   * THE TIER FILTER, transcribed from `reviewTier` (skill-discovery-plan.ts:764-769) branch for
   * branch:
   *
   *     if (phrase_class === "ACTIVITY_PHRASE") return "direct";
   *     if (matches.some(m => m.strength === "strong")) return "direct";
   *     if (phrase_class === "AMBIGUOUS") return "ambiguous";
   *     return "derived";
   *
   * THE BRANCH ORDER IS LOAD-BEARING, and it is why `ambiguous` and `derived` both carry
   * {@link HAS_NO_STRONG_MATCH}: an `AMBIGUOUS` candidate WITH a strong match is `direct`,
   * because the second `if` fires before the third. Dropping that term is the exact disagreement
   * a `phrase_class IN (...)` shortcut would introduce — and it would stay invisible until a
   * reviewer noticed one candidate appearing under two different tier filters.
   *
   * `notInArray` and not two `ne`s: `derived` is the FALL-THROUGH, so it must exclude both named
   * classes — and an unrecognised `phrase_class` (possible; no CHECK) then lands in `derived`
   * here, matching `reviewTier`'s own final `return "derived"`.
   */
  private static readonly TIER_PREDICATES: Readonly<Record<AdminSkillReviewTier, SQL>> = {
    direct: or(
      eq(skillCandidates.phraseClass, PHRASE_CLASS_ACTIVITY),
      AdminSkillDiscoveryRepository.HAS_STRONG_MATCH,
    )!,
    ambiguous: and(
      eq(skillCandidates.phraseClass, PHRASE_CLASS_AMBIGUOUS),
      AdminSkillDiscoveryRepository.HAS_NO_STRONG_MATCH,
    )!,
    derived: and(
      notInArray(skillCandidates.phraseClass, [PHRASE_CLASS_ACTIVITY, PHRASE_CLASS_AMBIGUOUS]),
      AdminSkillDiscoveryRepository.HAS_NO_STRONG_MATCH,
    )!,
  };

  /**
   * "has at least one source of this type" — an `EXISTS` for the same no-multiplication reason as
   * the tier, since a candidate has many sources by construction (that is what a cluster is).
   */
  private static hasSourceOfType(sourceType: SkillCandidateSourceType): SQL {
    return sql`exists (
      select 1
        from ${skillCandidateSources}
       where ${skillCandidateSources.candidateId} = ${skillCandidates.candidateId}
         and ${skillCandidateSources.sourceType} = ${sourceType}
    )`;
  }

  /**
   * An ANCHORED prefix pattern with the `LIKE` metacharacters escaped.
   *
   * WITHOUT THE ESCAPE THE ANCHOR IS DECORATIVE: the pipe bounds `phrase` to 80 characters of
   * arbitrary text, so `?phrase=%weld` would reach `LIKE '%weld%'` — an unanchored substring
   * search over a corpus that includes worker-derived wording, which is the one shape this
   * surface refuses (dto: "a leading-wildcard substring search ... is a discovery tool no matter
   * how the column is described"). `_` matters for the same reason on a snake_cased vocabulary.
   *
   * Backslash is the DEFAULT `LIKE` escape character in Postgres and `standard_conforming_strings`
   * is on, so no explicit `ESCAPE` clause is needed — the doubled backslash below is JS regex
   * syntax and exactly one backslash reaches the pattern.
   */
  private static prefixPattern(phrase: string): string {
    return `${phrase.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
  }

  // ─── the queue ───────────────────────────────────────────────────────────────────────

  /**
   * One keyset page of the review queue. `limit` is the caller's page size PLUS ONE — the service
   * over-fetches by one to tell "there is more" from "that was the last page", and an honest
   * `nextCursor` is the whole reason.
   *
   * ── WHICH FILTERS ARE INDEX-BACKED ────────────────────────────────────────────────────
   * `skill_candidate_queue_idx (status, confidence_band, source_domain_count)` is the intended
   * queue index and `status` + `band` are its leading columns, so the common console read ("the
   * two undecided statuses") is an index scan. `run_id`, `trade_family` and `(run_id,
   * cluster_key)` have their own indexes.
   *
   * TWO GAPS, NAMED SO THEY ARE A TASK AND NOT A SURPRISE: 0093 ships NO `(created_at, id)`
   * keyset index and NO index on `normalized_phrase`, so the default page order is a SORT over
   * the table and `phrase` is a scan. The owed pair is
   * `skill_candidate_admin_keyset_idx (created_at DESC NULLS FIRST, candidate_id DESC NULLS FIRST)`
   * and a `text_pattern_ops` index on `normalized_phrase`. `.nullsFirst()` is load-bearing on the
   * first: drizzle's bare `desc()` renders `DESC NULLS FIRST`, and an index built `NULLS LAST`
   * does not satisfy it, so the planner keeps the index for the filter and adds a Sort anyway
   * (packages/db/src/schema/feedback.ts:95-104). Both are additive to a migration that is
   * authored-but-unapplied, which is the cheapest moment they will ever be.
   *
   * The projection is an EXPLICIT column map. `confidence`, `review_reason`,
   * `proposed_description` and the provenance columns are deliberately absent — a queue row is an
   * index entry, and a bare `select()` would put every one of them one `return row` away from a
   * list response.
   */
  async list(
    filter: AdminSkillDiscoveryFilter,
    sort: AdminSkillDiscoverySort,
    cursor: EntityCursor | null,
    limit: number,
  ): Promise<AdminSkillDiscoveryQueueRow[]> {
    const clauses: SQL[] = [];

    // `inArray`, because "everything not yet decided" is TWO statuses and serving it as two
    // requests would mean two cursors that cannot be merged into one honest `nextCursor`.
    if (filter.status && filter.status.length > 0) {
      clauses.push(inArray(skillCandidates.status, filter.status));
    }
    if (filter.band) clauses.push(eq(skillCandidates.confidenceBand, filter.band));
    if (filter.proposedAction) {
      clauses.push(eq(skillCandidates.proposedAction, filter.proposedAction));
    }
    if (filter.tier) clauses.push(AdminSkillDiscoveryRepository.TIER_PREDICATES[filter.tier]);
    if (filter.tradeFamily) clauses.push(eq(skillCandidates.tradeFamily, filter.tradeFamily));
    if (filter.sourceType) {
      clauses.push(AdminSkillDiscoveryRepository.hasSourceOfType(filter.sourceType));
    }
    if (filter.runId) clauses.push(eq(skillCandidates.runId, filter.runId));
    if (filter.clusterKey) clauses.push(eq(skillCandidates.clusterKey, filter.clusterKey));
    if (filter.phrase) {
      clauses.push(
        like(
          skillCandidates.normalizedPhrase,
          AdminSkillDiscoveryRepository.prefixPattern(filter.phrase),
        ),
      );
    }
    if (filter.createdFrom) clauses.push(gte(skillCandidates.createdAt, filter.createdFrom));
    if (filter.createdTo) clauses.push(lte(skillCandidates.createdAt, filter.createdTo));
    if (cursor) clauses.push(AdminSkillDiscoveryRepository.keyset(sort, cursor));

    const query = this.db
      .select({
        candidateId: skillCandidates.candidateId,
        runId: skillCandidates.runId,
        clusterKey: skillCandidates.clusterKey,
        normalizedPhrase: skillCandidates.normalizedPhrase,
        proposedSkillName: skillCandidates.proposedSkillName,
        phraseClass: skillCandidates.phraseClass,
        tradeFamily: skillCandidates.tradeFamily,
        sourceAliasCount: skillCandidates.sourceAliasCount,
        sourceDomainCount: skillCandidates.sourceDomainCount,
        proposedAction: skillCandidates.proposedAction,
        confidenceBand: skillCandidates.confidenceBand,
        status: skillCandidates.status,
        reviewerAdminId: skillCandidates.reviewerAdminId,
        reviewedAt: skillCandidates.reviewedAt,
        resultingSkillId: skillCandidates.resultingSkillId,
        createdAt: skillCandidates.createdAt,
        updatedAt: skillCandidates.updatedAt,
        sortKey: AdminSkillDiscoveryRepository.SORT_KEY,
      })
      .from(skillCandidates)
      .where(clauses.length > 0 ? and(...clauses) : undefined);

    // The ORDER BY and the cursor must agree on the sort key AND its direction, or paging
    // silently loses rows. Both terms flip together; `candidate_id` is the tie-breaker the
    // keyset predicate above depends on.
    const rows = await (sort === "oldest"
      ? query.orderBy(asc(skillCandidates.createdAt), asc(skillCandidates.candidateId))
      : query.orderBy(desc(skillCandidates.createdAt), desc(skillCandidates.candidateId))
    ).limit(limit);

    return rows.map((r) => ({
      row: {
        id: r.candidateId,
        run_id: r.runId,
        cluster_key: r.clusterKey,
        normalized_phrase: r.normalizedPhrase,
        proposed_skill_name: r.proposedSkillName,
        phrase_class: r.phraseClass,
        trade_family: r.tradeFamily,
        source_alias_count: r.sourceAliasCount,
        source_domain_count: r.sourceDomainCount,
        proposed_action: r.proposedAction,
        confidence_band: r.confidenceBand,
        status: r.status,
        reviewer_admin_id: r.reviewerAdminId,
        reviewed_at: r.reviewedAt,
        resulting_skill_id: r.resultingSkillId,
        created_at: r.createdAt,
        updated_at: r.updatedAt,
      },
      sortKey: r.sortKey,
    }));
  }

  /**
   * The two match-derived facts for a whole page, in ONE round trip.
   *
   * `inArray` over the page's ids, so this is one query per page and not one per row — the N+1 a
   * per-row `has_strong_match` lookup would be. An empty id list short-circuits WITHOUT a query:
   * `inArray(col, [])` renders `false`, which is correct but is still a round trip to learn
   * something the caller already knows.
   *
   * A candidate with NO matches produces NO row here (there is nothing to group), so the service
   * must read an absent entry as `{ has_strong_match: false, related_skill_count: 0 }` — which is
   * the common case: most candidates compete with nothing.
   */
  async matchFactsFor(candidateIds: readonly string[]): Promise<AdminSkillCandidateMatchFacts[]> {
    if (candidateIds.length === 0) return [];

    const rows = await this.db
      .select({
        candidateId: skillCandidateMatches.candidateId,
        relatedSkillCount: count(),
        // `bool_or(...)` over the group, not a second EXISTS: the group is already being read.
        // `coalesce` is belt — `bool_or` over a non-empty group cannot be NULL unless every
        // `strength` is NULL, which the NOT NULL column forbids.
        hasStrongMatch: sql<boolean>`coalesce(bool_or(${skillCandidateMatches.strength} = ${STRENGTH_STRONG}), false)`,
      })
      .from(skillCandidateMatches)
      .where(inArray(skillCandidateMatches.candidateId, [...candidateIds]))
      .groupBy(skillCandidateMatches.candidateId);

    return rows.map((r) => ({
      candidate_id: r.candidateId,
      has_strong_match: r.hasStrongMatch,
      related_skill_count: r.relatedSkillCount,
    }));
  }

  // ─── one candidate ───────────────────────────────────────────────────────────────────

  /**
   * One candidate's stored columns. `undefined` for an unknown id — the service turns that into a
   * 404 and never into an empty detail page.
   *
   * `created_at_iso` rides along; see {@link AdminSkillCandidateDetailRow.created_at_iso} for why
   * it can only be produced here.
   */
  async findCandidate(
    candidateId: string,
    tx: Database = this.db,
  ): Promise<AdminSkillCandidateDetailRow | undefined> {
    const [r] = await tx
      .select({
        candidateId: skillCandidates.candidateId,
        runId: skillCandidates.runId,
        clusterKey: skillCandidates.clusterKey,
        normalizedPhrase: skillCandidates.normalizedPhrase,
        proposedSkillName: skillCandidates.proposedSkillName,
        proposedDescription: skillCandidates.proposedDescription,
        phraseClass: skillCandidates.phraseClass,
        classifierRule: skillCandidates.classifierRule,
        occupationHeads: skillCandidates.occupationHeads,
        evidenceTokens: skillCandidates.evidenceTokens,
        tradeFamily: skillCandidates.tradeFamily,
        sourceAliasCount: skillCandidates.sourceAliasCount,
        sourceDomainCount: skillCandidates.sourceDomainCount,
        proposedAction: skillCandidates.proposedAction,
        confidenceBand: skillCandidates.confidenceBand,
        confidence: skillCandidates.confidence,
        status: skillCandidates.status,
        reviewerAdminId: skillCandidates.reviewerAdminId,
        reviewedAt: skillCandidates.reviewedAt,
        reviewReason: skillCandidates.reviewReason,
        approvedJobDomainIds: skillCandidates.approvedJobDomainIds,
        approvedRequirement: skillCandidates.approvedRequirement,
        resultingSkillId: skillCandidates.resultingSkillId,
        embeddingStatus: skillCandidates.embeddingStatus,
        model: skillCandidates.model,
        promptVersion: skillCandidates.promptVersion,
        corpusFingerprint: skillCandidates.corpusFingerprint,
        provenanceDigest: skillCandidates.provenanceDigest,
        createdAt: skillCandidates.createdAt,
        createdAtIso: AdminSkillDiscoveryRepository.PROVENANCE_CREATED_AT,
        updatedAt: skillCandidates.updatedAt,
      })
      .from(skillCandidates)
      .where(eq(skillCandidates.candidateId, candidateId))
      .limit(1);

    if (!r) return undefined;

    return {
      id: r.candidateId,
      run_id: r.runId,
      cluster_key: r.clusterKey,
      normalized_phrase: r.normalizedPhrase,
      proposed_skill_name: r.proposedSkillName,
      proposed_description: r.proposedDescription,
      phrase_class: r.phraseClass,
      classifier_rule: r.classifierRule,
      // `text[] NOT NULL DEFAULT '{}'` on both, so `?? []` is belt for a row written before the
      // default existed — and it means no reader above this line re-decides which spelling of
      // "no tokens" it is looking at.
      occupation_heads: r.occupationHeads ?? [],
      evidence_tokens: r.evidenceTokens ?? [],
      trade_family: r.tradeFamily,
      source_alias_count: r.sourceAliasCount,
      source_domain_count: r.sourceDomainCount,
      proposed_action: r.proposedAction,
      confidence_band: r.confidenceBand,
      confidence: r.confidence,
      status: r.status,
      reviewer_admin_id: r.reviewerAdminId,
      reviewed_at: r.reviewedAt,
      review_reason: r.reviewReason,
      approved_job_domain_ids: r.approvedJobDomainIds ?? [],
      approved_requirement: r.approvedRequirement,
      resulting_skill_id: r.resultingSkillId,
      embedding_status: r.embeddingStatus,
      model: r.model,
      prompt_version: r.promptVersion,
      corpus_fingerprint: r.corpusFingerprint,
      provenance_digest: r.provenanceDigest,
      created_at: r.createdAt,
      created_at_iso: r.createdAtIso,
      updated_at: r.updatedAt,
    };
  }

  /**
   * Every contributing source phrase for one candidate. ONE round trip for the whole collection.
   *
   * `original_text` IS SERVED, and the posture is three schema properties rather than a promise:
   * there is no `worker_id` column on this table (deliberately — it is not a per-worker DSAR
   * surface), the text is contractually pseudonymized upstream for the `worker_phrase` type, and
   * the classifier's `FORBIDDEN_CHARS` rule is checked FIRST and rejects any phrase carrying a
   * digit, an `@` or a URL. And the reviewer cannot work without it: those strings ARE the alias
   * set a `create` approval would mint.
   *
   * ORDERED BY THE PRIMARY KEY's own leading columns `(source_type, source_id)` — stable across
   * reads, so a reviewer comparing two visits sees the same list in the same order, and served by
   * the PK index rather than by a sort.
   */
  async listSources(
    candidateId: string,
    tx: Database = this.db,
  ): Promise<AdminSkillCandidateSource[]> {
    const rows = await tx
      .select({
        sourceType: skillCandidateSources.sourceType,
        sourceId: skillCandidateSources.sourceId,
        originalText: skillCandidateSources.originalText,
        normalizedText: skillCandidateSources.normalizedText,
        jobDomainId: skillCandidateSources.jobDomainId,
      })
      .from(skillCandidateSources)
      .where(eq(skillCandidateSources.candidateId, candidateId))
      .orderBy(asc(skillCandidateSources.sourceType), asc(skillCandidateSources.sourceId));

    return rows.map((r) => ({
      source_type: r.sourceType,
      source_id: r.sourceId,
      original_text: r.originalText,
      normalized_text: r.normalizedText,
      job_domain_id: r.jobDomainId,
    }));
  }

  /**
   * Every COMPETING existing-canonical match for one candidate, in the pipeline's own rank order.
   * ONE round trip.
   *
   * PLURAL BY DESIGN, and the reason is on the table itself: with a single `best_match` a false
   * match is invisible — the reviewer sees `ducting_installation -> plumber (0.82)` and cannot
   * tell that `pipe_fitting (0.81)` and `hvac_ducting (0.79)` were right behind it.
   *
   * ── THE ONE JOIN ON THIS SURFACE, AND WHY IT IS HERE ──────────────────────────────────
   * `skill_candidate_match` stores only `skill_id`, and no reviewer can choose between
   * `skill_arc_welding` and `skill_gas_welding` by reading ids. `label_en` comes from `skill` via
   * an INNER join, which loses nothing: `skill_id` is a real FK with `ON DELETE NO ACTION` (a
   * skill is deprecated, never deleted — SG-5), so every match row has exactly one partner.
   *
   * NO `kind <> 'match_skill'` FILTER, deliberately. The `mskill_*` wall is
   * `skill_candidate_match_not_match_skill_chk` plus the index build that drops them
   * (skill-discovery-match.ts:113); filtering here would HIDE a violation of that CHECK by
   * silently dropping the row, when what is wanted is for it to be visible and impossible.
   *
   * ── `score` COMES BACK, AND STOPS AT THIS LAYER ──────────────────────────────────────
   * {@link AdminSkillCandidateMatchRow} is a repository-only type and the wire's
   * `AdminSkillRelatedSkill` has NO `score` key: a 0..1 number on a review screen re-imports the
   * threshold thinking this surface exists to keep out (a UI that sorts by it has invented an
   * approval floor with no owner behind it). TypeScript does not excess-property-check a SPREAD,
   * so the service's mapper must project the wire fields EXPLICITLY — `{ ...matchRow }` would
   * carry `score` onto the response and compile.
   */
  async listMatches(
    candidateId: string,
    tx: Database = this.db,
  ): Promise<AdminSkillCandidateMatchRow[]> {
    const rows = await tx
      .select({
        skillId: skillCandidateMatches.skillId,
        skillLabel: skills.labelEn,
        relation: skillCandidateMatches.relation,
        score: skillCandidateMatches.score,
        strength: skillCandidateMatches.strength,
        rank: skillCandidateMatches.rank,
        evidenceDetail: skillCandidateMatches.evidenceDetail,
      })
      .from(skillCandidateMatches)
      .innerJoin(skills, eq(skills.skillId, skillCandidateMatches.skillId))
      .where(eq(skillCandidateMatches.candidateId, candidateId))
      // `rank` is 1-based and contiguous (`skill_candidate_match_rank_chk` >= 1), and it is a
      // display ORDER rather than a measurement — which is exactly why the wire keeps it and
      // drops the score. `skill_id` breaks a tie so the order is total.
      .orderBy(asc(skillCandidateMatches.rank), asc(skillCandidateMatches.skillId));

    return rows.map((r) => ({
      skill_id: r.skillId,
      skill_label: r.skillLabel,
      relation: r.relation,
      score: r.score,
      // `strength` is plain `text` in the model with no `$type<>()`, but
      // `skill_candidate_match_strength_chk` closes it to `('strong','weak')` in the database —
      // which is what makes this narrowing a statement about the data rather than a hope.
      strength: r.strength as AdminSkillMatchStrength,
      rank: r.rank,
      evidence_detail: r.evidenceDetail,
    }));
  }

  // ─── metrics ─────────────────────────────────────────────────────────────────────────

  /**
   * The raw aggregate facts behind the dashboard tiles.
   *
   * SPARSE ON PURPOSE: a `GROUP BY` returns only the keys that have rows, and emitting a zero for
   * every enum member is presentation. The service densifies (and sums `total` FROM `by_status`,
   * so the headline cannot disagree with its own breakdown).
   *
   * NO WINDOW. A review queue is a BACKLOG, and a 30-day window would hide the oldest undecided
   * candidates — exactly the rows the tile exists to surface. `oldest_awaiting_created_at`
   * answers the age question instead.
   *
   * `awaitingStatuses` IS A PARAMETER rather than a constant here: which statuses count as
   * "nobody has decided this" is queue policy, it is already stated once in the service (two
   * statuses, `deferred` excluded because "somebody could not decide" is a different fact from
   * "nobody looked"), and a second copy in a repository is how the tile and the queue end up
   * disagreeing about what they are counting.
   *
   * Five statements, issued together. They are independent aggregates over one table with no
   * cross-query invariant to protect, so they need no transaction — but they DO need to be
   * concurrent, because a metrics tile costing five sequential round trips gets cached by
   * somebody, and then it is stale instead of slow.
   */
  async metricFacts(filter: {
    runId?: string;
    awaitingStatuses: readonly SkillCandidateStatus[];
  }): Promise<AdminSkillDiscoveryMetricFacts> {
    const scope: SQL[] = [];
    if (filter.runId) scope.push(eq(skillCandidates.runId, filter.runId));
    const where = scope.length > 0 ? and(...scope) : undefined;

    const awaiting: SQL[] = [...scope];
    if (filter.awaitingStatuses.length > 0) {
      awaiting.push(inArray(skillCandidates.status, [...filter.awaitingStatuses]));
    }

    const [statusRows, bandRows, actionRows, phraseClassRows, awaitingRows] = await Promise.all([
      this.db
        .select({ key: skillCandidates.status, count: count() })
        .from(skillCandidates)
        .where(where)
        .groupBy(skillCandidates.status),
      this.db
        .select({ key: skillCandidates.confidenceBand, count: count() })
        .from(skillCandidates)
        .where(where)
        .groupBy(skillCandidates.confidenceBand),
      this.db
        .select({ key: skillCandidates.proposedAction, count: count() })
        .from(skillCandidates)
        .where(where)
        .groupBy(skillCandidates.proposedAction),
      // TWO NUMBERS FROM ONE SCAN, and the split is what lets the service reuse `reviewTier`
      // instead of restating it: `count(*) filter (where <strong exists>)` plus the group total.
      this.db
        .select({
          phraseClass: skillCandidates.phraseClass,
          total: count(),
          withStrongMatch: sql<number>`count(*) filter (where ${AdminSkillDiscoveryRepository.HAS_STRONG_MATCH})::int`,
        })
        .from(skillCandidates)
        .where(where)
        .groupBy(skillCandidates.phraseClass),
      // `min(created_at)`, not an ORDER BY + LIMIT 1: the question is a single scalar and there
      // is no index on `created_at` to walk (see {@link list}'s owed-index note).
      this.db
        .select({ oldest: sql<Date | null>`min(${skillCandidates.createdAt})` })
        .from(skillCandidates)
        .where(awaiting.length > 0 ? and(...awaiting) : undefined),
    ]);

    return {
      by_status: statusRows.map((r) => ({ key: r.key, count: r.count })),
      by_band: bandRows.map((r) => ({ key: r.key, count: r.count })),
      by_proposed_action: actionRows.map((r) => ({ key: r.key, count: r.count })),
      by_phrase_class: phraseClassRows.map((r) => ({
        phrase_class: r.phraseClass,
        with_strong_match: r.withStrongMatch,
        without_strong_match: r.total - r.withStrongMatch,
      })),
      oldest_awaiting_created_at: awaitingRows[0]?.oldest ?? null,
    };
  }

  /**
   * The three facts that decide whether a mapping target is a legal one — a READ of `skill`, and
   * the only reason this repository knows that table has rows of its own.
   *
   * WHY THE DECISION PATH NEEDS IT. An `alias`/`merge` body names an EXISTING `skill_id`, and
   * three different things can be wrong with one: it may not exist, it may be `deprecated`, or it
   * may be `kind = 'match_skill'`. Without this read the first surfaces as an FK violation from
   * inside an open transaction (a 500 naming a constraint, mid-decision), and the other two do
   * not surface at all — `skill_candidate_not_match_skill_chk` only tests the `mskill_` PREFIX,
   * so a match skill renamed out of that convention would map cleanly and silently. `kind` is the
   * fact the prefix is a proxy for, which makes this the LAST wall rather than a duplicate of the
   * first three.
   *
   * `undefined` for an unknown id. Three columns, named explicitly: nothing else about a skill is
   * any of this surface's business.
   */
  async findCorpusSkill(
    skillId: string,
    tx: Database = this.db,
  ): Promise<{ skill_id: string; status: SkillStatus; kind: SkillKind } | undefined> {
    const [row] = await tx
      .select({ skillId: skills.skillId, status: skills.status, kind: skills.kind })
      .from(skills)
      .where(eq(skills.skillId, skillId))
      .limit(1);
    return row ? { skill_id: row.skillId, status: row.status, kind: row.kind } : undefined;
  }

  /**
   * WHICH OF THESE `jd_*` IDS ACTUALLY EXIST AND ARE STILL LIVE — the `create` branch's other
   * referential check, and the second (with {@link findCorpusSkill}) of the two READS of a table
   * outside migration 0093 that this repository performs.
   *
   * WHY THE DECISION PATH NEEDS IT. A `create` decision records `approved_job_domain_ids`: the
   * trades the reviewer says the new skill belongs to, which the offline chain later turns into
   * `job_domain_skill` edges (`source = 'curated'`). `approved_job_domain_ids` is a bare
   * `text[]` — an array column CANNOT carry a foreign key in Postgres, so nothing in 0093
   * refuses an id that names no domain. Without this read a plausible-looking `jd_` typo is
   * recorded as a decision, passes every CHECK, and surfaces WEEKS LATER as an FK violation
   * halfway through `db:seed:domain-skills`, naming a constraint instead of a fix — with the
   * reviewer who could have corrected it long gone. The dto says the service resolves these
   * (dto:995-997); this is what it resolves them with.
   *
   * `selectable AND status = 'active'` IS PART OF THE QUESTION, not a filter bolted on. A
   * deprecated or non-selectable domain is not on any trade's picker, so an edge to it reaches
   * nobody — which is the very condition `SKILL_ORPHAN` exists to refuse. Approving a skill onto
   * one produces a skill that seeds, embeds and is invisible: exactly the outcome
   * `approved_job_domain_ids` was added to prevent. The service reports the unknown ids BY NAME,
   * so a reviewer sees which of their trades was refused rather than a bare 400.
   *
   * Returns the ids it FOUND. The caller diffs against what it asked for — an empty result for a
   * non-empty request is a complete refusal, and set arithmetic in the service beats a per-id
   * round trip.
   */
  async findLiveJobDomainIds(
    ids: readonly string[],
    tx: Database = this.db,
  ): Promise<Set<string>> {
    if (ids.length === 0) return new Set();
    const rows = await tx
      .select({ jobDomainId: jobDomains.jobDomainId })
      .from(jobDomains)
      .where(
        and(
          inArray(jobDomains.jobDomainId, [...ids]),
          eq(jobDomains.selectable, true),
          eq(jobDomains.status, "active"),
        ),
      );
    return new Set(rows.map((r) => r.jobDomainId));
  }

  // ─── the one write ───────────────────────────────────────────────────────────────────

  /**
   * A candidate's id + current status, and nothing else.
   *
   * TWO CALLERS, TWO PURPOSES. Before the transaction it is the cheap terminal-state read that
   * lets the service answer an idempotent re-submit with `changed: false` WITHOUT opening a
   * transaction at all. After a zero-row decision write, called with the same `tx`, it is how the
   * 409 body learns the `current_status` to report — a conflict that says only "somebody else
   * moved first" and cannot say what they moved it TO is a conflict a reviewer cannot act on.
   *
   * It is NOT the concurrency guard. The guard is in {@link recordDecision}'s WHERE; this read
   * exists beside it, never instead of it.
   */
  async findStatus(
    candidateId: string,
    tx: Database = this.db,
  ): Promise<{ candidate_id: string; status: SkillCandidateStatus } | undefined> {
    const [row] = await tx
      .select({ candidateId: skillCandidates.candidateId, status: skillCandidates.status })
      .from(skillCandidates)
      .where(eq(skillCandidates.candidateId, candidateId))
      .limit(1);
    return row ? { candidate_id: row.candidateId, status: row.status } : undefined;
  }

  /**
   * `pending -> needs_review`, guarded, carrying NO reviewer. The first half of the ladder's one
   * two-step.
   *
   * `canTransition('pending', 'deferred')` is FALSE — `pending` may only go to `needs_review` or
   * `rejected` — so a HOLD on a `pending` candidate is two moves, and writing `deferred` straight
   * onto a `pending` row passes every DB CHECK (the reviewer triple is satisfied) while violating
   * the code ladder SILENTLY, which is the worst combination available. The service runs both
   * moves inside ONE {@link withTransaction}, so no caller observes the intermediate state.
   *
   * THE REVIEWER COLUMNS ARE NOT IN THE PATCH, and that is not an omission:
   * `skill_candidate_machine_status_chk` FORBIDS a reviewer on `pending`/`needs_review`, so
   * naming the human on this step would make the database refuse the write. The human is
   * recorded by the SECOND step, which is where the decision actually is.
   *
   * `undefined` when it matched no row — a racer, or a candidate that was never `pending`.
   */
  async advanceToNeedsReview(
    candidateId: string,
    tx: Database = this.db,
  ): Promise<{ status: SkillCandidateStatus } | undefined> {
    const [row] = await tx
      .update(skillCandidates)
      .set({ status: "needs_review", updatedAt: new Date() })
      .where(
        and(eq(skillCandidates.candidateId, candidateId), eq(skillCandidates.status, "pending")),
      )
      .returning({ status: skillCandidates.status });
    return row;
  }

  /**
   * THE ONLY DECISION WRITE ON THIS SURFACE: record one human decision on `skill_candidate`.
   *
   * ── WHAT IT DOES NOT DO ───────────────────────────────────────────────────────────────
   * It touches ONE ROW IN ONE TABLE. It does not create a `skill`, a `skill_alias` or a
   * `job_domain_skill`; `resulting_skill_id` is only ever the id the REVIEWER named, and on an
   * `approved_create` it is not written at all — it stays NULL until the offline chain mints the
   * row and somebody backfills it. `approved_job_domain_ids` is the reviewer's judgement
   * RECORDED, not an edge written: the edges are `db:seed:domain-skills`'s to write, from the
   * corpus, after `validateTaxonomyCorpus` and a human commit.
   *
   * ── THE OPTIMISTIC-CONCURRENCY GUARD ─────────────────────────────────────────────────
   * `WHERE candidate_id = $1 AND status = $expected`. A second reviewer deciding the same
   * candidate matches ZERO rows and gets `undefined`, which the service reports as a 409
   * (`stale_expected_status` / `already_decided`) — the first human's authorship is never
   * overwritten, and the loser is TOLD rather than shown a success for a decision that did not
   * happen. Terminality rides on the same clause: a terminal row's status can never equal an
   * `expectedStatus` that any legal transition came from.
   *
   * The guard is IN THE STATEMENT and not in a preceding read, because a read-then-write has the
   * same code and none of the protection (admin-actions.repository.ts:41-44).
   *
   * ── PROVENANCE, AS A CLOSED LIST ─────────────────────────────────────────────────────
   * The patch below is built key by key and never spreads {@link AdminSkillDecisionWrite}. None
   * of the 19 `PROVENANCE_FIELDS` appears in it. The four editable proposal columns that DO
   * appear — `proposed_skill_name`, `proposed_description`, `approved_job_domain_ids`,
   * `approved_requirement` — are outside the digest BY DESIGN
   * (skill-discovery-candidate.ts:233): they are the proposal a reviewer is invited to correct,
   * and correcting one is a NEW FACT in the review columns rather than a change to what the run
   * observed.
   *
   * Each is written ONLY when the caller supplied it, so an `alias` decision cannot blank a label
   * and a `reject` cannot touch either. `undefined` is drizzle's "leave this column alone";
   * `null` would be an update TO NULL, which is a different statement and is not what any branch
   * asks for.
   *
   * ── ATOMICITY WITH THE AUDIT EVENT ───────────────────────────────────────────────────
   * `tx` defaults to the injected db so the method is usable alone, but the service MUST pass the
   * transaction from {@link withTransaction} and emit `admin.action_performed` on the same one.
   * Events and SoR are the same Postgres database, so an emit throw then rolls this write back —
   * and an admin decision with no spine row is a taxonomy change with no audit trail.
   */
  async recordDecision(
    write: AdminSkillDecisionWrite,
    tx: Database = this.db,
  ): Promise<{ status: SkillCandidateStatus } | undefined> {
    const patch: {
      status: SkillCandidateStatus;
      reviewerAdminId: string;
      reviewedAt: Date;
      reviewReason: string;
      updatedAt: Date;
      resultingSkillId?: string;
      proposedSkillName?: string;
      proposedDescription?: string;
      approvedJobDomainIds?: string[];
      approvedRequirement?: "required" | "preferred";
    } = {
      // All three of the reviewed triple, always, together. `skill_candidate_reviewed_chk`
      // demands reviewer_admin_id AND reviewed_at AND review_reason for every human-decided
      // status, so a partial decision is refused by the database — which is what makes the audit
      // trail a property of the schema rather than a promise made by whoever wrote the row.
      status: write.nextStatus,
      reviewerAdminId: write.reviewerAdminId,
      reviewedAt: write.reviewedAt,
      reviewReason: write.reviewReason,
      // No trigger maintains this column; an unstamped `updated_at` would leave the row looking
      // untouched since the run wrote it.
      updatedAt: new Date(),
    };
    if (write.resultingSkillId !== undefined) patch.resultingSkillId = write.resultingSkillId;
    if (write.proposedSkillName !== undefined) patch.proposedSkillName = write.proposedSkillName;
    if (write.proposedDescription !== undefined) {
      patch.proposedDescription = write.proposedDescription;
    }
    if (write.approvedJobDomainIds !== undefined) {
      patch.approvedJobDomainIds = write.approvedJobDomainIds;
    }
    if (write.approvedRequirement !== undefined) {
      patch.approvedRequirement = write.approvedRequirement;
    }

    const [row] = await tx
      .update(skillCandidates)
      .set(patch)
      .where(
        and(
          eq(skillCandidates.candidateId, write.candidateId),
          eq(skillCandidates.status, write.expectedStatus),
        ),
      )
      .returning({ status: skillCandidates.status });
    return row;
  }
}
