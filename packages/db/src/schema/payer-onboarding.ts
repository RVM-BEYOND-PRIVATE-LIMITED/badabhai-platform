/**
 * The four payer-onboarding tables that existed only on production — GAP-DB-21, now MODELLED.
 *
 * ===========================================================================
 * WHY THESE ARE HERE, AND WHY THAT IS A DECISION RATHER THAN A CLEANUP
 * ===========================================================================
 * All four were created out of band. No migration creates them, no schema file described them,
 * and nothing in this repository reads or writes them. `db:audit:live-drift` found them by
 * asking the question a presence check structurally cannot: *what does the live database have
 * that no schema file declares?*
 *
 * Migration `0082` locked them (RLS enabled, FORCED, revoked from every Data-API role) and
 * recorded a recommendation to DROP them. **The owner ruled the other way on 2026-08-20: keep
 * them and model them.** The reasoning is in `phase-9-recommendations.md` §6, and the deciding
 * fact is that dropping is the only irreversible option on the table:
 *
 *   - all four hold **0 rows**, have **0 inbound foreign keys**, and are already locked, so
 *     dropping buys nothing measurable;
 *   - their column names (`employer_profiles.gst_number_enc`,
 *     `payer_member_invites.invited_email_enc`) read as a deliberate, unfinished
 *     payer-onboarding design rather than as debris;
 *   - a drop migration would have to be written FROM THE LIVE CATALOG rather than from a model,
 *     which is the same provenance problem that created GAP-DB-21.
 *
 * Declaring them closes the gap at its root: a declared table is covered by `db:audit:live-drift`,
 * by the schema contract, and by a fresh database's own migration chain. "Do we still want this
 * design?" then becomes a product question answerable at leisure instead of a standing item
 * against a locked empty table.
 *
 * ===========================================================================
 * THE DECLARATION MATCHES THE LIVE CATALOG, NAME FOR NAME
 * ===========================================================================
 * Every column type, default, nullability, CHECK, unique and index below was read off
 * production on 2026-08-20 and is reproduced exactly — including CONSTRAINT NAMES, which are
 * Postgres's `_fkey` / `_check` / `_key` defaults rather than Drizzle's `_fk` convention.
 *
 * That is not cosmetic. `adopt-migrations.ts` verifies a migration's declared constraints
 * against the live catalog BY NAME, so a Drizzle-flavoured name here would make the
 * accompanying migration unadoptable against the one database that already has these tables.
 * Hence the explicit `foreignKey({ name })` / `check(name)` / `unique(name)` everywhere.
 *
 * ===========================================================================
 * THE ONE THING THAT IS NOT MODELLED, AND WHY
 * ===========================================================================
 * `payer_member_invites.accepted_by_user_id` carries a live foreign key to **`auth.users`** —
 * Supabase Auth, a schema this codebase does not otherwise use and which does not exist on a
 * plain Postgres. Modelling it would mean declaring the `auth` schema in Drizzle, and Drizzle
 * would then try to CREATE it.
 *
 * So the column is declared and the CONSTRAINT lives in the migration behind a
 * `to_regclass('auth.users')` guard: present where Supabase is, absent where it is not, and the
 * column is nullable with 0 rows either way. The split is deliberate — the model holds what is
 * portable, the migration holds what is environment-specific — and it is stated here because a
 * reader comparing this file to `\\d payer_member_invites` on production will otherwise find a
 * constraint the model does not mention.
 *
 * ===========================================================================
 * NOT WIRED TO ANYTHING
 * ===========================================================================
 * No repository, service or query reads these tables. Declaring them creates a MODEL, not a
 * feature — `payer_capabilities` in particular is a per-payer boolean permission matrix that
 * the shipped `payer_members.org_role` enum supersedes, and nothing should start reading it
 * without a product ruling that the design is alive.
 */
import { sql } from "drizzle-orm";
import {
  boolean,
  check,
  foreignKey,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  unique,
  uuid,
} from "drizzle-orm/pg-core";

import { jsonArray, jsonObject } from "./internal/sql-defaults";
import { payers } from "./payer";

