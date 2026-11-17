import { sql } from "drizzle-orm";
import {
  boolean,
  check,
  integer,
  jsonb,
  pgTable,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

// ---------------------------------------------------------------------------
// credit_rules_config — the credit rules' settings, one row per revision (#2750 item 1).
//
// Every number the brief's credit rules use (contact cost, the experience line, welcome credits,
// the opening limits, the couldn't-reach windows, returned credits, the refund rules, the goodwill
// cap). The SHAPE and the brief's defaults live in `@badabhai/pricing` (`CreditRulesSchema`); this
// table stores the values, validated on load and FAILING CLOSED whole to the defaults.
//
// A SIBLING OF `match_config`, NOT A KEY IN IT (owner ruling 2026-11-17): money rules never share
// a row with the ranking knobs, so an invalid edit of one can never reset the other.
//
// APPEND-ONLY BY REVISION. `PUT /admin/credit-rules` inserts a NEW row (revision = last + 1) and
// clears `is_active` on the old one in the same transaction; no row's `rules` is ever rewritten,
// so the table is the full history of who set which numbers when. `credit_rules_config_active_uq`
// keeps at most one active row; `credit_rules_config_revision_uq` makes two concurrent edits of
// the same revision collide (the loser rolls back and gets a 409), never both commit.
//
// `updated_by` is the opaque `admin_users.id` that wrote the revision (no FK: an admin row is
// never deleted, and the audit trail must survive one being suspended). The written reason lives
// on the `audit_logs` row of the same transaction, not here.
//
// READ ONLY WHILE `CREDIT_RULES_ROLLOUT` IS ON (pilot or on). PII-FREE: integers in jsonb, ids and
// times. RLS forced, every role revoked (the hand-written tail of the migration).
// ---------------------------------------------------------------------------
export const creditRulesConfig = pgTable(
  "credit_rules_config",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    // The rule values. Loose jsonb here (like match_config.config); `CreditRulesSchema` owns the
    // shape and validates on load.
    rules: jsonb("rules").notNull(),
    // 1, 2, 3 ... one per edit.
    revision: integer("revision").notNull(),
    // Exactly one active row once the first revision is written (partial unique index below).
    isActive: boolean("is_active").notNull().default(true),
    // The admin who wrote this revision (opaque id, no PII).
    updatedBy: uuid("updated_by").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("credit_rules_config_active_uq")
      .on(t.isActive)
      .where(sql`${t.isActive}`),
    uniqueIndex("credit_rules_config_revision_uq").on(t.revision),
    check("credit_rules_config_revision_pos_chk", sql`${t.revision} > 0`),
    check("credit_rules_config_rules_object_chk", sql`jsonb_typeof(${t.rules}) = 'object'`),
  ],
).enableRLS(); // RLS tracked in the model; FORCE + four REVOKEs carried by the migration's tail

export type CreditRulesConfigRow = typeof creditRulesConfig.$inferSelect;
export type NewCreditRulesConfigRow = typeof creditRulesConfig.$inferInsert;
