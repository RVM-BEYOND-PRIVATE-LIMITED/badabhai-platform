import { z } from "zod";
import { nonEmptyMessageSchema, safeTextSchema, uuidSchema } from "@badabhai/validators";
import { COMPANION_MESSAGE_ROLES, COMPANION_V2_EDIT_OPS } from "@badabhai/types";
import { NewsLinksWireSchema, PostMessageResponseSchema } from "../chat/chat.dto";

/**
 * `POST /chat/companion/message` body. The same text rules as `POST /chat/message` — non-empty,
 * bounded, safe — and the same optional per-send `submission_id` (the event's dedupe key). No
 * session id: the companion has no session; the worker comes from the bearer token.
 */
export const CompanionMessageSchema = z.object({
  text: nonEmptyMessageSchema.pipe(safeTextSchema(4000)),
  submission_id: uuidSchema.optional(),
});
export type CompanionMessageDto = z.infer<typeof CompanionMessageSchema>;

/**
 * One companion turn. DELIBERATELY THE CHAT REPLY'S OWN SHAPE MINUS `session_id`, so the worker
 * app parses it with the parser it already has (`ChatReply.fromJson` reads named keys only and
 * never `session_id`) and draws it with the widgets it already has. Plus:
 *   - `mode: "companion"` — the discriminant;
 *   - `digest_key` — a short hash of the facts the turn was composed from, so a tab refocus can
 *     tell "nothing changed" from "your counts moved" without comparing copy.
 *
 * `.strict()` because this wire is new and no shipped client depends on its leniency: a field
 * that is not declared here is a leak, and the service fails closed on it rather than sending it.
 */
/**
 * One row of an edit card (ADR-0046 §5.1). `before`/`after` are the stored values — the worker's
 * own, so the card is `no-store` and the values never ride an event. The app ticks rows and sends
 * their `row_id`s back to the confirm route — never the values.
 *
 * THE LABELS ARE ADDITIVE (BUG-CARD-LABELS, 2026-09-30) and optional, so the shipped app, which
 * reads `section_label`/`before`/`after` only, is unchanged:
 *   - `field_label` — which field the row changes ("Travel kar sakte hain"); on a whole-entry
 *     delete the entry itself ("Yeh poora certificate"). A whole-entry delete is never proposed
 *     ("Never from chat": a job since 2026-10-01; a certificate/education/training since
 *     TD151(1), 2026-10-05), so these entry labels only ever front a card stored before a
 *     ruling, which the confirm refuses;
 *   - `before_display`/`after_display` — the worker-facing label of a CLOSED-SET value ("hindi" →
 *     "Hindi", "true" → "Haan", a role id → its taxonomy label); null when the value is free
 *     text, a date or a number (shown as typed), absent, or not in its dictionary.
 */
export const EditProposalRowSchema = z
  .object({
    row_id: uuidSchema,
    section_label: z.string().min(1).max(80),
    field_label: z.string().min(1).max(80).optional(),
    op: z.enum(COMPANION_V2_EDIT_OPS),
    before: z.string().max(4000).nullable(),
    after: z.string().max(4000).nullable(),
    before_display: z.string().min(1).max(120).nullable().optional(),
    after_display: z.string().min(1).max(120).nullable().optional(),
  })
  .strict();
export type EditProposalRow = z.infer<typeof EditProposalRowSchema>;

/**
 * The most rows one edit card carries (ADR-0046 O5) — and so the most one confirm may tick.
 *
 * ONE NUMBER FOR BOTH ENDS. A card with more rows than the confirm route accepts would show
 * rows the worker cannot all apply, so the service caps every card at
 * `min(CHAT_COMPANION_V2_EDIT_MAX_ROWS, this)` and asks the model for no more than that.
 */
export const EDIT_CARD_ROWS_MAX = 3;

/**
 * The pending edit card. `expires_at` is the proposal's Redis TTL, mirrored so the app can
 * disable Haan/Nahi without a round-trip; the server re-checks everything on confirm.
 */
export const EditProposalSchema = z
  .object({
    proposal_id: uuidSchema,
    expires_at: z.string(),
    rows: z.array(EditProposalRowSchema).min(1).max(EDIT_CARD_ROWS_MAX),
  })
  .strict();
export type EditProposal = z.infer<typeof EditProposalSchema>;

export const CompanionTurnSchema = PostMessageResponseSchema.omit({ session_id: true })
  .extend({
    mode: z.literal("companion"),
    digest_key: z.string().min(1).max(64).optional(),
    /** ADR-0046 P1 — present only on a turn that carries an edit card. */
    edit_proposal: EditProposalSchema.optional(),
    /** ADR-0046 P3 — model-written replies set this false; fixed copy keeps its twin. */
    read_aloud: z.literal(false).optional(),
    /** ADR-0046 P2 — the faltu cool-down, so the app can disable the composer. */
    cooldown_until: z.string().optional(),
    // ADR-0055 — `news_links` (1-3 "read more" tiles on an answered live-news turn) is INHERITED
    // from the chat reply's own schema above, with the same shape and bounds; the free-chat brain
    // is the first companion path that serves it. ABSENT on every other turn.
  })
  .strict();
export type CompanionTurn = z.infer<typeof CompanionTurnSchema>;

/** `POST /chat/companion/edits/:proposalId/confirm` body (ADR-0046 §5.2). */
export const ConfirmEditSchema = z
  .object({
    row_ids: z.array(uuidSchema).min(1).max(EDIT_CARD_ROWS_MAX),
    submission_id: uuidSchema.optional(),
  })
  .strict();
export type ConfirmEditDto = z.infer<typeof ConfirmEditSchema>;

/** `POST /chat/companion/edits/:proposalId/cancel` body. */
export const CancelEditSchema = z
  .object({
    submission_id: uuidSchema.optional(),
  })
  .strict();
