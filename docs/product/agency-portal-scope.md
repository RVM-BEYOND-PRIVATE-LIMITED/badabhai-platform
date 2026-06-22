# Agency portal — scope (product)

> Scope of record for the agency slice in `apps/payer-web`. The agency is an existing
> **payer with `role='agent'`** (ADR-0019) reusing payer auth and the SHARED DEMAND loop.
> This doc states what is built now, what is parked, and the legal/money gates. It does
> NOT change any legal or product decision.

## Build-now slice (DEMAND only)

An agency gets a read-only, faceless **demand desk** — "Post roles and manage demand like
a payer account" — identical to the company DEMAND loop, only labelled for an agency:

- **Agency dashboard** (`/agency/dashboard`): identity card (role "Agency", the agency's
  own org label, account status), faceless reach summary (LIVE credit balance + unlocked
  count), demand job summary (vacancy counts, preview), a vacancy management table
  (preview), a consent-first **disabled** invite explainer, and disabled parked-module
  cards.
- **Faceless:** "BadaBhai protects worker privacy. Agencies see only consent-safe progress
  and aggregate signals." The agency never sees a worker name/phone/raw resume.
- **Consent-first invite:** "Share this link with workers. They must self-onboard and
  accept consent before BadaBhai processes their data." No link is generated, no phone/name
  is accepted, no success is faked (there is no agency invite API today).

### LIVE vs MOCK vs disabled (honest)

- **LIVE:** identity (`GET /payer/me`), credit balance (`GET /payer/credits`), unlocked
  count (`GET /payer/unlocks`).
- **MOCK (preview-labelled):** vacancy summary + vacancy management table — no payer-authed
  job-postings endpoint exists yet.
- **Disabled — coming soon:** the invite control (no agency invite API).
- **Honest blanks:** reached / eligible / consented / invite-intent counts render `—` with
  a "not available yet" affordance — never fabricated.

## Parked modules (informational, disabled — built nothing)

| Module                      | Treatment            | Gate                                             |
| --------------------------- | -------------------- | ------------------------------------------------ |
| KYC                         | Parked card          | legal/DPDP sign-off required                     |
| Payouts                     | Parked card          | real payments + product-ratified params required |
| Bulk Invite Upload          | "Not available" card | consent violation (DEAD)                         |
| Matching / Outcome Tracking | Deferred card        | product lock                                     |

Each is gated on a public flag (default OFF). Flipping a flag on only re-labels the card;
it ships no flow. The dashboard NEVER promises a commercial term (no ₹500 / 25% / 90d / any
payout math).

## Legal / money gates (HARD LOCKS — building any is STOP+escalate)

- **KYC** — a new high-sensitivity (financial) PII surface; DPDP
  consent/purpose/retention plus a legal review are prerequisites.
- **Payouts / real payments** — real money out; TD34 real payments + product-ratified
  attribution params (window/share/floor) + a human authorization (CLAUDE.md §7).
- **Bulk raw-phone/CSV upload** — DEAD: it would process workers without their own consent
  (CLAUDE.md §2 #6).
- **Matching / ranking / Reach-Engine UI** and **hire-outcome stages** — deferred by
  product lock; jobs are OPEN/CLOSED/PAUSED/DRAFT only.

## Open escalations (to other owners)

- **Backend:** payer-authed `GET/POST /payer/job-postings`, lifecycle
  (pause/resume/close), and applicant-quota top-up; a payer-authed masked-resume
  disclosure. Until these land, the postings surface stays MOCK.
- **Backend / Product:** an agency-callable invite API (today `POST /invites` is
  WORKER-authed). Until then the agency invite control stays DISABLED.
- **Backend:** faceless aggregate counts for reached / eligible / consented (so those cards
  can move from `—` to a LIVE count).
- **Security / Legal:** KYC, payouts, and any financial-PII surface — see
  [phase-2-agency-referral-payouts.md](../sprint-plans/phase-2-agency-referral-payouts.md).

## Cross-links

- [docs/frontend/agency-portal.md](../frontend/agency-portal.md) — frontend reference.
- [docs/sprint-plans/phase-2-agency-referral-payouts.md](../sprint-plans/phase-2-agency-referral-payouts.md)
  — parked SUPPLY (referrals/payouts/KYC) spec.
- ADR-0019 (payer auth + agency-as-payer), CLAUDE.md §2 (#2 PII, #6 consent) + §8 (deferred).
