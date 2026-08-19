import { z } from "zod";
import type { ChatSessionStatus, AiJobStatus, AiJobType } from "@badabhai/types";
import type { PackAnswerSource, PackAnswerStatus } from "@badabhai/db";
import type { AdminStuckQuestionResult } from "./admin-worker-journey.stuck";

/**
 * Zod DTOs + response projections for the ADMIN WORKER JOURNEY (Phase 6).
 *
 * THE PRODUCT QUESTION. "We are building this app for users who are not habituated with
 * apps" — so for any ONE worker an operator must be able to see which steps they completed,
 * where they stopped, and for the AI profiling interview exactly which question they stalled
 * on and how many of the total they got through.
 *
 * ══ THE HARD LINE: NO RAW TRANSCRIPT TEXT LEAVES THIS SURFACE ═══════════════════════════
 *
 * `chat_messages.body_text` and `voice_notes.transcript_text` hold the worker's own words
 * UNMASKED. Pseudonymization happens transiently at the LLM-call boundary only —
 * `chat.service.ts` writes `bodyText: m.text` with no masking at all — so those two columns
 * are the rawest PII in the system after the encrypted phone. Serving them would be a
 * materially larger exposure than ANY capability the admin portal has today (`reveal_pii`
 * hands over ONE decrypted phone, behind its own capability, its own default-off flag, an
 * audit-before-decrypt and a per-admin rate cap — a whole interview transcript is not in the
 * same class), and it has had no security-engineer review.
 *
 * SO THIS SURFACE RETURNS: question keys, statuses, counts, timings, error codes, opaque ids.
 * NEVER `body_text`, NEVER `transcript_text`, NEVER `answer_text`/`answer_number`/
 * `answer_bool`/`answer_option_keys`, NEVER `value_raw`/`value_normalized` off the answer map.
 * The repository's select lists are the enforcement; a static source scan in
 * `admin-static-guards.test.ts` is the build-blocker. If someone needs transcripts, that is a
 * NEW capability behind a NEW review — not a field quietly added to an existing projection.
 *
 * (Note the asymmetry that makes this workable: `worker_pack_answer.status` says whether a
 * question was answered, declined or never settled. That is the whole funnel signal. The
 * VALUE adds nothing an operator needs to see where a worker got stuck.)
 *
 * ══ PAGINATION ═════════════════════════════════════════════════════════════════════════
 * The session list is KEYSET-paginated on `(started_at, id)` DESC with a hard cap, using the
 * shipped `admin-events.cursor` helper — its field is called `occurredAt` and here it
 * carries `started_at`, which IS when the session occurred. Migration 0079 adds the matching
 * `(worker_id, started_at DESC, id DESC)` index.
 */

// ---------------------------------------------------------------------------
// Bounds
// ---------------------------------------------------------------------------

/** Hard upper bound on one page of a worker's chat sessions. */
export const ADMIN_JOURNEY_SESSIONS_PAGE_MAX = 50;
export const ADMIN_JOURNEY_SESSIONS_PAGE_DEFAULT = 20;

/**
 * Hard cap on each sub-list of the session DETAIL read.
 *
 * A real interview settles ~13 answers and records a few dozen voice attempts, so this is
 * far above any legitimate session — it exists so a pathological row count (a retry storm, a
 * corrupted sweep) cannot turn one admin page view into an unbounded response. The lists are
 * ordered deterministically, so a truncated read is the FIRST n, not an arbitrary n.
 */
export const ADMIN_JOURNEY_DETAIL_ROWS_MAX = 300;

/**
 * Hard cap on how many DISTINCT `(pack_id, pack_version)` pairs a worker's answers may
 * contribute to the profiling denominator.
 *
 * Bounded in reality by re-interviews (`wpa_worker_question_uq` is keyed on
 * `(worker, pack, question_key)`), so single digits — but "in reality" is a property of
 * today's product, and this query fans out into an OR list.
 */
export const ADMIN_JOURNEY_PACK_PAIRS_MAX = 25;

// ---------------------------------------------------------------------------
// Query / param DTOs
// ---------------------------------------------------------------------------

