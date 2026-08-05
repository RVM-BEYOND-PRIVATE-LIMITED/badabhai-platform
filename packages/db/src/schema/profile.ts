/**
 * Profile domain — the canonicalized worker profile and generated resumes, plus the
 * metadata-driven profiling questionnaire (profiles / questions / answers).
 */
import { sql } from "drizzle-orm";
import type { AnyPgColumn } from "drizzle-orm/pg-core";
import {
  pgTable,
  uuid,
  text,
  integer,
  doublePrecision,
  boolean,
  timestamp,
  date,
  jsonb,
  vector,
  index,
  uniqueIndex,
  check,
} from "drizzle-orm/pg-core";
import type {
  ProfileStatus,
} from "@badabhai/types";
import { jsonObject, jsonArray } from "./internal/sql-defaults";
import { workers } from "./worker";
import { jobDomains } from "./occupation";
import type { JobDomainMatchStatus } from "./occupation";

// ---------------------------------------------------------------------------
// worker_profiles — canonicalized profile (one current per worker in Phase 1)
// ---------------------------------------------------------------------------
export const workerProfiles = pgTable(
  "worker_profiles",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workerId: uuid("worker_id")
      .notNull()
      .references(() => workers.id, { onDelete: "cascade" }),
    // The extraction job that produced this profile (logical ref to ai_jobs.id;
    // no FK, kept lean like the rest of the spine). The UNIQUE index below makes
    // profile creation idempotent per job (TD14): a partial-success retry (the
    // profile row committed, then markCompleted failed → BullMQ redelivers) finds
    // the key already taken and re-creates NOTHING, instead of orphaning a second
    // profile. Nullable — legacy/non-extraction profiles have none, and Postgres
    // treats NULLs as DISTINCT so they never collide.
    aiJobId: uuid("ai_job_id"),
    profileStatus: text("profile_status").$type<ProfileStatus>().notNull().default("draft"),
    canonicalTradeId: text("canonical_trade_id"),
    canonicalRoleId: text("canonical_role_id"),
    skills: jsonb("skills").$type<string[]>().notNull().default(jsonArray),
    // B-6 (context-drift register 2026-07-16): the @badabhai/taxonomy
    // SKILL_TAXONOMY_VERSION in force when `skills` was last WRITTEN (extraction
    // create; offline TAX-9 retag). Stamped only where skills are (re)written —
    // never touched on read. NULLABLE by design, no backfill: NULL honestly means
    // "written before versioning existed". Text (not integer) so a future version
    // scheme (date-tagged / semver on re-embed) needs no lossy migration; equality
    // is the only operation, never ordering.
    taxonomyVersion: text("taxonomy_version"),
    machines: jsonb("machines").$type<string[]>().notNull().default(jsonArray),
    experience: jsonb("experience").notNull().default(jsonObject),
    salaryExpectation: jsonb("salary_expectation").notNull().default(jsonObject),
    locationPreference: jsonb("location_preference").notNull().default(jsonObject),
    availability: jsonb("availability").notNull().default(jsonObject),
    rawProfile: jsonb("raw_profile").notNull().default(jsonObject),
    // Issue #419 — the AI service's RICH WorkerProfileDraft (28 fields: controllers,
    // education, certifications, current vs expected salary, availability,
    // current_city/current_state, ...). The extraction response has always carried it
    // (ProfileExtractionOutputSchema.worker_profile_draft) and apps/api discarded it, so
    // everything the interview asked beyond the narrow legacy shape was thrown away.
    //
    // Stored as-is, additively, in its OWN column — `raw_profile` cannot be reused for it
    // because resume.service.ts parses that column with DraftProfileSchema, so widening it
    // would break resume generation (§8).
    //
    // NULLABLE with no default and no backfill: NULL honestly means "extracted before this
    // column existed", exactly like `taxonomy_version` above.
    //
    // §2: verified field-by-field against the schema — no employer name, worker name,
    // phone, address, or id-doc token. Location is city/state only, no finer than the
    // `location_preference` column beside it. It is written HERE and nowhere else: never
    // into events, ai_jobs, audit_logs, logs, or LLM input. The one field to watch on any
    // future widening is `clarification_questions`, the only free-text the model authors.
    //
    // Untyped jsonb like `experience`/`salary_expectation` beside it, so packages/db does
    // not take a dependency on @badabhai/ai-contracts; the API validates with the Zod
    // schema at the write site.
    richProfileDraft: jsonb("rich_profile_draft"),
    // Managed Vertex embedding (text-multilingual-embedding-002, 768-dim) for
    // semantic similarity. Nullable until the profile is embedded (plan G3).
    embedding: vector("embedding", { dimensions: 768 }),
    // ── Generalized profiling: the matched job domain (migration 0066) ────────
    //
    // A NEW, PARALLEL COLUMN — deliberately NOT a widening of `canonical_role_id`.
    // That distinction is load-bearing, and getting it wrong fails SILENTLY:
    // `canonical_role_id` feeds WorkerSkillsService.rebuildForWorker ->
    // deriveWorkerSkills -> ROLE_TO_MATCH_SKILL, a map that is exhaustive over the 13
    // taxonomy ROLES. An id outside that set returns `undefined`, the derived skill
    // set comes back EMPTY, the reach reconciler is handed an empty wanted-list, and
    // the worker is removed from every job_reach row. Nothing throws. Writing a `jd_*`
    // id into that column would quietly delete workers from every feed, so it never
    // happens: `canonical_role_id` keeps its 13-value meaning, and the domain lands
    // here, where nothing existing reads it.
    //
    // FK is the LAST line of defence against a hallucinated id. The model picks from a
    // shortlist we retrieved, the id is re-checked against the shortlist and then
    // against the DB — and even if both were bypassed, an invented id is physically
    // unwritable. ON DELETE SET NULL, never CASCADE: catalog rows are deprecated
    // rather than deleted (SG-5), but if one ever were, degrading to "unmatched" is
    // correct and deleting the worker's whole profile plainly is not.
    jobDomainId: text("job_domain_id").references(
      (): AnyPgColumn => jobDomains.jobDomainId,
      { onDelete: "set null" },
    ),
    // WHY the match ended where it did. Recorded on EVERY path including failure,
    // because "we could not place this worker" is exactly the metric the catalog's
    // coverage is judged on, and it is invisible if only successes are stored.
    jobDomainMatchStatus: text("job_domain_match_status").$type<JobDomainMatchStatus>(),
    // Cosine similarity of the winning candidate. Diagnostic + floor calibration only;
    // NEVER an input to ranking (invariant #4 — rank stays deterministic).
    jobDomainMatchScore: doublePrecision("job_domain_match_score"),
    jobDomainMatchedAt: timestamp("job_domain_matched_at", { withTimezone: true }),
    confirmedAt: timestamp("confirmed_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("worker_profiles_worker_id_idx").on(t.workerId),
    // Idempotent extraction (TD14): at most one profile per ai_job. Many NULLs
    // allowed (NULLS DISTINCT — Postgres default). See `aiJobId` above.
    uniqueIndex("worker_profiles_ai_job_id_uq").on(t.aiJobId),
    // HNSW index for cosine similarity search over the 768-dim embedding (plan G5).
    index("worker_profiles_embedding_hnsw").using("hnsw", t.embedding.op("vector_cosine_ops")),
    // "How many workers landed in domain X" — the coverage read, and the FK-referencing
    // column Postgres does not auto-index.
    index("worker_profiles_job_domain_id_idx").on(t.jobDomainId),
    check(
      "worker_profiles_job_domain_match_status_chk",
      sql`${t.jobDomainMatchStatus} IS NULL OR ${t.jobDomainMatchStatus} IN ('matched_auto', 'matched_llm', 'unmatched_below_floor', 'unmatched_llm_declined', 'unmatched_degraded')`,
    ),
  ],
);

