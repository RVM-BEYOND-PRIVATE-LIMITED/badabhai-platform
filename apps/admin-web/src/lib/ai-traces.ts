import "server-only";
import { z } from "zod";
import { adminFetch } from "./admin-http";
import { qs } from "./entities";

/**
 * The AI-call-trace data layer (migration 0083) — the portal's read seam onto
 * `GET /admin/ai-traces` and `GET /admin/ai-traces/:id`.
 *
 * ── ONE TABLE, TWO PRIVILEGE LEVELS, AND THE SPLIT IS THE WHOLE DESIGN ──────────────────
 * {@link listAiTraces} serves SCALARS ONLY: task type, model, success, the closed-set error
 * code, `real_call`, opaque ids, and the two character COUNTS. No ciphertext leaves the
 * server on that path and nothing is decrypted, so "which extraction calls failed this
 * morning, and how big were they" stays answerable on the ordinary `read_entities` floor.
 * `feedback.submitted` ships `message_length` for the same reason — a size question wants a
 * size, not the text.
 *
 * {@link getAiTrace} DECRYPTS. It is gated on `read_ai_traces`, sits behind a default-off
 * server switch that answers a NEUTRAL 404 when unset, is charged against a per-admin
 * allowance, and writes a fail-closed `admin.ai_trace_viewed` audit row BEFORE any plaintext
 * exists. Read `lib/ai-trace-view.ts`'s header before writing a word of copy about it: what
 * the platform enforces and what it does not are both written down there.
 *
 * ── WHAT THIS MODULE DELIBERATELY CANNOT DO ─────────────────────────────────────────────
 *   * NO SEARCH over the text — not by substring, not by hash. The route offers none and this
 *     module must never grow a client-side equivalent; a search over this table would be a
 *     search over everything every worker has ever said to the platform. `lib/feedback.ts`
 *     refuses the same thing over one screen's worth of complaints, and the corpus here is
 *     larger by orders of magnitude.
 *   * NO BULK READ. The detail helper takes exactly one id, because every control on the
 *     server side — the audit row, the allowance, the single-subject shape — assumes that is
 *     the only way text leaves. A "fetch these ten" helper would go around all of them at once.
 *   * NO WORKER NAME. `worker_id` is the opaque id every other admin list shows. Identity
 *     egress stays on the separate, reason-gated `reveal_pii` path and nothing here goes near it.
 *
 * ── NOTHING HERE IS EVER CACHED ─────────────────────────────────────────────────────────
 * Neither call passes `revalidate`, which is what keeps `adminFetch` on `cache: "no-store"`.
 * Passing a number instead writes the response — decrypted prompt included — into Next's
 * on-disk Data Cache under `.next/cache`, where it would outlive the audited, budgeted read
 * that disclosed it and be served to the next admin without one. `ai-traces.test.ts` asserts
 * it, for the same reason `entities.identity.test.ts` asserts it of every name-bearing helper.
 */

/**
 * One row of the PII-FREE list projection.
 *
 * ── WHY `task_type` AND `error_code` ARE BARE STRINGS AND NOT ENUMS ─────────────────────
 * Both are closed sets on the server, and pinning either here would still be wrong. The
 * `task_type` column is `text` with no IN-list CHECK precisely so the ai-service can gain a
 * surface without a migration having to land first; an enum here would turn that routine
 * widening into an `AdminRequestError` that blanks the WHOLE page until admin-web redeploys —
 * hiding exactly the new surface an operator would be looking for. `screen_context` on the
 * feedback list makes this ruling in full. Values the server vouched for are safe to display;
 * refusing to display them is the only way this schema could make things worse.
 *
 * There is no `prompt_enc`, no `response_enc` and no `*_preview` key, because the server's own
 * projection has none — the ciphertext never leaves its repository on this path.
 */
