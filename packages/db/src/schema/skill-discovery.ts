/**
 * SKILL DISCOVERY & CURATION — the staging layer (migration 0093).
 *
 * ===========================================================================
 * WHAT THIS IS FOR
 * ===========================================================================
 * `job_domain_alias` holds 9,121 rows of published occupation vocabulary. Somewhere inside
 * them is evidence of skills the canonical `skill` table does not yet carry. Finding that
 * evidence needs normalization, clustering, similarity against a corpus, and a model — and
 * every one of those steps produces a GUESS.
 *
 * These four tables are where guesses live. They are deliberately NOT `skill` and NOT
 * `skill_alias`, and the separation is the entire safety property: a row here has no path
 * into the production vocabulary except through a named human's recorded decision, and from
 * there through the two gates and the human commit the taxonomy corpus pipeline already
 * enforces (`validateTaxonomyCorpus` -> `taxonomyQualityVerdict` -> `db:seed:domain-skills`).
 *
 *     skill_discovery_run  1 ──< skill_candidate  1 ──< skill_candidate_source
 *                                       │
 *                                       └──< skill_candidate_match
 *
 * ===========================================================================
 * ONE ROW PER CLUSTER, NOT PER ALIAS. THIS IS THE WORKLOAD REDUCTION.
 * ===========================================================================
 * The naive staging table is one row per source phrase, which hands a reviewer 8,762
 * distinct normalized phrases and is not a queue anybody will finish. A candidate is instead
 * one row per CLUSTER of phrases that mean the same thing — "CNC turning", "CNC lathe
 * turning", "CNC turner", "CNC lathe operation" arrive as ONE decision with four sources
 * attached, not four decisions.
 *
 * `skill_candidate_source` is what makes that safe rather than lossy: every contributing
 * phrase keeps its own row, its own `job_domain_id`, and its own original text, so the
 * Phase-8 auditor's question — *"which job-domain aliases caused this skill to be
 * proposed?"* — is a single indexed join and not an archaeology exercise.
 *
 * ===========================================================================
 * SIMILARITY IS EVIDENCE, NOT AUTHORIZATION
 * ===========================================================================
 * `skill_candidate_match` is a CHILD TABLE holding EVERY plausible existing-canonical match
 * with its score, not one `best_match_skill_id` column on the candidate. That shape is a
 * direct response to measured false matches in this repository —
 * `ducting_installation -> plumber`, `visual_defect_identification -> quality_inspector`,
 * `split_unit_installation -> fitter`. A single winner column would have hidden the
 * competition that makes those visible as wrong.
 *
 * There is NO threshold-driven state transition anywhere in this schema. No CHECK, no
 * trigger, no default moves a candidate toward approval because a number crossed a line.
 * `proposed_action` is a SUGGESTION column; `status` only ever moves by an admin write.
 *
 * ===========================================================================
 * THE MATCH-SKILL WALL (Phase 12)
 * ===========================================================================
 * `mskill_*` is a closed, CEO-ratified 18-member vocabulary the deterministic match engine
 * consumes directly. Nothing in this schema may reference it: `resulting_skill_id` carries a
 * CHECK refusing the prefix, and there is no column anywhere that could propose one. A
 * discovered skill is an ATTRIBUTE and stays unmapped to `MATCH_SKILLS` until a separate
 * owner decision exists. Invariant #4 (CLAUDE.md §3): an LLM must never author ranking
 * vocabulary.
 *
 * ===========================================================================
 * PRIVACY
 * ===========================================================================
 * `skill_candidate_source.original_text` is the one column where worker free text could
 * land, and it is contractually PSEUDONYMIZED: the `worker_phrase` source type is fed only
 * through the ai-service pseudonymizer (fail-closed, `mine-chat-aliases.ts` is the
 * reference), and the discovery classifier additionally refuses any phrase carrying a digit,
 * `@` or a URL before it can become a source row. There is NO `worker_id` column on any
 * table here — the same aggregate-only contract `unresolved_phrase` holds, and the same
 * reason: this must not become a per-worker DSAR surface.
 *
 * RLS: `.enableRLS()` in the model; FORCE + REVOKE carried by migration 0093, matching 0066
 * / 0076 / 0052.
 */
