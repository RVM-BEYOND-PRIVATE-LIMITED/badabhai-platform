/**
 * Question packs — the occupation-specific interview, as DATA (migration 0069).
 *
 * WHAT THIS REPLACES AND WHY. The first deterministic engine kept its questions in a
 * 632-line Python bank keyed to seven hardcoded role families, so a tailor got asked CNC
 * questions. Deleting it handed the interview to an LLM, which fixed coverage by giving a
 * model conversational control — the thing CLAUDE.md §3 exists to forbid. This schema is
 * the third answer: the question set is neither code nor a model's improvisation, it is
 * versioned, reviewed rows bound to a published occupation taxonomy.
 *
 * FIVE TABLES, AND THE ONE IDEA THAT ORGANISES THEM.
 *
 *   profiling_family          ~200 rows. The PACK OWNER.
 *   profiling_family_binding  how a family claims part of the occupation tree.
 *   question_pack             a versioned container, one active per (family, locale).
 *   question_pack_item        the question.
 *   question_pack_option      the chips.
 *
 * The idea is that FAMILY, not occupation, is the unit of conversation. NCO has 3,449
 * occupations and unit group 7223 alone holds 44 near-identical machining titles;
 * "Welder, Gas" and "Welder, Electric" differ by ~0.02 at occupation level and by nothing
 * at all in what you would ASK someone. Binding packs to occupations would mean 3,449
 * packs, near-duplicates all, and a retrieval margin too thin to act on. Binding them to
 * ~200 families makes the margin computable and the authoring finite. The exact NCO code
 * is then settled by the pack's own first question — deterministic, free, and better UX
 * than a disambiguation prompt listing 44 titles.
 *
 * WHY NOT EXTEND `questions` / `worker_answers` (schema.ts:852-940). That table is
 * unversioned; its `question_key` is GLOBALLY unique, so two packs could not both own
 * `experience_years`; it has no options table (ADR-0005 defers it explicitly) and no
 * conditional logic. Superseded, not extended — and deliberately not dropped (CLAUDE.md
 * §10).
 *
 * PRIVACY: reviewed interview copy and occupation references. No worker data reaches any
 * of these tables — worker ANSWERS live in `worker_pack_answer` (migration 0073).
 */
import { sql } from "drizzle-orm";
import type { AnyPgColumn } from "drizzle-orm/pg-core";
import {
  pgTable,
  uuid,
  text,
  integer,
  smallint,
  boolean,
  jsonb,
  timestamp,
  index,
  uniqueIndex,
  check,
  primaryKey,
  foreignKey,
} from "drizzle-orm/pg-core";

import type {
  ProfilingFamilyStatus,
  QuestionPackStatus,
  QuestionTargetKind,
  AnswerType,
} from "./internal/question-pack-types";

// ===========================================================================
// profiling_family — the pack owner
// ===========================================================================

/**
 * ~200 rows, one per conversational family.
 *
 * THIS IS ALSO WHERE `industry_id` AND `canonical_role_id` FINALLY GET A HOME. Both are
 * NULL on all 4,071 `job_domain` rows (finding F5) because nobody was ever going to
 * hand-crosswalk four thousand occupations into the 13-role match space. At ~200 families
 * it is a week of work rather than a quarter of it, and every occupation inherits its
 * family's answer through the binding table.
 *
 * `label_hi` matters more than it looks: it is what a worker is SHOWN when the engine
 * says "so you're a welder?" — the trust moment of the whole interview. `label_en` is
 * frequently unusable for that ("Metal Working Machine Tool Setters and Operators").
 */
