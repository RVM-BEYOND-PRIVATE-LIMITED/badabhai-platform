# ADR-0020: WhatsApp invite funnel + worker re-engagement (provider-and-consent-first)

- **Status:** **ACCEPTED for the MOCK build (2026-06-18) — REAL SENDS are a SEPARATE human gate.**
  The provider seam, the consent-to-message gate, the funnel + re-engagement flows, and the
  PII-free events are **built on a MOCK provider** (`MESSAGING_ENABLE_REAL=false` default). **No
  real WhatsApp message is sent and no message-provider spend occurs** without a recorded human
  sign-off (CLAUDE.md §7) — exactly like `AI_ENABLE_REAL_CALLS` / `PAYMENTS_ENABLE_REAL`.
  **Phase-2 — NOT alpha-gate.**
- **Date:** 2026-06-18
- **Author:** system-architect + product-manager + **security-engineer (MANDATORY — messaging PII
  + a new DPDP consent basis)**; backend-engineer builds.
- **Builds on / reconciles:**
  - **CLAUDE.md invariant #2** (raw PII only in `workers`; never in events/logs) and **#6**
    (consent gate, fail-closed). A WhatsApp send means a worker's **phone leaves to a third
    party (Meta)** — the widest new PII egress since OTP SMS.
  - The **SMS/OTP provider pattern** (`SmsProvider` token + config-selected impl;
    `console` mock vs `fast2sms` real, gated by `assertAuthConfig`) — **Q1's "provider pattern"**.
    This ADR mirrors it for WhatsApp.
  - The **consent model** (`worker_consents` append-only; latest-row + `revokedAt`; `ConsentGuard`
    fail-closed; `CONSENT_PURPOSES` incl. the precedent `employer_sharing` purpose-specific gate).
  - The **deferred agency-referral attribution** (Phase-2 payouts) — invite/referral attribution
    here is the **upstream** signal that feeds it; kept PII-free (ids/hashes) so the two compose.

---

## Context

Growth needs two messaging flows: **(a) invite funnel** — a worker shares an invite/referral
deep-link (over WhatsApp) that attributes a new signup back to them; **(b) re-engagement** —
nudging a dormant, consented worker back into the app. Both are **messaging to a phone via a new
external provider**, which makes this **provider-and-consent-first**: the phone egress and the
lawful basis must be decided before a line of funnel code, or we risk an un-consented message or a
phone in a log/event.

---

## Decision

### Decision 1 — Provider: WhatsApp Business API behind a mock-default seam
- A single **`WhatsAppProvider`** seam (DI token + interface), config-selected like `SmsProvider`:
  **`MockWhatsAppProvider` is the default**; a real **Meta WhatsApp Cloud API** impl sits behind
  **`MESSAGING_ENABLE_REAL=false`** (master gate) + `WHATSAPP_*` keys.
- **The provider is the ONLY place a raw phone is used** — read at send time, handed to the
  provider, **never logged, never put in an event** (the `SmsProvider` rule, verbatim). Mock logs
  only a phone-**hash** prefix + status.
- **Real send = HARD human gate (spend + a new third party gets PII):** real keys (staging-first,
  never committed) + a webhook for delivery receipts are escalation-only (CLAUDE.md §7). A
  boot-time `assertMessagingConfig` fails closed if `MESSAGING_ENABLE_REAL=true` without keys.
- **Cost/PII note (ratify):** Meta charges per conversation (utility/marketing templates) and
  requires pre-approved templates + explicit opt-in — both reinforce Decision 2.

### Decision 2 — Consent-to-message: a NEW, explicit DPDP purpose `whatsapp_messaging`
- The existing `communication` purpose is **transactional** (OTP); a marketing/re-engagement
  WhatsApp message to a third-party channel is a **distinct, higher-sensitivity disclosure** that
  DPDP + WhatsApp's own opt-in rules require an **explicit** basis for. So this ADR adds a new
  `CONSENT_PURPOSES` value: **`whatsapp_messaging`** (additive; auto-flows to `consentPurposesSchema`).
