import type { PendingChatUpdateFacts } from "./resume.repository";
import type { ResumePendingUpdate } from "./resume.dto";

/**
 * What the worker's accepted chat update ("Resume update kar doon?" → Haan) looks like right now,
 * for `GET /resume/history` (ADR-0043). Pure over the durable facts and a clock.
 *
 *   null         nothing was accepted, OR it LANDED — a résumé was generated at or after the
 *                Haan, so the history's newest entry is the answer and there is nothing to wait on.
 *   in_progress  the extraction → confirm → generate chain is still running.
 *   failed       it cannot land any more, or it has not landed within `timeoutMs`.
 *
 * `failed` IS DECIDED FROM THREE DIFFERENT KINDS OF EVIDENCE, because the chain has three
 * different ways to stop:
 *   - the extraction job is `failed` — a terminal state the processor recorded;
 *   - the profile came back `draft` — an empty extraction, which `confirmAcceptedUpdate` refuses
 *     to confirm, so no résumé will ever follow it;
 *   - the clock — a generate that hit the daily cap, a consent withdrawn mid-chain, a queue that
 *     never ran. None of those leaves a failure row, and without a deadline the worker would be
 *     told "in progress" forever.
 *
 * A FAILED UPDATE STAYS FAILED UNTIL THE NEXT RÉSUMÉ. There is no expiry: "your last update did
 * not go through" is true until a later generation of any kind supersedes it — which is also what
 * the app's retry does.
 */
export function pendingUpdateFrom(
  facts: PendingChatUpdateFacts | null,
  now: Date,
  timeoutMs: number,
): ResumePendingUpdate | null {
  if (facts === null || facts.landed) return null;
  const requested_at = facts.requestedAt.toISOString();
  const stopped =
    facts.extractionStatus === "failed" ||
    facts.profileStatus === "draft" ||
    now.getTime() - facts.requestedAt.getTime() > timeoutMs;
  return { requested_at, status: stopped ? "failed" : "in_progress" };
}