export const profilingFamilies = pgTable(
  "profiling_family",
  {
    familyId: text("family_id").primaryKey(),
    labelEn: text("label_en").notNull(),
    labelHi: text("label_hi"),
    /** Crosswalk into the 13-role match space. NULL until an author sets it. */
    canonicalRoleId: text("canonical_role_id"),
    industryId: text("industry_id"),
    status: text("status").$type<ProfilingFamilyStatus>().notNull().default("active"),
    /** Bumped when the family's MEANING changes, not when a pack under it changes. */
    version: integer("version").notNull().default(1),
    /**
     * Set when a family is split or merged, so a pinned conversation can still resolve.
     * Self-FK for the same reason `job_domain.replaced_by` has one: a pointer to a family
     * that was itself deleted is worse than no pointer, because the resolver follows it.
     */
    replacedBy: text("replaced_by").references((): AnyPgColumn => profilingFamilies.familyId),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    // `fam_` prefix for the same reason `jd_` exists on job_domain: this is a FOURTH id
    // space in a repo that already carries three meanings of "domain id". A grep for
    // fam_ must never return anything else.
    check("profiling_family_id_chk", sql`${t.familyId} ~ '^fam_[a-z0-9_]+$'`),
    check(
      "profiling_family_status_chk",
      sql`${t.status} IN ('active', 'draft', 'deprecated')`,
    ),
    check("profiling_family_version_chk", sql`${t.version} >= 1`),
    index("profiling_family_status_idx").on(t.status),
  ],
).enableRLS(); // RLS tracked in the model; carried by the migration (BL-26 parity fix)

// ===========================================================================
// profiling_family_binding — how a family claims part of the occupation tree
// ===========================================================================

/**
 * THE INHERITANCE TABLE. A family claims occupations at one of six granularities, and
 * resolution is one `ORDER BY specificity DESC LIMIT 1` rather than a six-way COALESCE
 * with six NULL checks that drift apart the moment a seventh level appears.
 *
 *   50  job_domain_id       this exact occupation
 *   40  isco_unit_code      the unit group (7223)
 *   30  isco_minor_code     the minor group (722)
 *   20  isco_submajor_code  the sub-major (72)
 *   10  isco_major_code     the major (7)
 *    0  is_universal        the fallback that keeps every unauthored trade working
 *
 * EXACTLY ONE TARGET COLUMN IS NON-NULL, and `specificity` must agree with WHICH one.
 * Both are CHECK constraints rather than conventions, because a row with two targets has
 * no defined meaning and a row whose specificity disagrees with its target silently wins
 * or loses resolutions it should not.
 *
 * SIX PARTIAL UNIQUE INDEXES make two families claiming the same target STRUCTURALLY
 * impossible. Without them, most-specific-wins would quietly paper over a double-claim by
 * picking one — a corpus bug that never surfaces as an error, only as workers in a trade
 * getting the wrong interview. The universal one is `((true)) WHERE is_universal`, which
 * permits exactly one universal binding across the whole table.
 */
