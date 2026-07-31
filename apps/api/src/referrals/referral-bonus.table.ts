import { integer, pgTable, timestamp, uuid } from "drizzle-orm/pg-core";

/**
 * ============================ TEMPORARY LOCAL DECLARATION ============================
 * `referral_bonus_accruals` — the MOCK ₹20 worker-referral activation-bonus ledger (§X.6).
 *
 * THE TABLE + ITS MIGRATION ARE OWNED BY `packages/db` (a sibling change), NOT by this
 * file. This declaration exists ONLY because the table was not yet present in this
 * worktree, and Drizzle needs a table object to build a query. It is a NAME/SHAPE mapping
 * only — it creates nothing and migrates nothing.
 *
 * WHEN `packages/db` EXPORTS `referralBonusAccruals`: delete this file and change the one
 * import in `referral-bonus.repository.ts` to `@badabhai/db`. Nothing else references it.
 * The shape below is coded against exactly what the db change specifies:
 *
 *   id                  uuid PK default random
 *   inviter_worker_id   uuid   — the worker OWED the bonus
 *   invited_worker_id   uuid   UNIQUE — the referred worker; the UNIQUE constraint IS the
 *                              idempotency key (one bonus per referred worker, EVER)
 *   amount_inr          integer default 20 (whole rupees, never paise)
 *   qualified_at        timestamptz — when BOTH legs of the rule became true
 *
 * The two worker columns are declared NULLABLE here on purpose: the repo's DSAR posture
 * (`invites`, `unlocks`, `agency_invites`) is `ON DELETE SET NULL` so a hard-deleted worker
 * nulls the join but PRESERVES the PII-free ledger row. A nullable TS type is safe against
 * either choice the db change makes — it can never claim non-null for a column that is.
 *
 * NO PII: opaque worker ids + an integer + a timestamp. No phone, no phone_hash, no name.
 * The fraud rule's phone-hash comparisons run ENTIRELY inside SQL (see the repository) —
 * no hash is ever read into this process.
 * =====================================================================================
 */
export const referralBonusAccruals = pgTable("referral_bonus_accruals", {
  id: uuid("id").primaryKey().defaultRandom(),
  inviterWorkerId: uuid("inviter_worker_id"),
  invitedWorkerId: uuid("invited_worker_id"),
  amountInr: integer("amount_inr").notNull().default(20),
  qualifiedAt: timestamp("qualified_at", { withTimezone: true }).notNull().defaultNow(),
});

export type ReferralBonusAccrual = typeof referralBonusAccruals.$inferSelect;