- **Fail-closed gate (like invariant #6 / the `employer_sharing` + corpus gates):** a worker is
  messaged **only if** their **latest** `worker_consents` row carries `whatsapp_messaging` **and**
  `revoked_at IS NULL`. Missing / revoked / purpose-absent / any resolution error → **no send**
  (recorded as `messaging.suppressed{reason}`, PII-free). One chokepoint
  (`MessagingConsentService`); no second send path may bypass it.
- **Revocation propagates:** a revoked `whatsapp_messaging` consent immediately stops future sends.
- **Production DPDP/WhatsApp opt-in copy is a launch gate** (human/legal, CLAUDE.md §8).

### Decision 3 — Attribution: PII-free invite/referral deep-links
- An **invite** is an opaque `invites` row: `code` (the deep-link token), `inviter_worker_id`,
  `channel`, `status`, and — on signup — `invited_worker_id`. **No phone, no name** — worker ids
  are opaque UUIDs; the table is RLS+REVOKE-locked like the spine.
- The deep-link is `…/i/<code>`; **the code is the only thing shared**, and click/accept
  attribution is keyed on it. This is the **upstream** signal for the deferred agency-referral
  payout attribution — kept ids/hashes-only so that decision can consume it without a PII bridge.
- **Anti-abuse (ratify):** self-invite and duplicate-attribution are rejected; per-inviter invite
  caps; the per-worker consent gate still bounds any message the funnel triggers.

---

## Events (PII-free, v1, additive — version never mutate)
New domains `invite` + `messaging`, subject `invite`. **ids/enums/hashes ONLY — never a phone,
name, message body, or provider message-id-bearing PII.**

| event | domain | subject | payload (v1) |
|---|---|---|---|
| `invite.created` | invite | invite | `{ invite_id, inviter_worker_id, channel, campaign? }` |
| `invite.clicked` | invite | invite | `{ invite_id, channel }` |
| `invite.accepted` | invite | invite | `{ invite_id, inviter_worker_id, invited_worker_id }` |
| `messaging.requested` | messaging | worker | `{ message_id, worker_id, template, channel, real_call:false }` |
| `messaging.sent` | messaging | worker | `{ message_id, worker_id, template, channel, real_call }` |
| `messaging.suppressed` | messaging | worker | `{ worker_id, template, reason:enum(no_consent\|unknown_worker) }` |
| `messaging.failed` | messaging | worker | `{ message_id, worker_id, template, reason:enum, real_call }` |

The message body / template variables / phone **never** appear; only the template **id** + ids.

---

## EXPLICITLY OUT — hard boundary
- **No real WhatsApp send / no provider spend** without the human gate (Decision 1; §7). Mock default.
- **No message without `whatsapp_messaging` consent** (fail-closed; Decision 2). `communication`
  consent does NOT authorize a WhatsApp marketing/re-engagement send.
- **No phone / name / message body in any event or log** (invariant #2). Phone touches the
  provider only, at send time.
- **No bulk blast** that bypasses the per-worker consent gate; each send is consent-checked.
- **No agency-referral payout logic** here — only the PII-free attribution signal it will consume.
- **No production DPDP/WhatsApp opt-in copy authored here** (launch gate).
- **No mutation of a shipped payload/column** — additive only (invariant 8).

---

## Phased plan
| Phase | Scope | Gate |
|---|---|---|
| **0 — this ADR** | provider/consent/attribution decisions | — |
| **1 — MOCK build (this PR)** | `whatsapp_messaging` consent + `MessagingConsentService` (fail-closed) + `WhatsAppProvider` seam (mock default) + invite funnel + re-engagement + PII-free events + tests | ADR accepted for mock |
| **2 — launch hardening** | production DPDP/WhatsApp opt-in copy + per-worker rate caps + delivery-receipt webhook design | human/legal |
| **3 — REAL sends (HUMAN-GATED)** | Meta Cloud API keys (staging-first), template approval, spend guardrails behind `MESSAGING_ENABLE_REAL` | **HARD human gate (§7)** |

---

## STOP — before REAL sends
The mock build is authorized. **Real WhatsApp keys/spend, template approval, and production opt-in
copy require recorded human sign-off** (Decision 1 / Phase 3). Do not flip `MESSAGING_ENABLE_REAL`
without it.

## Related
- CLAUDE.md §2 (invariants 2, 6, 8) · §7 (escalation) · §8 (deferred: real providers, prod DPDP copy)
- `apps/api/src/sms/*` (the provider pattern this mirrors; Q1) · `apps/api/src/consent/*` + `ConsentGuard`
- `packages/types` `CONSENT_PURPOSES` (the new `whatsapp_messaging` purpose) · `packages/validators` `consentPurposesSchema`
- Deferred agency-referral payouts (the attribution consumer) · `packages/event-schema` (the event contract extended)
