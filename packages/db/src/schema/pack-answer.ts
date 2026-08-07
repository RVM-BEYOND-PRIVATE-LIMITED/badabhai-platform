/**
 * `worker_pack_answer` — the durable record of what a worker actually said, question by
 * question (migration 0073).
 *
 * WHY THIS EXISTS WHEN THE TRANSCRIPT ALREADY DOES. The transcript is the interview's
 * EVIDENCE store: prose, in the worker's own words, ordered by time. This table is its
 * RECORD: one typed row per question, keyed by a `question_key` that is stable across pack
 * versions. Everything downstream — the profile projection, a re-interview, an ops review of
 * which questions workers refuse — is a lookup by question, and answering that from prose
 * means re-parsing a conversation on every read.
 *
 * WHY NOT `worker_answers` (schema.ts:852-940). That table is unversioned, its
 * `question_key` is GLOBALLY unique so two packs could not both own `experience_years`, it
 * has no options table (ADR-0005 defers it explicitly), and it carries no conditional logic.
 * Superseded, not extended, and deliberately not dropped (CLAUDE.md §10).
 *
 * UNIQUE ON (worker, pack, question_key) — WITHOUT THE VERSION. A re-interview under pack
 * v2 REPLACES the v1 answer for the same question rather than accumulating a second row the
 * readers would then have to rank. That is the entire reason `question_key` was specified as
 * stable across versions in migration 0069; this index is what cashes that in.
 *
 * DPDP ERASURE IS COVERED BY THE CASCADE, WITH ZERO CODE. `WorkersRepository.hardDelete`
 * enumerates no table names, so `ON DELETE CASCADE` on `worker_id` *is* the coverage — a new
 * table that named itself in a delete list would be a new thing to forget.
 *
 * PRIVACY: worker-authored answer values. This is worker data, not reference data — it is
 * RLS-locked to the service role like every other worker table, it is never an LLM input in
 * raw form (the parse call receives the pseudonymized answer map), and it never appears in an
 * event payload.
 */
import { sql } from "drizzle-orm";
import {
  pgTable,
  uuid,
  text,
  integer,
  boolean,
  doublePrecision,
  timestamp,
  index,
  uniqueIndex,
  check,
} from "drizzle-orm/pg-core";

import { workers } from "./worker";
import { chatSessions } from "./chat";

/**
 * How the answer reached us.
 *
 * `chip` is kept DISTINCT from `chat` on purpose: a chip tap is an unambiguous selection
 * from a reviewed closed set, and free text is an interpretation of prose. When the two
 * disagree about the same worker later, knowing which was which is the difference between a
 * data-quality question and a parser bug.
 */
export const PACK_ANSWER_SOURCES = ["chat", "chip", "form", "ops"] as const;
export type PackAnswerSource = (typeof PACK_ANSWER_SOURCES)[number];

/**
 * The terminal states an answer can be persisted in.
 *
 * A SUBSET of the contract's `AnswerStatus`, and the omission is deliberate: `superseded`
 * describes a value that LOST a correction, and those live in the answer map's `history[]`
 * and in the transcript. Persisting them here would need a second row for the same
 * `question_key` and break the unique index this table is built around.
 *
 * `declined` IS PERSISTED, and that is not decoration. "The worker told us they do not know
 * their exact salary" and "we never got to that question" are different facts about the same
 * empty cell, and only one of them means the next interview should ask again. It is also the
 * metric that tells content authors which questions workers refuse.
 */
export const PACK_ANSWER_STATUSES = ["answered", "declined", "unanswered"] as const;
export type PackAnswerStatus = (typeof PACK_ANSWER_STATUSES)[number];

export const workerPackAnswers = pgTable(
  "worker_pack_answer",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workerId: uuid("worker_id")
      .notNull()
      .references(() => workers.id, { onDelete: "cascade" }),
    // SET NULL, not CASCADE. A chat session is provenance, not ownership — deleting a
    // session (retention, an ops cleanup) must not silently erase the answers that session
    // produced, because the profile built from them is still live.
    chatSessionId: uuid("chat_session_id").references(() => chatSessions.id, {
      onDelete: "set null",
    }),
    // NO FK to `question_pack(pack_id, version)`, deliberately. Pack rows are seeded from
    // git; a seeder that retires an old version would then fail against worker data it has
    // no business being coupled to, and the only way out would be deleting answers. The
    // pointer is recorded for provenance; the pack corpus is the integrity authority.
    packId: text("pack_id").notNull(),
    packVersion: integer("pack_version").notNull(),
    questionKey: text("question_key").notNull(),

    // Exactly ONE of these is non-null when `status = 'answered'`, and all four are null
    // otherwise — enforced by `wpa_answer_shape_chk` below. Four typed columns rather than
    // one jsonb because every reader of this table wants a typed value, and a jsonb column
    // would push the type decision to every read site instead of settling it at the write.
    answerText: text("answer_text"),
    answerNumber: doublePrecision("answer_number"),
    answerBool: boolean("answer_bool"),
    answerOptionKeys: text("answer_option_keys").array(),

    status: text("status").$type<PackAnswerStatus>().notNull().default("answered"),
    source: text("source").$type<PackAnswerSource>().notNull().default("chat"),
    answeredAt: timestamp("answered_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    // The plan's `wpa_worker_question_uq`. Also the read path for "this worker's answers",
    // since `worker_id` leads it — no separate worker index is needed.
    uniqueIndex("wpa_worker_question_uq").on(t.workerId, t.packId, t.questionKey),
    // The FK-referencing column Postgres does not index for you. Needed so deleting a chat
    // session does not seq-scan every answer row to apply SET NULL.
    index("wpa_chat_session_idx").on(t.chatSessionId),
    check(
      "wpa_status_chk",
      sql`${t.status} IN ('answered', 'declined', 'unanswered')`,
    ),
    check("wpa_source_chk", sql`${t.source} IN ('chat', 'chip', 'form', 'ops')`),
    // A BICONDITIONAL, not two one-way rules: `answered` implies exactly one value column,
    // and exactly one value column implies `answered`. Written this way so neither a valued
    // declination nor a valueless answer can exist — both would be a row whose status lies
    // about its own contents, and a reader would have no way to tell which half to believe.
    check(
      "wpa_answer_shape_chk",
      sql`(${t.status} = 'answered') = (
        (${t.answerText} IS NOT NULL)::int
        + (${t.answerNumber} IS NOT NULL)::int
        + (${t.answerBool} IS NOT NULL)::int
        + (${t.answerOptionKeys} IS NOT NULL)::int
        = 1
      )`,
    ),
  ],
).enableRLS(); // RLS tracked in the model; FORCE + REVOKE carried by migration 0073