import { sql } from "drizzle-orm";
import {
  pgTable,
  text,
  uuid,
  integer,
  real,
  smallint,
  timestamp,
  index,
  uniqueIndex,
  primaryKey,
  check,
} from "drizzle-orm/pg-core";

import { skills } from "./skill";
import { jobDomains } from "./occupation";
import { adminUsers } from "./ops";

// ===========================================================================
// Shared vocabularies
// ===========================================================================

/** Lifecycle of a discovery run. */
export type SkillDiscoveryRunStatus = "running" | "completed" | "failed";

/**
 * Where a candidate's evidence came from.
 *
 * A CLOSED union because the coverage report breaks down by source, and the question the
 * whole workstream answers ("out of the job-domain aliases, how many…") is unanswerable if
 * two sources can be conflated. `job_domain_label` is separate from `job_domain_alias`
 * deliberately: the catalogue's own canonical title and its worker-vernacular variants are
 * different evidence about the same trade.
 */
export type SkillCandidateSourceType =
  | "job_domain_alias"
  | "job_domain_label"
  | "unresolved_phrase"
  | "worker_phrase"
  | "job_text"
  | "skill_alias";

/**
 * What the pipeline SUGGESTS a reviewer do. A suggestion and nothing more.
 *
 * Mirrors the four decisions a human can make plus `review` for the candidates where the
 * evidence genuinely does not reach. It is stored so the queue can be sorted and so a later
 * audit can ask "how often was the machine right?", never so it can be applied.
 */
export type SkillCandidateAction = "map" | "create" | "merge" | "reject" | "review";

/**
 * The candidate lifecycle.
 *
 * HOUSE SPELLING — lowercase snake with a CHECK, matching `skill.status`,
 * `job_domain.status`, `unresolved_phrase.status` and `job_domain_skill.status`. The brief
 * proposed SCREAMING_CASE; the concepts are identical and the spelling follows the four
 * lifecycle columns already in this schema.
 *
 * `pending`          written by the discovery run. THE ONLY STATUS A PIPELINE MAY WRITE.
 * `needs_review`     queued for a human, or returned by one who wants a second opinion.
 * `approved_create`  a human decided this is a NEW canonical skill.
 * `approved_map`     a human decided this is an alias of `resulting_skill_id`.
 * `approved_merge`   a human decided this is the same competency as `resulting_skill_id`.
 * `rejected`         a human decided it is not a standalone skill.
 * `deferred`         a human looked and declined to decide. A real answer, not a gap.
 *
 * WHY `deferred` EXISTS. Without it an undecidable candidate either sits in `needs_review`
 * indistinguishably from one nobody has opened, or takes a `rejected` it does not deserve —
 * which is terminal and silent. The queue metrics must be able to tell those apart.
 *
 * THE THREE `approved_*` AND `rejected` ARE TERMINAL. A human decision was recorded against
 * a specific `corpus_fingerprint`; re-opening the row in place would silently re-scope that
 * decision to a corpus the human never saw. Re-deciding is a NEW candidate in a NEW run,
 * which the run fingerprint makes visible.
 */
export type SkillCandidateStatus =
  | "pending"
  | "needs_review"
  | "approved_create"
  | "approved_map"
  | "approved_merge"
  | "rejected"
  | "deferred";

/** Coarse confidence band. Coarse on purpose — a reviewer sorts by it, never decides on it. */
export type SkillCandidateConfidenceBand = "high" | "medium" | "low";

/** Whether a candidate's phrases could be scored against stored vectors, and how. */
export type SkillCandidateEmbeddingStatus =
  /** Every source phrase had a stored vector — scored at ₹0. */
  | "reused"
  /** At least one phrase has no stored vector; a paid call would be needed to score it. */
  | "needs_embedding"
  /** Not attempted (deterministic-only run). */
  | "not_required";

// ===========================================================================
// skill_discovery_run
// ===========================================================================

/**
 * ONE REPRODUCIBLE DISCOVERY RUN.
 *
 * The reason this table exists rather than a `run_id` string on the candidate: a run has
 * facts of its own that must not be duplicated onto thousands of child rows — which inputs,
 * which configuration, which model, and above all which FINGERPRINT.
 *
 * `input_fingerprint` is the `corpus-fingerprint.ts` digest of the taxonomy spine COMBINED
 * with the head-lexicon digest (`headLexiconFingerprint`). Both are needed and neither is
 * sufficient: the corpus digest catches a changed alias or a promoted skill, the lexicon
 * digest catches a changed rule about what counts as an occupation head. Two runs that
 * disagree about whether `fitter` is an occupation head produce different candidates from
 * identical database inputs, and without the second digest that difference is invisible.
 *
 * Equality, never a timestamp — the argument `corpus-fingerprint.ts` makes at length.
 */
