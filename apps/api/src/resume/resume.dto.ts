import { z } from "zod";
import { uuidSchema } from "@badabhai/validators";

/**
 * Generate a resume (worker-authed, TD70 item 5). The ACTING worker id is
 * derived from the SESSION in the controller (XB-A: ids from the session,
 * never the body). `worker_id` stays accepted in the body ONLY for back-compat
 * with shipped worker-app clients that still send it — when present it must
 * equal the session worker or the request 404s (no existence oracle).
 */
export const GenerateResumeSchema = z.object({
  worker_id: uuidSchema.optional(),
  profile_id: uuidSchema,
});
export type GenerateResumeDto = z.infer<typeof GenerateResumeSchema>;

/**
 * Service-side generate input: `worker_id` is ALWAYS resolved by the caller —
 * the controller passes the session worker id; the auto-generate queue
 * processor passes the job's own workerId. Never a client-supplied value.
 */
export interface GenerateResumeInput {
  worker_id: string;
  profile_id: string;
}

/**
 * Response of `GET /resume/document` — the worker's OWN latest resume as structured data,
 * plus the two fields a client needs to know whether that data is worth waiting for (#1397).
 *
 * WHY THERE ARE TWO SIGNALS AND NOT ONE. The obvious answer to "the client can't tell
 * 'still rendering' from 'nothing here'" is to expose `render_status`, and that is here. It
 * is not sufficient on its own, because it describes the PDF RENDER and the two things move
 * together on only one of the paths a client polls after:
 *
 *   FIRST render (trade form finished, profile confirmed) — the row is created 'pending' and
 *   flips to 'rendered' when the document lands. `render_status` answers this perfectly.
 *
 *   FORCED re-render (a work-history description source changed, credentials or preferences
 *   edited, a photo added or removed) — the row is ALREADY 'rendered' and NOTHING ON THAT PATH
 *   EVER WRITES 'pending' BACK. The only writer of 'pending' in the repo is
 *   `ResumeRepository.createInitial({overwrite: true})` — the manual generate, which a forced
 *   re-render never calls; the enqueue sites write no status at all, and
 *   `ResumeRenderProcessor.process` only ever writes 'rendered' or 'failed'. So `render_status`
 *   reads 'rendered' for the entire lifetime of that re-render and a client polling it stops
 *   immediately on the PREVIOUS document. `rendered_at` is what moves, because
 *   `ResumeRepository.markRendered` writes it in the SAME single UPDATE as `resume_document`.
 *
 * SO THE POLLING RULE IS: hold the `rendered_at` you had BEFORE the write and poll until it
 * changes — no clock agreement between device and server is needed, only inequality — using
 * `render_status` to decide whether waiting is worth anything at all.
 *
 * THAT RULE DOES NOT SELF-TERMINATE, AND A CLIENT MUST CARRY AN UNCONDITIONAL DEADLINE OF ITS
 * OWN. Three outcomes end a render without ever moving `rendered_at`: a forced re-render that
 * produces no PDF over an already-good one leaves BOTH fields exactly as they were (deliberate
 * — a failed re-render must not cost a worker the resume they already had); a fail-closed
 * re-render moves `render_status` to 'failed' and nothing else; and a first render can park at
 * 'pending' indefinitely, below. Waiting here is a bet on a timestamp changing, and this
 * endpoint cannot promise that it will.
 *
 * WHAT EACH VALUE ACTUALLY PROMISES — the honest version, because a client is about to build
 * a loop on it:
 *
 *   'pending'  A render is EXPECTED, NOT GUARANTEED — but far more nearly guaranteed than when
 *              this contract was first written. #1399 closed the two ways a row parked here
 *              forever: a render producing no PDF now retries and ends at 'failed', and an
 *              enqueue failure now marks the row 'failed' instead of leaving it waiting on a job
 *              that was never created. What remains is the render kill-switch (a deliberate
 *              steady state, and nothing re-enqueues those rows when it goes back on) and rows
 *              that were already stranded before #1399 — it fixed the writers and deliberately
 *              did not backfill. `pnpm db:audit:render-status` counts them.
 *              SO THE DEADLINE ABOVE IS STILL REQUIRED, just for a smaller set of causes.
 *              `document` may still be non-null and STALE here: the manual-generate overwrite
 *              resets the status and the PDF key but deliberately leaves the previous document
 *              in place, which is why `rendered_at` — reset to null by that same write — is
 *              the field that tells the two apart.
 *
 *   'rendered' The render completed. `document` is the one it produced — EXCEPT on rows
 *              rendered before the column shipped (migration 0095), which read 'rendered' with
 *              `document: null` until something forces a re-render and fills the column. That
 *              combination is the case this endpoint most clearly fixes: today a client burns
 *              its whole retry budget waiting for a document this render will never produce.
 *              Stop polling THIS render and fall back to `resume_text` — but re-read on the
 *              next screen entry rather than caching the negative, since a later forced
 *              re-render will fill it.
 *
 *   'failed'   Terminal FOR THE PDF, which is not the same as terminal for the document. Since
 *              #1399 this is also where a render that produced no PDF lands after its retries,
 *              and where a row whose render job could never be enqueued lands immediately.
 *              `markRenderFailed` writes only the status, so a row can read 'failed' while
 *              holding a perfectly renderable document from an earlier render — the
 *              photo-removal fail-closed path does exactly that, to take PDF bytes carrying
 *              an erased face out of service. Stop polling; prefer `document` if it is
 *              non-null, and only then fall back.
 *
 * SCOPE OF THE ANSWER: these fields describe the LATEST VERSION row (`latestResume` orders by
 * version desc), not "the worker's best resume". An ops regenerate that mints a v2 shadows a
 * good v1 — the state is now legible here, which it was not before.
 *
 * `render_status` is typed `string`, deliberately matching `WorkerProfileBundleResume` rather
 * than narrowing to a union on one route only: the column is unconstrained `text` validated in
 * code, and a client that treats an unrecognised value as "stop polling" degrades safely.
 */
export interface MyResumeDocumentResponse {
  resume_id: string;
  version: number;
  /** The structured resume, or null. NULL IS ORDINARY — see the values above. */
  document: unknown | null;
  /** 'pending' | 'rendered' | 'failed' — the render state of THIS version's row. */
  render_status: string;
  /**
   * ISO-8601 UTC, or null when this row has never completed a render. THE FRESHNESS SIGNAL:
   * written in the same UPDATE as `document`, so a change here means a NEW document.
   *
   * Serialized here rather than handed over as a `Date` so the declared type is the type that
   * actually reaches the wire — the sibling ops view returns the raw column and lets the JSON
   * layer decide, which makes its contract true only by coincidence.
   */
  rendered_at: string | null;
}

/**
 * Share a resume. `channel` is a closed enum — no free text, so no link or PII
 * can leak into the emitted `resume.shared` event payload.
 */
export const ShareResumeSchema = z.object({
  channel: z.enum(["whatsapp", "link", "download", "other"]).default("link"),
});
export type ShareResumeDto = z.infer<typeof ShareResumeSchema>;
