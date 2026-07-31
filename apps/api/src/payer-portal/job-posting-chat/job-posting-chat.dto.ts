import { z } from "zod";
import { MESSAGE_DIRECTIONS, MESSAGE_TYPES } from "@badabhai/types";
import { uuidSchema, nonEmptyMessageSchema, safeTextSchema } from "@badabhai/validators";
import { JobPostingDraftSchema } from "@badabhai/ai-contracts";

/**
 * DTOs for the AI job-posting chat (ADR-0035 §Decision 5).
 *
 * XB-A RUNS THROUGH EVERY SCHEMA HERE: none of them has a `payer_id`, and none ever
 * will. The payer is the verified session (`req.payer.id`), stamped by the service.
 * A body-supplied owner id is the exact defect this repo's never-trust-body-IDs rule
 * exists to prevent, so the schemas make it unrepresentable rather than merely
 * discouraged.
 *
 * There is also no `org_label` anywhere on this surface — not on input, not on the
 * draft, not on the publish request. The payer's organisation name is already known
 * server-side (`payers.orgNameEnc`) and is stamped onto the create call at publish
 * time (ADR-0035 §Decision 3). Accepting it here would let a payer post under
 * someone else's name AND would invite them to type contact details next to it.
 */

/** Bound on a single payer turn — matches the worker chat's `PostMessageSchema`. */
const MESSAGE_MAX = 4000;

/**
 * `POST /payer/job-posting-chat/session` — nothing is taken from the body. The payer
 * comes from the session; `trade_hint` is deliberately NOT accepted in this slice
 * (the AI service's bank does not branch on it today, and leaving it off keeps the
 * opener cache keyed by a server-controlled value — see `AiService`).
 */
export const StartJobPostingChatSchema = z.object({});
export type StartJobPostingChatDto = z.infer<typeof StartJobPostingChatSchema>;

/**
 * `POST /payer/job-posting-chat/message`. The `session_id` is BODY-SUPPLIED and
 * therefore attacker-controlled: this schema proves only that it is a uuid.
 * Ownership is proved separately in the service — parsing is not permission.
 */
export const PostJobPostingChatMessageSchema = z.object({
  session_id: uuidSchema,
  // Non-empty + bounded. Pseudonymization (fail-closed) happens on the AI service
  // before the engine or any model sees this text (invariant #3).
  text: nonEmptyMessageSchema.pipe(safeTextSchema(MESSAGE_MAX)),
});
export type PostJobPostingChatMessageDto = z.infer<typeof PostJobPostingChatMessageSchema>;

/**
 * Route param for the two `:id` routes. Same note as above: proving the shape of an
 * attacker-supplied id is not authorization.
 */
export const JobPostingChatSessionParamSchema = z.object({ id: uuidSchema });
export type JobPostingChatSessionParamDto = z.infer<typeof JobPostingChatSessionParamSchema>;

/** The four session lifecycle states (mirrors `PayerJobPostingChatStatus` in the schema). */
export const JOB_POSTING_CHAT_STATUSES = [
  "active",
  "draft_ready",
  "published",
  "abandoned",
] as const;

/**
 * Compact per-session card for the cross-device "continue where I left off" list.
 *
 * The role/location/band labels are the payer's OWN text handed back to the SAME
 * authenticated payer — a list of bare uuids is unusable for the feature this endpoint
 * exists for. That is not a §2 boundary crossing: §2 governs free text reaching an LLM,
 * an event payload, `ai_jobs`, `audit_logs`, or a log line, and none of those is here.
 * The values are never logged and never evented.
 *
 * FLAT, not nested, because both clients (apps/payer-web `jobPostingChatSessionWireSchema`
 * and the payer app's `JobPostingChatSessionSummary`) read `role_title` at the top level.
 */
export const JobPostingChatSessionSummarySchema = z.object({
  session_id: uuidSchema,
  status: z.enum(JOB_POSTING_CHAT_STATUSES),
  /** Convenience mirror of `status === "draft_ready"` — the clients render off this. */
  draft_ready: z.boolean(),
  role_title: z.string().nullable(),
  location_label: z.string().nullable(),
  vacancy_band: z.string().nullable(),
  started_at: z.string(),
  last_message_at: z.string().nullable(),
  published_job_posting_id: uuidSchema.nullable(),
});
export type JobPostingChatSessionSummary = z.infer<typeof JobPostingChatSessionSummarySchema>;

export const JobPostingChatSessionsResponseSchema = z.object({
  // Newest activity first — the order a "resume this" list is read in.
  sessions: z.array(JobPostingChatSessionSummarySchema),
});
export type JobPostingChatSessionsResponse = z.infer<typeof JobPostingChatSessionsResponseSchema>;

