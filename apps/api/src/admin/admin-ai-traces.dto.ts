import { z } from "zod";
import {
  AiCostRecordedPayload,
  type AiCostTaskType,
  type AiTraceErrorCode,
} from "@badabhai/event-schema";

/**
 * The task-type vocabulary, taken FROM THE EVENT PAYLOAD rather than retyped.
 *
 * `aiTaskType` is module-private in `@badabhai/event-schema`, and the shape of the shipped
 * payload is the closest thing to it that is exported — the same route `ai-cost-coverage.test.ts`
 * takes to enumerate the surfaces. Reaching through the payload keeps this filter and the cost
 * event on ONE vocabulary: a task type added there is filterable here in the same commit, and a
 * value this route would accept that no writer can produce cannot exist.
 */
const AiTaskTypeEnum = AiCostRecordedPayload.shape.task_type;

/**
 * `GET /admin/ai-traces` and `GET /admin/ai-traces/:id` (migration 0083).
 *
 * ── TWO ROUTES, TWO DATA CLASSES, ONE GATE ───────────────────────────────────────────────
 * `ai_call_traces` holds the prompt and the completion of every AI call. The two routes still
 * differ by DATA CLASS, and the difference is real and worth keeping visible:
 *
 *   LIST   — the PII-FREE scalars: task type, model, success, the two LENGTHS, `real_call`, the
 *            closed-set error code, and opaque ids. No ciphertext leaves the repository and
 *            nothing is decrypted. The lengths are what make it useful: `feedback.submitted`
 *            carries `message_length` for the same reason — a size question wants a size.
 *   DETAIL — DECRYPTS, charged against a per-admin egress cap, and audited FAIL-CLOSED before
 *            any plaintext exists.
 *
 * BOTH sit on `read_ai_traces` (super_admin ONLY) behind the default-OFF
 * `ADMIN_AI_TRACE_READ_ENABLED` flag, per the owner ruling. The case for putting the LIST on
 * `read_entities` instead — so ops can triage failures without being entitled to read what
 * workers said — is a good one and is written out in `admin-ai-traces.controller.ts`, where it
 * is waiting on a ruling rather than being taken. The thing to weigh when that ruling is made:
 * a full walk of this list is an index of which worker spoke, in which interview, when, and how
 * much, across the whole worker base.
 *
 * ── WHAT IS DELIBERATELY ABSENT FROM BOTH ───────────────────────────────────────────────
 *   * NO SEARCH over the text. Not by substring, not by full-text, not by hash. `worker_feedback`
 *     refuses the same thing for the same reason — a search over free text is a PII discovery
 *     tool ("find every worker who said the word 'salary'") — and here the corpus is every
 *     interview on the platform rather than one screen's worth of complaints. Filtering is by
 *     task type, by success, and by worker id, all of which are LOOKUPS: inputs the admin
 *     already holds, returning subsets of a page they were already entitled to.
 *   * NO EXPORT. There is no bulk/CSV/range route and there must never be one. The whole shape
 *     of the detail read — one `:id`, one audit row, one cap unit — assumes it is the only way
 *     text leaves, and an export would be a way around every control at once.
 *   * NO WORKER NAME. `worker_id` is an opaque id here exactly as on every other admin list.
 *     Identity egress stays `POST /admin/workers/:id/reveal-contact` and the identity layer, and
 *     nothing on this surface goes near either.
 */

/** Hard upper bound on a single trace page. Half the entity ceiling — see the schema below. */
export const ADMIN_AI_TRACES_PAGE_MAX = 50;
export const ADMIN_AI_TRACES_PAGE_DEFAULT = 25;

