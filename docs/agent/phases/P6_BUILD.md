PHASE P6 — contact caps and boost supply gate.

Two things.

1. CONTACT CAPS — 5 unlocks per worker per rolling 7 days, 15 per rolling 30 days.
   Check the cap at the unlock REQUEST, before any credit is taken.
   The unlock flow already has a "denied" state. Use it, with a clear reason code.
   Emit an event when denied.
   A worker at cap must STILL APPEAR in employer lists. Only the unlock is refused.
   Hiding them would break the locked rule "relevance sorts, never blocks".

2. BOOST SUPPLY GATE — do not OFFER boost for a job whose job_reach count for that
   role and radius is below a floor. The floor comes from matching_catalog.
   Gate it at the point of offer, not only at purchase.
   Locked sales rule: boost must not sell what supply cannot deliver.

Both the caps and the floor are config values, not constants in code.

INVARIANT: no credit is ever taken for an unlock that breaks a cap.