export const skillDiscoveryRuns = pgTable(
  "skill_discovery_run",
  {
    /** `sdr_<iso8601-compact>_<slug>`. Readable, sortable, and derived from the run itself. */
    runId: text("run_id").primaryKey(),
    status: text("status").$type<SkillDiscoveryRunStatus>().notNull().default("running"),
    /** Corpus digest + head-lexicon digest. See the table docblock. */
    inputFingerprint: text("input_fingerprint").notNull(),
    /** The run's own configuration, verbatim, so a re-run is a copy rather than a reconstruction. */
    configJson: text("config_json"),
    /** Source rows read. */
    sourceCount: integer("source_count").notNull().default(0),
    /** Distinct normalized phrases after normalization + dedup. */
    normalizedCount: integer("normalized_count").notNull().default(0),
    /** Candidates written. */
    candidateCount: integer("candidate_count").notNull().default(0),
    /** Clusters formed (== candidate_count for a completed run; separate while running). */
    clusterCount: integer("cluster_count").notNull().default(0),
    errorCount: integer("error_count").notNull().default(0),
    /**
     * The extraction model, or NULL for a deterministic-only run.
     *
     * A provider MODEL ID, never a display name — `gemini-2.5-flash`, not "Flash". The id is
     * what `model_config.py` prices and what a later cost reconciliation joins on.
     */
    model: text("model"),
    /** The prompt contract version. NULL iff `model` is NULL — a CHECK pins the pair. */
    promptVersion: text("prompt_version"),
    /** The vector model whose stored embeddings were read. NULL when none were. */
    embeddingModel: text("embedding_model"),
    startedAt: timestamp("started_at", { withTimezone: true }).notNull().defaultNow(),
    completedAt: timestamp("completed_at", { withTimezone: true }),
  },
  (t) => [
    index("skill_discovery_run_status_idx").on(t.status, t.startedAt),
    /** "has this exact input been run before?" — the reproducibility probe. */
    index("skill_discovery_run_fingerprint_idx").on(t.inputFingerprint),
    check(
      "skill_discovery_run_status_chk",
      sql`${t.status} IN ('running', 'completed', 'failed')`,
    ),
    /**
     * A model attribution without a prompt version is unreproducible; a prompt version
     * without a model attributes the output to nothing. Both or neither.
     */
    check(
      "skill_discovery_run_model_pair_chk",
      sql`(${t.model} IS NULL) = (${t.promptVersion} IS NULL)`,
    ),
    check(
      "skill_discovery_run_completed_chk",
      sql`${t.status} = 'running' OR ${t.completedAt} IS NOT NULL`,
    ),
  ],
).enableRLS(); // FORCE + REVOKE carried by migration 0093

// ===========================================================================
// skill_candidate
// ===========================================================================

