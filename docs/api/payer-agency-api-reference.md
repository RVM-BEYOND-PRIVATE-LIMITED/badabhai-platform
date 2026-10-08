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

When a route throws a structured body, the filter puts that **whole body** under `error` — nothing is lifted to the top level. A purchase `409` (#2111) therefore reads its machine-readable reason at `error.reason`, never at `reason`:

```json
{
  "statusCode": 409,
  "error": { "statusCode": 409, "error": "Conflict", "message": "…", "reason": "in_flight" },
  "requestId": "opaque-uuid",
  "path": "/payer/job-postings/…/quota-topup",
  "timestamp": "ISO8601"
}
```

Purchase `409` reasons: `price_mismatch` (#2085), `in_flight` and `no_active_plan` (#2111) — see [Purchase idempotency](#purchase-idempotency-idempotency-key) and [Price confirmation](#price-confirmation-expected_price_inr). Branch on `error.reason`; `error.message` is advice copy for humans. Do not reword the in-flight copy (`already being processed`) while payer-web builds that predate `reason` support are live — they tell the two quota top-up 409s apart by that text.

### 3.3 Status codes

| Code | Meaning | Mobile action |
| --- | --- | --- |
| 200 | Success (most GET/PATCH; auth verify/refresh) | — |
| 201 | Created (POST creates: postings, jobs, credits, capacity, invites) | — |
| 204 | No Content (logout) | clear token |
| 400 | Zod validation failure / bad lifecycle transition (e.g. closed job edit) | fix request; show field error from `error.message` |
| 401 | Missing/invalid/expired Bearer | refresh once, retry; else re-login |
| 403 | Role mismatch: an employer on an agent-only `/payer/agency/*` route, or an agent on a company-posting write (`/payer/job-postings` writes, chat publish — #1885). Body: `error.message` = `"Payer role is not permitted for this resource"` | check role; route agents to `/payer/agency/jobs` |
| 403 | Org tenancy refused (ADR-0053 R3–R7; only with `PAYER_ORG_TENANCY_MODE=on`, which production refuses until P3): the caller's organization could not be resolved — e.g. in two teams, the org or its owner suspended, a role mismatch, or (ops routes) a `payer_id` that names no payer. Body: `error.message` = `"Not permitted for this organization"`, no reason given. On the plan / boost / quota-top-up routes and `GET`/`POST /payer/capacity` it is returned before any plan, boost or capacity row is read or written, and nothing is charged (on `POST /payer/capacity` a sent `Idempotency-Key` is reserved first, so a retry replays the `403`) | contact support; not retryable |
| 404 | Unknown **or** not-owned resource (no-oracle) | treat as generic "not found" |
| 409 | Conflict. On a purchase route the body carries `error.reason` (§3.2): `price_mismatch`, `in_flight`, `no_active_plan` (quota top-up). Other 409s (lifecycle, an active boost) carry no `reason` | branch on `error.reason`; no reason → generic conflict |
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
- The applicant feed returns **every worker who applied** (agency job: all of them, ranked; company posting: capped server-side) with **no pagination params** — virtualize long lists; escalate to backend if you need server paging.

### 3.6 Rate limits (all fail-closed; Redis down ⇒ reject)

| Scope | Default | Applies to |
| --- | --- | --- |
| Per-IP / hour (public auth) | `PAYER_AUTH_MAX_PER_IP_PER_HOUR` ≈ 20 | signup, login/request, login/verify |
| Per-payer disclosure / hour | `PAYER_DISCLOSURE_MAX_PER_HOUR` (default 30) | `POST /payer/unlocks` + reveal (shared cap) |
| Per-payer reach / hour | `PAYER_REACH_MAX_PER_HOUR` (default 60) | applicant feed reads + `GET /payer/reach/applicants` pages (one shared bucket) |
| Per-payer invite-mint / hour | `AGENCY_INVITE_MINT_MAX_PER_HOUR` (default 60) | agency invite mint |
| Per-payer applicant-stage writes / hour | `PAYER_APPLICANT_STAGE_MAX_PER_HOUR` (default 600) | `PUT /payer/reach/jobs/:jobId/applicants/:workerId/stage` (its own bucket — never the reach read budget) |
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
- **Response:** `{ id: UUID, role: 'employer'|'agent', status: 'pending'|'active'|'suspended', orgName: string, email: string, phoneLast4: string|null, orgId: UUID|null, orgRole: 'owner'|'recruiter'|null }`.
- **Org role (#2079, additive):** `orgId`/`orgRole` are the caller's CURRENT active org membership, read from `payer_members` on every call (never from the token). `null` = no active membership → treat as least privilege (`recruiter`). This is the authoritative read for UI owner affordances; the server enforces owner-only routes itself.
- **Events:** none.
- **Mobile gotchas:** Self-scoped only. Phone is masked to last 4 (`phoneLast4`); raw E.164 never returned. `Cache-Control: no-store` — do not cache.

#### `PATCH /payer/me`
- **Auth:** `PayerAuthGuard` (Bearer).
- **Body:** `{ orgName?: string (2–120 graphemes), phone?: E.164 }` — at least one field; `.strict()` rejects unknown keys and any `email`/`role`/`status`/`payer_id`.
- **Response:** same shape as `GET /payer/me`.
- **Events:** `payer.account_updated` (carries `changed_fields` = field **keys** only, never values).
- **Mobile gotchas:** `email`/`role`/`status` are immutable. Empty patch → `400`. `no-store`.

### 4.2 Job Postings (Company / Employer)

> Payer-owned postings live under `/payer/job-postings`. Ownership is enforced from the session; unknown-or-foreign IDs return a neutral `404`.
>
> **Employer-only writes (#1885, owner ruling 2026-10-01).** Agencies post agency jobs to `/payer/agency/jobs` (§4.6), never company postings. Every WRITE here — `POST /payer/job-postings`, `PATCH /payer/job-postings/:id` (edit + publish), `POST …/:id/close`, `…/pause`, `…/resume`, `…/plan`, `…/boost`, `…/quota-topup` — and the AI chat `POST /payer/job-posting-chat/sessions/:id/publish` require `PayerRoleGuard` role=`employer`. An `agent` session gets `403` with the same body an employer gets on an agent-only route (`"Payer role is not permitted for this resource"`); the role check runs before validation and ownership, so the refusal is the same for any posting id. The READS (`GET /payer/job-postings`, `GET /payer/job-postings/:id`) stay open to both roles: a `job_postings` row an agent account created before the ruling is **read-only** for it (list/detail, and applicants via `/payer/reach`), and every write on it is refused. No rows were changed. The `/job-postings` (no `/payer`) routes are **OPS-ONLY, unauthenticated alpha** — do **not** call them from mobile (see appendix).

#### `POST /payer/job-postings`
- **Auth:** `PayerAuthGuard` + `PayerRoleGuard` role=`employer` (Bearer); session-scoped. Agent → `403`.
- **Body:** `{ org_label: string, role_title: string (1–200, screened), location_label?: string, description?: string (1–2000, screened), vacancy_band?: '1'|'2-5'|'6-10'|'11-25'|'25+' | vacancies?: positive int, city?: string (1–80, screened as a place), area?: string (1–120, screened as a place), pay_min?: int, pay_max?: int, pay_type?: 'in_hand'|'gross'|'ctc', min_experience_years?: int, max_experience_years?: int, shift?: 'day'|'night'|'rotational', needed_by?: 'immediate'|'soon'|'flexible', benefits?: string[] (≤12 × ≤80 chars, screened), requirements?: string[] (same caps), role_kind?: RoleKind, match_skill_ids?: 'mskill_*'[], unticked_related_ids?: 'mskill_*'[] }` — **exactly one** of `vacancy_band` / `vacancies`. No `payer_id`/`created_by` (session-stamped).
- **Response:** the full posting row — **snake_case on the wire** (`JobPostingApi`), including `city`, `area`, `pay_min`, `pay_max`, `pay_type`, `min_experience_years`, `max_experience_years`, `shift`, `needed_by`, `benefits`, `requirements`, `role_kind`, `match_skill_ids`, `reach_skill_ids`, `unticked_related_ids`, `status: 'draft'`, `created_at`, `updated_at`, `closed_at: null`. (This line used to list camelCase keys; the API has always returned snake_case here.)
- **Events:** `job_posting.created` (actor `payer`; payload — `vacancy_band`, `status`, `has_location`, `has_description`, and `role_kind` (the closed enum value, or `null`) — never free text).
- **Atomic create (#1928).** The posting row and its `job_posting.created` commit in one transaction. If the event cannot be written, the request fails (`5xx`) and **no posting exists**, so a retry cannot leave a duplicate behind. The AI chat publish (`POST /payer/job-posting-chat/sessions/:id/publish`) uses the same create. When that create fails, the conversation goes back to its live status, and publishing it again creates exactly one posting.
- **Mobile gotchas:** Send `vacancies` as a **raw integer**; the backend derives the band. `org_label` is the session org (the web portal resolves it from `GET /payer/me`); never collect raw company PII. Free-through-launch — **no price/quota in the body**. `201`.
- **#1645 (2026-09-22) — the create used to accept only the first six keys and answer `201` anyway.** Everything else was stripped silently by Zod. Because `match_skill_ids` was among the dropped fields the row's reach set stayed empty, publish skipped materialization, `job_reach` got no rows, and **the posting reached no worker at all** while the company saw a success state. The payer app worked around it with an immediate follow-up `PATCH`; **that workaround can now be deleted.**
- **Worker-visible free-text screen (#1823 B3).** Workers see `role_title` as the card title and `description` verbatim, on the feed, search and job detail. So both run the agency job's write-time screen: phone/email, legal-entity company name, and link. The `benefits` / `requirements` chips already ran it. This applies on `POST`, on `PATCH` (both `/payer/job-postings` and the ops `/job-postings`) and on the chat publish. A hit is a `400` that names the field and never echoes the value. The messages are the agency job's: `remove contact details from the title` / `title must not contain a company name` / `title must not contain links`, and the same three with `description`.
  - The screen runs at write time only. A row stored before it keeps its text until an edit resends the field, and that edit is screened. A client that always resends `role_title` (payer-web's edit form does) gets a `400` until the title is fixed.
  - **The AI job-posting chat runs the same screen on every turn (#1911, #1921), not only at publish.** A refused `role_title` or `description` is dropped from the draft, and so is each refused `benefits` / `requirements` chip. The field is re-asked in that turn's `reply_text`. The reply names the field and the reason (contact details, a company name, website links) and never quotes the text. On that turn `asked_question_id` is the field (`role_title` / `benefits` / `requirements` / `description`), `draft_ready` is `false`, and a `draft_ready` session goes back to `active`. When the field is asked from the start, `suggested_replies` is the question bank's benefits options on a `benefits` re-ask and `[]` on the other three. Publish keeps its screen, so a draft stored before #1911 / #1921 can still `400` there until the payer's next message re-asks it.
    - If the field held a clean value before that turn, the value is kept rather than dropped. This is the usual case for the description: after the wrap-up, any later message is taken as a new description. The reply then says the earlier value is still in the draft, and that replying `no` keeps it. Any other answer replaces it.
    - A chip list loses only its refused chips; the clean ones stay in the draft. When some are left, the reply says the rest are still in the draft and asks for any others: `no` keeps the list as it is, and any other answer is added to it. `suggested_replies` is then the benefits options the list does not already hold, followed by `No` (just `["No"]` for requirements). Tapping `No` keeps the list. A typed "no more" or "that's it" is not read as no and is added as a chip. When none are left, the field is listed in `missing_fields` again and asked from the start.
    - A list re-asked at the wrap-up takes the one answer that follows. The wrap-up after it gives later messages back to the description. Limit: if the interview wrapped up on its ask ceiling before the description was ever asked, later messages still go to the topic asked last, and that can be a list.
    - A client must take `draft_ready: false` as sent on a non-blocked turn. payer-app latches readiness, so it keeps Publish enabled on a re-ask (#1920). payer-web reads it fresh on every turn.
  - Not a hit (#1914): a `co-` compound (`and co-ordinate`, `& co-workers`, `and co operative`, `co.ordinator`) is not a company name, and the degrees `B.Com` / `M.Com` are not links. `Sharma & Co` / `Sharma and Co.` / `Sharma Co.-Pune`, the co-operative names `Cosmos Co.op. Bank` / `Shanti Co. Operative Housing Society`, and any other host (`acme.com`, `x.in`) still are. One dotted co-op form is a place, not a firm (#1970): a co-operative industrial estate (`Gokul Shirgaon Co. Op. Industrial Estate`, `Co.op Indl. Estate`). Every other co-op tail (bank, society, dairy, store) and an estate written with a suffix (`… Estate Ltd`) are still refused. The price: a `& Co` / `and Co` firm glued to any dash (`Sharma & Co-Pune`, `Sharma & Co—Pune`) or followed across a space by a listed compound word — worker(s), operation / operative / operate, op, curricular, ordinat…, `2 weld` / `2 gas` (`Sharma & Co workers chahiye`) — passes, and so do the bare hosts `b.com` / `m.com`, with or without a path, port or query. The same helpers back the companion career-answer `named_employer` gate, the skill certifier's org and link walls and the general-form brief's organisation and link walls, so the narrowing applies there too.
  - A seven-digit run in the title, such as a dated job code, is now a `400`. The agency title has always behaved this way. This reverses ADR-0012 §(c) for `role_title`; see that ADR's 2026-10-01 addendum.
  - `org_label` and `location_label` stay unscreened. They are the company's own name and site label, and no worker read selects them.
  - **`city` and `area` run the same screen as places (#1848).** Both reach the worker card and job detail verbatim. They are screened on `POST`, `PATCH` and the chat publish here, and on the agency job routes (§4.6). Messages: `remove contact details from the city` / `city must not contain a company name` / `city must not contain links`, and the same three with `area`. One difference from the text fields: a pincode beside a sector, phase or plot number (`Sector 63 201301`, `MIDC Phase 2 411026`) is **not** refused as a phone number. The phone/email check is waived only when the value contains no `@`, has fewer than ten digits in total, contains a six-digit pincode standing alone between spaces, commas or the value's ends, and still passes the phone/email check once the pincode is removed. A 10-digit mobile, an 11-digit landline and an email are still refused, pincode or not. The company-name and link checks are unchanged. A co-operative industrial estate passes in any spelling, dotted (`Co. Op. Industrial Estate`, since #1970) or hyphenated (`Co-op` / `Co-operative`). A dotted housing society (`Shanti Co. Operative Housing Society`) is still refused as a company name; the owner ruled estates only.
  - Write-side only, like the other fields. A stored `city` / `area` is re-screened only when a write resends it. payer-web's edit form resends both, so a stored value the screen refuses must be corrected before that form can save. payer-web's own client-side check does not yet apply the pincode waiver, so the pincode forms above still fail in the form until it does.
  - The chat's per-turn screen does not cover `city`, so a refused `city` in a chat draft is first reported at publish (`400`, path `city`).
- `pay_type` (#1648) states what the ₹ band MEANS. **Omit it rather than guess** — `NULL` renders the band with no pay-type pill, and there is no server-side default.
- `unticked_related_ids` is now **persisted on the draft** (migration 0121), so unticks chosen on the create form survive to publish. `reach_skill_ids` remains server-resolved and is never accepted from a client (Policy 10).
- **`role_kind` (migration 0131, 2026-09-29) — the posting's ROLE.** `RoleKind` is exactly one of the 21 declared worker-side roles:
  `'cnc_turner'|'vmc_milling'|'cnc_grinding'|'cam_programmer'|'cad_draughtsman'|'conventional_machinist'|'tool_die_maker'|'welder'|'sheet_metal_worker'|'press_operator'|'painter_coating'|'fitter'|'maintenance_technician'|'industrial_electrician'|'assembly_line_worker'|'quality_inspector'|'injection_moulding_operator'|'mould_die_maker'|'blow_moulding_operator'|'rubber_moulding_operator'|'plastic_process_technician'`
  (`TRADE_FORM_KINDS_ALL` in `@badabhai/types`; display labels in `JOB_ROLE_LABELS` / `jobRoleLabel()`).
  - **Display / classification only** (ADR-0036 addendum 2026-09-29): it is **never a match input** — sending `role_kind` without `match_skill_ids` still reaches nobody — and, since the owner ruling of 2026-10-05 ([ADR-0024 addendum](../decisions/0024-worker-visible-job-fields-pii.md)), it reaches the worker card **as a role illustration only** (`/feed` and job detail; not `/jobs/search`), never as text.
  - Optional, **no default**: omitted stores `null` ("no role picked"). A chat-published posting always has `role_kind: null`.
  - **Errors:** anything outside the 21 (a trade key such as `cnc_operator`, a display label such as `"Welder"`, free text) → `400`; an explicit `role_kind: null` → `400` (unset with `clear`, see PATCH).
  - **Deploy note:** an API older than migration 0131 strips this key silently (Zod), so clients must not ship a role picker ahead of the API.

#### `GET /payer/job-postings`
- **Auth:** `PayerAuthGuard` (Bearer). Any role. Scoped to the caller's own rows; for an agent those all predate #1885 and are read-only.
- **Query:** `status?: 'draft'|'open'|'closed'`.
- **Response:** array of posting rows (own only), newest-first, limit 100.
- **Mobile gotchas:** Rows include `orgLabel`/`description` at REST; do not display raw company labels you didn't collect — treat as faceless. No applicant count in this projection.

#### `GET /payer/job-postings/:id`
- **Auth:** `PayerAuthGuard` (Bearer). Any role.
- **Response:** posting row, or neutral `404` (unknown OR not-owned).

#### `PATCH /payer/job-postings/:id`
- **Auth:** `PayerAuthGuard` + `PayerRoleGuard` role=`employer` (Bearer). Agent → `403`.
- **Body:** every field `POST` accepts (see above), all optional, plus `status?: 'open'` — at least one field; `status` may only be `'open'` (publish draft→open). No `org_label`/`payer_id`.
- **Response:** updated posting row.
- **Events:** `job_posting.updated` (changed-field **keys** only; publish surfaces as `status` in keys). Keys added 2026-09-22: `area`, `experience` (ONE key for both ends of the window, as `pay_band` is one key for `pay_min`+`pay_max`), `pay_type`, `benefits`, `requirements`. Key added 2026-09-29: `role_kind` (its own key — a role change is never reported as `match_skills`). Additive enum widening — every shipped payload still validates, no version bump.
- **Ordering is re-checked against the STORED row**, so a one-sided edit (`pay_max` alone) that would invert the band or the experience window is a `400`.
- **#1652 (2026-09-22) — `clear: [...]` unsets a field.** The contract used to be value-or-absent, so a payer could overwrite a wrong pay band or shift but never REMOVE it, and the stale wage stayed on the worker card. Send `{ "clear": ["pay_min", "shift"] }` to store NULL. Clearable: `location_label`, `description`, `city`, `area`, `pay_min`, `pay_max`, `pay_type`, `min_experience_years`, `max_experience_years`, `shift`, `needed_by`, `benefits`, `requirements`, `role_kind` (0131).
  - **`role_kind` edits:** `{ "role_kind": "welder" }` sets it (`changed_fields: ["role_kind"]`); `{ "clear": ["role_kind"] }` stores `null`; re-sending the stored value, or clearing an already-null role, is no change (`400 no effective changes` if nothing else changed); an unknown value or `null` is a `400`.
  - **A field that is both set and cleared is a `400`**, naming the field — not a precedence rule. Resolving it silently would mean one of the two things you asked for did not happen.
  - **Clearing one end of a band is legal** (`clear: ["pay_min"]` keeps `pay_max`). The ordering re-check runs against the RESULT, so it does not compare against the value you are erasing.
  - **`clear: ["benefits"]` stores NULL, `benefits: []` stores an empty list.** Different values: "never stated" vs "stated: none". The client renders them differently.
  - Clearing a field that is already NULL is not a change; if nothing else changed you get the usual `400 no effective changes`.
  - `org_label` / `role_title` / `vacancy_band` / `status` and the skill sets are **not clearable** — the closed set is what keeps `clear` away from a NOT NULL column or the server-resolved reach set.
- **Mobile gotchas:** Lifecycle: `draft→open` publish only; `closed` is terminal (editing a closed posting → `400`/conflict). No-op edits rejected. Closing is a **separate** endpoint.

#### `POST /payer/job-postings/:id/close`
- **Auth:** `PayerAuthGuard` + `PayerRoleGuard` role=`employer` (Bearer). Agent → `403`.
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
- **Org tenancy (PAY-DB-01 P2c, inert while `PAYER_ORG_TENANCY_MODE=off`):** with the mode `on`, the allowance and `active_plan_count` are the **org's** (one allowance per team, its plans counted whichever member bought them); `payer_id` still echoes the caller. Shapes unchanged. A caller whose org cannot be resolved gets the neutral `403` `"Not permitted for this organization"` (§3.2 table) on both capacity routes, before any capacity read or charge.

#### `POST /payer/capacity`
- **Auth:** `PayerAuthGuard` (Bearer). `payer_id` from session.
- **Headers:** `Idempotency-Key?: string` (#1148) — see [Purchase idempotency](#purchase-idempotency-idempotency-key).
- **Body:** `{ tier: string (1–64), coupon?: string (1–64), expected_price_inr?: int (0–10,000,000) }` — **no** `payer_id`, **no** price/amount (XT5: send the tier **code** only; server resolves price). `expected_price_inr` (#2085) is a guard, never charged — see [Price confirmation](#price-confirmation-expected_price_inr).
- **Response:** `{ payer_id, quote, max_active_vacancies, source_tier, expires_at, resumed_plan_ids: UUID[] }`.
- **Events:** `payment.authorized`, `payment.captured`, `capacity.purchased`, `posting_plan.resumed` (one per auto-resumed plan), `coupon.redeemed` (if coupon).
- **Errors:** `400` unknown tier · `409 in_flight` — same key still in flight (`"This capacity purchase is already being processed; check your capacity before trying again"`) · `409 price_mismatch`. The reason is `error.reason` (§3.2).
- **Mobile gotchas:** **MOCK payment** (`PAYMENTS_ENABLE_REAL=false`; `real_call:false`) — no real money in Phase 1. `quote` is informational; don't echo it as an authoritative charge. `resumed_plan_ids` tells you how many paused plans were auto-resumed. Atomic per-payer (advisory-locked); concurrent buys serialize. `201`.

#### `POST /payer/job-postings/:id/plan` · `POST /payer/job-postings/:id/boost`
- **Auth:** `PayerAuthGuard` + `PayerRoleGuard` role=`employer`. Ownership first: unknown/foreign posting → neutral `404` (checked **before** any idempotency reservation).
- **Headers:** `Idempotency-Key?: string` (#2103) — the same seam, scope rules, window and replay semantics as `POST /payer/capacity` / `…/quota-topup`; scopes `plan_purchase` and `boost_purchase` (separate — one key on plan and boost is two purchases). See [Purchase idempotency](#purchase-idempotency-idempotency-key).
- **Body:** plan `{ tier: 'standard'|'pro', coupon?, expected_price_inr? }` · boost `{ tier: 'boost_7'|'boost_15'|'boost_30'|'all_candidates', coupon?, expected_price_inr? }`.
- **Errors:** `400` unknown tier · `409 price_mismatch` (#2085) — refused before the plan/boost row or any payment event · boost: `409` an active boost already exists (no `reason`) · `409 in_flight` (#2111) — same key still in flight (`"This plan purchase is already being processed; check the posting before trying again"` / `"This boost purchase is already being processed; …"`). The reason is `error.reason` (§3.2).
- A replay under the same key emits no event and charges nothing.
- **Org tenancy (PAY-DB-01 P2c, inert while `PAYER_ORG_TENANCY_MODE=off`):** with the mode `on`, a teammate may buy a plan / boost / quota top-up on any of the org's postings; the receipt is the org's (`payerId` = the org owner's id), counted against the org's capacity, and a coupon's per-payer limit is per org. Ownership is checked and the purchase made in one tenant resolution. Same routes, bodies and error model (`in_flight` / `no_active_plan` / `price_mismatch`), plus the neutral `403` `"Not permitted for this organization"` (§3.2 table) when the caller's org cannot be resolved — returned before ownership, the idempotency reservation or any charge. The ops `POST /job-postings/:id/plan` and `/boost` (`InternalServiceGuard`) resolve their body `payer_id` the same way: in `on`, an id that names no payer, or one the resolver refuses, gets that `403` and nothing is written.

#### `POST /payer/job-postings/:id/quota-topup`
- **Auth:** `PayerAuthGuard` + `PayerRoleGuard` role=`employer`. Ownership first: unknown/foreign posting → neutral `404` (checked **before** any idempotency reservation).
- **Headers:** `Idempotency-Key?: string` (#2085) — the same seam, scope rules, window and replay semantics as `POST /payer/capacity`; scope `quota_topup_purchase`. See [Purchase idempotency](#purchase-idempotency-idempotency-key).
- **Body:** `{ tier: string (1–64, e.g. 'topup_10'), coupon?: string (1–64), expected_price_inr?: int (0–10,000,000) }`. No `payer_id`.
- **Response:** `{ plan, quote }` — `plan.quotaTopupCount` is the running top-up total.
- **Events:** `payment.authorized`, `payment.captured`, `posting_plan.quota_topped`, `coupon.redeemed` (if coupon). Unchanged by #2085; a replay emits nothing.
- **Errors:** `400` unknown tier · three `409`s, told apart by `error.reason` (§3.2; #2111):
  - `no_active_plan` — the posting has no active, unexpired plan of yours to top up (`"no active plan to top up for this posting"`). Nothing charged. Buy a plan first. Stored under the key and replayed like any outcome.
  - `in_flight` — the same `Idempotency-Key` is still running (`"This quota top-up is already being processed; check the posting before trying again"`). Outcome unknown: re-read `GET /payer/job-postings/:id`, never re-post.
  - `price_mismatch` — see [Price confirmation](#price-confirmation-expected_price_inr).

  The messages are unchanged from before #2111; `reason` is additive. A client on a pre-#2111 API sees no `reason` and must keep its message fallback until it drops support for that build.
- `201`. **MOCK payment** (`real_call:false`).

#### Purchase idempotency (`Idempotency-Key`)
Routes: `POST /payer/credits`, `POST /payer/capacity`, `POST /payer/job-postings/:id/plan`, `…/boost`, `…/quota-topup`.
- **Optional.** No header (or a blank one) → the request runs exactly as before; nothing is reserved.
- Mint **one key per confirmed purchase** and reuse it only for retries of that purchase. A new purchase (a renewal, a second top-up) needs a new key.
- Keys are scoped per route **and** per session payer, and honoured for **180 s**.
- **Same key, first attempt finished** → the stored outcome is replayed: the same `201` body, or the same error status **and the same error body** (#2103). The work does not run again, so nothing is charged twice and no event is emitted twice.
- **Same key, first attempt still running** → `409` with `error.reason: "in_flight"` (#2111, on all five routes) and the route's in-flight message (unchanged). Re-read state (`GET /payer/capacity`, `GET /payer/job-postings/:id`, `GET /payer/credits`) rather than resubmitting. This `409` is never stored, so it is never replayed.
- **Same key, different body** → **not** compared: the first purchase's outcome is replayed. The key names the intent; a client that changes the body under one key has a bug.
- **Replayed error body (#2103):** identical to the first response's `error` object — every field, e.g. a replayed `409 price_mismatch` still carries `reason`, `expected_price_inr`, `current_price_inr`. Only the envelope's `requestId`/`path`/`timestamp` differ (they describe the retry). Outcomes stored by a pre-#2103 build (at most 180 s around the deploy) replay as `{ message }` only.
- If Redis is unavailable the request runs undeduplicated (fail open at this one step; all money paths stay fail-closed).

#### Price confirmation (`expected_price_inr`)
Routes: `POST /payer/job-postings/:id/plan`, `…/boost`, `…/quota-topup`, `POST /payer/capacity`, `POST /payer/credits`, `POST /payer/credits/order` (#2085).
- **Optional** integer, whole rupees, `0–10,000,000`. A non-integer, negative or string value is a `400`. Absent → behaviour unchanged.
- It is compared to the **final** price the purchase would be charged at that moment — after the active offer and any valid `coupon`. It is never used as the charge.
- Mismatch → `409`, **nothing charged**: no entitlement row, no ledger row, no provider order, no `payment.*` event. The wire body (the global filter nests the thrown body under `error` — §3.2; read `error.reason`, `error.current_price_inr`):
  ```json
  {
    "statusCode": 409,
    "error": {
      "statusCode": 409,
      "error": "Conflict",
      "reason": "price_mismatch",
      "message": "The price changed: you confirmed ₹1000 but the current price is ₹750. Nothing was charged; re-read the price and confirm again",
      "expected_price_inr": 1000,
      "current_price_inr": 750
    },
    "requestId": "opaque-uuid",
    "path": "/payer/job-postings/…/quota-topup",
    "timestamp": "ISO8601"
  }
  ```
  Re-read `GET /payer/pricing/catalog`, show the new price, and ask the payer to confirm again (with a **new** `Idempotency-Key`; the old key replays this `409`).
- Send the `price_inr` from `GET /payer/pricing/catalog` for that tier. With a coupon, the catalog price is pre-coupon, so expect a `409` unless you send the post-coupon amount.

#### `GET /payer/pricing/catalog`
- **Auth:** `PayerAuthGuard` (Bearer).
- **Response:** `{ revision: int, source: 'db'|'default', products: Product[], prices: PayerTierPrice[], priced_at: ISO8601 }`. `products` is unchanged since D-6. `prices` + `priced_at` are additive (#2085):
  `PayerTierPrice = { product_code, tier_code, base_price_inr: int, price_inr: int, discount_inr: int, offer: { code: string, ends_at: ISO8601 } | null }`.
- `price_inr` is what a purchase of that tier is charged at `priced_at` without a coupon. It is computed by the same function the purchase routes charge through, so shown == charged. `offer` is the automatic ops offer applied, or `null`. Coupons and `floorPriceInr` never ship.
- Credit packs (`contact_unlock`) are charged at list price and take no offer, so their `offer` is always `null`.
- An offer can expire after `priced_at`; `expected_price_inr` catches that.
- **Events:** none (read-only).

#### Pricing (read-only, ops-intent, unauthenticated)
- `GET /pricing/catalog` → `{ catalog, revision, source: 'db'|'default' }`.
- `GET /pricing/quote?product=&tier=&coupon=&payer_id=` → **VERIFIED CORRECTION:** the failure shape is `{ ok: false, reason: 'unavailable' }` (an enum `reason`, **not** a free-form `error` string); success is `{ ok: true, quote }`. The `payer_id` query param is accepted but **unused** by the quote path (coupon caps are enforced at purchase, not preview).
- `PUT /pricing/catalog` is an ops-only write — not for mobile.
- **Mobile gotchas:** These have no auth guard (ops-intent). If you display pricing, prefer reading it as part of an authed purchase flow rather than depending on these public endpoints in-product.

### 4.4 Unlock / Reveal & Credits

> ✅ **VERIFIED 2026-06-29** against `apps/api/src/.../payer-unlocks.controller.ts` + `payer-disclosure.controller.ts` (the payer-self surface — `PayerAuthGuard`, `@CurrentPayer`, session `payer_id`; distinct from the ops `unlocks.controller.ts` which uses `InternalServiceGuard` + body `payer_id`). The only path to a worker's contact. Faceless: you get a **routed relay handle**, never a raw phone.

#### `GET /payer/credits`
- **Auth:** `PayerAuthGuard` (Bearer) only — any authenticated payer, any `org_role` (owner ruling 2026-10-07). The balance is the **caller's own** `payer_id` wallet; there is no org-shared wallet until org tenancy (`PAY-DB-01`) lands.
- **Response:** `{ payer_id, balance: number (≥0) }`.

#### `POST /payer/credits`
- **Auth:** `PayerAuthGuard` (Bearer) only — **any authenticated payer may buy credits**, whatever their `org_role` (`owner` or `recruiter`) and with or without an active org membership (owner ruling 2026-10-07; matches ADR-0027 D3). The same applies to `POST /payer/credits/order` and `POST /payer/credits/verify` (real-payments routes). This reverses the owner-only gate #2098 added for #2079 (removed by #2109): there is no org-role `403` on any credit route.
- **Headers:** `Idempotency-Key?: string` (#1046) — see [Purchase idempotency](#purchase-idempotency-idempotency-key).
- **Body:** `{ pack_code: string, expected_price_inr?: int }` — code only; price/credits resolved server-side. `expected_price_inr` (#2085): mismatch → `409 price_mismatch`, no ledger row, no credits (see [Price confirmation](#price-confirmation-expected_price_inr)). `POST /payer/credits/order` accepts the same optional field; a mismatch creates no provider order and no `payment_orders` row.
- **Response:** `{ payer_id, balance, credits, pack_code }`.
- **Events:** `payment.authorized`, `payment.captured`.
- **Mobile gotchas:** **MOCK money** (`real_call:false`). Unknown pack → `404`. `201`.

#### `GET /payer/unlocks`
- **Auth:** `PayerAuthGuard` (Bearer).
- **Query:** none (corrected 2026-10-06 — the route never read a `limit`). Newest first, capped at 500 rows.
- **Response:** `{ unlocks: [{ unlock_id, payer_id, worker_id|null, job_id|null, job_posting_id|null, status: 'granted'|'revealed'|'expired'|'revoked', reveal_count, granted_at, expires_at, created_at }] }`.
- **Status (#2033):** only payer-visible rows are listed — internal attempt/deny rows never are. `expired` is **derived**: a `granted`/`revealed` row whose `expires_at` is at or before the server's now reads `expired`. `revoked` is in the contract but nothing emits it today.
- **Context (#2033):** `job_id` is an agency `jobs` id; `job_posting_id` (additive, migration 0132) is the owned company posting the unlock was made from. At most one is set; both are `null` for search, the ops route, and rows written before 0132.
- **Mobile gotchas:** PII-free routing records only — opaque IDs, no names/phones. `worker_id` is `null` after a worker's DSAR deletion.

#### `POST /payer/unlocks`
- **Auth:** `PayerAuthGuard` (Bearer). Per-payer hourly disclosure cap.
- **Body:** `{ worker_id: UUID, job_id: UUID|null }` — no `payer_id`. `job_id` is optional context and must be `null` or a job / posting the **session payer owns** (#1899): an owned `jobs` id (agency vacancy) is stored; an owned company posting's id is accepted, stored as `job_id: null` (#1903) and kept as `job_posting_id` (#2033, migration 0132; row-only — no event carries it). An unknown or another payer's id gets the neutral `200 { status: 'unavailable' }` body — byte-identical to every other deny — with nothing emitted, debited or written. A malformed id is a `400` (syntax only).
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
- **Body:** `{ worker_id: UUID, job_posting_id: UUID|null }` — no `payer_id`. `job_posting_id` is the context the résumé was opened from and must be `null` or a posting / job the **session payer owns** (#1899): an owned company posting is stored; an owned agency `jobs` id (from the agency applicants page) is accepted and **stored as `null`** (#1898, the #1903 approach) — the disclosure still succeeds and `GET` lists it with `posting_id: null`. An unknown or another payer's id gets the neutral body — byte-identical to every other deny — with nothing written or emitted. A malformed id is a `400` (syntax only).
- **Response:** SUCCESS `{ ok: true, disclosure_id: UUID, status: 'disclosed', resume_url: string (short-TTL signed), expires_at }` **OR** NEUTRAL `{ status: 'unavailable' }` (HTTP `200`).
- **Events:** `resume.disclosed` (fact only — payload never includes the PDF bytes, the worker's name, or the signed URL).
- **Mobile gotchas:** The worker's real name is decrypted server-side at render-time, masked to **initials** in the PDF, then discarded — you only ever get a signed `resume_url` to a masked PDF. **Render the URL short-lived; never log it.** payer-web currently still mocks this; the backend is live (safe to integrate, verify in staging).

#### `GET /payer/resume-disclosures` (VERIFIED LIVE)
- **Auth:** `PayerAuthGuard` (Bearer).
- **Response:** `{ disclosures: [{ disclosure_id, worker_id, posting_id|null, status, expires_at, … }] }` — PII-free projection (no `resume_url`, no name, no deny reason).

### 4.5 Applicant Feed (Faceless Reach)

#### `GET /payer/reach/jobs/:jobId/applicants`
- **Auth:** `PayerAuthGuard` (Bearer). Per-payer hourly reach cap (default 60), checked before any read. `jobId` must be a `jobs` row or a `job_postings` row the session payer owns.
- **Request:** path `jobId` (UUID); no query/body; **no pagination**.
- **Source selection** (`PayerApplicantsService.listForOwned`, #1823/#1898; first owner-scoped hit wins; **independent of `MATCH_V1_ENABLED`**):
  1. An owned agency/seed `jobs` row → **only the workers who applied to it** (`applications.job_id` = that job, `action = 'applied'`), ordered by the deterministic reach ranking (the legacy shape below). A worker who skipped or never decided is never listed; a job nobody applied to returns `200` with `applicants: []`. (#1898 — before it, this returned the whole ranked worker pool, and with `MATCH_V1_ENABLED` on it 404'd.)
  2. Otherwise an owned company posting → that posting's **actual applicants** (the V1 shape). Not gated by `FEED_POSTINGS_UNION_ENABLED`, so disarming the worker-feed union never hides people who already applied. Applications without a rank snapshot sort last.
  3. Otherwise → neutral `404` in the §3.2 envelope with `error.message = "Job not found"`. The `error` object is identical for an unknown id, another payer's job and another payer's posting (no existence oracle); only the per-request `path`, `requestId` and `timestamp` differ.
- **Membership:** neither list ever includes a worker inside the account-deletion grace window (ADR-0031 ruling (b)); a cancelled deletion puts him back.
- **`stage` (owner ruling 2026-10-07 — behind `PAYER_APPLICANT_STAGES_ENABLED`, default off):** while the flag is on, **every row in both shapes below also carries `stage: 'new' | 'shortlist' | 'passed'`**, appended as the row's last key — the applicant's place on the payer's saved New / Shortlist / Passed board for this posting (`new` when nobody has moved him). Every other key and value is unchanged, and the board never filters or reorders the list: a `passed` applicant is still listed, labelled `passed`; which tab shows him is the client's call. While the flag is off **no row carries `stage`** — treat its absence as "the server does not persist stages" and keep the local board. Set it with `PUT …/applicants/:workerId/stage` below.
- **Response (agency `jobs` row — its appliers):**
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
- **Response (company posting — its applicants):**
  ```
  { jobId, applicants: [ {
      workerId, applicationId, rank,
      matchTier, effectiveTier,            // number | null (null when no rank snapshot)
      skillMonths, industryMonths,         // number | null
      lastWorkedAt, matchedSkillLabel, engineVersion   // string | null
  } ] }
  ```
- **Events:** agency `jobs` list only: `feed.shown` (one per rendered applier — none for an empty list, actor `payer`, batch all-or-nothing; payload `worker_id`/`job_id`/`rank`/`score`/`hot` — PII-free). The posting list emits nothing (people who already applied are not a feed impression), so a posting-list read is rate-limited (Redis, hourly) but **not durably audited**.
- **Errors:** `404` as above. `429` on the reach cap. A DB failure is a `5xx`, never folded into the `404`.
- **Mobile gotchas:**
  - **FREE — no credit debit.** Spending happens only on unlock/reveal.
  - Agency `jobs` list: every applier, ranked, no limit/offset — virtualize long lists. Posting list: actual applicants, capped server-side. Neither list ever contains a worker who did not apply.
  - Branch on the row shape (`score` vs `applicationId`), never on the id — both lists share the route.
  - Faceless: opaque `workerId` + banded chips only — **never** display/expect names/phones/employers.
  - Neutral `404` for unknown-or-not-owned job. `429` on reach cap. `5xx` → retry with backoff.
  - Safe to cache client-side briefly (≤1h, information-only), but ranks/scores may shift — don't serve stale long.

#### `GET /payer/reach/applicants` — every applicant across the payer's own postings (Candidates tab)
- **Auth:** `PayerAuthGuard` (Bearer), either role. The **same** per-payer hourly reach bucket as the per-posting list (`payer_reach`, `PAYER_REACH_MAX_PER_HOUR`, default 60): **one unit per page**, checked before any read, shared with `GET /payer/reach/jobs/:jobId/applicants` (not a second budget). Fails closed: Redis down → the same `429`.
- **Scope:** every worker who **applied** to a posting the **session** payer owns — agency `jobs` rows (`jobs.payer_id`) and company `job_postings` (`job_postings.payer_id`), the same two ownership rules the per-posting list resolves an id with, all statuses. `payer_id` comes from the session only; the query has no slot for one.
- **Query** (all optional; any other key, including `payer_id`, is a `400` — and so is `stage` while `PAYER_APPLICANT_STAGES_ENABLED` is off):
  - `postingId` (UUID) — only that posting's applicants; matches an agency job id or a company posting id. **Neutral result:** an unknown id and another payer's id return `200 { applicants: [], nextCursor: null }` — byte-identical to an owned posting nobody has applied to (no existence oracle, one read in every case).
  - `limit` — integer `1..50`, default `20`.
  - `cursor` — the previous response's `nextCursor`, passed back untouched (≤256 chars). Empty = first page. Anything the server did not mint is a `400`, including a cursor whose timestamp is not a real instant (e.g. 30 February, year 0000). Opaque is not secret: it decodes to the last row's application `created_at` and id.
  - `stage` — `new` | `shortlist` | `passed` (owner ruling 2026-10-07). **Only while `PAYER_APPLICANT_STAGES_ENABLED` is on**; off, `?stage=` is the same `400` it always was (never a filter that silently does nothing). Keeps only applicants in that stage of the saved board; `new` matches an applicant nobody has moved **and** one moved back to New. Composes with `postingId` and with paging: the filter narrows the same order without changing it, so pages under a filter never skip or repeat a row. A cursor is a position, not a filter — when you change `stage`, start again from the first page (no cursor). An applicant moved between two of your page reads is shown or skipped by the stage he holds when his page is read, never twice.
- **Order:** newest application first — `applications.created_at DESC`, then `applications.id DESC` as the tiebreak (a total order, so pages never skip or repeat a row). Keyset pagination; the cursor is opaque base64url of `{ v: 1, t: <created_at, microsecond UTC>, id: <application id> }`.
- **Response:**
  ```
  { applicants: [ <row> ], nextCursor: string | null }   // null = last page
  ```
  Each `<row>` is **exactly** the row `GET /payer/reach/jobs/:jobId/applicants` returns for that applicant (same code builds both, same values), **plus** `posting`:
  ```
  // agency job applicant — the legacy weighted row
  { workerId, rank, score, hot, pushEligible, components, experienceBand, tradeLabel, cityLabel,
    posting: { id, title, kind: 'agency_job' } }
  // company posting applicant — the V1 candidate row
  { workerId, applicationId, rank, matchTier, effectiveTier, skillMonths, industryMonths,
    lastWorkedAt, matchedSkillLabel, engineVersion,
    posting: { id, title, kind: 'company_posting' } }
  ```
  - `posting.id` is the id the per-posting route and the unlock's `job_id` context take; `posting.title` is the payer's own title (`jobs.title` / `job_postings.role_title`); branch on `posting.kind` (or, as on the per-posting route, on `score` vs `applicationId`).
  - `rank` (and `hot` on an agency row) is the applicant's position on **his posting's** list ("#2 on Welder"), not his position in this inbox. A worker who applied to two of your postings is two rows.
  - `stage` — present on every row **only while `PAYER_APPLICANT_STAGES_ENABLED` is on**: the same value the per-posting route shows for him on that posting (a worker's two rows have two independent stages, one per posting). Absent while off.
- **Membership:** the per-posting lists' — `action = 'applied'` only, never a worker inside the deletion grace window (ADR-0031 (b)), and an agency applier only if he has a profile row (the agency list ranks profiles). An application that names both one of your agency jobs and one of your postings is listed once, under the agency job. The per-posting company list stops at 500 rows; this list is paginated instead, so a company posting's applicants ranked 501st and below appear only here, with their true posting `rank`.
- **Faceless:** the rows carry exactly the per-posting projection — opaque ids, banded chips and rank inputs; no name, phone, employer or contact. Identity is still bought through `/payer/unlocks`.
- **Events:** the per-posting posture, row for row: each **agency** row on the page emits the same `feed.shown` the per-job list emits for it (actor `payer`, payload `worker_id`/`job_id`/`rank`/`score`/`hot`, one all-or-nothing batch); **company** rows emit nothing. A company-only page is therefore rate-limited but not durably audited (the per-posting list's existing residual).
- **Errors:** `400` bad query / cursor; `429` reach cap (or Redis down); a DB failure is a `5xx`. No `404` — a filter that matches nothing is an empty page.
- **Mobile/web gotchas:** FREE (no credit debit). Pass `nextCursor` back verbatim; never build one. New applications arriving mid-scroll appear on the next first page, not mid-list. An agent account's older company postings are included, as on the per-posting route.

#### `PUT /payer/reach/jobs/:jobId/applicants/:workerId/stage` — move an applicant on the pipeline board
Owner ruling 2026-10-07: payer-web's New / Shortlist / Passed board is saved server-side (it survives a reload and every session with access to the posting sees the same board). **Behind `PAYER_APPLICANT_STAGES_ENABLED` (default off): while off this route is a neutral `404` for every caller** (after the `401` for no session) and the feeds carry no `stage`.
- **Auth:** `PayerAuthGuard` (Bearer), either role. No role gate: like the feed it annotates, the board is governed by **posting ownership** alone — an agent's agency job and an employer's company posting alike. Own per-payer hourly bucket (`payer_applicant_stage`, `PAYER_APPLICANT_STAGE_MAX_PER_HOUR`, default 600), one unit per request (a no-op and a `404` count too), charged before any read; fails closed (Redis down → the same `429`).
- **Path:** `jobId` — the id `GET /payer/reach/jobs/:jobId/applicants` takes: an agency `jobs` id **or** a company `job_postings` id; the server resolves which, exactly as the feed does (jobs first). `workerId` — the row's `workerId`. Both UUIDs (malformed → `400`).
- **Body:** `{ "stage": "new" | "shortlist" | "passed" }` — strict; any other key (`payer_id`, a note, a posting kind) is a `400`. `new` moves the applicant back to New.
- **Who may set it:** the session payer must **own** the posting (`jobs.payer_id` / `job_postings.payer_id` — the same check the feed uses), **and** the worker must be on that posting's applicant feed (applied, not withdrawn/skipped, not inside the deletion grace window, and — on an agency job — with a profile, exactly the feed's membership). Otherwise → `404` with `error.message = "Job not found"`, **identical** to the feed's 404 for an unknown id, another payer's posting, or a worker who is not an applicant (no existence oracle). When org tenancy lands (PAY-DB-01) ownership widens to the org and so does the board — the route does not change.
- **Response `200`** (the same shape for a change and for a no-op):
  ```
  { postingId, postingKind: 'company_posting' | 'agency_job', workerId,
    stage, previousStage, changed: boolean }
  ```
  `previousStage` is what the board held before this request (`new` if nobody had moved him). `changed: false` = he already held `stage`: nothing written, no event.
- **Idempotent:** retrying the same body is safe (`changed: false`, same body otherwise). Two sessions moving the same applicant at once serialise; the last write wins, and each response's `previousStage` is the stage it actually replaced.
- **Events:** one `payer.applicant_stage_changed` v1 per **real** change, in the same transaction as the write — actor `payer` (the session payer), subject `worker`, payload `{ posting_kind, posting_id, worker_id, stage, previous_stage }` (ids + closed enums only). A no-op emits nothing.
- **Errors:** `400` bad ids / body; `401` no session; `404` flag off, or not settable (above); `429` cap or Redis down; a DB failure is a `5xx`, never folded into the `404`.
- **Web gotchas:** read `stage` from the feed rows (absent ⇒ the flag is off ⇒ keep the local board and do not call this route). Update the row optimistically, then reconcile with the response's `stage`; on `404` re-fetch the feed (the applicant left it). Stages are per posting: the same worker on two postings has two independent stages.

### 4.6 Agency (role `agent` only)

> All `/payer/agency/*` routes require `PayerAuthGuard` **+ `PayerRoleGuard` role=`agent`**. A non-agent gets `403` (or no-oracle `404`). `payer_id` is session-derived; never in body. Responses are faceless camelCase views with **no `payer_id`**.

#### `POST /payer/agency/jobs`
- **Body:** `{ trade_key: enum, title: string (1–200, screened), city: string (1–120, screened as a place), area?: string (1–120, screened as a place), pay_min?: int (0–10M), pay_max?: int (0–10M, ≥pay_min), pay_type?: 'in_hand'|'gross'|'ctc', min_experience_years?: int (0–60), max_experience_years?: int (0–60, ≥min_exp), needed_by?: 'immediate'|'soon'|'flexible', description?: string (1–2000, screened), shift?: 'day'|'night'|'rotational', benefits?: string[] (≤12 × ≤80, screened), requirements?: string[] (same caps), role_kind?: RoleKind, match_skill_ids?: 'mskill_*'[] (1–50) }` — `RoleKind` is the same 21-value enum as on `/payer/job-postings`.
- **Response:** `AgencyJobView { id, status: 'open', tradeKey, title, city, area, payMin, payMax, payType, minExperienceYears, maxExperienceYears, neededBy, description, shift, benefits, requirements, roleKind, matchSkillIds, applicantsReceived, createdAt, updatedAt }`.
- **Events:** `job.created` (PII-free: opaque IDs + coarse bands + `role_kind`, the closed enum value or `null`).
- **Mobile gotchas:** Starts `open` (no draft). Pay is whole INR (no paise). `201`.
- **#1647 (2026-09-22) — `description`, `shift`, `benefits` and `requirements` are now RETURNED.** They were accepted and stored by `POST`/`PATCH` and projected by nothing, so a payer could not see what they had posted and the edit screen had to start those inputs empty with an overwrite warning. **That warning can now be removed** — the view prefills.
- `pay_type` (#1648) states what the ₹ band means; omit it rather than guess. `NULL` renders no pay-type pill.
- **`city` / `area` are screened as places (#1848)** on `POST` and `PATCH`, with the same messages and the same pincode waiver as `/payer/job-postings` (see "`city` and `area` run the same screen as places" in §4.2). A `PATCH` that omits them does not re-screen the stored values.
- **`role_kind` (migration 0131, 2026-09-29) — a SECOND classifier beside `trade_key`, not a replacement.** `trade_key` (15 trades) stays required and stays the job's matching classifier; `role_kind` (21 roles) is display / classification only and never a match input; since 2026-10-05 it reaches the worker card as a role illustration only (ADR-0024 addendum). Optional with no default (`roleKind: null` when omitted — never inferred from `trade_key`). Same errors as the posting contract: unknown value or explicit `null` → `400`.
- **`match_skill_ids` (#1983, ADR-0050 §6.1 step 2) — the job's explicit match input.** The closed `mskill_*` ids the agent picked (the same vocabulary as `GET /payer/match/skills` and the posting form). It feeds only the job's ADR-0050 V1 twin, and it is never inferred from `trade_key`. It is **optional**: omitted stores `[]` (`matchSkillIds: []`, "not chosen yet"). Validation is the **posting form's own**: an id outside the closed set → `400 "unknown match skill id(s): …"`; more than `match_config.max_skills_per_posting` (3 at launch) → `400 "a posting may name at most N skills (got M)"`; `[]` or `null` → `400` (to unset it, use `clear` on PATCH). Duplicates are de-duplicated. `job.created` does **not** carry it (v1 unchanged).

#### `GET /payer/agency/jobs`
- **Response:** `AgencyJobView[]`, newest-first. No pagination.

#### `GET /payer/agency/jobs/:jobId`
- **Response:** `AgencyJobView`, or neutral `404` (unknown/not-owned).

#### `PATCH /payer/agency/jobs/:jobId`
- **Body:** any subset of the create fields (≥1 required), plus `clear?: string[]`. Ordering re-validated against the **result** row (handles one-sided edits).
- **#1652 — `clear: [...]` unsets a field.** Clearable here: `area`, `pay_min`, `pay_max`, `pay_type`, `min_experience_years`, `max_experience_years`, `needed_by`, `description`, `shift`, `benefits`, `requirements`, `role_kind` (0131), `match_skill_ids` (#1983).
  - **`match_skill_ids` edits (#1983):** when present the set **replaces** the stored pick. It is compared order-free, so re-sending the same skills in another order is no change. Omitted leaves it unchanged. `{ "clear": ["match_skill_ids"] }` resets it to `[]` (never `null`; the column is `NOT NULL`). A changed set is validated exactly as on create and reported as `changed_fields: ["match_skills"]` (the key only, never the ids).
  - **`city`, `title` and `trade_key` are NOT clearable on this contract** — they are `NOT NULL` on `jobs`. Note `city` IS clearable on `/payer/job-postings` because `job_postings.city` is nullable: same word, different table, different answer.
  - Same rules as the posting contract: set-and-clear of one field is a `400`, clearing one end of a band is legal, `clear: ["benefits"]` stores NULL while `benefits: []` stores an empty list, and clearing an already-NULL field is not a change.
- **Response:** updated `AgencyJobView`.
- **Events:** `job.updated` (`changed_fields` = keys only; `role_kind` is its own key since 2026-09-29, never reported as `trade_key`; `match_skills` since #1983, an additive key-enum member with no version bump).
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

#### `PUT /ops/agency-jobs/:jobId/match-skills` — **OPS ONLY, not a payer/mobile route** (#1983)
- **Auth:** `InternalServiceGuard` **and** `AdminAuthGuard`, both required (the `POST /job-postings/:id/reach/widen` precedent). The recorded actor is the authenticated admin, never a body field.
- **Body:** `{ match_skill_ids: 'mskill_*'[] (0–50) }` (`.strict()`). This is the full desired set; `[]` resets it to "not chosen yet".
- **Response:** `{ job_id, match_skill_ids, changed: boolean }`. An unchanged set (in any order) returns `changed: false` with no write and no event.
- **Errors:** a job that is not an **agency** job (unknown id, a seed/ops row, an employer-owned legacy row) → neutral `404 "Job not found"`. A closed job → `400 "Job is closed and cannot be edited"`. Vocabulary and cap errors are the same as on the agency form.
- **Events:** one `job.updated` v1, actor `ops` (admin id), `payer_id` = the owning agency, `changed_fields: ["match_skills"]`.
- **Why:** ADR-0050 §6.3 step (c) requires ops to set match skills on the live agency jobs before the V1 flip.

### 4.7 Admin posting detail (NOT a payer/mobile route — for reference)

#### `GET /admin/job-postings/:id`
- **Auth:** `AdminAuthGuard` + capability `read_entities`. Never called by the payer app.
- **Response (`AdminJobPostingDetail`, snake_case):** the list fields plus `description`, `shift`, `needed_by`, `boosted_until`, `previous_status`, `applied_count`, `skipped_count`, `updated_at`, and — **added 2026-09-29** — `area`, `min_experience_years`, `max_experience_years`, `pay_type`, `requirements`, `benefits`, `role_kind`. Every one is a nullable, PII-free card field the owning payer already reads back; `role_kind` is returned **raw** (the admin UI labels it with `jobRoleLabel()` and shows the raw id when it is not one of the 21). Explicit column select — never a bare `select()`.
- **`payer_role` (added 2026-10-06, #2032):** `'employer' | 'agent' | null`, next to `payer_id`, on `GET /admin/job-postings` (list) and `GET /admin/job-postings/:id`, and on every row of `GET /admin/finance/ledger` and `GET /admin/finance/orders` — and, **added 2026-10-07 (#2106)**, on every `top_balances[]` row of `GET /admin/finance/summary` (`{ payer_id, payer_role, balance }`). It is `payers.role`, read through one `LEFT JOIN payers ON payers.id = <row>.payer_id` inside the page query (no per-row lookup). `null` when `payer_id` is null or resolves to no `payers` row (these columns carry no FK). Additive — consumers that ignore it are unaffected; admin-web uses it to link to `/companies/:id` (`employer`) or `/agencies/:id` (`agent`) and falls back to `/companies/:id` on `null` — on `top_balances` too since the admin-web pass-through (#2138), which also treats an absent `payer_role` as `null`.

---

## 5. Role Model

| Concept | Value | Meaning |
| --- | --- | --- |
| Account role | `employer` | Company / direct hirer. Uses `/payer/job-postings/*`, capacity, unlocks, reach, credits. |
| Account role | `agent` | Agency. Posts agency jobs via `/payer/agency/*` (agency jobs, invites, referrals); shares capacity, unlocks, reach and credits with employers. **Cannot write company postings** (#1885) — reads its own pre-existing `job_postings` only. |

- The role is set at account creation (`signup` `role`) and is carried in the JWT and returned by `login/verify` + `GET /payer/me`. Use it for UI gating, but **the backend enforces it** (`PayerRoleGuard` + `@PayerRoles('agent')` on `/payer/agency/*`; `@PayerRoles('employer')` on the `/payer/job-postings` writes and chat publish — #1885). Do not rely on client-side role checks for security.
- **Owner vs recruiter (org-member roles, ADR-0027 / B5.3, #2079).** Every payer is a member of one org with `org_role` `owner` | `recruiter` (a self-signed-up payer is the `owner` of their solo org). Read it from `GET /payer/me` `orgRole` (always current). The payer JWT also carries `org_id` + `org_role` claims minted at login/refresh — a display hint only, absent on tokens minted before #2079 (treat absent as `recruiter`). **Owner-only, enforced server-side** by `PayerOrgRoleGuard` (current role from the DB per request): `POST /payer/org/members`, `DELETE /payer/org/members/:id` → `403` for a recruiter. **Credit purchase is NOT owner-only** (owner ruling 2026-10-07): `POST /payer/credits`, `/credits/order` and `/credits/verify` are open to any authenticated payer, recruiters and payers with no org membership included. Mobile must not surface payment flows anyway (CLAUDE.md §12).

Which surface each role can call:

| Endpoint group | `employer` | `agent` |
| --- | --- | --- |
| Auth / `/payer/me` / credits / capacity | ✅ | ✅ |
| `GET /payer/job-postings`, `GET /payer/job-postings/:id` | ✅ | ✅ (own rows only, read-only) |
| `/payer/job-postings` writes (create, PATCH, close, pause, resume, plan, boost, quota-topup), `POST /payer/job-posting-chat/sessions/:id/publish` | ✅ | ❌ `403` (#1885) |
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
| `POST /payer/resume-disclosures` + `GET /payer/resume-disclosures` (masked resume) | **BACKEND LIVE, FRONTEND MOCK** | The payer-authed endpoint exists (returns `{ ok, disclosure_id, status:'disclosed', resume_url (signed), expires_at }` or neutral `unavailable`; free, no credit). But payer-web still mocks it. Safe to integrate against the live backend; verify in staging first. Render the signed `resume_url` short-lived; never log it. |
| Posting **pause / resume / quota top-up** (company postings) | **NOT READY — no backend** | Web portal `pausePosting`/`resumePosting`/`topUpPostingQuota` are **mock-store only**. The `job_postings` schema has **no `paused` state** and **no quota column**. Stub in the app until backend wires `POST /payer/job-postings/:id/pause` + resume + quota. |
| Posting **plans/boosts for payers** (payer-authed) | **MISSING ENDPOINT** | No payer-authed plan/boost purchase route exists; only the IDOR ops routes above. Buyers are blocked until built. |
| Credit **history / top-up ledger** | **PARTIAL — balance live, history synthesized** | `GET /payer/credits` (balance) and `GET /payer/unlocks` (spends) are live; there is **no** credit-ledger/top-up-history endpoint. Build history from those two; do not expect a server ledger. |
| Per-posting **applicant quota** field | **MOCK-ONLY** | Live posting rows have no `applicantQuota`; it's config-sourced. Do not display a per-posting quota for live rows. |
| **Org-member / team management** (owner vs recruiter) | **LIVE (web)** | `GET/POST /payer/org/members`, `DELETE /payer/org/members/:id`, `POST /payer/org/invites/accept` (B5.3); writes owner-only. The caller's role is `GET /payer/me` `orgRole` (#2079). Accept answers **409** `"This invite can't be accepted with this account"` (one body, no reason given) when the caller is already in another team, owns a team with other members, or has a different role (employer vs agent) from the inviting org's owner (ADR-0053 §3.5). The token is not consumed. Mobile: no team UI planned. |
| Worker **attribution** to agency invite | **STUB — no caller** | `attributeWorkerToInvite()` exists server-side (consent-gated) but is **not wired** to onboarding; `agency_invite.accepted` does not fire yet. Referral `accepted` counts stay ~0. |
| Real **WhatsApp invite send** | **MOCK** | `MESSAGING_ENABLE_REAL=false`. Agency copies the `link` manually; no platform send. |
| Real **payments** (credits/capacity/any purchase) | **MOCK** | `PAYMENTS_ENABLE_REAL=false` (fail-closed). All money flows are mock ledgers in Phase 1; `real_call:false`. Do not integrate a real payment SDK. |
| Agency **payouts / commissions / KYC** | **PARKED (legal-gated)** | No endpoints; type-only shells. Phase-2, behind legal/§7 human gates. |
| Production **identity provider** (`supabase` login) | **INERT** | `PAYER_LOGIN_METHOD` supports `supabase` but it's inert without keys. Email-OTP is the live method. WhatsApp OTP is mock. |
| Ops surfaces: `/job-postings/*`, `/reach/jobs/:jobId/applicants`, `/unlocks/*`, `PUT /pricing/catalog` | **OPS-ONLY / unauthenticated** | Not payer-authed; do **not** call from mobile. Use the `/payer/*` equivalents. `/reach/jobs/:jobId/applicants` is the ops **ranked worker pool** (suggested workers, not applicants) — never a payer list (#1898). |
| `POST /payer/agency/invites/:code/click` | **STUB** | Returns `{ ok: true }` always; local funnel only, no worker attribution. Generally not needed from the app. |

---

### Quick auth recap for the impatient

1. `POST /payer/signup` or `POST /payer/login/request` → user gets emailed a code.
2. `POST /payer/login/verify { email, code }` → store **body** `access_token` (Keystore).
3. Send `Authorization: Bearer <token>` on every call. **No cookies. Ignore `x-session-token`.**
4. On `401`: `POST /payer/refresh` (Bearer) once → new **body** token → retry; else re-login.
5. `POST /payer/logout` → `204`, then wipe the local token.
6. `is_new_payer` is always `false` — don't trust it.