export type CancelEditDto = z.infer<typeof CancelEditSchema>;

/** Not a companion worker (or the flag is off): the app runs today's chat. */
export const CompanionInterviewSchema = z.object({ mode: z.literal("interview") }).strict();
export type CompanionInterview = z.infer<typeof CompanionInterviewSchema>;

/** #2297 (ADR-0056) — the stored conversation is drawn from the last 7 days, at most this many lines. */
export const COMPANION_HISTORY_MAX = 200;

/**
 * #2297 (ADR-0056) — ONE STORED LINE of the Bada Bhai chat, as `GET /chat/companion` returns it
 * in `history`: the worker's message, or Bada Bhai's reply with what its live turn carried. The
 * contract the app builds against (#2298): every optional field is ABSENT, never null, when the
 * line has none — `tts_text` on fixed lines only, `read_aloud: false` on model-written lines, the
 * chips (meaningful on the last `bada_bhai` line only) and the news tiles.
 */
export const CompanionHistoryItemSchema = z
  .object({
    id: uuidSchema,
    role: z.enum(COMPANION_MESSAGE_ROLES),
    text: z.string().min(1),
    tts_text: z.string().min(1).optional(),
    read_aloud: z.literal(false).optional(),
    suggested_options: z
      .array(
        z
          .object({
            option_key: z.string(),
            label_text: z.string(),
            is_none_of_above: z.boolean(),
          })
          .strict(),
      )
      .min(1)
      .optional(),
    suggested_followups: z.array(z.string()).min(1).optional(),
    news_links: NewsLinksWireSchema.optional(),
    created_at: z.string().datetime({ offset: true }),
  })
  .strict();
export type CompanionHistoryItem = z.infer<typeof CompanionHistoryItemSchema>;

/** #2391 (ADR-0059) — the whole conversation is drawn from the last 7 days, at most this many lines. */
export const COMPANION_CONVERSATION_MAX = 400;

/** #2391 — where a conversation line comes from: the profiling chat, or the Bada Bhai chat itself. */
export const COMPANION_CONVERSATION_SOURCES = ["profiling", "bada_bhai_chat"] as const;

/** The chips under the conversation's last line — the turn's own option shape. */
const ConversationOptionSchema = z
  .object({
    option_key: z.string(),
    label_text: z.string(),
    is_none_of_above: z.boolean(),
  })
  .strict();

/**
 * #2391 (ADR-0059) — ONE LINE of the Bada Bhai chat's whole conversation: a line of a profiling
 * chat, or a stored line of the Bada Bhai chat. Every optional field is ABSENT, never null:
 *   - `tts_text` — the reviewed read-aloud twin, on a Bada Bhai line that has one;
 *   - `read_aloud: false` — a model-written Bada Bhai chat line (no speaker, plain prose);
 *   - `news_links` — an answered news reply's tiles;
 *   - `ends_profiling_chat: true` — the LAST line of one profiling chat: the app draws the
 *     "End of conversation" divider right after it.
 * Chips are not per line: the conversation carries the ones to show, once.
 */
export const CompanionConversationItemSchema = z
  .object({
    id: uuidSchema,
    source: z.enum(COMPANION_CONVERSATION_SOURCES),
    role: z.enum(COMPANION_MESSAGE_ROLES),
    text: z.string().min(1),
    tts_text: z.string().min(1).optional(),
    read_aloud: z.literal(false).optional(),
    news_links: NewsLinksWireSchema.optional(),
    ends_profiling_chat: z.literal(true).optional(),
    created_at: z.string().datetime({ offset: true }),
  })
  .strict();
export type CompanionConversationItem = z.infer<typeof CompanionConversationItemSchema>;

/**
 * #2391 (ADR-0059) — THE WHOLE CONVERSATION OF THE LAST 7 DAYS, as the app draws it instead of the
 * recap: every profiling chat line and every Bada Bhai chat line, OLDEST FIRST, and the chips to
 * show under the last line (the newest Bada Bhai chat reply's; the recap's when a profiling chat is
 * newer than that reply, or there is none). The stored recap is never a line of it.
 */
export const CompanionConversationSchema = z
  .object({
    messages: z
      .array(CompanionConversationItemSchema)
      .min(1)
      .max(COMPANION_CONVERSATION_MAX),
    suggested_options: z.array(ConversationOptionSchema),
    suggested_followups: z.array(z.string()),
  })
  .strict();
export type CompanionConversation = z.infer<typeof CompanionConversationSchema>;

/**
 * The companion turn `GET /chat/companion` answers with: the recap, as ever, plus (#2297) the
 * conversation of the last 7 days, OLDEST FIRST, when there is one. ADDITIVE — absent when there
 * is no stored line (the app draws the recap, as today) and on every message turn.
 *
 * #2391 (ADR-0059) — plus `conversation`: the profiling chat(s) and the Bada Bhai chat together,
 * which an app that knows it draws INSTEAD of `history` and the recap. ADDITIVE and absent when
 * there is no line of either kind in the window; `history` is unchanged for an older app.
 */
export const CompanionOpenTurnSchema = CompanionTurnSchema.extend({
  history: z.array(CompanionHistoryItemSchema).min(1).max(COMPANION_HISTORY_MAX).optional(),
  conversation: CompanionConversationSchema.optional(),
});
export type CompanionOpenTurn = z.infer<typeof CompanionOpenTurnSchema>;

/** `GET /chat/companion`. */
export const CompanionOpenResponseSchema = z.discriminatedUnion("mode", [
  CompanionInterviewSchema,
  CompanionOpenTurnSchema,
]);
export type CompanionOpenResponse = z.infer<typeof CompanionOpenResponseSchema>;