/** Every `:id` on this surface is a uuid. `.strict()` — an unknown param is a 400, not a silent ignore. */
export const AdminJourneyParamsSchema = z.object({ id: z.string().uuid() }).strict();
export type AdminJourneyParamsDto = z.infer<typeof AdminJourneyParamsSchema>;

/** GET /admin/workers/:id/chat-sessions */
export const AdminChatSessionsQuerySchema = z
  .object({
    cursor: z.string().min(1).max(256).optional(),
    limit: z.coerce
      .number()
      .int()
      .positive()
      .max(ADMIN_JOURNEY_SESSIONS_PAGE_MAX)
      .optional()
      .default(ADMIN_JOURNEY_SESSIONS_PAGE_DEFAULT),
    status: z.enum(["active", "ended", "abandoned"]).optional(),
  })
  .strict();
export type AdminChatSessionsQueryDto = z.infer<typeof AdminChatSessionsQuerySchema>;

// ---------------------------------------------------------------------------
// Caveats — the honest-reporting channel
// ---------------------------------------------------------------------------

/**
 * Closed-set caveats attached to a response, so a MISSING measurement never renders as a
 * confident zero.
 *
 * A closed enum rather than free text on purpose: the UI has to be able to render each one
 * as a specific sentence, and a server-authored string would be an untranslatable,
 * unversioned message shipped through a data field.
 */
export const JOURNEY_CAVEATS = [
  /**
   * `interview_kit.downloaded` only began carrying `worker_id` at migration 0079, and no
   * backfill is possible (the route was anonymous by design). A zero on step 7 means "no
   * ATTRIBUTED download since then", never "this worker never took a kit".
   *
   * The number in this name tracks the migration and was `..._0078` until that slot collided
   * with `0078_unresolved_phrase_job_domain_id` on `main`. Renaming a wire value is normally
   * forbidden; it is safe exactly here because this enum has never shipped — it is introduced
   * by the same unmerged PR that carries the migration, and no consumer reads it yet.
   */
  "interview_kit_attribution_since_0079",
  /**
   * `session_ai_cost_totals` accrues only from migration 0077 forward, with no backfill. A
   * session older than that has NO row — which is reported as `ai_cost: null`, never as ₹0,
   * because "we did not measure it" and "it cost nothing" are different facts.
   */
  "ai_cost_not_recorded",
  /**
   * The session has no `conversation_state` (a v1 model-driven interview, or one that never
   * reached the deterministic engine), so `ask_counts` does not exist and no stuck question
   * can be derived from anything.
   */
  "no_conversation_state",
  /**
   * The worker has `worker_pack_answer` rows whose `(pack_id, pack_version)` no longer has
   * any `question_pack_item` rows — a pack version retired out from under the answers. The
   * profiling denominator is then an UNDERCOUNT, so the progress bar is not trustworthy.
   */
  "pack_version_retired",
  /**
   * At least one question in this session's `ask_counts` resolved to NO `question_pack_item`
   * row, in any pack version this read could load. Its `max_asks`, `is_mandatory`, `is_core`
   * and `display_order` are unknown, so the stuck ranking could not judge it on the two legs
   * that need them. `stuck.unresolved_count` says how many.
   */
  "stuck_items_unresolved",
] as const;
export type JourneyCaveat = (typeof JOURNEY_CAVEATS)[number];

// ---------------------------------------------------------------------------
// The 7-step funnel
// ---------------------------------------------------------------------------

/**
 * THREE VALUES, and no `not_tracked`.
 *
 * A "we have no way of knowing" value would be right in principle — collapsing it into
 * `not_done` is how a product decision gets made on a measurement that never existed — but no
 * step produces it: every one of the seven returns done / in_progress / not_done. The honest
 * -absence channel that DOES carry real work here is {@link JOURNEY_CAVEATS}, which is per
 * RESPONSE rather than per step and is actually populated. A fourth status nobody emits is a
 * value the UI must render a case for and can never see.
 */
export type AdminJourneyStepStatus = "done" | "in_progress" | "not_done";

/** What every funnel row carries, so the UI can render one component seven times. */
interface AdminJourneyStepBase {
  /** 1..7 — the funnel order, served by the server so the client never re-orders it. */
  order: number;
  status: AdminJourneyStepStatus;
  /** Progress numerator, or null where a count is not meaningful for this step. */
  completed: number | null;
  /** Progress denominator, or null where a count is not meaningful for this step. */
  total: number | null;
  first_at: Date | null;
  last_at: Date | null;
}