/**
 * ONE TURN SHAPE, returned by BOTH `POST …/session` (the opener) and `POST …/message`.
 *
 * The two endpoints share it deliberately: a client renders an assistant bubble the same
 * way whether it is the greeting or the fifth question, and both shipped clients
 * (`jobPostingChatTurnWireSchema` in apps/payer-web, `JobPostingChatTurn` in the payer
 * app) parse the session response with their turn schema.
 *
 * `reply_text` is ALWAYS present and ALWAYS a string. When the AI service cannot supply
 * an opener it is `""` — never a missing key and never a fabricated greeting, so the
 * client can test for empty and render its own constant. (A local fallback string here
 * would be a second copy of the opener copy, free to drift from the AI service's.)
 *
 * `draft` is the FULL current draft, not a delta: the client redraws a draft card every
 * turn, and a blocked turn carries the STORED draft (the AI contract returns null on that
 * leg precisely so the caller keeps what it had).
 */
export const JobPostingChatTurnResponseSchema = z.object({
  session_id: uuidSchema,
  status: z.enum(JOB_POSTING_CHAT_STATUSES),
  reply_text: z.string(),
  /** The stored assistant message this turn produced; null when nothing was stored. */
  message_id: uuidSchema.nullable().default(null),
  // Chips are ANSWERS to the question just asked (a tapped chip is sent back verbatim as
  // the payer's next message), not follow-up questions.
  suggested_replies: z.array(z.string()).default([]),
  blocked: z.boolean().default(false),
  is_mock: z.boolean().default(true),
  asked_question_id: z.string().nullable().default(null),
  draft_ready: z.boolean().default(false),
  draft: JobPostingDraftSchema.nullable().default(null),
  /** Present only on the session-start turn. */
  started_at: z.string().optional(),
});
export type JobPostingChatTurnResponse = z.infer<typeof JobPostingChatTurnResponseSchema>;

/**
 * One hydrated transcript line. DELIBERATELY NARROW. The message row also carries
 * payer_id and a metadata JSONB, neither of which a client needs to redraw bubbles, so
 * neither is named here; the service maps field-by-field rather than spreading the row,
 * so a future column cannot silently join the response. `id` is included because both
 * clients key their bubble lists on it.
 */
export const JobPostingChatMessageSchema = z.object({
  id: uuidSchema,
  direction: z.enum(MESSAGE_DIRECTIONS),
  message_type: z.enum(MESSAGE_TYPES),
  body_text: z.string().nullable(),
  created_at: z.string(),
});

/**
 * `GET /payer/job-posting-chat/sessions/:id/messages` — the cross-device hydration
 * read. Carries the transcript AND the session's current status + draft, because
 * "continue on another device" means redrawing the whole surface, not just bubbles.
 */
export const JobPostingChatMessagesResponseSchema = z.object({
  session_id: uuidSchema,
  status: z.enum(JOB_POSTING_CHAT_STATUSES),
  draft_ready: z.boolean(),
  draft: JobPostingDraftSchema.nullable(),
  published_job_posting_id: uuidSchema.nullable(),
  // OLDEST FIRST — chronological, the order a thread is drawn in.
  messages: z.array(JobPostingChatMessageSchema),
});
export type JobPostingChatMessagesResponse = z.infer<typeof JobPostingChatMessagesResponseSchema>;

/** `POST /payer/job-posting-chat/sessions/:id/publish` — nothing from the body. */
export const PublishJobPostingChatSchema = z.object({});
export type PublishJobPostingChatDto = z.infer<typeof PublishJobPostingChatSchema>;

/**
 * Draft fields the interview collects that the CREATE path has nowhere to put.
 *
 * `PayerCreateJobPostingSchema` accepts org_label/role_title/location_label/
 * description/vacancy_band/skills, and `job_postings` has no column for pay, shift,
 * benefits or requirements (those live on the separate `jobs` entity, ADR-0024).
 * Rather than drop them silently — or, worse, splice them into the payer's own
 * description text — they stay on the session draft (durable, resumable, auditable)
 * and are reported back BY NAME so the client can tell the payer what did not make it
 * onto the posting. KEYS only; the values are never echoed here.
 */
export const UNMAPPED_DRAFT_FIELDS = [
  "pay_min",
  "pay_max",
  "shift",
  "benefits",
  "requirements",
] as const;
export type UnmappedDraftField = (typeof UNMAPPED_DRAFT_FIELDS)[number];

/** `POST .../publish` response — the created posting id + the honest gap report. */
export const PublishJobPostingChatResponseSchema = z.object({
  session_id: uuidSchema,
  job_posting_id: uuidSchema,
  status: z.literal("published"),
  /** Field KEYS the draft held but the posting cannot store yet. Never values. */
  unmapped_fields: z.array(z.enum(UNMAPPED_DRAFT_FIELDS)).default([]),
});
export type PublishJobPostingChatResponse = z.infer<typeof PublishJobPostingChatResponseSchema>;
