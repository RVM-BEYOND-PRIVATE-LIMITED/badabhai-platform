import { relations, sql } from "drizzle-orm";
import {
  boolean,
  check,
  integer,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

import { workers } from "./worker";

/**
 * WORKER LANGUAGES (migration 0110) — which languages a worker speaks, reads and writes.
 *
 * ═══ WHY THE `languages` ATTRIBUTE COULD NOT CARRY THIS ═══
 *
 * `worker_attributes.languages` is a `text_list` of slugs, one row per worker. It answers "which
 * languages?" and cannot answer "how well, in which skills" — a worker who speaks Haryanvi but
 * cannot read it, or reads English but does not speak it, has no way to say so, and the sheet has
 * no row to print. That list is also the ONLY source the résumé has ever had for its Languages
 * row, so the distinction has never been representable anywhere.
 *
 * ═══ THREE BOOLEANS PER LANGUAGE, NOT A SINGLE `level` SLUG ═══
 *
 * "Speaks / reads / writes" are three independently true facts, and a level enum would have to
 * invent a ladder that loses the combination a supervisor actually checks ("trained in Hindi and
 * English" means something different from "reads manuals in English"). The booleans are the
 * worker's own ticks, each independently honest, and `wl_ability_chk` refuses a row that ticks
 * none. There is no derived level anywhere, on purpose.
 *
 * ═══ THE LANGUAGE SLUG IS A CLOSED VOCABULARY, ENFORCED ONE LAYER UP ═══
 *
 * The dictionary is `LANGUAGES` in `worker-preferences.vocabulary.ts` — the same 16 slugs the
 * finishing form's multi-select already offers — and the DTO validates every row against it. The
 * database deliberately checks only the SHAPE (`^[a-z_]+$`, the platform's slug convention), not
 * membership: the vocabulary lives in TypeScript, and a CHECK duplicating it here would be a
 * second list to forget. An unknown slug from a manual write stops printing (the `labelFor`
 * rule) rather than printing raw, exactly as an unknown `education.credential` does.
 *
 * ═══ ADDITIVE. NOTHING EXISTING IS TOUCHED ═══
 *
 * One new, empty table. The `languages` attribute key keeps being written and read; this table is
 * a SECOND source that wins where it has rows (`tradeSheet.qualification.languages` already
 * resolves with `??`). Rollback is one DROP TABLE and the database is byte-identical to 0109.
 *
 * NEITHER THIS TABLE NOR ITS ROWS CROSS THE AI BOUNDARY. The sheet composes the row
 * deterministically from the slugs and the three ticks; no prompt is built on this path.
 */
export const workerLanguages = pgTable(
  "worker_language",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workerId: uuid("worker_id")
      .notNull()
      .references(() => workers.id, { onDelete: "cascade" }),
    /**
     * A slug from `LANGUAGES` (`hindi`, `english`, `haryanvi`, …) — never a printed label.
     * Shape-checked here, membership checked in the DTO against the single dictionary.
     */
    language: text("language").notNull(),
    canSpeak: boolean("can_speak").notNull().default(false),
    canRead: boolean("can_read").notNull().default(false),
    canWrite: boolean("can_write").notNull().default(false),
    /**
     * Display order — the worker's own ordering, never derived from the slug or the abilities.
     * Re-deriving would reshuffle rows between renders and make every regenerated PDF a false
     * diff, the same argument `worker_certificate.sort_order` records.
     */
    sortOrder: integer("sort_order").notNull().default(0),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (t) => [
    // The platform's slug convention (`wa_attribute_key_chk` states it on the attributes table).
    // Bounds too: a language slug is one short token, never a sentence.
    check("wl_language_chk", sql`${t.language} ~ '^[a-z_]+$' AND length(${t.language}) <= 40`),
    // A row that ticks no ability says nothing about the language — the same "must say something"
    // rule `wed_not_empty_chk` enforces one table over, and refused at the database because the
    // sheet would otherwise have to guess whether to print it.
    check("wl_ability_chk", sql`${t.canSpeak} OR ${t.canRead} OR ${t.canWrite}`),
    check("wl_sort_order_chk", sql`${t.sortOrder} >= 0`),
    // ONE ROW PER LANGUAGE. The API replaces the whole list per worker (delete-then-insert, the
    // qualifications precedent), so this is what makes "Hindi" twice a 23505 instead of a
    // duplicated printed row.
    uniqueIndex("wl_worker_language_uq").on(t.workerId, t.language),
    // ...and one row per POSITION, so the stored order is total and a replace cannot collide.
    uniqueIndex("wl_worker_sort_uq").on(t.workerId, t.sortOrder),
  ],
).enableRLS();

export const workerLanguagesRelations = relations(workerLanguages, ({ one }) => ({
  worker: one(workers, {
    fields: [workerLanguages.workerId],
    references: [workers.id],
  }),
}));

export type WorkerLanguage = typeof workerLanguages.$inferSelect;
export type NewWorkerLanguage = typeof workerLanguages.$inferInsert;
