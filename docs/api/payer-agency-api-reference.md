# BadaBhai Payer & Agency API — Mobile Integration Reference

> For Android engineers building the native Payer (Company) + Agency app. This document is derived from the verified backend source. Where the original extraction and the verification verdict differ, the **verified correction wins** and is called out inline.

> **Status / provenance (2026-06-29):** Generated from an adversarially-verified extraction of `apps/api` (7 of 8 areas were dedicated-verified against source). **§4.4 (Unlock/Reveal & Credits)** was reconstructed from adjacent verified areas (its dedicated verification pass is being re-run) — treat exact field names there as **provisional; confirm in staging before relying**. Source of truth is the code — regenerate this doc when endpoints change. Owner: Divyanshu (backend) + Prakash. Consumer: Rishi (Android/Flutter).

---

## 1. Overview & Environments

The Payer/Agency API is the NestJS backend (`apps/api`) that powers the self-serve Company (`employer`) and Agency (`agent`) portal (ADR-0019 / ADR-0022). Today it is consumed by the Next.js web portal (`apps/payer-web`); the Android app calls the **same** HTTP endpoints directly.

### Base URL

| Environment | Base URL | Notes |
| --- | --- | --- |
| Local dev | `http://localhost:3001` | Backend default. Configurable via the backend's `PAYER_API_URL` (default `http://localhost:3001`). |
| Staging | (deployment-specific host) | Use HTTPS. CORS allow-list applies to browser/WebView clients; native HTTP clients send no `Origin` and are unaffected. |
| Prod | (deployment-specific host) | HTTPS only. `JWT_SECRET` must be overridden (fail-closed at boot). |

Pointing the app at an environment: make the base URL a build-config/flavor value (e.g. `BuildConfig.API_BASE_URL`). Do not hardcode. All payer/agency routes are under the `/payer/*` prefix (plus agency `/payer/agency/*`). Do **not** call the ops-only surfaces `/job-postings`, `/reach`, or `/unlocks` (those are internal/ops, not payer-authed).

Health probe: `GET /health` → `200` when Postgres + Redis are up, `503` otherwise. Unauthenticated; safe for a connectivity check.

---

## 2. Authentication (Mobile) — READ THIS FIRST

This is the most important section for the Android build.

### 2.1 The login flow (non-browser client)

The payer login is a **passwordless email-code (OTP) flow**. There is no password.

```
1. POST /payer/signup        (new account)   ─┐
   POST /payer/login/request  (existing)      ─┴─►  { status: 'code_sent', resend_in_seconds }
                                                     (code is EMAILED, never in the response)

2. user reads the code from their email inbox

3. POST /payer/login/verify  { email, code } ──►  { access_token, token_type: 'Bearer',
                                                     expires_in_seconds, payer_id, role,
                                                     is_new_payer }
   ◄── STORE access_token securely

4. every authed call:  Authorization: Bearer <access_token>
```

The email code is **REAL-ONLY** (ZeptoMail/SMTP). There is no mock code returned to the client in any environment. The user must read it from their email.

### 2.2 How the token is obtained and sent — CRITICAL

> **BIG CALLOUT — the token comes ONLY from the response body, never a cookie or header.**
>
> - `POST /payer/login/verify` returns the JWT in the **response body** field `access_token`. The backend does **NOT** send `Set-Cookie`. (The web portal stores it in an httpOnly cookie `bb_payer_token` on the server side — that is a payer-web detail and does NOT apply to mobile.)
> - On every subsequent request, send `Authorization: Bearer <access_token>`. **This is the only auth mechanism. There are no cookies for mobile.**
> - The token is an HS256 JWT with claims `{ sub: payer_id, sid: session_id, typ: 'payer', role, exp }`. **Do not parse or validate it client-side** — the server validates it. Treat it as opaque.
> - Store it in **Android Keystore / EncryptedSharedPreferences**, never plaintext `SharedPreferences` and never in logs.
> - Session TTL default is **7 days** (`SESSION_TTL_DAYS`).

### 2.3 Refresh

`POST /payer/refresh` (auth: `Authorization: Bearer <token>`, empty body) → `{ access_token, token_type: 'Bearer', expires_in_seconds }`.

- Rolling refresh: past the half-life of the session TTL, a fresh JWT is returned in the **response body** `access_token`. **Use the body token.**
- The backend ALSO sets an `x-session-token` **response header** when rolling a token — this exists for browser clients. **Mobile must ignore `x-session-token` and always use the body `access_token`.**
- **There is NO `x-session-token` REQUEST header.** `PayerAuthGuard` reads **only** `Authorization: Bearer`. Do not attempt to send a refresh token in any header other than `Authorization`.
- Refresh proactively (past half-life), not reactively. A typical interceptor: on `401`, refresh once and retry; if refresh fails, drop to re-login.