export const skillCandidates = pgTable(
  "skill_candidate",
  {
    candidateId: uuid("candidate_id").primaryKey().defaultRandom(),
    runId: text("run_id")
      .notNull()
      .references(() => skillDiscoveryRuns.runId, { onDelete: "cascade" }),

    // ── identity of the cluster ───────────────────────────────────────────
    /**
     * The cluster's stable key — the normalized form of its most frequent member.
     *
     * Unique WITHIN a run (index below), never globally: the same phrase legitimately
     * produces a candidate in run 1 and again in run 5 against a changed corpus, and those
     * are different claims that must both be inspectable.
     */
    clusterKey: text("cluster_key").notNull(),
    /** The representative normalized phrase. Same value as `clusterKey` today; separate
     *  because the key is an identifier and this is display text, and conflating an id with
     *  a label is how a "harmless" relabel becomes a broken foreign key. */
    normalizedPhrase: text("normalized_phrase").notNull(),

    // ── the proposal ──────────────────────────────────────────────────────
    /**
     * The canonical skill label being proposed. NULL until something proposes one.
     *
     * The DETERMINISTIC layer never fills this: inventing a label is a wording judgement and
     * the classifier has no basis for one. A model fills it in the extraction stage; a
     * reviewer may overwrite it, which is a decision and is recorded as such.
     */
    proposedSkillName: text("proposed_skill_name"),
    proposedDescription: text("proposed_description"),
    /** `REJECTED_NON_SKILL` | `OCCUPATION_ONLY` | … — see `skill-discovery-classify.ts`. */
    phraseClass: text("phrase_class").notNull(),
    /** The stable rule code that produced `phrase_class`. Counted by the coverage report. */
    classifierRule: text("classifier_rule").notNull(),
    /** Tokens identified as occupation identity. Postgres text[]. */
    occupationHeads: text("occupation_heads").array().notNull().default(sql`'{}'::text[]`),
    /** Tokens carrying trade meaning after heads and stoplist are removed. */
    evidenceTokens: text("evidence_tokens").array().notNull().default(sql`'{}'::text[]`),
    /** Review/batching cluster ("cnc_machining"). Free text; not an id in any table. */
    tradeFamily: text("trade_family"),

    // ── denormalized counts, for the queue's sort ─────────────────────────
    /** How many source rows contributed. Denormalized from `skill_candidate_source`. */
    sourceAliasCount: integer("source_alias_count").notNull().default(0),
    /** How many DISTINCT `jd_*` domains contributed. The "how widely attested" signal. */
    sourceDomainCount: integer("source_domain_count").notNull().default(0),

    // ── the suggestion, and the human decision ────────────────────────────
    proposedAction: text("proposed_action").$type<SkillCandidateAction>().notNull().default("review"),
    confidenceBand: text("confidence_band").$type<SkillCandidateConfidenceBand>().notNull().default("low"),
    /** 0..1. NULL for a purely deterministic candidate, which has no proposer certainty. */
    confidence: real("confidence"),
    status: text("status").$type<SkillCandidateStatus>().notNull().default("pending"),
    /**
     * WHO decided. FK to `admin_users`, never a free-text name.
     *
     * ON DELETE NO ACTION: an admin row is the identity behind a permanent taxonomy
     * decision, so removing it must fail loudly rather than orphan the audit trail.
     */
    reviewerAdminId: uuid("reviewer_admin_id").references(() => adminUsers.id),
    reviewedAt: timestamp("reviewed_at", { withTimezone: true }),
    /** WHY. Mandatory on every human decision (CHECK below) — an unexplained approval is
     *  indistinguishable from a misclick six months later. */
    reviewReason: text("review_reason"),
    /**
     * WHICH TRADES THE REVIEWER SAID THIS SKILL BELONGS TO.
     *
     * ── WHY THIS COLUMN EXISTS, AND IT IS NOT OPTIONAL POLISH ──
     *
     * `validateTaxonomyCorpus` refuses a skill with zero `job_domain_skill` edges —
     * `SKILL_ORPHAN`, whose own message is the argument: *"Nothing reaches this skill: it is not
     * on any trade's picker and no posting can be built from it. It seeds, it embeds, and it is
     * invisible."* The first draft of the export path emitted no edges on the grounds that a
     * discovery pipeline must not INFER what a trade requires, and every batch it produced was
     * therefore permanently BLOCKED. The validator was right and the design was wrong.
     *
     * The resolution is not to infer the edge, and not to weaken the gate. It is to ask the
     * human who is already looking at the answer. The review screen shows the candidate's
     * SOURCE OCCUPATIONS — that is where the phrase was observed — and the reviewer either
     * accepts them, trims them, or names others. That is a judgement, recorded here, and it is
     * the same judgement `job_domain_skill.source = 'curated'` already exists to represent.
     *
     * ── NO FK, AND THAT IS A DELIBERATE COST ──
     *
     * A Postgres array element cannot carry a foreign key, so this column can hold a `jd_*` id
     * that does not exist. It is validated TWICE instead, at both ends: the admin service
     * resolves every id against `job_domain` before it will record the decision, and
     * `seed-domain-skills.ts` re-checks the whole corpus's domains against the live catalogue
     * before it writes anything (its existing `shippedDependencies` precondition). The
     * alternative — a fifth child table with a real FK — buys the constraint and costs a join
     * on the one read that has to be fast, for a column that is written once by a human.
     *
     * EMPTY for every status except `approved_create` and `approved_map`. A CHECK requires it to
     * be non-empty on `approved_create`, because that is the status that mints a new skill and
     * an orphan is what this column exists to prevent.
     */
    approvedJobDomainIds: text("approved_job_domain_ids")
      .array()
      .notNull()
      .default(sql`'{}'::text[]`),
    /**
     * What the reviewer said the new skill IS for those trades — `required` or `preferred`.
     *
     * Defaults to `preferred`, matching `job_domain_skill.default_requirement`'s own default and
     * for the same reason: `required` is a strong claim about hiring, and a newly discovered
     * skill has no evidence behind it yet. A reviewer who knows better says so; the default
     * never overstates.
     */
    approvedRequirement: text("approved_requirement")
      .$type<"required" | "preferred">()
      .notNull()
      .default("preferred"),
    /**
     * The canonical skill this candidate resolved TO.
     *
     * Set for `approved_map` and `approved_merge` at decision time. For `approved_create` it
     * stays NULL until the corpus export -> `validateTaxonomyCorpus` -> human commit ->
     * `db:seed:domain-skills` chain actually mints the row, and is backfilled then. It is
     * therefore also the honest answer to "did this approval ever ship?".
     */
    resultingSkillId: text("resulting_skill_id").references(() => skills.skillId),

    // ── provenance ────────────────────────────────────────────────────────
    embeddingStatus: text("embedding_status")
      .$type<SkillCandidateEmbeddingStatus>()
      .notNull()
      .default("not_required"),
    model: text("model"),
    promptVersion: text("prompt_version"),
    /** The corpus this candidate was measured against. Copied from the run, per-row, so a
     *  candidate exported on its own still carries its own freshness evidence. */
    corpusFingerprint: text("corpus_fingerprint").notNull(),
    /**
     * sha256 over the immutable provenance fields, stamped at insert.
     *
     * The failure it prevents is quiet: a reviewer improves `proposed_skill_name` and, in the
     * same edit, `model` picks up whatever produced the latest batch. The row then claims a
     * lineage it does not have, and "which model, under which prompt, said this?" is answered
     * wrongly, with confidence, forever. A reviewer's edit is a NEW FACT recorded in the
     * review columns — never a correction of an old one.
     */
    provenanceDigest: text("provenance_digest").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    /** One candidate per cluster per run — makes the writer's upsert natural and a
     *  duplicated cluster impossible. */
    uniqueIndex("skill_candidate_run_cluster_uq").on(t.runId, t.clusterKey),
    /** THE QUEUE READ: "pending candidates, most widely attested first". */
    index("skill_candidate_queue_idx").on(t.status, t.confidenceBand, t.sourceDomainCount),
    /** FK-referencing columns; Postgres does not auto-index them. */
    index("skill_candidate_run_id_idx").on(t.runId),
    index("skill_candidate_resulting_skill_idx").on(t.resultingSkillId),
    index("skill_candidate_reviewer_idx").on(t.reviewerAdminId),
    /** The report's per-family breakdown. */
    index("skill_candidate_family_idx").on(t.tradeFamily),
    /**
     * THE ADMIN QUEUE'S KEYSET WALK — `(created_at DESC, candidate_id DESC)`.
     *
     * `skill_candidate_queue_idx` above serves the FILTER (`status`, `band`) and cannot serve the
     * ORDER: the admin review page is `ORDER BY created_at DESC, candidate_id DESC LIMIT n+1`, so
     * without this the default page is a full sort of the table — and the table is 6,673 rows on
     * a single run, growing per run.
     *
     * `.nullsFirst()` IS LOAD-BEARING, and it is invisible in a diff and silent in production —
     * the `chat_messages_session_created_idx` lesson (migration 0067), repeated at
     * `worker_feedback_admin_keyset_idx` (schema/feedback.ts:90-104) and now a third time.
     * Drizzle's bare `desc()` in the repository emits no NULLS clause, which Postgres reads as
     * DESC NULLS FIRST; an index built by `.desc()` alone is DESC NULLS LAST and does NOT satisfy
     * that ordering. The planner then keeps the index for the filter and inserts a Sort anyway,
     * which is the entire cost this index exists to remove. Both columns are NOT NULL, so this
     * changes no result — only the plan.
     *
     * THE TIE-BREAKER IS DOING MORE WORK HERE THAN ANYWHERE ELSE IN THE SCHEMA. A whole run's
     * candidates are inserted in one statement and share ONE `created_at`, so at a page boundary
     * the keyset predicate's equality branch is the only branch that can be true — the timestamp
     * alone would page 6,673 identical values.
     */
    index("skill_candidate_admin_keyset_idx").on(
      t.createdAt.desc().nullsFirst(),
      t.candidateId.desc().nullsFirst(),
    ),
    /**
     * THE REVIEWER'S `?phrase=` LOOKUP — an ANCHORED prefix on `normalized_phrase`.
     *
     * `text_pattern_ops` and not the default `text_ops`, and that is the whole point of the
     * index: a btree built with the collation-aware default CANNOT serve `LIKE 'welding%'` unless
     * the database was initialised with the C locale, which this one was not. The operator class
     * compares byte by byte, which is exactly what an anchored `LIKE` needs.
     *
     * IT IS ALSO WHAT KEEPS THE ANCHOR HONEST RATHER THAN MERELY POLITE. The API refuses a
     * leading wildcard (`prefixPattern` escapes `%` and `_` before appending its own `%`) because
     * an unanchored substring search over a corpus containing worker-derived wording is a
     * discovery tool no matter how the column is described. This index is the reason the anchored
     * form is also the FAST form, so nobody has a performance argument for widening it later.
     */
    index("skill_candidate_norm_prefix_idx").using(
      "btree",
      sql`${t.normalizedPhrase} text_pattern_ops`,
    ),

    check(
      "skill_candidate_status_chk",
      sql`${t.status} IN ('pending', 'needs_review', 'approved_create', 'approved_map', 'approved_merge', 'rejected', 'deferred')`,
    ),
    check(
      "skill_candidate_action_chk",
      sql`${t.proposedAction} IN ('map', 'create', 'merge', 'reject', 'review')`,
    ),
    check("skill_candidate_band_chk", sql`${t.confidenceBand} IN ('high', 'medium', 'low')`),
    check(
      "skill_candidate_embedding_status_chk",
      sql`${t.embeddingStatus} IN ('reused', 'needs_embedding', 'not_required')`,
    ),
    check(
      "skill_candidate_confidence_range_chk",
      sql`${t.confidence} IS NULL OR (${t.confidence} >= 0 AND ${t.confidence} <= 1)`,
    ),
    check(
      "skill_candidate_model_pair_chk",
      sql`(${t.model} IS NULL) = (${t.promptVersion} IS NULL)`,
    ),

    /**
     * A HUMAN DECISION NAMES THE HUMAN, THE MOMENT, AND THE REASON.
     *
     * All three or the row is refused. This is the constraint that makes the audit trail a
     * property of the database rather than a promise made by whichever service happened to
     * write the row.
     */
    check(
      "skill_candidate_reviewed_chk",
      sql`${t.status} NOT IN ('approved_create', 'approved_map', 'approved_merge', 'rejected', 'deferred')
           OR (${t.reviewerAdminId} IS NOT NULL AND ${t.reviewedAt} IS NOT NULL AND ${t.reviewReason} IS NOT NULL)`,
    ),
    /** The inverse. A machine status carrying a reviewer claims a decision nobody made. */
    check(
      "skill_candidate_machine_status_chk",
      sql`${t.status} NOT IN ('pending', 'needs_review') OR ${t.reviewerAdminId} IS NULL`,
    ),
    /** Mapping or merging onto nothing is not a decision. */
    check(
      "skill_candidate_resolution_chk",
      sql`${t.status} NOT IN ('approved_map', 'approved_merge') OR ${t.resultingSkillId} IS NOT NULL`,
    ),
    /** Approving a creation with no label leaves nothing to mint an id from. */
    check(
      "skill_candidate_create_label_chk",
      sql`${t.status} <> 'approved_create' OR ${t.proposedSkillName} IS NOT NULL`,
    ),
    /**
     * A NEW SKILL MUST NAME AT LEAST ONE TRADE.
     *
     * The database half of the `SKILL_ORPHAN` argument on `approvedJobDomainIds`. Without an
     * edge the skill is unreachable: not on any picker, not requestable by any posting, and
     * unpromotable (`db:promote:skills` C3 ACTIVE_EDGE refuses it). Enforcing it here rather
     * than only in the service means a row written by anything — a backfill, a fixture, a
     * future runner — is subject to the same rule.
     *
     * ── `cardinality`, NOT `array_length`, AND THE DIFFERENCE IS THE WHOLE CONSTRAINT ──────
     * `array_length('{}', 1)` is NULL, not 0 — an empty array has no dimension 1 to measure. So
     * `array_length(...) >= 1` is NULL for the empty case, `false OR NULL` is NULL, and a CHECK
     * is SATISFIED by NULL. Written with `array_length` this constraint accepted exactly the row
     * it exists to refuse, and `'{}'` is the column DEFAULT, so that is the state every row
     * starts in. Measured on the server rather than argued from the manual:
     *
     *   array_length('{}'::text[], 1)                  -> NULL
     *   cardinality('{}'::text[])                      -> 0
     *   'approved_create' <> 'approved_create'
     *     OR array_length('{}'::text[], 1) >= 1        -> NULL   (row ACCEPTED)
     *     OR cardinality('{}'::text[])   >= 1          -> false  (row REFUSED)
     *
     * The HTTP path never depended on it — `AdminSkillCreateDecision` requires a non-empty array
     * and `assertLiveJobDomains` resolves every id — but this is the wall that survives a
     * hand-written UPDATE, which is the only reason it exists.
     */
    check(
      "skill_candidate_create_domain_chk",
      sql`${t.status} <> 'approved_create' OR cardinality(${t.approvedJobDomainIds}) >= 1`,
    ),
    check(
      "skill_candidate_requirement_chk",
      sql`${t.approvedRequirement} IN ('required', 'preferred')`,
    ),
    /**
     * THE MATCH-SKILL WALL, IN THE DATABASE (Phase 12).
     *
     * `mskill_*` is a closed 18-member vocabulary the deterministic match engine consumes.
     * A discovery candidate resolving onto one would let a mined phrase change what the
     * engine ranks on — which CLAUDE.md §3 forbids outright. Stated as a constraint and not
     * as a service-layer check, because the service layer is not the only thing that can
     * write a row.
     */
    check(
      "skill_candidate_not_match_skill_chk",
      sql`${t.resultingSkillId} IS NULL OR ${t.resultingSkillId} NOT LIKE 'mskill\\_%'`,
    ),
  ],
).enableRLS(); // FORCE + REVOKE carried by migration 0093