export const profilingFamilyBindings = pgTable(
  "profiling_family_binding",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    familyId: text("family_id")
      .notNull()
      .references(() => profilingFamilies.familyId, { onDelete: "cascade" }),
    jobDomainId: text("job_domain_id"),
    iscoUnitCode: text("isco_unit_code"),
    iscoMinorCode: text("isco_minor_code"),
    iscoSubmajorCode: text("isco_submajor_code"),
    iscoMajorCode: text("isco_major_code"),
    isUniversal: boolean("is_universal").notNull().default(false),
    specificity: smallint("specificity").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    check(
      "pfb_exactly_one_target_chk",
      sql`(
        (CASE WHEN ${t.jobDomainId}       IS NOT NULL THEN 1 ELSE 0 END) +
        (CASE WHEN ${t.iscoUnitCode}      IS NOT NULL THEN 1 ELSE 0 END) +
        (CASE WHEN ${t.iscoMinorCode}     IS NOT NULL THEN 1 ELSE 0 END) +
        (CASE WHEN ${t.iscoSubmajorCode}  IS NOT NULL THEN 1 ELSE 0 END) +
        (CASE WHEN ${t.iscoMajorCode}     IS NOT NULL THEN 1 ELSE 0 END) +
        (CASE WHEN ${t.isUniversal}       THEN 1 ELSE 0 END)
      ) = 1`,
    ),
    // Specificity is DERIVED from which target is set, so letting an author supply a
    // contradicting value would make the ordering lie.
    check(
      "pfb_specificity_matches_target_chk",
      sql`(
        (${t.jobDomainId}      IS NOT NULL AND ${t.specificity} = 50) OR
        (${t.iscoUnitCode}     IS NOT NULL AND ${t.specificity} = 40) OR
        (${t.iscoMinorCode}    IS NOT NULL AND ${t.specificity} = 30) OR
        (${t.iscoSubmajorCode} IS NOT NULL AND ${t.specificity} = 20) OR
        (${t.iscoMajorCode}    IS NOT NULL AND ${t.specificity} = 10) OR
        (${t.isUniversal}      AND ${t.specificity} = 0)
      )`,
    ),
    uniqueIndex("pfb_job_domain_uq").on(t.jobDomainId).where(sql`${t.jobDomainId} IS NOT NULL`),
    uniqueIndex("pfb_isco_unit_uq").on(t.iscoUnitCode).where(sql`${t.iscoUnitCode} IS NOT NULL`),
    uniqueIndex("pfb_isco_minor_uq").on(t.iscoMinorCode).where(sql`${t.iscoMinorCode} IS NOT NULL`),
    uniqueIndex("pfb_isco_submajor_uq")
      .on(t.iscoSubmajorCode)
      .where(sql`${t.iscoSubmajorCode} IS NOT NULL`),
    uniqueIndex("pfb_isco_major_uq").on(t.iscoMajorCode).where(sql`${t.iscoMajorCode} IS NOT NULL`),
    // THE SIXTH INDEX. Every row matching the predicate has is_universal = true, so
    // uniqueness on that column permits exactly ONE universal binding in the table —
    // the same effect as the plan's `((true)) WHERE is_universal`, without needing an
    // expression index.
    //
    // It is called out because its absence was NOT hypothetical: the first cut of this
    // file shipped five indexes and a comment claiming six, and a fresh-database probe
    // inserted two universal bindings side by side. Two universals make the fallback
    // chain's last step ambiguous, and the resolver would silently pick one — so every
    // trade with no specific pack could get either interview, with nothing to alert on.
    uniqueIndex("pfb_universal_uq").on(t.isUniversal).where(sql`${t.isUniversal}`),
    index("pfb_family_idx").on(t.familyId),
    // Resolution reads (target, specificity DESC) — the covering shape for the lookup the
    // orchestrator performs on every pinned occupation.
    index("pfb_specificity_idx").on(t.specificity),
  ],
).enableRLS(); // RLS tracked in the model; carried by the migration (BL-26 parity fix)

// ===========================================================================
// question_pack — the versioned container
// ===========================================================================

/**
 * PRIMARY KEY IS (pack_id, version), which makes a published version IMMUTABLE BY
 * CONSTRUCTION rather than by discipline. A conversation pins `pack_id` + `pack_version`
 * at occupation-pin time and reads that row for its whole life; editing a live pack
 * therefore cannot change the questions under a worker mid-interview, because an edit
 * writes a NEW row. This is also why the pack cache needs no invalidation logic —
 * immutability IS the invalidation.
 *
 * `question_pack_active_uq` permits exactly one `active` version per (family, locale).
 * The resolver must never have to choose between two actives, because whatever rule it
 * used would be invisible to the person authoring the second one.
 */