### 2.4 Logout

`POST /payer/logout` (auth Bearer, empty body) → `204 No Content`. Revokes the Redis session record (best-effort). After logout, delete the stored token locally. Note: the JWT itself remains cryptographically valid until natural expiry, but the server-side Redis lookup will fail and the guard returns `401`.

### 2.5 Resolving session on app restart

`GET /payer/me` (auth Bearer) → the payer's own account. Use this on cold start to check the stored token is still valid and to read `role`/`status`. `Cache-Control: no-store` — do not cache.

### 2.6 BIG CALLOUT — is current payer auth cookie-only? NO (verified)

The web portal uses an httpOnly cookie, which can make it *look* cookie-only. **It is not.** The backend `POST /payer/login/verify` returns the token in the response **body**, and `PayerAuthGuard` accepts a plain `Authorization: Bearer` header (verified: `apps/api/src/payers/payer-auth.guard.ts` extracts only the `Authorization: Bearer` header). **Mobile is fully supported today with Bearer tokens — no backend change is required for the core auth flow.**

Caveats the Android dev must still honor:
- The backend does **not** read any `x-session-token` *request* header — there is no separate refresh-token grant. The refresh model is "call `/payer/refresh` with your current Bearer, get a new Bearer in the body." If a future spec assumes an `x-session-token` request header, that is a gap that does not exist in the backend today.
- There is **no** org-member (owner vs recruiter) auth model — see §5. Each payer account is a single principal.

### 2.7 `is_new_payer` — VERIFIED CORRECTION

> `POST /payer/login/verify` returns `is_new_payer` but **it is always hardcoded `false`** (verified: `apps/api/src/payer-portal/payer-auth.service.ts` returns `is_new_payer: false`). Do **not** use it to branch onboarding UI — it never signals newness. To detect a fresh account, rely on `GET /payer/me` `status` (`pending` vs `active`) or your own first-run state. Treat `is_new_payer` as unreliable/deprecated.

---

## 3. Conventions

### 3.1 Content-Type & headers

- Request bodies: `Content-Type: application/json`.
- Authed routes: `Authorization: Bearer <jwt>`.
- No other custom request headers are required. All tenancy/IDs ride in the JWT or in the path/body. **Never send `payer_id` in body or query** (XB-A: payer identity is session-derived; a client-supplied `payer_id` is ignored/rejected on payer-authed routes).

### 3.2 Error / response envelope

The global exceptions filter returns:

```json
{
  "statusCode": 400,
  "error": { "message": "string OR nested field object" },
  "requestId": "opaque-uuid",
  "path": "/payer/...",
  "timestamp": "ISO8601"
}
```

Stack traces are never leaked; `requestId` is for support correlation.

### 3.3 Status codes

| Code | Meaning | Mobile action |
| --- | --- | --- |
| 200 | Success (most GET/PATCH; auth verify/refresh) | — |
| 201 | Created (POST creates: postings, jobs, credits, capacity, invites) | — |
| 204 | No Content (logout) | clear token |
| 400 | Zod validation failure / bad lifecycle transition (e.g. closed job edit) | fix request; show field error from `error.message` |
| 401 | Missing/invalid/expired Bearer | refresh once, retry; else re-login |
| 403 | Rare on payer routes (mostly role mismatch on agent-only routes) | check role |
| 404 | Unknown **or** not-owned resource (no-oracle) | treat as generic "not found" |
| 429 | Rate limit exceeded (fail-closed) | back off; show neutral "try again later" |
| 500 | Server error | retry with backoff; surface `requestId` |

### 3.4 No-oracle / neutral responses (privacy by design)

- **404 is byte-identical** for "unknown resource" and "belongs to another payer." Do not try to distinguish; treat both as not-found.
- **Unlock / reveal / resume-disclosure** return HTTP `200` with a neutral body `{ status: 'unavailable' }` on **every** denial branch (no credits, capped, no consent, expired, not owned, …). You get the same body regardless of reason — surface a generic "Not available right now." Never infer the deny reason.
- **Auth**: signup and `login/request` return an identical `{ status: 'code_sent', resend_in_seconds }` for new/known/unknown emails (no account-enumeration). `login/verify` failure is one neutral `401` "Incorrect or expired code".
- **Agency referral summary** suppresses counts below a k-anonymity floor (`minBucket`, default 5) to `0` — a `0` means "below floor," not literally zero. Render as `<minBucket` (e.g. `<5`).

### 3.5 Pagination

- Most list endpoints return the **full set** (no offset/cursor), newest-first by `createdAt`.
- Some lists accept `?limit=` (clamped `1–500`, default `100`); responses are bare arrays with **no `totalCount`**. There is no way to page beyond the limit today.
- The applicant feed returns the **full pool** (sort-never-block) with **no pagination params** — design the UI to handle large lists (virtualize); escalate to backend if you need server paging.

