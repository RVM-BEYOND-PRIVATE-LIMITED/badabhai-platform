import { sql } from "drizzle-orm";
import { check, integer, pgTable, primaryKey, text, timestamp } from "drizzle-orm/pg-core";

// ---------------------------------------------------------------------------
// app_release_policy — the minimum supported app build (#3048).
//
// Neither BadaBhai app could be told it is too old, so every server change had to keep the oldest
// installed copy working (#3006 froze the old trades route at 16 trades for exactly that reason).
// One row per app (`worker`, `payer`) and platform (`android`, `ios`) carries:
//   - `min_supported_build`: a build BELOW this gets 426 on every mutating route and the apps'
//     "Update required" page (#3049). 0 blocks nobody.
//   - `latest_build`: a build below this (but not below the minimum) sees a dismissible notice.
//   - `store_url`: where the update button goes (a Play Store link, or a download link until the
//     apps are listed). Null until the owner sets it.
//   - `message_key`: a short copy key the apps map to their own text (an unknown key reads as the
//     default copy).
// The migration seeds all four rows at 0 / 0 / null / `update_default`, which blocks nobody.
// Rows are never inserted or deleted after the seed: the admin PUT updates one row in place, and
// `app_version.policy_changed` (v1) is the change history.
//
// The build is the app's integer build number (the `+N` of pubspec `version`, Android
// versionCode / iOS CFBundleVersion), NOT the `x-app-build` commit stamp (#966).
//
// READ by the public `GET /app-config` and the global 426 guard; RLS forced, every role revoked
// (the migration's hand-written tail).
// ---------------------------------------------------------------------------
export const appReleasePolicy = pgTable(
  "app_release_policy",
  {
    app: text("app").notNull(),
    platform: text("platform").notNull(),
    minSupportedBuild: integer("min_supported_build").notNull().default(0),
    latestBuild: integer("latest_build").notNull().default(0),
    storeUrl: text("store_url"),
    messageKey: text("message_key").notNull().default("update_default"),
    updatedBy: text("updated_by"),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ name: "app_release_policy_pk", columns: [t.app, t.platform] }),
    check("app_release_policy_app_chk", sql`${t.app} IN ('worker', 'payer')`),
    check("app_release_policy_platform_chk", sql`${t.platform} IN ('android', 'ios')`),
    check(
      "app_release_policy_builds_chk",
      sql`${t.minSupportedBuild} >= 0 AND ${t.latestBuild} >= ${t.minSupportedBuild}`,
    ),
    check("app_release_policy_message_key_chk", sql`${t.messageKey} ~ '^[a-z][a-z0-9_]{0,63}$'`),
    check(
      "app_release_policy_store_url_chk",
      sql`${t.storeUrl} IS NULL OR (${t.storeUrl} ~ '^https://' AND length(${t.storeUrl}) <= 512)`,
    ),
  ],
).enableRLS(); // RLS tracked in the model; FORCE + four REVOKEs carried by the migration's tail

export type AppReleasePolicyRow = typeof appReleasePolicy.$inferSelect;
export type NewAppReleasePolicyRow = typeof appReleasePolicy.$inferInsert;