// ===========================================================================
// skill_candidate_source
// ===========================================================================

/**
 * THE TRACEABILITY TABLE — every phrase that contributed to a candidate, kept whole.
 *
 * This is what answers the Phase-8 auditor's two questions:
 *
 *   "Why does this canonical skill exist?"                 candidate -> run -> model/prompt/fingerprint
 *   "Which job-domain aliases caused it to be proposed?"   candidate -> these rows
 *
 * Clustering is what makes the queue reviewable; this table is what stops clustering being
 * lossy. Nothing is aggregated away — original text, normalized text, and the domain each
 * was observed under all survive.
 *
 * PRIVACY: `original_text` is the one column that could carry worker free text, and for the
 * `worker_phrase` source type it is contractually PSEUDONYMIZED upstream. There is no
 * `worker_id` column, deliberately — the same aggregate-only contract `unresolved_phrase`
 * holds, so this is not a per-worker DSAR surface.
 */
export const skillCandidateSources = pgTable(
  "skill_candidate_source",
  {
    candidateId: uuid("candidate_id")
      .notNull()
      .references(() => skillCandidates.candidateId, { onDelete: "cascade" }),
    sourceType: text("source_type").$type<SkillCandidateSourceType>().notNull(),
    /**
     * The source row's own id, as text.
     *
     * TEXT AND NOT A TYPED FK, because the six source types point at four different id
     * spaces (a `job_domain_alias` uuid, a `jd_*` text id, an `unresolved_phrase` uuid, a
     * chat message uuid). Six nullable FK columns would express the same thing with five
     * NULLs per row and a CHECK to enforce exactly-one — the shape `unresolved_phrase`'s
     * `domain_id`/`job_domain_id` pair already shows is only worth it for TWO columns.
     */
    sourceId: text("source_id").notNull(),
    originalText: text("original_text").notNull(),
    /** `normalizeOccupationText(original_text)` — the SAME key `skill_alias.text_norm` stores. */
    normalizedText: text("normalized_text").notNull(),
    /** The domain this phrase was observed under. NULL for sources with no domain scope. */
    jobDomainId: text("job_domain_id").references(() => jobDomains.jobDomainId),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    /** The natural key IS the triple — makes the writer's insert `ON CONFLICT DO NOTHING`
     *  and a duplicated source row impossible. Its leading column serves the detail read. */
    primaryKey({ columns: [t.candidateId, t.sourceType, t.sourceId] }),
    /** The reverse lookup: "which candidate did THIS alias end up in?" — the audit read. */
    index("skill_candidate_source_source_idx").on(t.sourceType, t.sourceId),
    /** "which candidates came out of this trade?" */
    index("skill_candidate_source_job_domain_idx").on(t.jobDomainId),
    /** Search by normalized phrase across the queue. */
    index("skill_candidate_source_norm_idx").on(t.normalizedText),
    check(
      "skill_candidate_source_type_chk",
      sql`${t.sourceType} IN ('job_domain_alias', 'job_domain_label', 'unresolved_phrase', 'worker_phrase', 'job_text', 'skill_alias')`,
    ),
  ],
).enableRLS(); // FORCE + REVOKE carried by migration 0093

