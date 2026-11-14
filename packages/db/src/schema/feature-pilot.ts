import { sql } from "drizzle-orm";
import { check, pgTable, primaryKey, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { payers } from "./payer";

/**
 * The pilot list (#2746 item 1): which companies may use a feature whose switch reads `pilot`.
 * One row per (feature, company). `payer_id` is the TENANT key (`PayerTenantScopeService`): with
 * `PAYER_ORG_TENANCY_MODE=on` the company's anchor, so a team member inherits its pilot place; in
 * `off` / `shadow` the login itself, so list each login. Feature names are a closed list in the API
 * (`FEATURE_ROLLOUT_KEYS`), not here: #2747–#2750 add theirs without a migration, and the shape
 * CHECK keeps a typo from passing as a new name.
 *
 * This list will gate real payments (#2749), so every row says who added it and why. Written by
 * hand (owner SQL) or by a later admin route, never by a company. Readers fail closed: a read
 * error means "not on the pilot".
 */
export const featurePilotPayers = pgTable(
  "feature_pilot_payers",
  {
    feature: text("feature").notNull(),
    payerId: uuid("payer_id")
      .notNull()
      .references(() => payers.id, { onDelete: "cascade" }),
    /**
     * Who put the company on the pilot: an admin id or a fixed token such as `owner_sql`, never
     * a person's name (`fpp_added_by_chk` admits the id charset only).
     */
    addedBy: text("added_by").notNull(),
    reason: text("reason").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ name: "feature_pilot_payers_pk", columns: [t.feature, t.payerId] }),
    check("fpp_feature_chk", sql`${t.feature} ~ '^[a-z][a-z0-9_]{1,63}$'`),
    check("fpp_added_by_chk", sql`${t.addedBy} ~ '^[A-Za-z0-9._:-]{1,128}$'`),
    check("fpp_reason_chk", sql`char_length(${t.reason}) BETWEEN 1 AND 500`),
  ],
).enableRLS();
