import {
  boolean,
  check,
  index,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";

import type { CompanionMessageRole } from "@badabhai/types";

import { workers } from "./worker";

// ===========================================================================
// companion_messages — the Bada Bhai chat's conversation, kept 7 days (migration 0135)
// ===========================================================================
//
// #2297 (owner rulings 2026-10-15). The Bada Bhai chat (the post-completion companion, ADR-0044)
// keeps its conversation ON THE SERVER: every line of the last 7 days is drawn when the tab opens,
// older lines drop off, and a reinstall or a new phone keeps it. Until this table the companion
// stored nothing, and its AI memory was six turns in Redis for 30 minutes.
//
// ONE ROW PER LINE, as the app draws it: the worker's message (`worker`, the text as sent — the
// chip label for a tap) and Bada Bhai's reply (`bada_bhai`) with everything a live turn carries —
// the read-aloud twin, the "never read aloud" marker of a model-written line, the chips and the
// news tiles. The recap bubble served on the first open of a window is stored too, so it heads the
// conversation.
//
// `model_context` — WHETHER A LATER MODEL CALL MAY READ THIS LINE. True only for the turns the
// companion's Redis memory would have kept (the v2 / brain turns whose pair is remembered); false
// for everything else, and in particular for a distress turn and a trash verdict (ADR-0055 F3/F4:
// such a message is never replayed to a model). The reply's recent turns and the rolling summary's
// fold read only these rows; the worker's history shows every row.
//
// TEXT AT REST, LIKE `chat_messages.body_text`. The worker's own words may carry anything he
// typed (ADR-0047 lifts the ban on PII in stored text; name and phone stay encrypted only in
// `workers`). Erasure is the `worker_id` cascade, so account deletion removes every line.
//
// RETENTION: a daily sweep deletes rows older than 7 days (`CompanionHistorySweepProcessor`).
//
// DEPLOY-SAFE WITHOUT A FLAG. Every read and write of this table tolerates `undefined_table`
// (42P01): until 0135 is applied the chat has no history and behaves exactly as before.
// ===========================================================================
export const companionMessages = pgTable(
  "companion_messages",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workerId: uuid("worker_id")
      .notNull()
      .references(() => workers.id, { onDelete: "cascade" }),
    /** One of `COMPANION_MESSAGE_ROLES`. */
    role: text("role").$type<CompanionMessageRole>().notNull(),
    /** The line as drawn: the worker's words, or Bada Bhai's reply text. */
    bodyText: text("body_text").notNull(),
    /** The reply's Devanagari read-aloud twin — fixed lines only. */
    ttsText: text("tts_text"),
    /** `false` on a model-written line (never read aloud); null otherwise. */
    readAloud: boolean("read_aloud"),
    /** The reply's chips, as the turn carried them (`{option_key,label_text,is_none_of_above}[]`). */
    suggestedOptions: jsonb("suggested_options"),
    /** The reply's chip labels (`string[]`). */
    suggestedFollowups: jsonb("suggested_followups"),
    /** An answered live-news reply's tiles (`{title,url,site}[]`). */
    newsLinks: jsonb("news_links"),
    /** The send's client-minted idempotency key; a replayed submission is never stored twice. */
    submissionId: uuid("submission_id"),
    /** Whether a later model call may read this line (see the header). */
    modelContext: boolean("model_context").notNull().default(false),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    // The hot read: `WHERE worker_id = $1 AND created_at > $since ORDER BY created_at DESC LIMIT n`
    // (the history, the recent turns, the fold). NULLS FIRST is load-bearing, exactly as on
    // `chat_messages_session_created_idx`: Postgres reads a bare DESC as DESC NULLS FIRST, and
    // only a matching index serves filter + sort + limit without a separate sort. The column is
    // NOT NULL, so this changes no result — only the plan. Also backs the worker_id cascade.
    index("companion_messages_worker_created_idx").on(t.workerId, t.createdAt.desc().nullsFirst()),
    // The daily retention sweep's predicate (`created_at < now() - 7 days`, every worker at once):
    // without it each tick scans the whole table. Ascending — the sweep takes the oldest first.
    index("companion_messages_created_at_idx").on(t.createdAt),
    // A replayed turn (the same submission) never inserts twice: one worker line and one reply
    // per submission. Partial — a send without a submission id has nothing to dedupe on.
    uniqueIndex("companion_messages_submission_uq")
      .on(t.workerId, t.submissionId, t.role)
      .where(sql`${t.submissionId} IS NOT NULL`),
    // `COMPANION_MESSAGE_ROLES`, spelled out because a CHECK is static SQL.
    check("companion_messages_role_chk", sql`${t.role} IN ('worker', 'bada_bhai')`),
  ],
).enableRLS(); // RLS tracked in the model; FORCE + REVOKE carried by migration 0135

// ===========================================================================
// companion_conversation_summaries — the Bada Bhai chat's rolling summary (migration 0135)
// ===========================================================================
//
// #2297 — the AI's memory of the WHOLE conversation: compact notes folded from the stored lines
// that aged out of the reply's six-turn window, through the armed `profiling_free_summary` task
// (the ADR-0051 §8 machinery). The casual/career REPLY reads it with every query; the classifier
// never does (ADR-0051 R24). Model-facing only — never shown to the worker.
//
// ONE ROW PER WORKER. `folded_through` is the WATERMARK: the `created_at` of the newest line the
// summary covers, so the next fold sends only lines after it. A fold only ever moves it forward.
//
// `summary` IS NULLABLE ON PURPOSE — the ADR-0051 §8 watermark-only record. A real call that
// judged a batch but produced nothing usable (no notes, or notes the API refused) CONSUMES the
// batch: the watermark moves and the previous text is kept. With no previous text that is a row
// whose summary is null, which every reader treats as "no summary". Without it the same refused
// batch would be re-sent on every turn.
//
// LIVE FOR 7 DAYS. A summary is read only while the worker has a stored line in the last 7 days;
// the daily sweep deletes one whose conversation has expired. Erasure is the `worker_id` cascade.
// ===========================================================================
export const companionConversationSummaries = pgTable("companion_conversation_summaries", {
  workerId: uuid("worker_id")
    .primaryKey()
    .references(() => workers.id, { onDelete: "cascade" }),
  /** The notes, screened by the API before storing; null on a watermark-only record. */
  summary: text("summary"),
  /** The `created_at` of the newest line this summary covers. */
  foldedThrough: timestamp("folded_through", { withTimezone: true }).notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}).enableRLS(); // RLS tracked in the model; FORCE + REVOKE carried by migration 0135

export type CompanionMessage = typeof companionMessages.$inferSelect;
export type NewCompanionMessage = typeof companionMessages.$inferInsert;
export type CompanionConversationSummary = typeof companionConversationSummaries.$inferSelect;
