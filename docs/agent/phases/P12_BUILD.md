PHASE P12 — Flutter payer app: draft and resume only. BLOCKED ON RULING R6.

STOP AND ASK IMMEDIATELY if ruling R6 is not closed.
apps/payer-app has no named owner. Building into an unowned app breaks the locked
single-owner-per-app rule. Do not assume Prakash owns it by default — he is already
recorded as standing risk number 1.

If R6 is closed, continue:

The Flutter payer app DRAFTS, EDITS, and SUBMITS FOR VERIFICATION. It never purchases.
Create ZERO in-app-purchase products.
Zero entries in Play Console or App Store Connect.
When a draft needs a paid band, show "Complete on web" and issue the handoff code
into payer-web checkout.

Same rule as P10: nothing hardcoded. Everything drawn from GET /schema.

Offline: queue checkpoints locally with client-generated Idempotency-Keys and flush
them in seq order when the connection returns. Autosave every step.
Resume, never restart.

Same 409 conflict handling as the web app.

INVARIANT: the Flutter payer app contains no payment surface at all.
