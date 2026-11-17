import type { ExpiredCreditLot } from "@badabhai/db";
import type { CreditLotExpiryTrigger } from "@badabhai/types";
import type { EmitParams } from "../events/events.service";

/**
 * #2749 — the ONE spelling of `payer.credits_expired`, shared by its two emitters: the contact
 * open that spent a credit and found a lot past its date (`spend`, UnlockService) and the expiry
 * sweep (`sweep`, CreditLotExpirySweepProcessor). Both emit it ON the transaction that writes the
 * lot's `expired` ledger line (`EventsService.emit({ tx })`), so a committed expiry cannot lose it.
 *
 * ONE PER LOT, EVER: the idempotency key is the lot (the ledger line's own identity is
 * `credit_lot_expired:<lot id>`), so a replayed flush records it once, and a lot can only be
 * expired once anyway.
 *
 * FACELESS: the wallet key, the lot id, an integer, two closed codes and a date.
 */
export function creditsExpiredEvent(input: {
  /** The wallet the credits left — the tenant key the lot is keyed by. */
  walletKey: string;
  lot: ExpiredCreditLot;
  trigger: CreditLotExpiryTrigger;
  /** The company login whose spend found it, or the system (the sweep). */
  actor: { actor_type: "payer"; actor_id: string } | { actor_type: "system"; actor_id: null };
  correlationId: string;
  requestId: string;
}): EmitParams<"payer.credits_expired"> {
  return {
    event_name: "payer.credits_expired",
    actor: input.actor,
    // The subject is the WALLET whose credits expired — the tenant's (ADR-0053 §7), as for
    // `payer.credits_exhausted`.
    subject: { subject_type: "payer", subject_id: input.walletKey },
    payload: {
      payer_id: input.walletKey,
      lot_id: input.lot.lotId,
      credits: input.lot.credits,
      source: input.lot.source,
      expires_at: input.lot.expiresAt.toISOString(),
      trigger: input.trigger,
    },
    idempotencyKey: `payer.credits_expired:${input.lot.lotId}`,
    correlationId: input.correlationId,
    requestId: input.requestId,
  };
}