// ---------------------------------------------------------------------------
// generated_resumes
// ---------------------------------------------------------------------------
export const generatedResumes = pgTable(
  "generated_resumes",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workerId: uuid("worker_id")
      .notNull()
      .references(() => workers.id, { onDelete: "cascade" }),
    profileId: uuid("profile_id")
      .notNull()
      .references(() => workerProfiles.id, { onDelete: "cascade" }),
    resumeJson: jsonb("resume_json").notNull().default(jsonObject),
    resumeText: text("resume_text").notNull(),
    generatedAt: timestamp("generated_at", { withTimezone: true }).notNull().defaultNow(),
    version: integer("version").notNull().default(1),
    // TD5 layer 2 — versioned PDF render artifact (ADR resume-render).
    // The text/json above is generated synchronously; the PDF is rendered async by the
    // resume-render worker, which fills pdf_storage_key + flips render_status -> 'rendered'.
    templateId: text("template_id").notNull().default("fallback"),
    // Canonical (name-free) structured profile captured at generation time, so a future,
    // better renderer can re-render a richer PDF from the snapshot. Nullable for legacy rows.
    sourceProfileSnapshot: jsonb("source_profile_snapshot"),
    // Opaque object key in the private resumes bucket; null until the PDF is rendered.
    pdfStorageKey: text("pdf_storage_key"),
    // 'pending' -> 'rendered' | 'failed'. Plain text (matches ai_jobs.status), validated in code.
    renderStatus: text("render_status").notNull().default("pending"),
    renderedAt: timestamp("rendered_at", { withTimezone: true }),
  },
  (t) => [
    index("generated_resumes_worker_id_idx").on(t.workerId),
    index("generated_resumes_profile_id_idx").on(t.profileId),
    // At most ONE initial (version 1) resume per profile. Makes initial generation
    // idempotent/race-safe (ON CONFLICT): the auto-generate on profile.confirmed and
    // a manual POST /resume/generate converge on one row instead of double-creating.
    // Partial (version = 1) so regenerations (version > 1) are unconstrained.
    uniqueIndex("generated_resumes_initial_uq")
      .on(t.profileId)
      .where(sql`${t.version} = 1`),
  ],
);

