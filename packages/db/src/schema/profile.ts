// Profiling-questionnaire domain (ADR-0005): profiles, questions,
// profile_questions and worker_answers.

import { sql } from "drizzle-orm";
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
  index,
  uniqueIndex,
  check,
} from "drizzle-orm/pg-core";
import { jsonObject } from "./_internal/json-defaults";
import { workers } from "./worker";

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

// ---------------------------------------------------------------------------
// Inferred row types (select / insert) for use across services.
// ---------------------------------------------------------------------------
export type Profile = typeof profiles.$inferSelect;
export type NewProfile = typeof profiles.$inferInsert;
export type Question = typeof questions.$inferSelect;
export type NewQuestion = typeof questions.$inferInsert;
export type ProfileQuestion = typeof profileQuestions.$inferSelect;
export type NewProfileQuestion = typeof profileQuestions.$inferInsert;
export type WorkerAnswer = typeof workerAnswers.$inferSelect;
export type NewWorkerAnswer = typeof workerAnswers.$inferInsert;