### 3.6 Rate limits (all fail-closed; Redis down ⇒ reject)

| Scope | Default | Applies to |
| --- | --- | --- |
| Per-IP / hour (public auth) | `PAYER_AUTH_MAX_PER_IP_PER_HOUR` ≈ 20 | signup, login/request, login/verify |
| Per-payer disclosure / hour | `PAYER_DISCLOSURE_MAX_PER_HOUR` (default 30) | `POST /payer/unlocks` + reveal (shared cap) |
| Per-payer reach / hour | `PAYER_REACH_MAX_PER_HOUR` (default 60) | applicant feed reads |
| Per-payer invite-mint / hour | `AGENCY_INVITE_MINT_MAX_PER_HOUR` (default 60) | agency invite mint |
| Global OTP sends / day | `PAYER_OTP_GLOBAL_MAX_SENDS_PER_DAY` (default 2000; `0` = kill-switch) | total payer email sends |

Per-worker protection caps also gate unlocks server-side (`UNLOCK_MAX_REVEALS_PER_WORKER_PER_DAY` default 5, `UNLOCK_MAX_PAYERS_PER_WORKER_PER_WEEK` default 10, `UNLOCK_MAX_ATTEMPTS_PER_UNLOCK` default 3) — these surface to you only as a neutral `unavailable`. The per-payer disclosure cap is **shared** across unlock + reveal + resume-disclosure.

Client: exponential backoff on `429`; honor `resend_in_seconds` on the auth flow.

---

## 4. Endpoint Reference

Conventions: request fields use the casing the endpoint expects (auth/unlock/posting bodies are **snake_case**; responses are **camelCase** for posting/job views, **snake_case** for auth/unlock/capacity payloads — matched below). Auth column states the guard and role.

### 4.1 Auth / Identity

#### `POST /payer/signup`
- **Auth:** none (public, IP rate-limited).
- **Body:** `{ role: 'employer'|'agent', email: string (≤254), org_name: string (1–200), phone?: E.164 }`.
- **Response:** `{ status: 'code_sent', resend_in_seconds: number }` (identical for new/known/unknown — no enumeration).
- **Events:** `payer.created` (once, first signup); `payer.otp_send_cap_exceeded` (global daily breach only).
- **Mobile gotchas:** Code is emailed, never returned. `org_name`/`email`/`phone` are PII — sent in the request but never echoed/eventized. 429 = IP cap.

#### `POST /payer/login/request`
- **Auth:** none (public, IP rate-limited).
- **Body:** `{ email: string }`.
- **Response:** `{ status: 'code_sent', resend_in_seconds: number }`.
- **Events:** `payer.login_requested` (only if email matches an existing account; unknown → nothing emitted).
- **Mobile gotchas:** No enumeration — unknown emails get the identical timing/response. Code is emailed only.

#### `POST /payer/login/verify`
- **Auth:** none (public, IP rate-limited).
- **Body:** `{ email: string, code: string (4–8 digits) }`.
- **Response:** `{ access_token, token_type: 'Bearer', expires_in_seconds, payer_id (UUID), role: 'employer'|'agent', is_new_payer (always false) }`.
- **Events:** `payer.session_started`.
- **Mobile gotchas:** Token is in the **body**, not `Set-Cookie`. Failure = single neutral `401`. **`is_new_payer` is always `false` — do not branch on it** (verified correction). Single-use code (deleted on success).

#### `POST /payer/refresh`
- **Auth:** `PayerAuthGuard` (Bearer).
- **Body:** empty.
- **Response:** `{ access_token, token_type: 'Bearer', expires_in_seconds }`.
- **Events:** none.
- **Mobile gotchas:** Use the body `access_token`; ignore the `x-session-token` response header. New token carries the resolved role.

#### `POST /payer/logout`
- **Auth:** `PayerAuthGuard` (Bearer).
- **Body:** empty.
- **Response:** `204 No Content`.
- **Mobile gotchas:** Revokes Redis session (best-effort). Clear local token after.

#### `GET /payer/me`
- **Auth:** `PayerAuthGuard` (Bearer).
- **Response:** `{ id: UUID, role: 'employer'|'agent', status: 'pending'|'active'|'suspended', orgName: string, email: string, phoneLast4: string|null }`.
- **Events:** none.
- **Mobile gotchas:** Self-scoped only. Phone is masked to last 4 (`phoneLast4`); raw E.164 never returned. `Cache-Control: no-store` — do not cache.

