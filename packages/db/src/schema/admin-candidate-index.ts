/**
 * ADMIN CANDIDATE READ TABLE (B4, #2557 — design: ADR-0062 §3.5 + §7).
 *
 * `admin_candidate_index` is a DERIVED READ MODEL, one row per worker — never a
 * source of truth. Every value is computed by
 * `CandidateIndexProjector.projectWorker` (apps/api) with the same TypeScript
 * resolvers the employer-facing reads use (`worker-field-precedence.ts`,
 * `profile-summary.mapper.ts`, `toCandidateRow`), plus the correction overlay
 * once #2561 ships (`resolveEffectiveFacts` seam). A DB trigger would
 * re-implement that precedence in SQL and drift — hence a queued projector.
 *
 * PRIVACY (§2 / ADR-0062 §9): folded canonical labels, opaque ids, closed-vocab
 * labels, counts and integer ₹ ONLY. `search_doc` carries trade/role/skills/
 * city/machines/languages labels — NEVER a name, phone, employer name or free
 * text. `name_token_hashes` are whole-word HMACs under the dedicated
 * `ADMIN_NAME_TOKEN_KEYS` keyring (never `PII_HASH_PEPPER`); `phone_hash` is a
 * copy of `workers.phone_hash` for exact lookup (never recomputed). None of
 * `search_doc` / `name_token_hashes` / `phone_hash` may ever be selected into
 * an API response (static DTO test), analytics export, replica or BI feed.
 *
 * DPDP ERASURE IS THE CASCADE: `worker_id → workers(id) ON DELETE CASCADE`, so
 * the existing hard delete removes the row atomically — no deletion-service
 * change (the `job_reach` / `learn_labels` pattern).
 *
 * ADDITIVE. Rollback: DROP TABLE "admin_candidate_index"; DROP TABLE
 * "admin_candidate_index_cursor";
 */
import { sql } from "drizzle-orm";
import {
  boolean,
  check,
  index,
  integer,
  numeric,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

import { workers } from "./worker";

export const adminCandidateIndex = pgTable(
  "admin_candidate_index",
  {
    workerId: uuid("worker_id")
      .primaryKey()
      .references(() => workers.id, { onDelete: "cascade" }),
    status: text("status"),
    // An open `worker_flags` row.
    flagged: boolean("flagged").notNull().default(false),
    isTestAccount: boolean("is_test_account").notNull().default(false),
    deletionScheduledAt: timestamp("deletion_scheduled_at", { withTimezone: true }),
    // Latest `worker_consents.purposes` contains `employer_sharing`.
    employerSharingConsent: boolean("employer_sharing_consent").notNull().default(false),
    // Effective city after the correction overlay.
    currentCity: text("current_city"),
    currentState: text("current_state"),
    canonicalTradeId: text("canonical_trade_id"),
    canonicalRoleId: text("canonical_role_id"),
    jobDomainId: uuid("job_domain_id"),
    tradeLabel: text("trade_label"),
    roleLabel: text("role_label"),
    domainLabel: text("domain_label"),
    // Effective `experience.total_years`.
    totalExperienceYears: numeric("total_experience_years"),
    // Bucketed months on the current role's leading skill.
    roleExperienceMonths: integer("role_experience_months"),
    salaryMinInr: numeric("salary_min_inr"),
    salaryMaxInr: numeric("salary_max_inr"),
    salaryPeriod: text("salary_period"),
    availabilityStatus: text("availability_status"),
    shiftPreference: text("shift_preference"),
    // `worker_profiling_tier.tier` (easy / medium / hard).
    formLevel: text("form_level"),
    // Effective skill labels (ids resolved to labels).
    skills: text("skills").array().notNull().default(sql`'{}'::text[]`),
    // `worker_language` labels.
    languages: text("languages").array().notNull().default(sql`'{}'::text[]`),
    educationLevel: text("education_level"),
    resumeCount: integer("resume_count").notNull().default(0),
    latestResumeStatus: text("latest_resume_status"),
    latestResumeVersion: integer("latest_resume_version"),
    profileStatus: text("profile_status"),
    profileSource: text("profile_source"),
    // Latest `worker_devices.app_version`.
    appVersion: text("app_version"),
    // Latest `worker_devices.last_seen_at`.
    lastActiveAt: timestamp("last_active_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull(),
    // `worker_ai_cost_totals.total_cost_inr`, zero when absent.
    aiCostInr: numeric("ai_cost_inr", { precision: 16, scale: 6 }).notNull().default("0"),
    // First-touch referral label (kind/channel/campaign code — never referrer identity).
    referralSource: text("referral_source"),
    // Folded canonical labels only. Never a name, phone, employer name or free text.
    searchDoc: text("search_doc").notNull().default(""),
    // De-duplicated whole-word name tokens in hash order (not name order).
    nameTokenHashes: text("name_token_hashes").array().notNull().default(sql`'{}'::text[]`),
    // Key id the row's tokens were computed under; NULL when no name is indexed.
    nameTokenKeyId: text("name_token_key_id"),
    // Copy of `workers.phone_hash` for exact phone lookup.
    phoneHash: text("phone_hash").notNull(),
    projectedAt: timestamp("projected_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    // Phone exact lookup — one row per phone hash (mirrors `workers_phone_hash_uq`).
    uniqueIndex("admin_candidate_index_phone_hash_uq").on(t.phoneHash),
    // Partial-match search over the folded label document.
    index("admin_candidate_index_search_doc_trgm_idx").using("gin", t.searchDoc.op("gin_trgm_ops")),
    // Array membership (skills / languages / name-token) lookups.
    index("admin_candidate_index_skills_gin_idx").using("gin", t.skills),
    index("admin_candidate_index_languages_gin_idx").using("gin", t.languages),
    index("admin_candidate_index_name_tokens_gin_idx").using("gin", t.nameTokenHashes),
    // Facet / filter / sort columns.
    index("admin_candidate_index_status_idx").on(t.status),
    index("admin_candidate_index_trade_idx").on(t.canonicalTradeId),
    index("admin_candidate_index_city_idx").on(t.currentCity),
    index("admin_candidate_index_last_active_idx").on(t.lastActiveAt),
    index("admin_candidate_index_created_idx").on(t.createdAt),
    // Key-rotation drift check: which rows still sit on a retired key.
    index("admin_candidate_index_name_key_idx").on(t.nameTokenKeyId),
    check("admin_candidate_index_resume_count_chk", sql`${t.resumeCount} >= 0`),
    check(
      "admin_candidate_index_salary_period_chk",
      sql`${t.salaryPeriod} IS NULL OR ${t.salaryPeriod} IN ('month', 'day', 'year')`,
    ),
  ],
).enableRLS(); // RLS tracked in the model; FORCE + REVOKE carried by the migration

/**
 * Single-row projector watermark (`id = 'singleton'`) over `events.created_at`
 * — the `learn_labels_cursor` precedent (migration 0091). Each tick re-reads a
 * small overlap window before the watermark; projection is an idempotent
 * upsert, so overlap is safe. Holds no PII (a timestamp only).
 */
export const adminCandidateIndexCursor = pgTable("admin_candidate_index_cursor", {
  id: text("id").primaryKey(), // always 'singleton'
  watermark: timestamp("watermark", { withTimezone: true }).notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}).enableRLS(); // RLS tracked in the model; FORCE + REVOKE carried by the migration

export type AdminCandidateIndexRow = typeof adminCandidateIndex.$inferSelect;
export type NewAdminCandidateIndexRow = typeof adminCandidateIndex.$inferInsert;
