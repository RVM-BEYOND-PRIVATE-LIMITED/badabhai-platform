# Legal — Later

Structural placeholder, not production legal copy. Tracks what DPDP-facing legal
content is still owed before launch — the actual copy is a Product + Security
decision, not something engineering should draft.

## What exists today

Consent is captured **structurally**: `worker_consents` is an append-only DPDP
consent ledger (`ADR-0010`), `employer_sharing` consent is tracked separately from
profiling consent, and revocation is modeled via `revoked_at`. The mechanism is
built and enforced. What's missing is the **content** — the actual consent-screen
copy, privacy-policy text, and terms a worker/payer reads before consenting.

## What's owed before launch (R4, `docs/registers/risks-register.md`)

- Final DPDP-compliant consent-screen copy (worker + payer flows)
- Privacy policy text
- Terms of service text
- Legal review/sign-off on all of the above

## Status

Open — launch gate. This file exists so the citing docs (`README.md`,
`.claude/agents/system-architect.md`) point at something real instead of a
dead reference; it does not close R4.