#### `PATCH /payer/me`
- **Auth:** `PayerAuthGuard` (Bearer).
- **Body:** `{ orgName?: string (2–120 graphemes), phone?: E.164 }` — at least one field; `.strict()` rejects unknown keys and any `email`/`role`/`status`/`payer_id`.
- **Response:** same shape as `GET /payer/me`.
- **Events:** `payer.account_updated` (carries `changed_fields` = field **keys** only, never values).
- **Mobile gotchas:** `email`/`role`/`status` are immutable. Empty patch → `400`. `no-store`.

### 4.2 Job Postings (Company / Employer)

> Payer-owned postings live under `/payer/job-postings`. Ownership is enforced from the session; unknown-or-foreign IDs return a neutral `404`. The `/job-postings` (no `/payer`) routes are **OPS-ONLY, unauthenticated alpha** — do **not** call them from mobile (see appendix).

#### `POST /payer/job-postings`
- **Auth:** `PayerAuthGuard` (Bearer). Role: employer (primary); session-scoped.
- **Body:** `{ org_label: string, role_title: string (1–200), location_label?: string, description?: string (1–2000, PII-screened), vacancy_band?: '1'|'2-5'|'6-10'|'11-25'|'25+' | vacancies?: positive int }` — **exactly one** of `vacancy_band` / `vacancies`. No `payer_id`/`created_by` (session-stamped).
- **Response:** `{ id, payerId, createdBy, orgLabel, roleTitle, locationLabel, description, vacancyBand, status: 'draft', createdAt, updatedAt, closedAt: null }`.
- **Events:** `job_posting.created` (actor `payer`; payload keys only — `vacancy_band`, `status`, `has_location`, `has_description`).
- **Mobile gotchas:** Send `vacancies` as a **raw integer**; the backend derives the band. `org_label` is the session org (the web portal resolves it from `GET /payer/me`); never collect raw company PII. Free-through-launch — **no price/quota in the body**. `201`.

#### `GET /payer/job-postings`
- **Auth:** `PayerAuthGuard` (Bearer).
- **Query:** `status?: 'draft'|'open'|'closed'`.
- **Response:** array of posting rows (own only), newest-first, limit 100.
- **Mobile gotchas:** Rows include `orgLabel`/`description` at REST; do not display raw company labels you didn't collect — treat as faceless. No applicant count in this projection.

#### `GET /payer/job-postings/:id`
- **Auth:** `PayerAuthGuard` (Bearer).
- **Response:** posting row, or neutral `404` (unknown OR not-owned).

#### `PATCH /payer/job-postings/:id`
- **Auth:** `PayerAuthGuard` (Bearer).
- **Body:** `{ role_title?, location_label?, description?, vacancy_band? | vacancies?, status?: 'open' }` — at least one field; `status` may only be `'open'` (publish draft→open). No `org_label`/`payer_id`.
- **Response:** updated posting row.
- **Events:** `job_posting.updated` (changed-field **keys** only; publish surfaces as `status` in keys).
- **Mobile gotchas:** Lifecycle: `draft→open` publish only; `closed` is terminal (editing a closed posting → `400`/conflict). No-op edits rejected. Closing is a **separate** endpoint.

#### `POST /payer/job-postings/:id/close`
- **Auth:** `PayerAuthGuard` (Bearer).
- **Body:** empty.
- **Response:** posting row with `status: 'closed'`, `closedAt` set. `404` unknown/foreign; `409` already closed.
- **Events:** `job_posting.closed` (`previous_status`, `status: 'closed'`).
- **Mobile gotchas:** Terminal — no reopen.

### 4.3 Posting Plans, Boosts & Hiring Capacity

> **Capacity** is fully payer-authed and live. **Plans/Boosts** are **NOT mobile-ready** (unauthenticated, IDOR — see appendix).

#### `GET /payer/capacity`
- **Auth:** `PayerAuthGuard` (Bearer). `payer_id` from session.
- **Response:** `{ payer_id, max_active_vacancies: int, active_plan_count: int (REAL, from enforcement engine), source_tier: string|null, expires_at: ISO8601|null }`.
- **Mobile gotchas:** `active_plan_count` is the live count. Enforcement is **INERT by default** (`CAPACITY_ENFORCEMENT_ENABLED=false`) — over-cap does not pause anything in Phase 1. Use this endpoint as the source of truth for the capacity banner.

#### `POST /payer/capacity`
- **Auth:** `PayerAuthGuard` (Bearer). `payer_id` from session.
- **Body:** `{ tier: string (1–64), coupon?: string (1–64) }` — **no** `payer_id`, **no** price/amount (XT5: send the tier **code** only; server resolves price).
- **Response:** `{ payer_id, quote, max_active_vacancies, source_tier, expires_at, resumed_plan_ids: UUID[] }`.
- **Events:** `payment.authorized`, `payment.captured`, `capacity.purchased`, `posting_plan.resumed` (one per auto-resumed plan), `coupon.redeemed` (if coupon).
- **Mobile gotchas:** **MOCK payment** (`PAYMENTS_ENABLE_REAL=false`; `real_call:false`) — no real money in Phase 1. `quote` is informational; don't echo it as an authoritative charge. `resumed_plan_ids` tells you how many paused plans were auto-resumed. Atomic per-payer (advisory-locked); concurrent buys serialize — no special client retry needed. `201`.