// ===========================================================================
// skill_candidate_match
// ===========================================================================

/**
 * EVERY COMPETING EXISTING-CANONICAL MATCH, WITH ITS SCORE AND ITS STRENGTH.
 *
 * PLURAL BY DESIGN. The alternative — one `best_match_skill_id` column on the candidate — is
 * how a false match becomes invisible: the reviewer sees `ducting_installation -> plumber
 * (0.82)` with nothing beside it and no way to tell that the second and third candidates
 * were `pipe_fitting (0.81)` and `hvac_ducting (0.79)`. The brief's Phase 5 requires the
 * competition be shown; this table is that requirement in the schema.
 *
 * `strength` mirrors `EquivalenceEvidence` in `taxonomy-lexical.ts`: `strong` may be acted
 * on, `weak` may only be escalated. A weak match must never populate `proposed_action` — see
 * `skill-discovery-plan.ts`, where that rule lives as code and is asserted by test.
 */
export const skillCandidateMatches = pgTable(
  "skill_candidate_match",
  {
    candidateId: uuid("candidate_id")
      .notNull()
      .references(() => skillCandidates.candidateId, { onDelete: "cascade" }),
    /** ON DELETE NO ACTION: a skill is deprecated, never deleted (SG-5). */
    skillId: text("skill_id")
      .notNull()
      .references(() => skills.skillId),
    /** `exact_surface` | `skeleton_surface` | an `EquivalenceRelation` | `vector_cosine`. */
    relation: text("relation").notNull(),
    /** 0..1. Lexical jaccard, a pinned exact-rung score, or cosine over stored vectors. */
    score: real("score").notNull(),
    strength: text("strength").notNull(),
    /** 1-based display order, so the UI renders the competition in the pipeline's order. */
    rank: smallint("rank").notNull(),
    /** Human-readable evidence for the reviewer. Never parsed. */
    evidenceDetail: text("evidence_detail"),
  },
  (t) => [
    primaryKey({ columns: [t.candidateId, t.skillId] }),
    /** "which candidates are competing for THIS skill?" — the collision read. */
    index("skill_candidate_match_skill_idx").on(t.skillId),
    check("skill_candidate_match_strength_chk", sql`${t.strength} IN ('strong', 'weak')`),
    check(
      "skill_candidate_match_score_chk",
      sql`${t.score} >= 0 AND ${t.score} <= 1`,
    ),
    check("skill_candidate_match_rank_chk", sql`${t.rank} >= 1`),
    /**
     * The match-skill wall again, on the other column that could reach `mskill_*`.
     *
     * Discovery never resolves onto the matchable space. Stated at BOTH ends rather than
     * once, because a constraint on `skill_candidate.resulting_skill_id` alone would still
     * let a reviewer SEE an `mskill_*` in the competing-match list and reasonably conclude
     * it was an option.
     */
    check(
      "skill_candidate_match_not_match_skill_chk",
      sql`${t.skillId} NOT LIKE 'mskill\\_%'`,
    ),
  ],
).enableRLS(); // FORCE + REVOKE carried by migration 0093