/**
 * Step 1 — LOGIN.
 *
 * A `workers` row IMPLIES a completed OTP verify: the only production writer is
 * `WorkersRepository.createOrGetByPhoneHash`, whose only caller is
 * `AuthService.mintLoginForPhone`, which is reached only from `verifyOtp` and `testLogin`.
 * (`WorkersRepository.create` has no production caller at all.) So the useful data is not
 * whether, it is WHEN and HOW OFTEN.
 */
export interface AdminJourneyLoginStep extends AdminJourneyStepBase {
  key: "login";
  /** `worker.otp_verified` events for this worker — REAL logins. `completed` mirrors this. */
  otp_verified_count: number;
  /**
   * `worker.test_login` events — the staging/e2e mint, a DISTINCT event name precisely so a
   * test mint can never masquerade as a real login. Reported separately and NEVER summed in.
   */
  test_login_count: number;
  last_test_login_at: Date | null;
  /** When the worker row itself was created — the first login, whichever route minted it. */
  worker_created_at: Date;
}

/**
 * Step 2 — CHAT / AI PROFILING.
 *
 * NUMERATOR: the worker's own `worker_pack_answer` rows.
 * DENOMINATOR: `question_pack_item` counts for exactly the `(pack_id, pack_version)` pairs
 * those rows STAMP THEMSELVES WITH — never "the currently active pack".
 *
 * ⚠ WHY THAT DISTINCTION IS LOAD-BEARING. The interview merges TWO packs, an occupation pack
 * and a universal one, and only the occupation pack is pinned on `chat_sessions.pack_id`. The
 * universal pack is resolved fresh from whatever is `active` at the time. So re-deriving the
 * denominator from the active packs silently changes a finished worker's total the moment a
 * pack is re-seeded — the progress bar moves for a worker who did nothing. Each answer row
 * carries its own `pack_id` + `pack_version`, which is the only record of what that worker
 * was actually asked; that is what this counts.
 */
export interface AdminJourneyProfilingStep extends AdminJourneyStepBase {
  key: "profiling";
  answered_count: number;
  declined_count: number;
  /**
   * Rows persisted with `status = 'unanswered'`. EXPECTED TO BE ZERO on every current row:
   * `packAnswerRowFor` returns null for an unanswered record, so the interview flush never
   * writes one — the status exists in the schema and is reachable only by a future writer.
   * Counted rather than assumed away, so it stops being zero VISIBLY.
   */
  unanswered_count: number;
  /** How many interview sessions this worker has, whatever their status. */
  session_count: number;
  /** One row per pack version this worker's answers actually stamp. */
  packs: AdminJourneyPackProgress[];
}

export interface AdminJourneyPackProgress {
  pack_id: string;
  pack_version: number;
  /** `question_pack_item` rows for THIS EXACT version. 0 = the version was retired. */
  item_count: number;
  /** The worker's answer rows stamped with this version. */
  answer_count: number;
}

/** Step 3 — RESUME. `generated_resumes` rows for the worker (index `generated_resumes_worker_id_idx`). */
export interface AdminJourneyResumeStep extends AdminJourneyStepBase {
  key: "resume";
  has_resume: boolean;
  resume_count: number;
  /** How many have a rendered PDF — the async second leg can lag or fail on its own. */
  rendered_count: number;
}

/**
 * Step 4 — PROFILE CONFIRMED. `worker_profiles.profile_status = 'confirmed'`.
 *
 * The live profile row is picked with `CURRENT_PROFILE_ORDER`, the ONE definition of "which
 * `worker_profiles` row is this worker's profile" — never a hand-rolled `ORDER BY updated_at`.
 * A worker has one row per extraction, and recency alone hands back the empty placeholder
 * written during an ai-service outage.
 */
export interface AdminJourneyProfileStep extends AdminJourneyStepBase {
  key: "profile_confirmed";
  /** `draft` | `extracting` | `extracted` | `confirmed`, or null when never profiled. */
  profile_status: string | null;
  confirmed_at: Date | null;
  /** How many profile rows exist — one per extraction, so >1 means re-interviews. */
  profile_count: number;
}

