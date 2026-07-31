import { z } from "zod";

/**
 * Evaluate the ₹20 activation-bonus rule for ONE referred worker (§X.6).
 *
 * The worker is named by an OPAQUE uuid — this route never takes a phone, a code, or a
 * name. The inviter is NOT accepted from the caller: it is resolved server-side from the
 * `invites` row that attributed this worker, so a caller can never nominate who gets paid.
 */
export const EvaluateReferralBonusSchema = z.object({
  invited_worker_id: z.string().uuid(),
});
export type EvaluateReferralBonusDto = z.infer<typeof EvaluateReferralBonusSchema>;