/**
 * The list query. `.strict()` for the reason every sibling is strict: silently dropping an
 * unknown filter is how a screen shows an unfiltered list while its URL claims otherwise.
 *
 * THE PAGE CEILING IS 50, HALF THE `read_entities` LIST CEILING OF 100, and that is a decision
 * rather than a copy. Every row here names an AI call that HAS stored text — the list is, read
 * end to end, an index of which workers have said how much and when. Keeping the page small does
 * not make that untrue; it makes walking the whole index cost more requests, each of which is
 * one more line in the API log. It is a speed bump on the one thing this surface can be abused
 * for, and it costs an operator nothing on the screen it exists for (one worker, one session).
 */
export const AdminAiTracesQuerySchema = z
  .object({
    cursor: z.string().min(1).max(256).optional(),
    limit: z.coerce
      .number()
      .int()
      .positive()
      .max(ADMIN_AI_TRACES_PAGE_MAX)
      .optional()
      .default(ADMIN_AI_TRACES_PAGE_DEFAULT),
    /**
     * Narrow to one surface. The vocabulary is `aiTaskType`'s, shared with the cost event, so a
     * value the reader accepts that no writer can produce is unrepresentable. An unknown value
     * is a 400, never a silently-ignored filter.
     */
    taskType: AiTaskTypeEnum.optional(),
    /** `?success=false` — the triage query this whole surface exists to make cheap. */
    success: z
      .union([z.boolean(), z.enum(["true", "false"])])
      .transform((v) => (typeof v === "boolean" ? v : v === "true"))
      .optional(),
    /**
     * `.uuid()` rather than a bare string: an id that is not a uuid can only fail at BIND
     * against a `uuid` column (22P02), which surfaces as a 500 for a caller whose address bar is
     * wrong. A 400 says what happened.
     */
    workerId: z.string().uuid().optional(),
  })
  .strict();
export type AdminAiTracesQueryDto = z.infer<typeof AdminAiTracesQuerySchema>;

/** The detail route's path parameter. */
export const AdminAiTraceParamsSchema = z.object({ id: z.string().uuid() }).strict();
export type AdminAiTraceParamsDto = z.infer<typeof AdminAiTraceParamsSchema>;

/**
 * One row on the trace LIST — the PII-free projection, and the ENTIRE contract.
 *
 * A field absent here is a field the list cannot show, because the repository selects exactly
 * these columns. There is deliberately no `prompt`, no `response`, no `prompt_enc`, no
 * `response_enc` and no `*_preview`: the ciphertext never leaves the repository on this path, so
 * "the list accidentally returned a token" is not a bug that can be introduced by editing a
 * mapper. The two `*_chars` fields are what a size question actually needs.
 */
export interface AdminAiTraceListItem {
  id: string;
  /** The join key back to `ai.cost_recorded` and `ai_jobs.output_ref`. Opaque. */
  ai_call_id: string;
  /** Opaque. No name, no phone, and no join to `workers` that could grow one. */
  worker_id: string;
  session_id: string | null;
  ai_job_id: string | null;
  correlation_id: string | null;
  task_type: AiCostTaskType;
  model_name: string | null;
  prompt_name: string | null;
  prompt_version: string | null;
  /** LENGTHS, never the text. Null when that half of the call had none. */
  prompt_chars: number | null;
  response_chars: number | null;
  real_call: boolean;
  success: boolean;
  /** A closed-set code (`AI_TRACE_ERROR_CODES`), never a provider message. */
  error_code: AiTraceErrorCode | null;
  created_at: Date;
}

/**
 * The DETAIL response — the list row plus the two decrypted strings.
 *
 * `prompt` / `response` exist ONLY in this response body. They are never logged, cached,
 * persisted anywhere else, or put on an event; the `admin.ai_trace_viewed` row that had to
 * commit before they were computed carries their LENGTHS and nothing more. The route sets
 * `Cache-Control: no-store` so the body cannot land in a shared proxy or a bfcache entry.
 *
 * `null` on either field means the stored column was null (a call with no reply) OR that the
 * ciphertext could not be decrypted — see the service for why those two degrade the same way.
 */
export interface AdminAiTraceDetail extends AdminAiTraceListItem {
  prompt: string | null;
  response: string | null;
}