/**
 * Step 5 — JOB SEARCH / APPLY.
 *
 * SEARCH: `job.search_performed` events, whose subject IS the worker (index
 * `events_subject_idx` on `(subject_type, subject_id)`).
 * APPLY: the `applications` table, `action = 'applied'`.
 *
 * ⚠ NOT `feed.shown` / `application.submitted`. Their `subject_id` is the JOB — the worker
 * appears only in `actor_id` or in the payload, neither of which is indexed. A per-worker
 * count off those is a sequential scan of the biggest table in the system.
 *
 * Deliberately narrower than `AdminWorkerDetail.application_count`, which counts applied AND
 * skipped. A skip is a real signal but it is not a funnel completion.
 */
export interface AdminJourneySearchApplyStep extends AdminJourneyStepBase {
  key: "job_search_apply";
  search_count: number;
  first_search_at: Date | null;
  last_search_at: Date | null;
  applied_count: number;
  skipped_count: number;
}

/**
 * Step 6 — PHOTO. `workers.photo_storage_key IS NOT NULL`.
 *
 * Reduced to a boolean IN POSTGRES, exactly as `admin-entities.repository.ts` does it. The
 * key is an opaque pointer, but it addresses a FACE PHOTO, and fetching it would put that
 * pointer in a variable in this process one `...r` spread away from a response.
 */
export interface AdminJourneyPhotoStep extends AdminJourneyStepBase {
  key: "photo";
  has_photo: boolean;
}

/**
 * Step 7 — INTERVIEW KIT. `interview_kit.downloaded` events whose payload `worker_id` is this
 * worker (partial index `events_interview_kit_worker_idx`, migration 0079).
 *
 * The route is public and unauthenticated by design, so attribution is OPTIONAL and only
 * exists from 0079 forward, with no backfill possible. `attribution_available` says so on
 * every response, and the summary carries the matching caveat — a zero here must never be
 * read as "this worker never took a kit".
 */
export interface AdminJourneyInterviewKitStep extends AdminJourneyStepBase {
  key: "interview_kit";
  download_count: number;
  /** Distinct trades downloaded — one worker preparing for three roles is a real signal. */
  trade_count: number;
  attribution_available: boolean;
}

export type AdminJourneyStep =
  | AdminJourneyLoginStep
  | AdminJourneyProfilingStep
  | AdminJourneyResumeStep
  | AdminJourneyProfileStep
  | AdminJourneySearchApplyStep
  | AdminJourneyPhotoStep
  | AdminJourneyInterviewKitStep;

export interface AdminWorkerJourneySummary {
  worker_id: string;
  /** When this snapshot was computed. It is a live read, not a materialization. */
  generated_at: Date;
  /** Always all seven, always in `order`. A step is never omitted — it reports `not_done`. */
  steps: AdminJourneyStep[];
  caveats: JourneyCaveat[];
}

// ---------------------------------------------------------------------------
// Chat sessions
// ---------------------------------------------------------------------------

export interface AdminChatSessionListItem {
  id: string;
  worker_id: string;
  /** `active` | `ended` | `abandoned`. `abandoned` is written by the idle sweep, not the worker. */
  status: ChatSessionStatus;
  started_at: Date;
  ended_at: Date | null;
  /** When the worker last spoke. The sweep deliberately does NOT stamp this. */
  last_message_at: Date | null;
  /**
   * Seconds since `last_message_at` at read time — "idle since". Null when the worker never
   * spoke at all, which is itself the signal for a session opened and immediately dropped.
   */
  idle_seconds: number | null;
  /** The pinned OCCUPATION pack. The universal pack is never pinned here — see the DTO header. */
  pack_id: string | null;
  pack_version: number | null;
  message_count: number;
  /**
   * DISTINCT question keys this session SETTLED — `count(distinct question_key)` over
   * `worker_pack_answer` rows with status `answered` or `declined`.
   *
   * ONE definition, shared by the list and the detail read: the list gets it from
   * `countAnswersBySession`, the detail from `listSettledKeys().length`, and both are built on
   * `SETTLED_ANSWER_STATUSES`. They used to be a `count(*)` and a filtered distinct count that
   * agreed only because no writer emits an `unanswered` row yet.
   */
  answer_count: number;
  /** `status === 'abandoned'` — the sweep's verdict, surfaced as its own flag. */
  abandoned: boolean;
}