/**
 * Shared by both profile tables, and the same four values in each.
 *
 * Exported because it IS the CHECK constraint's vocabulary: a reader comparing this file to the
 * live catalog needs the list, and a future consumer that renders a status must not re-type it.
 */
export const PAYER_PROFILE_VERIFICATION_STATUSES = [
  "pending",
  "verified",
  "rejected",
  "suspended",
] as const;
export type PayerProfileVerificationStatus =
  (typeof PAYER_PROFILE_VERIFICATION_STATUSES)[number];

// ---------------------------------------------------------------------------
// agency_profiles — the agency-side extension of a payer. 1:1, PK = payer_id.
// ---------------------------------------------------------------------------
export const agencyProfiles = pgTable(
  "agency_profiles",
  {
    payerId: uuid("payer_id").primaryKey(),
    /** Nullable, and the CHECK admits NULL explicitly — an unclassified agency is legal. */
    agencyType: text("agency_type").$type<
      "placement_agency" | "contractor" | "training_partner" | "consultant"
    >(),
    serviceLocations: jsonb("service_locations")
      .$type<unknown[]>()
      .notNull()
      .default(jsonArray),
    operatingCities: jsonb("operating_cities").$type<unknown[]>().notNull().default(jsonArray),
    recruiterCount: integer("recruiter_count"),
    sourceChannels: jsonb("source_channels").$type<unknown[]>().notNull().default(jsonArray),
    verificationStatus: text("verification_status")
      .$type<PayerProfileVerificationStatus>()
      .notNull()
      .default("pending"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    foreignKey({
      columns: [t.payerId],
      foreignColumns: [payers.id],
      name: "agency_profiles_payer_id_fkey",
    }),
    check(
      "agency_profiles_agency_type_check",
      sql`${t.agencyType} IS NULL OR ${t.agencyType} IN ('placement_agency', 'contractor', 'training_partner', 'consultant')`,
    ),
    check(
      "agency_profiles_verification_status_check",
      sql`${t.verificationStatus} IN ('pending', 'verified', 'rejected', 'suspended')`,
    ),
  ],
).enableRLS(); // FORCE + REVOKE carried by migration 0082, re-stated by 0084 for fresh databases

// ---------------------------------------------------------------------------
// employer_profiles — the employer-side extension of a payer. 1:1, PK = payer_id.
// ---------------------------------------------------------------------------
export const employerProfiles = pgTable(
  "employer_profiles",
  {
    payerId: uuid("payer_id").primaryKey(),
    industry: text("industry"),
    companySize: text("company_size"),
    hiringLocations: jsonb("hiring_locations").$type<unknown[]>().notNull().default(jsonArray),
    /**
     * GSTIN, AES ciphertext at rest — the `_enc` suffix is the house convention for a PII
     * column with no lookup hash (mirrors `payers.org_name_enc`). Business PII, so it must
     * never reach an event, a log, or an LLM prompt.
     */
    gstNumberEnc: text("gst_number_enc"),
    billingContact: jsonb("billing_contact")
      .$type<Record<string, unknown>>()
      .notNull()
      .default(jsonObject),
    website: text("website"),
    verificationStatus: text("verification_status")
      .$type<PayerProfileVerificationStatus>()
      .notNull()
      .default("pending"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    foreignKey({
      columns: [t.payerId],
      foreignColumns: [payers.id],
      name: "employer_profiles_payer_id_fkey",
    }),
    check(
      "employer_profiles_verification_status_check",
      sql`${t.verificationStatus} IN ('pending', 'verified', 'rejected', 'suspended')`,
    ),
  ],
).enableRLS(); // FORCE + REVOKE carried by migration 0082, re-stated by 0084 for fresh databases

// ---------------------------------------------------------------------------
// payer_capabilities — a per-payer boolean permission matrix. SUPERSEDED, see the note.
// ---------------------------------------------------------------------------
/**
 * NOT the live authorization model. `payer_members.org_role` (`owner` / `recruiter`) is what
 * the shipped code enforces; this table is the earlier per-capability design and holds 0 rows.
 * It is declared so a fresh database matches production, not so anything starts reading it.
 */
export const payerCapabilities = pgTable(
  "payer_capabilities",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    payerId: uuid("payer_id").notNull(),
    canPostJobs: boolean("can_post_jobs").notNull().default(true),
    canManageTeam: boolean("can_manage_team").notNull().default(true),
    canViewCandidates: boolean("can_view_candidates").notNull().default(true),
    canUnlockContacts: boolean("can_unlock_contacts").notNull().default(true),
    canManageBilling: boolean("can_manage_billing").notNull().default(true),
    canReferCandidates: boolean("can_refer_candidates").notNull().default(false),
    canManagePayouts: boolean("can_manage_payouts").notNull().default(false),
    canBulkUploadCandidates: boolean("can_bulk_upload_candidates").notNull().default(false),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    foreignKey({
      columns: [t.payerId],
      foreignColumns: [payers.id],
      name: "payer_capabilities_payer_id_fkey",
    }),
    unique("payer_capabilities_payer_id_key").on(t.payerId),
    // Redundant with the unique constraint's implicit index and present on production anyway.
    // Reproduced rather than tidied: this file's job is to describe what is there.
    index("idx_payer_capabilities_payer_id").on(t.payerId),
  ],
).enableRLS(); // FORCE + REVOKE carried by migration 0082, re-stated by 0084 for fresh databases

// ---------------------------------------------------------------------------
// payer_member_invites — an email invite into a payer org. See the auth.users note above.
// ---------------------------------------------------------------------------
export const payerMemberInvites = pgTable(
  "payer_member_invites",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    payerId: uuid("payer_id").notNull(),
    /** Keyed HMAC for lookup/dedup, alongside the ciphertext — the `workers.phone_*` pattern. */
    invitedEmailHash: text("invited_email_hash").notNull(),
    invitedEmailEnc: text("invited_email_enc").notNull(),
    role: text("role").$type<"admin" | "recruiter" | "finance" | "viewer">().notNull(),
    /** The invite secret is stored HASHED; the token itself only ever exists in the email. */
    inviteTokenHash: text("invite_token_hash").notNull(),
    /** No FK on production, so none here — the referent would be `payer_members`. */
    invitedByMemberId: uuid("invited_by_member_id"),
    /**
     * FK to `auth.users(id)` ON PRODUCTION ONLY. Not modelled — see the module docstring. The
     * constraint is created by migration 0084 behind a `to_regclass('auth.users')` guard.
     */
    acceptedByUserId: uuid("accepted_by_user_id"),
    status: text("status")
      .$type<"pending" | "accepted" | "expired" | "revoked">()
      .notNull()
      .default("pending"),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    acceptedAt: timestamp("accepted_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    foreignKey({
      columns: [t.payerId],
      foreignColumns: [payers.id],
      name: "payer_member_invites_payer_id_fkey",
    }),
    unique("payer_member_invites_invite_token_hash_key").on(t.inviteTokenHash),
    index("idx_payer_member_invites_email_hash").on(t.invitedEmailHash),
    index("idx_payer_member_invites_payer_id").on(t.payerId),
    check(
      "payer_member_invites_role_check",
      sql`${t.role} IN ('admin', 'recruiter', 'finance', 'viewer')`,
    ),
    check(
      "payer_member_invites_status_check",
      sql`${t.status} IN ('pending', 'accepted', 'expired', 'revoked')`,
    ),
  ],
).enableRLS(); // FORCE + REVOKE carried by migration 0082, re-stated by 0084 for fresh databases

export type AgencyProfile = typeof agencyProfiles.$inferSelect;
export type NewAgencyProfile = typeof agencyProfiles.$inferInsert;
export type EmployerProfile = typeof employerProfiles.$inferSelect;
export type NewEmployerProfile = typeof employerProfiles.$inferInsert;
export type PayerCapability = typeof payerCapabilities.$inferSelect;
export type NewPayerCapability = typeof payerCapabilities.$inferInsert;
export type PayerMemberInvite = typeof payerMemberInvites.$inferSelect;
export type NewPayerMemberInvite = typeof payerMemberInvites.$inferInsert;