export const aiTraceListItemSchema = z.object({
  id: z.string(),
  /** The join key back to `ai.cost_recorded` and `ai_jobs.output_ref`. Opaque. */
  ai_call_id: z.string(),
  /** Opaque. No name, no phone, and no join that could grow one. */
  worker_id: z.string(),
  session_id: z.string().nullable(),
  ai_job_id: z.string().nullable(),
  correlation_id: z.string().nullable(),
  task_type: z.string(),
  model_name: z.string().nullable(),
  prompt_name: z.string().nullable(),
  prompt_version: z.string().nullable(),
  /**
   * LENGTHS, never the text — a count of characters, which is what a size question actually
   * needs. Null means nothing was stored for that half of the call; see `aiTraceHalf`, which
   * is the one place that fact is interpreted.
   */
  prompt_chars: z.number().nullable(),
  response_chars: z.number().nullable(),
  real_call: z.boolean(),
  success: z.boolean(),
  error_code: z.string().nullable(),
  created_at: z.string(),
});
export type AiTraceListItem = z.infer<typeof aiTraceListItemSchema>;

/**
 * The list envelope — `{ items, nextCursor }`, the entity convention. Declared here rather
 * than imported because `pageOf` is private to `lib/entities.ts`, and widening that module's
 * surface to save one line is not a trade worth making (`lib/feedback.ts` said the same).
 */
export const aiTracePageSchema = z.object({
  items: z.array(aiTraceListItemSchema),
  nextCursor: z.string().nullable(),
});
export type AiTracePage = z.infer<typeof aiTracePageSchema>;

/**
 * The DETAIL response: every scalar above, plus the two decrypted strings.
 *
 * `prompt` is the request this API sent to the AI service and `response` is the reply it
 * received, both serialised verbatim. Either may be `null`, and the server states plainly that
 * the null is AMBIGUOUS — the column was empty, or the ciphertext did not decrypt. The portal
 * does not guess between them; `aiTraceHalf` uses the LENGTH beside it, which the writer sets
 * from the same value, to tell the two apart honestly.
 */
export const aiTraceDetailSchema = aiTraceListItemSchema.extend({
  prompt: z.string().nullable(),
  response: z.string().nullable(),
});
export type AiTraceDetail = z.infer<typeof aiTraceDetailSchema>;

/**
 * Filters the list route accepts. Mirrors `AdminAiTracesQuerySchema` on the server.
 *
 * Every value is a RAW query-string value, deliberately not narrowed here. The server's schema
 * is `.strict()`, so a hand-edited `?taskType=nope` must travel and earn an honest 400 that the
 * page renders as a refusal. Dropping it instead would show the WHOLE list under a URL that
 * claims a filter — a wrong answer wearing a right one's clothes.
 */
export interface AiTraceFilters {
  taskType?: string;
  /** `"true"` / `"false"`. `?success=false` is the triage query this surface exists for. */
  success?: string;
  /**
   * ONE worker's calls. A LOOKUP, not a search: an id the operator already holds, from a
   * surface they were already entitled to read, narrowing a page they could reach by scrolling.
   * It selects rows and discovers nobody, which is precisely why the refusal of a text search
   * above stays as absolute as it is.
   */
  workerId?: string;
  cursor?: string;
  limit?: number;
}

export function listAiTraces(f: AiTraceFilters = {}): Promise<AiTracePage> {
  return adminFetch(`/admin/ai-traces${qs(f)}`, { schema: aiTracePageSchema });
}

/**
 * ONE trace, decrypted. The single most privileged read this portal makes.
 *
 * Exactly one id, never a list — see the module header. A 404 here is NEUTRAL by the server's
 * design and covers several different situations on purpose; the caller must render it as
 * "not available" and must not translate it into a claim about which one.
 */
export function getAiTrace(id: string): Promise<AiTraceDetail> {
  return adminFetch(`/admin/ai-traces/${encodeURIComponent(id)}`, { schema: aiTraceDetailSchema });
}
