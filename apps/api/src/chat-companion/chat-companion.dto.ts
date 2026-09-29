import { z } from "zod";
import { nonEmptyMessageSchema, safeTextSchema, uuidSchema } from "@badabhai/validators";
import { COMPANION_V2_EDIT_OPS } from "@badabhai/types";
import { PostMessageResponseSchema } from "../chat/chat.dto";

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
 * One row of an edit card (ADR-0046 §5.1). `before`/`after` are what the card SHOWS; they are
 * the worker's own values, so the card is `no-store` and the values never ride an event. The app
 * ticks rows and sends their `row_id`s back to the confirm route — never the values.
 */
export const EditProposalRowSchema = z
  .object({
    row_id: uuidSchema,
    section_label: z.string().min(1).max(80),
    op: z.enum(COMPANION_V2_EDIT_OPS),
    before: z.string().max(4000).nullable(),
    after: z.string().max(4000).nullable(),
  })
  .strict();
export type EditProposalRow = z.infer<typeof EditProposalRowSchema>;

/**
 * The pending edit card. `expires_at` is the proposal's Redis TTL, mirrored so the app can
 * disable Haan/Nahi without a round-trip; the server re-checks everything on confirm.
 */
export const EditProposalSchema = z
  .object({
    proposal_id: uuidSchema,
    expires_at: z.string(),
    rows: z.array(EditProposalRowSchema).min(1),
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
  })
  .strict();
export type CompanionTurn = z.infer<typeof CompanionTurnSchema>;

/** `POST /chat/companion/edits/:proposalId/confirm` body (ADR-0046 §5.2). */
export const ConfirmEditSchema = z
  .object({
    row_ids: z.array(uuidSchema).min(1).max(3),
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

/** `GET /chat/companion`. */
export const CompanionOpenResponseSchema = z.discriminatedUnion("mode", [
  CompanionInterviewSchema,
  CompanionTurnSchema,
]);
export type CompanionOpenResponse = z.infer<typeof CompanionOpenResponseSchema>;
