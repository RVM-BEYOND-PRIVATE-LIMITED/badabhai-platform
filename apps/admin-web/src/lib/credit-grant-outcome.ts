import type { AdminActionOutcome } from "./admin-action-result";

/**
 * The idempotency-key lifecycle for a credit grant, as a pure transition.
 *
 * ── WHY THIS IS NOT INLINE IN THE PANEL ─────────────────────────────────────────────────
 * This is the one piece of client state in the console that decides whether real money
 * moves, and getting it wrong is silent in both directions:
 *
 *  - **Never rotating** turns the operator's second grant into a replay of the first key.
 *    The backend answers `applied: false`, no ledger row is written, no balance moves — and
 *    the UI reports it in the SUCCESS family ("No change") quoting the stale balance. A
 *    dropped money movement presented as a non-error.
 *  - **Rotating on failure** is the opposite failure. A failed response is not proof the
 *    server did not apply the grant (a lost response, a timeout after commit), so a fresh
 *    key on the retry is how one intended grant becomes two real ones.
 *
 * So the rule is: rotate ONLY when the server has CONFIRMED it decided on this key, i.e. on
 * a successful response — `changed: true` (the grant landed) and `changed: false` (the key
 * was already spent) alike. Both mean that key is used up. Anything else keeps it, so a
 * retry is the same logical request and stays exactly-once on the ledger (ADMIN-3a H2).
 *
 * `mintKey` is injected rather than calling `crypto.randomUUID()` here so the transition is
 * deterministic under test — this app's vitest environment is `node` with no DOM, so the
 * panel itself cannot be click-driven, and this is where the property is actually asserted.
 */
export interface CreditGrantFormState {
  /** The `idempotency_key` the NEXT submit will carry. */
  idempotencyKey: string;
  /** The amount field's current text, exactly as typed. */
  amount: string;
}

export function applyCreditGrantOutcome(
  prev: CreditGrantFormState,
  outcome: AdminActionOutcome,
  mintKey: () => string,
): CreditGrantFormState {
  // Failure: keep the key AND the amount. The operator retries the same request, not a new one.
  if (!outcome.ok) return prev;
  return {
    idempotencyKey: mintKey(),
    // A real grant clears the field; a no-op leaves what was typed on screen, because the
    // operator has to decide whether that grant still needs to happen.
    amount: outcome.changed ? "" : prev.amount,
  };
}
