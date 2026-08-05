"use server";

import { revalidatePath } from "next/cache";
import {
  createJobPosting,
  updateJobPosting,
  closeJobPosting,
  type CreateJobPostingBody,
  type JobPostingRow,
  type UpdateJobPostingBody,
} from "@/lib/api";

/**
 * Server Actions for the ops Job-Postings screens (ADR-0012).
 *
 * WHY THIS FILE EXISTS — these three writes were CALLED FROM THE BROWSER. Commit
 * 922af4d1 put `POST/PATCH /job-postings` and `POST /job-postings/:id/close` behind
 * the API's `InternalServiceGuard`, but the create form and the edit/publish/close
 * controls are `"use client"` components that imported `@/lib/api` directly. On the
 * client `process.env.INTERNAL_SERVICE_TOKEN` is `undefined` (Next only inlines
 * `NEXT_PUBLIC_*`), so `opsHeaders()` omitted the header and every ops job-posting
 * WRITE 401'd. The reads were unaffected — those already ran in Server Components.
 *
 * Note what did NOT happen: the secret was never shipped to the browser. Next
 * replaces a non-public `process.env` read with `undefined` in the client bundle
 * rather than inlining it, so this was a silent functional break, not a leak. The
 * bundle assertion in `client-server-boundary.test.ts` pins that distinction.
 *
 * SECURITY: all three endpoints are behind `InternalServiceGuard`. The shared
 * `INTERNAL_SERVICE_TOKEN` is attached server-side by `apiWrite` (read from
 * `process.env`, NEVER `NEXT_PUBLIC_*`). These actions run ONLY on the server
 * (`"use server"`), so the secret never reaches the browser bundle. If the token is
 * unset the guard fails closed (401) and the action returns its honest error state.
 *
 * ERROR POLICY — deliberately different from the agency-KYC / credits actions, which
 * collapse every failure into one generic sentence. Here the server's own message is
 * surfaced VERBATIM, because it is load-bearing UX: the 422 description-PII reject and
 * the 409 lifecycle conflict are the operator's only feedback on what to fix. That is
 * the pre-existing behaviour of these forms and it is preserved exactly. The console is
 * internal and server-rendered, so a leaked "401 Unauthorized" tells an operator their
 * token is unset — which is the loud failure `opsHeaders` is designed to produce.
 *
 * NO-LOG: nothing here logs the posting id, the field values, or the raw API error.
 */

/** Result handed back to the client — the fresh row, or the server's message. */
export type JobPostingActionResult =
  | { ok: true; posting: JobPostingRow }
  | { ok: false; error: string };

const LIST_PATH = "/ops/job-postings";

/** v4-shaped UUID, matching the ids the API mints for postings. */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/**
 * Re-validate the posting id SERVER-SIDE. The id reaches this action as a plain
 * string argument from a client component, so it is caller-supplied input even
 * though it originated from a server-rendered page. Rejecting a non-UUID here keeps
 * a crafted action invocation from reaching the API with an arbitrary path segment.
 */
function invalidId(id: string): JobPostingActionResult | null {
  return UUID_RE.test(id.trim()) ? null : { ok: false, error: "Invalid posting id." };
}

/** Create a posting. The server hard-codes `status: draft`; we never send one. */
export async function createJobPostingAction(
  body: CreateJobPostingBody,
): Promise<JobPostingActionResult> {
  try {
    const posting = await createJobPosting(body);
    revalidatePath(LIST_PATH);
    return { ok: true, posting };
  } catch (err) {
    // Verbatim — the 422 description-PII reject is the operator's only feedback.
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

/**
 * Edit a posting's fields, or publish it (`status: "open"`). The caller sends only
 * the changed fields; the API rejects a no-op edit.
 */
export async function updateJobPostingAction(
  id: string,
  body: UpdateJobPostingBody,
): Promise<JobPostingActionResult> {
  const bad = invalidId(id);
  if (bad) return bad;
  try {
    const posting = await updateJobPosting(id.trim(), body);
    revalidatePath(LIST_PATH);
    revalidatePath(`${LIST_PATH}/${id.trim()}`);
    return { ok: true, posting };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

/** Close a posting. `closed` is TERMINAL — the API refuses to reopen it. */
export async function closeJobPostingAction(
  id: string,
): Promise<JobPostingActionResult> {
  const bad = invalidId(id);
  if (bad) return bad;
  try {
    const posting = await closeJobPosting(id.trim());
    revalidatePath(LIST_PATH);
    revalidatePath(`${LIST_PATH}/${id.trim()}`);
    return { ok: true, posting };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}