// ---------------------------------------------------------------------------
// Profiling questionnaire (ADR-0005, first slice) — metadata-driven profiles.
//
// In scope here: profiles + questions + profile_questions + worker_answers.
// DEFERRED to later slices (per ADR-0005): `profile_versions` (questionnaire
// versioning) and `question_options` (single/multi-select choices). Until
// `question_options` exists, only text/number/date answers are wired — select-type
// questions can be authored but not yet answered (no `answer_option_id` column yet).
// ---------------------------------------------------------------------------

// profiles — one questionnaire per worker trade/role (Driver, VMC Operator, …).
export const profiles = pgTable(
  "profiles",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    slug: text("slug").notNull(), // stable key (e.g. "vmc_operator")
    name: text("name").notNull(), // display name (English — localized on the frontend)
    status: text("status").$type<"draft" | "active" | "archived">().notNull().default("draft"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex("profiles_slug_uq").on(t.slug)],
);

// questions — reusable question catalog, shared across profiles.
export const questions = pgTable(
  "questions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    questionKey: text("question_key").notNull(), // stable id (e.g. "years_experience")
    questionText: text("question_text").notNull(), // English; localized on the frontend
    answerType: text("answer_type")
      .$type<"text" | "number" | "date" | "single_select" | "multi_select">()
      .notNull(),
    // Maps the answer to a canonical match signal for the worker_profiles projection
    // (e.g. "experience.total_years"). Nullable until wired.
    extractionTopic: text("extraction_topic"),
    // Light validation kept with the question (required / min / max / date-range).
    validation: jsonb("validation").notNull().default(jsonObject),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex("questions_question_key_uq").on(t.questionKey)],
);

// profile_questions — which questions belong to a profile, and in what order.
// (No profile_version_id yet — versioning is a later slice; maps the profile directly.)
export const profileQuestions = pgTable(
  "profile_questions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    profileId: uuid("profile_id")
      .notNull()
      .references(() => profiles.id, { onDelete: "cascade" }),
    questionId: uuid("question_id")
      .notNull()
      .references(() => questions.id, { onDelete: "cascade" }),
    displayOrder: integer("display_order").notNull().default(0),
    // Per-profile requiredness drives interview readiness — NOT match filtering
    // (ADR-0005 sort-never-block invariant).
    isRequired: boolean("is_required").notNull().default(false),
  },
  (t) => [
    // A question appears at most once per profile.
    uniqueIndex("profile_questions_profile_question_uq").on(t.profileId, t.questionId),
    // Load a profile's questions in order.
    index("profile_questions_profile_id_idx").on(t.profileId),
  ],
);

// worker_answers — a worker's answers (PII-minimized; typed columns).
//
// Cardinality-1 today (text/number/date): one row per (worker, question), replaced
// in place on re-answer. An answer is a property of the WORKER (e.g. years_experience
// is the same regardless of which profile surfaced it); `profile_id` is provenance.
// Multi-select (one row per option) lands with `question_options`.
export const workerAnswers = pgTable(
  "worker_answers",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workerId: uuid("worker_id")
      .notNull()
      .references(() => workers.id, { onDelete: "cascade" }),
    // Which questionnaire surfaced this answer (provenance; questions are shared).
    profileId: uuid("profile_id")
      .notNull()
      .references(() => profiles.id, { onDelete: "cascade" }),
    questionId: uuid("question_id")
      .notNull()
      .references(() => questions.id, { onDelete: "cascade" }),
    // Exactly one of these is set (see the CHECK below). `answer_option_id` arrives
    // with `question_options`. PRIVACY: `answer_text` is free input → it must be
    // pseudonymized on the chat capture path before persist (ADR-0005) and is never
    // emitted into events; events/analytics read the typed columns only.
    answerText: text("answer_text"),
    answerNumber: doublePrecision("answer_number"),
    answerDate: date("answer_date"),
    source: text("source").$type<"chat" | "form" | "import">().notNull().default("chat"),
    answeredAt: timestamp("answered_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    // Cardinality-1: one answer per (worker, question); ON CONFLICT … DO UPDATE replaces.
    uniqueIndex("worker_answers_worker_question_uq").on(t.workerId, t.questionId),
    index("worker_answers_profile_id_idx").on(t.profileId),
    // Exactly one typed answer column is populated.
    check(
      "worker_answers_one_value_chk",
      sql`(
        (${t.answerText} IS NOT NULL)::int +
        (${t.answerNumber} IS NOT NULL)::int +
        (${t.answerDate} IS NOT NULL)::int
      ) = 1`,
    ),
  ],
);

