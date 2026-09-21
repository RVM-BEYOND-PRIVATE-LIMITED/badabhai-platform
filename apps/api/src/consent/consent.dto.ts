import { z } from "zod";
import { consentPurposesSchema } from "@badabhai/validators";

/**
 * `POST /consent/accept`.
 *
 * THERE IS DELIBERATELY NO `worker_id` HERE. Consent is invariant #6 — the gate
 * that decides whether a worker may be profiled at all — and it used to be
 * accepted for whatever `worker_id` the BODY named, on a route with no auth. That
 * made the gate forgeable by anyone on the internet, for any worker. Its sibling
 * `POST /consent/withdraw` was already worker-authed, which is what showed accept
 * had simply never been updated.
 *
 * The worker now comes from the SESSION (`WorkerAuthGuard` + `@CurrentWorker`),
 * the same XB-A rule the rest of the platform follows: never trust an id in a
 * body. Because this is a plain `z.object` (not `.strict()`), an older client that
 * still sends `worker_id` has the key STRIPPED rather than rejected — so the
 * rollout, and its rollback, work in both directions without a flag day.
 */
export const AcceptConsentSchema = z.object({
  consent_version: z.string().min(1).max(32),
  purposes: consentPurposesSchema,
});
export type AcceptConsentDto = z.infer<typeof AcceptConsentSchema>;

/**
 * `GET /consent/me` (#1637) — the caller's LATEST consent row, as the worker's own screen
 * needs it: purposes + revocation only.
 *
 * DELIBERATELY NOT the row. `ip_hash` and `user_agent` are consent EVIDENCE, not state a
 * client renders, and returning them would put a hashed IP on a worker's device for no
 * reason (§9: never expose unnecessary data). `consent_id` is included so a client can tell
 * "a write landed" from "nothing changed" without comparing timestamps.
 *
 * `purposes: []` AND NULLS IS A REAL ANSWER: a worker who has never consented gets this
 * shape, not a 404 — the switch screen needs to render "off", and an error would be a dead
 * end on a first launch.
 */
export interface MyConsentState {
  consent_id: string | null;
  consent_version: string | null;
  accepted_at: string | null;
  revoked_at: string | null;
  purposes: string[];
}