export const questionPacks = pgTable(
  "question_pack",
  {
    packId: text("pack_id").notNull(),
    version: integer("version").notNull(),
    familyId: text("family_id")
      .notNull()
      .references(() => profilingFamilies.familyId, { onDelete: "restrict" }),
    locale: text("locale").notNull().default("hi-IN"),
    status: text("status").$type<QuestionPackStatus>().notNull().default("draft"),
    /** sha256 over the pack's items+options, so a "no-op" reseed is provably a no-op. */
    contentHash: text("content_hash"),
    /** Free-text reviewer note. The AUTHORITATIVE reviewer record is git blame. */
    reviewNote: text("review_note"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    // A REAL composite primary key, not a unique index. The difference is load-bearing:
    // `question_pack_item` needs a composite FK onto (pack_id, version), and Postgres will
    // only accept a foreign key that references a PK or a unique CONSTRAINT — a unique
    // INDEX does not qualify. Declared as a unique index this table would have looked
    // correct while leaving every item row free to name a pack that does not exist.
    primaryKey({ columns: [t.packId, t.version], name: "question_pack_pkey" }),
    check("question_pack_id_chk", sql`${t.packId} ~ '^qp_[a-z0-9_]+$'`),
    check("question_pack_version_chk", sql`${t.version} >= 1`),
    check(
      "question_pack_status_chk",
      sql`${t.status} IN ('active', 'draft', 'deprecated')`,
    ),
    uniqueIndex("question_pack_active_uq")
      .on(t.familyId, t.locale)
      .where(sql`${t.status} = 'active'`),
    index("question_pack_family_idx").on(t.familyId),
  ],
).enableRLS(); // RLS tracked in the model; carried by the migration (BL-26 parity fix)

// ===========================================================================
// question_pack_item — the question
// ===========================================================================

/**
 * `question_key` IS STABLE ACROSS VERSIONS while `item_id` is not. That split is what
 * lets `worker_pack_answer` be unique on (worker, pack, question_key) WITHOUT the
 * version: a worker re-interviewed under v2 replaces their v1 answer to the same
 * question, rather than accumulating a second row that no reader knows how to reconcile.
 *
 * `target_kind` + `target_field` / `target_skill_id` say WHERE the answer goes. A
 * question that declares nothing is a question whose answer is silently discarded, which
 * is why `'none'` has to be stated explicitly rather than inferred from two NULLs.
 *
 * `ask_if` / `skip_if` are a JSON AST, never a string expression — there is no parser and
 * therefore no injection surface. See `predicate.ts` for the closed operator set.
 *
 * `min_turn` / `max_turn` exist to solve momentum vs loss-aversion AS DATA. Occupation
 * questions should come before universal ones (workers answer fluently about their own
 * trade; leading with salary has the highest abandon rate), but `current_city` and
 * `salary_expected` are the strongest matching signals and must survive abandonment.
 * Hoisting them into the middle of the occupation block is a property of the ROW, not a
 * special case in the engine.
 */
export const questionPackItems = pgTable(
  "question_pack_item",
  {
    itemId: uuid("item_id").primaryKey().defaultRandom(),
    packId: text("pack_id").notNull(),
    packVersion: integer("pack_version").notNull(),
    /** Stable across versions. Must pass the event-payload slug filter — see the check. */
    questionKey: text("question_key").notNull(),
    displayOrder: integer("display_order").notNull(),
    promptText: text("prompt_text").notNull(),
    /** Served when a worker asks back ("job milegi?") instead of answering. */
    whyText: text("why_text"),
    /** Served on the ONE re-ask before the engine gives up and advances. */
    retryText: text("retry_text"),
    targetKind: text("target_kind").$type<QuestionTargetKind>().notNull(),
    targetField: text("target_field"),
    targetSkillId: text("target_skill_id"),
    answerType: text("answer_type").$type<AnswerType>().notNull(),
    isMandatory: boolean("is_mandatory").notNull().default(false),
    isCore: boolean("is_core").notNull().default(false),
    maxAsks: smallint("max_asks").notNull().default(2),
    minTurn: smallint("min_turn"),
    maxTurn: smallint("max_turn"),
    askIf: jsonb("ask_if"),
    skipIf: jsonb("skip_if"),
    /** Follow-up parent, by question_key. Depth is capped at 1 by the validator. */
    parentItemKey: text("parent_item_key"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    // The composite FK the PK above exists to make possible. ON DELETE CASCADE so
    // retiring a pack version takes its items with it — an orphaned item is a question
    // no resolver can reach and no author can find.
    foreignKey({
      columns: [t.packId, t.packVersion],
      foreignColumns: [questionPacks.packId, questionPacks.version],
      name: "qpi_pack_fk",
    }).onDelete("cascade"),
    uniqueIndex("qpi_pack_question_uq").on(t.packId, t.packVersion, t.questionKey),
    index("qpi_pack_idx").on(t.packId, t.packVersion),
    // The SAME filter chat.service.ts applies before an id reaches an event payload
    // (`slugFieldIds`). Enforced here because a bad id does not fail loudly — it makes
    // the flush transaction discard a COMPLETED interview.
    check("qpi_question_key_chk", sql`${t.questionKey} ~ '^[a-z_]+$' AND length(${t.questionKey}) <= 40`),
    check(
      "qpi_target_kind_chk",
      sql`${t.targetKind} IN ('rfs', 'match_skill', 'attribute', 'none')`,
    ),
    // A question must declare where its answer goes, or say explicitly that it goes
    // nowhere. Two NULLs and no kind is how answers get silently dropped.
    check(
      "qpi_target_present_chk",
      sql`(
        (${t.targetKind} = 'none') OR
        (${t.targetKind} = 'match_skill' AND ${t.targetSkillId} IS NOT NULL) OR
        (${t.targetKind} IN ('rfs', 'attribute') AND ${t.targetField} IS NOT NULL)
      )`,
    ),
    check(
      "qpi_answer_type_chk",
      sql`${t.answerType} IN ('text', 'number', 'boolean', 'single_select', 'multi_select', 'city', 'salary', 'duration')`,
    ),
    check("qpi_max_asks_chk", sql`${t.maxAsks} >= 1 AND ${t.maxAsks} <= 3`),
    check("qpi_display_order_chk", sql`${t.displayOrder} >= 0`),
    check(
      "qpi_turn_window_chk",
      sql`${t.minTurn} IS NULL OR ${t.maxTurn} IS NULL OR ${t.minTurn} <= ${t.maxTurn}`,
    ),
  ],
).enableRLS(); // RLS tracked in the model; carried by the migration (BL-26 parity fix)

// ===========================================================================
// question_pack_option — the chips
// ===========================================================================

/**
 * OPTIONS ARE ANSWERS, NEVER QUESTIONS. That rule was unenforceable while an LLM wrote
 * the chips each turn; with static reviewed rows it becomes mechanically checkable by the
 * corpus validator, which is most of the point of moving them into data.
 *
 * `label_text` is what the worker taps AND what is recorded as their answer verbatim
 * (chat_profiling_screen.dart:672), so two options sharing a label make the recorded
 * answer ambiguous after the fact. The validator rejects that.
 *
 * `is_none_of_above` is flagged rather than inferred from the label, because "Kuch aur"
 * / "इनमें से कोई नहीं" / "Other" are all the same semantic and no substring rule
 * survives contact with a second locale.
 */
export const questionPackOptions = pgTable(
  "question_pack_option",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    itemId: uuid("item_id")
      .notNull()
      .references(() => questionPackItems.itemId, { onDelete: "cascade" }),
    optionKey: text("option_key").notNull(),
    displayOrder: integer("display_order").notNull(),
    labelText: text("label_text").notNull(),
    valueText: text("value_text"),
    valueNumber: integer("value_number"),
    valueBool: boolean("value_bool"),
    /** Tapping this chip asserts a skill, without a separate question. */
    impliesSkillId: text("implies_skill_id"),
    isNoneOfAbove: boolean("is_none_of_above").notNull().default(false),
  },
  (t) => [
    uniqueIndex("qpo_item_key_uq").on(t.itemId, t.optionKey),
    // Two chips with the same visible label make the recorded answer ambiguous, because
    // the label IS the answer of record.
    uniqueIndex("qpo_item_label_uq").on(t.itemId, t.labelText),
    index("qpo_item_idx").on(t.itemId),
    check("qpo_option_key_chk", sql`${t.optionKey} ~ '^[a-z0-9_]+$'`),
    check("qpo_display_order_chk", sql`${t.displayOrder} >= 0`),
  ],
).enableRLS(); // RLS tracked in the model; carried by the migration (BL-26 parity fix)