#### Pricing (read-only, ops-intent, unauthenticated)
- `GET /pricing/catalog` → `{ catalog, revision, source: 'db'|'default' }`.
- `GET /pricing/quote?product=&tier=&coupon=&payer_id=` → **VERIFIED CORRECTION:** the failure shape is `{ ok: false, reason: 'unavailable' }` (an enum `reason`, **not** a free-form `error` string); success is `{ ok: true, quote }`. The `payer_id` query param is accepted but **unused** by the quote path (coupon caps are enforced at purchase, not preview).
- `PUT /pricing/catalog` is an ops-only write — not for mobile.
- **Mobile gotchas:** These have no auth guard (ops-intent). If you display pricing, prefer reading it as part of an authed purchase flow rather than depending on these public endpoints in-product.

### 4.4 Unlock / Reveal & Credits

> ✅ **VERIFIED 2026-06-29** against `apps/api/src/.../payer-unlocks.controller.ts` + `payer-disclosure.controller.ts` (the payer-self surface — `PayerAuthGuard`, `@CurrentPayer`, session `payer_id`; distinct from the ops `unlocks.controller.ts` which uses `InternalServiceGuard` + body `payer_id`). The only path to a worker's contact. Faceless: you get a **routed relay handle**, never a raw phone.

#### `GET /payer/credits`
- **Auth:** `PayerAuthGuard` (Bearer).
- **Response:** `{ payer_id, balance: number (≥0) }`.

#### `POST /payer/credits`
- **Auth:** `PayerAuthGuard` (Bearer).
- **Body:** `{ pack_code: string }` — code only; price/credits resolved server-side.
- **Response:** `{ payer_id, balance, credits, pack_code }`.
- **Events:** `payment.authorized`, `payment.captured`.
- **Mobile gotchas:** **MOCK money** (`real_call:false`). Unknown pack → `404`. `201`.

#### `GET /payer/unlocks`
- **Auth:** `PayerAuthGuard` (Bearer).
- **Query:** `?limit=` (clamped 1–500, default 100).
- **Response:** `{ unlocks: [{ unlock_id, payer_id, worker_id, job_id|null, status: 'granted'|'revealed'|'expired'|'revoked', reveal_count, granted_at, expires_at, created_at }] }`.
- **Mobile gotchas:** PII-free routing records only — opaque IDs, no names/phones.

#### `POST /payer/unlocks`
- **Auth:** `PayerAuthGuard` (Bearer). Per-payer hourly disclosure cap.
- **Body:** `{ worker_id: UUID, job_id: UUID|null }` — no `payer_id`.
- **Response:** SUCCESS `{ ok: true, unlock_id, status: 'granted', expires_at }` **OR** NEUTRAL `{ status: 'unavailable' }` (HTTP `200` in both cases).
- **Events:** on success `unlock.requested` + `unlock.granted` + `payment.authorized` + `payment.captured`; on deny `unlock.denied` (plus `unlock.cap_exceeded` if a per-worker cap is hit, or `payment.failed` if no credit). The deny **reason is internal-only**, never echoed in the response.
- **Mobile gotchas:** Spends 1 credit on grant. All denials (no credit / capped / no consent / protected) return the **same** neutral `unavailable` — never infer why. Fail-closed ordering (credit precondition → consent → cap → grant). Branch on the `ok` field, not the HTTP status.

#### `POST /payer/unlocks/:unlockId/reveal`
- **Auth:** `PayerAuthGuard` (Bearer). Shares the disclosure cap.
- **Body:** empty.
- **Response:** SUCCESS `{ relay_handle: string (opaque), channel: 'in_app_relay'|'proxy_number', expires_at }` **OR** NEUTRAL `{ status: 'unavailable' }` (HTTP `200`).
- **Events:** `contact.revealed` (payload carries `channel` **KIND only** — never the handle or phone); `unlock.cap_exceeded` if the per-unlock attempt cap (`UNLOCK_MAX_ATTEMPTS_PER_UNLOCK`, default 3) is hit.
- **Mobile gotchas:** **Never a raw phone** — `relay_handle` is an opaque routed in-app handle (`relay_<unlockId>_<uuid>`, ADR-0010 Stream A), not derived from the number. Ownership checked server-side; not-owned/expired/capped → neutral `unavailable`. Render the handle in the in-app relay UI; do not log it.