/** One settled answer. THE VALUE IS NEVER PROJECTED — see the DTO header. */
export interface AdminSessionAnswer {
  question_key: string;
  status: PackAnswerStatus;
  source: PackAnswerSource;
  pack_id: string;
  pack_version: number;
  answered_at: Date;
}

/**
 * One recorded voice attempt — the table that shows where a worker had to repeat themselves.
 *
 * SUPERSEDED ATTEMPTS ARE INCLUDED ON PURPOSE. "Phir se bolein" writes a NEW row and stamps
 * the old one; deleting or hiding the first attempt would erase the only evidence that the
 * worker had to say it twice, which is the single most useful signal for tuning the capture.
 */
export interface AdminSessionVoiceAnswer {
  id: string;
  question_key: string;
  /** 1 for the first recording. >1 is a re-record. */
  attempt_no: number;
  /** Question position in the session. Repeats across attempts of the same question. */
  ordinal: number;
  capture_status: string;
  transcript_status: string;
  /** A CLOSED-SET failure code, never a provider message. Null unless the transcript failed. */
  transcript_error_code: string | null;
  duration_seconds: number | null;
  superseded_at: Date | null;
  superseded_by_id: string | null;
  purged_at: Date | null;
  /**
   * Derived from `voice_note_id IS NOT NULL` in POSTGRES. The id itself is never fetched: it
   * points at the `voice_notes` row that holds `transcript_text`, so handing it to the UI
   * turns "there is a clip" into "here is the handle to the raw transcript".
   */
  has_clip: boolean;
  pack_id: string;
  pack_version: number;
  created_at: Date;
}

/**
 * An AI job correlated to this session via `input_ref->>'session_id'`.
 *
 * Filtered to `job_type = 'profile_extraction'` — which is both index-backed
 * (`ai_jobs_extraction_session_idx` is PARTIAL on that job type and leads on session_id) and
 * COMPLETE: it is the only job type that records a `session_id` at all (transcription jobs
 * key on `voice_note_id`). Dropping the filter would trade an index scan for a sequential
 * scan of a table with no retention policy, and find nothing extra.
 */
export interface AdminSessionAiJob {
  id: string;
  job_type: AiJobType;
  status: AiJobStatus;
  model_name: string | null;
  real_call: boolean | null;
  input_tokens: number | null;
  output_tokens: number | null;
  total_tokens: number | null;
  cost_inr: number | null;
  /**
   * Derived from `error_message IS NOT NULL` in POSTGRES. The MESSAGE is not projected: it is
   * the one column on this table whose contents come from an external system, so it is the
   * one whose PII-freeness this codebase cannot guarantee (same rule as `payment_ref`).
   */
  has_error: boolean;
  created_at: Date;
  updated_at: Date;
}

/**
 * This session's AI spend, off `session_ai_cost_totals` (migration 0077). READ-ONLY.
 *
 * NULL rather than a zeroed object when there is no row — those totals accrue only from 0077
 * forward with no backfill, so an older session genuinely has no measurement. Reporting ₹0
 * would be a confident answer to a question nobody asked, and would make an unmeasured
 * session indistinguishable from a free one.
 *
 * `total_cost_inr` stays a STRING: the column is `numeric(16,6)` precisely so a running sum
 * of millions of fractional-paisa calls does not drift, and parsing it to a float here would
 * throw that away at the last step.
 */
export interface AdminSessionAiCost {
  total_cost_inr: string;
  call_count: number;
  real_call_count: number;
  first_recorded_at: Date;
  updated_at: Date;
}

export interface AdminChatSessionDetail extends AdminChatSessionListItem {
  answers: AdminSessionAnswer[];
  voice_answers: AdminSessionVoiceAnswer[];
  ai_jobs: AdminSessionAiJob[];
  ai_cost: AdminSessionAiCost | null;
  /** WHICH question the engine was serving when this session ended. See the stuck module. */
  stuck: AdminStuckQuestionResult;
  caveats: JourneyCaveat[];
}