#### `POST /payer/resume-disclosures` (masked résumé — VERIFIED LIVE)
- **Auth:** `PayerAuthGuard` (Bearer). Shares the per-payer disclosure cap. **Free — no credit debit.**
- **Body:** `{ worker_id: UUID, job_posting_id: UUID|null }` — no `payer_id`.
- **Response:** SUCCESS `{ ok: true, disclosure_id: UUID, status: 'disclosed', resume_url: string (short-TTL signed), expires_at }` **OR** NEUTRAL `{ status: 'unavailable' }` (HTTP `200`).
- **Events:** `resume.disclosed` (fact only — payload never includes the PDF bytes, the worker's name, or the signed URL).
- **Mobile gotchas:** The worker's real name is decrypted server-side at render-time, masked to **initials** in the PDF, then discarded — you only ever get a signed `resume_url` to a masked PDF. **Render the URL short-lived; never log it.** payer-web currently still mocks this; the backend is live (safe to integrate, verify in staging).

#### `GET /payer/resume-disclosures` (VERIFIED LIVE)
- **Auth:** `PayerAuthGuard` (Bearer).
- **Response:** `{ disclosures: [{ disclosure_id, worker_id, posting_id|null, status, expires_at, … }] }` — PII-free projection (no `resume_url`, no name, no deny reason).

### 4.5 Applicant Feed (Faceless Reach)

#### `GET /payer/reach/jobs/:jobId/applicants`
- **Auth:** `PayerAuthGuard` (Bearer). Per-payer hourly reach cap (default 60). `jobId` must be a job the session payer owns.
- **Request:** path `jobId` (UUID); no query/body; **no pagination**.
- **Response:**
  ```
  { jobId, applicants: [ {
      workerId,            // opaque UUID
      rank,                // 1-based, deterministic
      score,               // 0..1 relevance (LLM never decides)
      hot,                 // boolean high-signal flag
      pushEligible,        // boolean, response-only
      components: [ { signal, raw, weight, reason } ],
      experienceBand,      // '<1 yr'|'1-2 yrs'|'3-5 yrs'|'6-10 yrs'|'10+ yrs' | null
      tradeLabel,          // canonical label e.g. 'VMC Operator' | null
      cityLabel            // coarse slug e.g. 'pune' | null
  } ] }
  ```
- **Events:** `feed.shown` (one per rendered applicant, actor `payer`, batch all-or-nothing; payload `worker_id`/`job_id`/`rank`/`score`/`hot` — PII-free).
- **Mobile gotchas:**
  - **FREE — no credit debit.** Spending happens only on unlock/reveal.
  - Full pool returned (sort-never-block), no limit/offset — virtualize the list.
  - Faceless: opaque `workerId` + banded chips only — **never** display/expect names/phones/employers.
  - Neutral `404` for unknown-or-not-owned job. `429` on reach cap. `5xx` → retry with backoff.
  - Safe to cache client-side briefly (≤1h, information-only), but ranks/scores may shift — don't serve stale long.

### 4.6 Agency (role `agent` only)

> All `/payer/agency/*` routes require `PayerAuthGuard` **+ `PayerRoleGuard` role=`agent`**. A non-agent gets `403` (or no-oracle `404`). `payer_id` is session-derived; never in body. Responses are faceless camelCase views with **no `payer_id`**.

#### `POST /payer/agency/jobs`
- **Body:** `{ trade_key: enum, title: string (1–200, no PII), city: string (1–120), area?: string (1–120), pay_min?: int (0–10M), pay_max?: int (0–10M, ≥pay_min), min_experience_years?: int (0–60), max_experience_years?: int (0–60, ≥min_exp), needed_by?: 'immediate'|'soon'|'flexible' }`.
- **Response:** `AgencyJobView { id, status: 'open', tradeKey, title, city, area, payMin, payMax, minExperienceYears, maxExperienceYears, neededBy, applicantsReceived, createdAt, updatedAt }`.
- **Events:** `job.created` (PII-free: opaque IDs + coarse bands).
- **Mobile gotchas:** Starts `open` (no draft). Pay is whole INR (no paise). `201`.

#### `GET /payer/agency/jobs`
- **Response:** `AgencyJobView[]`, newest-first. No pagination.

#### `GET /payer/agency/jobs/:jobId`
- **Response:** `AgencyJobView`, or neutral `404` (unknown/not-owned).

#### `PATCH /payer/agency/jobs/:jobId`
- **Body:** any subset of the create fields (≥1 required). Ordering re-validated against the **result** row (handles one-sided edits).
- **Response:** updated `AgencyJobView`.
- **Events:** `job.updated` (`changed_fields` = keys only).
- **Mobile gotchas:** Editing a **closed** job → `400` (terminal). Status is not edited here (use close/pause).

#### `POST /payer/agency/jobs/:jobId/close`
- **Body:** empty. **Response:** `AgencyJobView` `status: 'closed'`. `400` if already closed; neutral `404` unknown/not-owned.
- **Events:** `job.closed`. Terminal — no reopen.

#### `POST /payer/agency/jobs/:jobId/pause`
- **Body:** empty. **Response:** `AgencyJobView` `status: 'closed'`.
- **Events:** `job.updated` (`changed_fields: ['status']` — a serving-state toggle, distinct from terminal close).
- **Mobile gotchas:** **Phase-1 reality: pause == close** (the schema has only `open|closed`; there is no `paused` state and **no resume**). The reach feed stops serving a closed job. Do not build a resume affordance against this endpoint.

#### `POST /payer/agency/invites`
- **Body:** `{ campaign?: string (1–64, non-PII tag) }` — **no** phone/name/email/worker-id (faceless).
- **Response:** `{ agency_invite_id: UUID, code: string (opaque, ~12 hex), link: '/i/<code>' }`.
- **Events:** `agency_invite.created` (channel `whatsapp`, optional campaign).
- **Mobile gotchas:** Per-payer hourly mint cap; `429` on cap OR Redis fail-closed (neutral, no reason). The agency shares the `link` manually — **there is no real WhatsApp send** (mock provider; `MESSAGING_ENABLE_REAL=false`). `201`.

#### `GET /payer/agency/referrals/summary`
- **Response:** `{ created: int, clicked: int, accepted: int, minBucket: int }`.
- **Mobile gotchas:** Aggregate-only, no per-invitee rows. Any count `0` may mean "below `minBucket`" — render as `<minBucket` (default `<5`). Worker attribution is **not yet wired** (see appendix), so `accepted` will stay low/zero in Phase 1.

#### `POST /payer/agency/invites/:code/click` — **NOT a primary mobile call (STUB)**
- **Auth:** agency-scoped stub. **Response:** **VERIFIED CORRECTION:** `{ ok: true }` always (even for unknown code — no-oracle), **not** `{ code, status, clicked_at }`.
- **Mobile gotchas:** Local funnel metric only; does not attribute a worker. The real invitee click is the public `POST /invites/:code/click` (worker funnel), not this. You generally do not need to call this from the agency app.

---

## 5. Role Model

| Concept | Value | Meaning |
| --- | --- | --- |
| Account role | `employer` | Company / direct hirer. Uses `/payer/job-postings/*`, capacity, unlocks, reach, credits. |
| Account role | `agent` | Agency. Uses everything an employer can, **plus** `/payer/agency/*` (agency jobs, invites, referrals). |

- The role is set at account creation (`signup` `role`) and is carried in the JWT and returned by `login/verify` + `GET /payer/me`. Use it for UI gating, but **the backend enforces it** (`PayerRoleGuard` + `@PayerRoles('agent')` on `/payer/agency/*`). Do not rely on client-side role checks for security.
- **Owner vs recruiter (org-member roles): DOES NOT EXIST.** There is **no** team/multi-user surface. Each payer account is a **single principal** — one login = one account. Multi-user org RBAC (owner/recruiter) is a Phase-2+ feature with **no API today** (stubbed in payer-web only). Build the app as single-user-per-account; do not surface team management.

Which surface each role can call:

| Endpoint group | `employer` | `agent` |
| --- | --- | --- |
| Auth / `/payer/me` / credits / capacity | ✅ | ✅ |
| `/payer/job-postings/*` | ✅ | ✅ (dual-role; not role-gated) |
| `/payer/unlocks/*`, `/payer/reach/*`, `/payer/resume-disclosures` | ✅ | ✅ |
| `/payer/agency/*` (jobs, invites, referrals) | ❌ `403`/`404` | ✅ |

---

## 6. PII / Faceless Rules the App MUST Honor (Invariant #2)

- **All worker references are opaque UUIDs** (`workerId`). Never expect, request, display, or log a worker's name, phone, address, employer, or ID-doc data — they are not in any response by construction.
- **Applicant feed is faceless**: only `workerId` + ranking signals + **coarse banded** fields (`experienceBand`, `tradeLabel`, `cityLabel`) and label-only `reason` strings. No free-text PII.
- **Contact reveal returns a routed relay handle only** (`relay_handle` + `channel`), **never a raw phone**. Render it inside the in-app relay; do not log it. Resume-disclosure (when wired) carries masked initials only.
- **The payer's own contact is masked**: `GET /payer/me` returns `phoneLast4` (last 4 digits) — never raw E.164. This is the payer's own data, returned only to themselves, never eventized.
- **Never send `payer_id`** in body/query — session is the identity (XB-A).
- **Never send price/amount/credits/quota** — send only the `tier` / `pack_code` code; the server resolves money from config.
- **Secure logging**: log only opaque IDs, HTTP status, timestamps, and `requestId`. Never log tokens, names, phones, relay handles, signed URLs, or amounts.
- **Events are PII-free and keys-only** on updates (`changed_fields` carries field names, not values) — you never need to (and must not) reconstruct PII from them.

---

## 7. Appendix — Endpoints NOT Yet Mobile-Ready

Stub or back these out behind a feature flag; do not ship them as working flows.

| Endpoint / feature | Status | Why / what's needed |
| --- | --- | --- |
| `POST /job-postings/:id/plan` (buy plan tier) | **NOT READY — IDOR / auth-gap** | Unauthenticated; trusts body `payer_id` (no guard). Any caller can buy for any payer. Mobile must wait for a payer-authed `POST /payer/job-postings/:id/plan`. Also mock-payment only. |
| `POST /job-postings/:id/boost` (buy boost) | **NOT READY — IDOR / auth-gap** | Same as plan: unauthenticated, body `payer_id` trusted. Needs a payer-authed route. Mock-payment only. |
| `POST /payers/:payerId/capacity` (ops capacity buy) | **NOT FOR MOBILE** | Guarded by `InternalServiceGuard` (shared secret); `:payerId` is **advisory** (no per-payer auth). Use the payer-authed `POST /payer/capacity` instead. |
| `POST /payer/resume-disclosures` + `GET /payer/resume-disclosures` (masked resume) | **BACKEND LIVE, FRONTEND MOCK** | The payer-authed endpoint exists (returns `{ ok, disclosure_id, status:'disclosed', resume_url (signed), expires_at }` or neutral `unavailable`; free, no credit). But payer-web still mocks it. Safe to integrate against the live backend; verify in staging first. Render the signed `resume_url` short-lived; never log it. |
| Posting **pause / resume / quota top-up** (company postings) | **NOT READY — no backend** | Web portal `pausePosting`/`resumePosting`/`topUpPostingQuota` are **mock-store only**. The `job_postings` schema has **no `paused` state** and **no quota column**. Stub in the app until backend wires `POST /payer/job-postings/:id/pause` + resume + quota. |
| Posting **plans/boosts for payers** (payer-authed) | **MISSING ENDPOINT** | No payer-authed plan/boost purchase route exists; only the IDOR ops routes above. Buyers are blocked until built. |
| Credit **history / top-up ledger** | **PARTIAL — balance live, history synthesized** | `GET /payer/credits` (balance) and `GET /payer/unlocks` (spends) are live; there is **no** credit-ledger/top-up-history endpoint. Build history from those two; do not expect a server ledger. |
| Per-posting **applicant quota** field | **MOCK-ONLY** | Live posting rows have no `applicantQuota`; it's config-sourced. Do not display a per-posting quota for live rows. |
| **Org-member / team management** (owner vs recruiter) | **MISSING — Phase 2+** | No `/payer/org/members` API. Single principal per account. Do not build team UI. |
| Worker **attribution** to agency invite | **STUB — no caller** | `attributeWorkerToInvite()` exists server-side (consent-gated) but is **not wired** to onboarding; `agency_invite.accepted` does not fire yet. Referral `accepted` counts stay ~0. |
| Real **WhatsApp invite send** | **MOCK** | `MESSAGING_ENABLE_REAL=false`. Agency copies the `link` manually; no platform send. |
| Real **payments** (credits/capacity/any purchase) | **MOCK** | `PAYMENTS_ENABLE_REAL=false` (fail-closed). All money flows are mock ledgers in Phase 1; `real_call:false`. Do not integrate a real payment SDK. |
| Agency **payouts / commissions / KYC** | **PARKED (legal-gated)** | No endpoints; type-only shells. Phase-2, behind legal/§7 human gates. |
| Production **identity provider** (`supabase` login) | **INERT** | `PAYER_LOGIN_METHOD` supports `supabase` but it's inert without keys. Email-OTP is the live method. WhatsApp OTP is mock. |
| Ops surfaces: `/job-postings/*`, `/reach/jobs/:jobId/applicants`, `/unlocks/*`, `PUT /pricing/catalog` | **OPS-ONLY / unauthenticated** | Not payer-authed; do **not** call from mobile. Use the `/payer/*` equivalents. |
| `POST /payer/agency/invites/:code/click` | **STUB** | Returns `{ ok: true }` always; local funnel only, no worker attribution. Generally not needed from the app. |

---

### Quick auth recap for the impatient

1. `POST /payer/signup` or `POST /payer/login/request` → user gets emailed a code.
2. `POST /payer/login/verify { email, code }` → store **body** `access_token` (Keystore).
3. Send `Authorization: Bearer <token>` on every call. **No cookies. Ignore `x-session-token`.**
4. On `401`: `POST /payer/refresh` (Bearer) once → new **body** token → retry; else re-login.
5. `POST /payer/logout` → `204`, then wipe the local token.
6. `is_new_payer` is always `false` — don't trust it.
