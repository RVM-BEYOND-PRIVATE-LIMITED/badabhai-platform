# ADR-0025: Admin Ops Portal — the "manage all events" command center (ADMIN-0, decision only)

- **Status:** **ACCEPTED (owner, 2026-06-27) — direction approved; ADMIN-1 cleared to build**
  carrying the security **must-fix #1–5** in scope. The **security-engineer SIGNED OFF WITH
  CONDITIONS (2026-06-27)** — see the [Security sign-off](#security-sign-off-2026-06-27) section
  (RBAC matrix Decision 3, PII-reveal policy Decision 4, `admin_users` design Decision 2 signed
  off subject to the must-fix conditions). This ADR is the mandatory architecture gate before
  any admin code (CLAUDE.md §3/§7: it touches **auth + PII reveal + RBAC**). It fixes the
  architecture for the owner-authorized **Admin Ops Portal** before a single line of
  `admin_users`, `AdminAuthGuard`, the events-query API, or the entity actions, exactly as
  ADR-0010/0013/0019 did. **Phase-2-adjacent — additive, gated, off by default.**
- **Owner decisions (2026-06-27):**
  - **OQ-1 (MFA scope) → MFA for ALL admin roles** (incl. `analyst`), enforced server-side at
    session-mint (a privileged role with `mfa_enrolled=false` mints no session). [must-fix #1 resolved]
  - **OQ-2 (onboarding default) → invite-then-activate;** `admin_users.status` defaults to
    `pending` (mirrors `payers`) — a created-but-unactivated admin authenticates to nothing.
  - **OQ-6 (kill-switch surface) → RECONCILED, NOT a blanket "enable from portal".** The owner
    asked for admin control/visibility over the provider flags. Per **§2 #5 + §7 (invariants
    override a casual instruction — CLAUDE.md preamble)** the portal will: (a) **DISPLAY** the
    live state of `AI_ENABLE_REAL_CALLS` / payments / telephony (read-only observability), and
    (b) toggle ONLY in the **fail-safe direction** — emergency **PAUSE / disable** + operational
    runtime pauses (e.g. force OTP cap → 0, pause AI even if enabled). **ENABLING** real LLM /
    payment / telephony providers stays **env/deploy-gated, staging-first, key-required, human
    escalation — NEVER a portal toggle.** A portal control that *enables* real spend or a
    PII→LLM path would violate §2 #5 and is **explicitly out of scope** absent a deliberate,
    separately-escalated decision to change that invariant (a §7 conversation in its own right,
    not a UI option). This satisfies the owner's intent (visibility + safe-direction control)
    without breaking the invariant. Affects the **kill-switch capability in ADMIN-3**, not ADMIN-1.
- **Date:** 2026-06-27
- **Owner-authorization:** the admin program is owner-authorized **as a gated design**; this
  ADR designs it gated, not loose. The authorization is to *design and stage behind gates*,
  **not** to ship a live privileged surface absent the security sign-off above.
- **Author:** system-architect (architecture + contract) + **security-engineer (MANDATORY —
  this creates a 4th, highly-privileged principal with a PII-reveal capability)** +
  product-manager (surface + role model). backend-engineer / database-architect /
  frontend-engineer **consulted** (build streams, after sign-off).
- **Builds on / reconciles (verified against the repo, 2026-06-27):**
  - **Three existing principals, never conflated** — the worker session
    ([`apps/api/src/auth/worker-auth.guard.ts`](../../apps/api/src/auth/worker-auth.guard.ts) +
    [`session.service.ts`](../../apps/api/src/auth/session.service.ts)), the payer session
    ([`apps/api/src/payers/payer-auth.guard.ts`](../../apps/api/src/payers/payer-auth.guard.ts) +
    [`payer-session.service.ts`](../../apps/api/src/payers/payer-session.service.ts), ADR-0019),
    and the ops service-to-service secret
    ([`apps/api/src/common/guards/internal-service.guard.ts`](../../apps/api/src/common/guards/internal-service.guard.ts)).
    The admin principal is a **DISTINCT 4th** — never one of these.
  - **The event spine** — [`packages/event-schema`](../../packages/event-schema/src) (envelope,
    `EVENT_REGISTRY`, `createEvent`, `validateEvent`) + the **insert-only** `events` table and
    its four indexes in [`packages/db/src/schema.ts`](../../packages/db/src/schema.ts)
    (`events_event_name_idx`, `events_occurred_at_idx`, `events_correlation_id_idx`,
    `events_subject_idx`; `correlation_id`/`causation_id` columns). The admin API rides these
    indexes and is **READ-ONLY on the spine** (CLAUDE.md §2 #1).
  - **PII crypto** — [`apps/api/src/common/pii-crypto.service.ts`](../../apps/api/src/common/pii-crypto.service.ts)
    (`encrypt`/`decrypt`/`hashPhone`/`hmac`); raw worker PII lives **only** in `workers`
    (`phone_e164`), encrypted payer contact in `payers` (CLAUDE.md §2 #2 / ADR-0004). The
    PII-reveal capability uses `decrypt` and is the **separate, audited, privileged** path.
  - **The boot-guard pattern** — `assertPayerAuthConfig` /
    [`apps/api/src/main.ts`](../../apps/api/src/main.ts) (fail-closed `assert*Config` on
    half-set auth) is the template for `assertAdminAuthConfig`.
  - **The OTP + session infra** — [`payer-otp.service.ts`](../../apps/api/src/payers/payer-otp.service.ts)
    (email-OTP, no-enumeration, constant-time, fail-closed, global send cap) + the payer
    rolling/revocable httpOnly-JWT session — **REUSED**, not reinvented, for admin auth.
  - **The ops console** — [`apps/web`](../../apps/web) (read-only `workers`/`events`/`ai-jobs`
    pages; talks to the API via plain `apiGet` for public reads + `apiGetInternal`/
    `apiPostInternal` with `INTERNAL_SERVICE_TOKEN` — see
    [`apps/web/src/lib/api.ts`](../../apps/web/src/lib/api.ts)). The console **has no login gate
    today.**
  - **ADR-0004 (PII at rest + RLS)** + [rls-plan.md](../../infra/supabase/rls-plan.md) — the
    REVOKE + `BYPASSRLS` posture the admin tables inherit.
  - **CLAUDE.md §2 invariants 1, 2, 7, 8; §3 locked stack; §7 escalation; §8 deferred.**

---

## Context

Today operations runs on a **read-only `apps/web` ops console** behind a single shared
`INTERNAL_SERVICE_TOKEN` (and several public, unguarded read endpoints). It can *view*
workers/events/ai-jobs and run the ADR-0010 unlock/reveal writes — but it has **no admin
identity, no roles, no per-actor audit, and no governed way to act on entities** (suspend a
payer, grant credits, force-close a posting, flag a worker, toggle a kill-switch) or to
**reveal a worker's contact for support**. A shared secret is not a person; "who did this and
why" is unanswerable; and there is no graduated privilege.

The owner has authorized an **Admin Ops Portal**: a privileged "manage all events" command
center that (a) makes the immutable event spine **queryable + explorable**, (b) exposes
**governed entity actions** each emitting a new event, (c) provides a **first-class,
reason-gated, audited PII-reveal** for support, and (d) does all of this behind a **real
admin identity with RBAC**.

This is a **new trust boundary and a new, highly-privileged principal** — distinct from the
worker, payer, and ops-secret principals. It is precisely the kind of change CLAUDE.md §3/§7
require to gate on an ADR + a security-engineer sign-off **before any code**. This ADR draws
that contract.

**Disciplines that govern every decision (restated as hard constraints):**
- **Event-first (§2 #1):** every admin **mutation** emits a `createEvent`-built, registry-
  validated event. No admin state change without an event.
- **No raw PII in the spine (§2 #2):** event payloads, `ai_jobs`, `audit_logs`, and logs stay
  PII-free. Because event payloads are *already* PII-free, the admin may **VIEW** them freely;
  raw-PII access is the **separate, audited, privileged reveal** (Decision 4) — never bulk.
- **Deny-by-default RBAC; fail-closed boot; secrets only from env; the events table is immutable.**
- **Additive only (§2 #8):** new tables, a new guard, a new route group, new PII-free event
  names registered additively. Nothing existing is mutated.

---

## Decision — overview

| # | Decision | Headline |
|---|----------|----------|
| **1** | **Surface** | **EXTEND `apps/web`** into the Admin portal (it already has the read pages + the internal-secret data path) **behind a NEW admin login gate** — not a new app. Admin and ops are the **same internal trust boundary**; payers/workers are external (a separate app each). |
| **2** | **Admin identity** | A net-new **`admin_users`** table + a **DISTINCT 4th `AdminAuthGuard`** principal. **MFA required** for privileged roles. Sessions **reuse the payer rolling/revocable httpOnly-JWT** mechanism (`typ:"admin"` audience-pin). **NO worker/payer PII** in the admin tables. **`assertAdminAuthConfig` fail-closed boot.** |
| **3** | **RBAC** | Four roles — `super_admin`, `ops_admin`, `support`, `analyst` — with a concrete **capability matrix**, **deny-by-default**, enforced by a `@RequireAdminRole(...)` decorator + a `AdminRolesGuard`. |
| **4** | **PII reveal** | Worker-contact decrypt is **reason-required (reason code), role-gated (`support`/`super_admin`), single-subject, rate-limited, NEVER bulk**, and fully audited via a **PII-FREE** `admin.pii_viewed` event (subject id + reason code — **never the value**). |
| **5** | **Spine read-only** | **NO admin route may UPDATE or DELETE an `events` row.** Every admin mutation emits a **NEW** validated event. Enforced by repository shape + a build-blocker test + the DB grant posture. |
| **6** | **New events** | `admin.session_started`, `admin.session_revoked`, `admin.action_performed` (action code + target id, no values), `admin.pii_viewed` (reason code + subject id, never PII) — all **PII-free + versioned**, registered **additively** in `@badabhai/event-schema`. |
| **7** | **OBS-4 migration** | Migrate the ops read routes from `InternalServiceGuard` → `AdminAuthGuard` (layered, dual-accept transition) and put `apps/web` behind admin login — with a backward-compatible rollout + rollback. |
| **8** | **Phasing + gates** | ADMIN-0 (this ADR) → **ADMIN-1 (auth/RBAC/DB — the HARD GATE)** → ADMIN-2 (events query API) ∥ ADMIN-3 (entity actions) → ADMIN-4..7 (UI) → ADMIN-8 (security gate). **ADMIN-1 may not build until this ADR is accepted + the security-engineer signs the matrix + PII policy + table design.** |

---

## Security sign-off (2026-06-27)

**Reviewer:** security-engineer. **Verdict: SIGN-OFF WITH CONDITIONS.** This section is
authoritative; where a condition here sharpens a decision below, the condition wins.

**Verdict.** The design **upholds every §2 invariant** — no PII to the spine (event payloads /
`ai_jobs` / `audit_logs` / logs stay PII-free), fail-closed authentication, deny-by-default
RBAC, an **immutable** event spine, and PII-free admin events. The **RBAC matrix (Decision 3)**,
the **PII-reveal policy (Decision 4)**, and the **`admin_users` table design (Decision 2)** are
**SIGNED OFF**, subject to the conditions below being **built into ADMIN-1 / ADMIN-3**.

### Must-fix in/before ADMIN-1 (BLOCKING ADMIN-1)

1. **MFA scope (OQ-1) resolved by owner** — security **recommends MFA for ALL roles (incl.
   `analyst`)**; whichever scope the owner picks is **enforced server-side at session-mint** with
   a test: *a privileged role with `mfa_enrolled = false` mints NO session* (fail-closed).
2. **`assertAdminAuthConfig` lands in ADMIN-1** with the **same fail-closed test matrix** as
   `assertPayerAuthConfig` — dev-JWT-in-prod **rejected**, half-set MFA/TOTP **rejected** (refuse
   to start).
3. **Spine-immutability build-blocker test lands in ADMIN-1** (Decision 5), **NOT deferred to
   ADMIN-8**: a **select-only** events repository + **no `update(events)` / `delete(events)` in
   any admin handler** + **every admin mutation route emits exactly one registry-valid event**.
4. **One-principal / one-role-per-route test** — *every admin route declares exactly one
   `@RequireAdminRole(...)` and exactly one principal class* (closes the unguarded-route
   escalation path).
5. **Matrix-drift test** — the capability→role **constant** is tested against the Decision-3
   table, landing **with** the constant (a drift is a build failure).

### Must-fix before ADMIN-3 (the reveal / mutation phase — BLOCKING ADMIN-3, not ADMIN-1)

6. **Reveal-note PII enforcement** — the free-text reason note is **length-bounded** and
   **residual-PII-rejected (or dropped)** so the audit row cannot itself become a PII sink.
7. **Audit-BEFORE-decrypt proven by test** — `admin.pii_viewed` is **committed before** the
   plaintext is computed/returned, **including on the denied branch**.
8. **Per-admin reveal rate cap is fail-closed** (Redis error → **deny**), mirroring the OTP
   global-cap pattern, **with a breach-alert event**.
9. **OBS-4 secret retirement is a scheduled, tracked deliverable** — a **time-boxed bake window**
   + `ADMIN_AUTH_ENFORCED` rollback; the **dual-accept composite guard is restricted to READ
   routes only** (no capability beyond read is reachable via the shared secret).

### Open questions — the owner MUST resolve before ADMIN-1

- **OQ-1 (MFA scope)** — *rec: all roles.*
- **OQ-2 (onboarding default)** — *rec: invite-then-activate; `admin_users.status` default
  `pending`, like `payers`.*
- **OQ-6 (kill-switch surface) — HARD LINE:** `AI_ENABLE_REAL_CALLS` and **any** real-provider /
  payment / telephony **enable MUST stay env/deploy-gated, NEVER portal-toggleable** (§2 #5 /
  §7). **Only operational runtime pauses** may be portal kill-switches. *(This blocks the
  kill-switch capability in ADMIN-3, not ADMIN-1.)*
- **OQ-5 (session store)** — Redis record **OK for v1**.
- **Deferrable:** **OQ-3** (SSO — defer), **OQ-4** (ticket-id linkage — defer), **OQ-7** (audit
  retention / review cadence — **must have a named owner + cadence before ADMIN-3 ships the
  reveal route**).

### Tracked gap

The **events-immutability DB-grant control is aspirational until RLS lands** (R1 / TD4); the
**interim enforcement is repo-shape + the build-blocker test** (must-fix #3).

---

## Decision 1 — Surface: EXTEND `apps/web` behind an admin login (NOT a new app)

**Decided: extend `apps/web`.** Locked.

`apps/web` is the **internal** ops console (CLAUDE.md §3/§4: "Next.js (internal only)"). It
already renders the read pages the admin portal needs (`workers`/`events`/`ai-jobs`, plus
reach/pricing/job-postings/pace) and already has the **server-only internal-secret data path**
([`apps/web/src/lib/api.ts`](../../apps/web/src/lib/api.ts)). Admins and ops are the **same
internal trust boundary** — privileged staff on a non-public origin. This is the inverse of
ADR-0019, where payers were *external* and therefore (correctly) got a *new* app
(`apps/payer-web`): conflating an internal console with an **external** boundary is the error
ADR-0019 Decision A avoided. Extending an internal console with **more internal privilege**
does not cross a trust boundary — it adds a login gate where today there is none.

**Options weighed:**

| Option | What | Verdict |
|---|---|---|
| **(i) EXTEND `apps/web`** behind a new admin login | add an `AdminAuthGuard`-gated admin area to the existing internal console; reuse its read pages + internal-secret data path | **DECIDED.** Same trust boundary, no duplicate read UI, fastest safe path. The change is **adding a login gate + RBAC-gated action UI** to an app that today has neither. The spec recommends this and the codebase confirms the read pages already exist. |
| **(ii) NEW app `apps/admin-web`** | a separate internal admin front-end | **Rejected.** Duplicates the read console and its data client for **no trust-boundary gain** (both are internal/non-public). Splitting ops-view from admin-action across two apps fragments the operator workflow and doubles the maintenance + deploy surface. (Contrast ADR-0019: a *new* app was right **because** payers are external — that rationale does not apply here.) |
| **(iii) bolt admin onto `apps/payer-web`** | reuse the external portal | **Rejected outright.** Puts a privileged internal surface on an **external, untrusted** origin — the exact conflation ADR-0019 forbids. |

**Consequence:** `apps/web` stops being unauthenticated. Today its data path is a server-only
shared secret + public reads; ADMIN-1 gives it a real **admin login** and ADMIN-7/OBS-4 puts
**every** page behind it. The internal-only property is *preserved* (non-public origin) and
*strengthened* (a login gate replaces "trust the network"). The admin area consumes a **NEW
admin-scoped API route group** behind `AdminAuthGuard` — distinct from the worker, payer, and
`InternalServiceGuard` groups; **one principal class per route**.

---

## Decision 2 — Admin identity: `admin_users` + a distinct `AdminAuthGuard` (4th principal)

**Decided. REQUIRES security-engineer sign-off on the table design before ADMIN-1.**

There is no admin identity today — only the shared `INTERNAL_SERVICE_TOKEN`. The portal needs a
**real, per-person admin account** with a role, a revocable session, and MFA for privilege.

### 2.1 The account model — `admin_users` (additive, NO worker/payer PII)

A new table modeled on `payers` (same at-rest discipline: encrypted contact, keyed-hash
lookup, `.enableRLS()`), holding **only the admin's own login identity + authz state** — never
any worker or payer PII.

| Column | Type | Notes |
|---|---|---|
| `id` | `uuid` PK `defaultRandom()` | the admin principal id (the `actor_id` in admin events) |
| `email_enc` | `text` notNull | AES-256-GCM ciphertext (admin's own work email — admin-class PII, same discipline as `payers.email_enc`) |
| `email_hash` | `text` notNull, **unique** | keyed HMAC for login lookup/dedup (never the raw email) |
| `role` | `text` `$type<AdminRole>()` notNull | enum: `super_admin \| ops_admin \| support \| analyst` (Decision 3) |
| `status` | `text` `$type<AdminStatus>()` notNull default `active`? | enum: `active \| suspended`; a suspended admin authenticates to **nothing** (fail-closed) |
| `mfa_enrolled` | `boolean` notNull default `false` | privileged roles (`super_admin`/`ops_admin`/`support`) **may not be granted access** until enrolled (Decision 2.3) |
| `last_login_at` | `timestamptz` nullable | observability only |
| `created_at` | `timestamptz` notNull `defaultNow()` | |
| `updated_at` | `timestamptz` notNull `defaultNow()` | |

> The default for `status` (active-on-create vs an explicit `pending` activation step, mirroring
> `payers.status` default `pending`) is an **OPEN QUESTION (OQ-2)** for the owner/security-
> engineer — invite-then-activate is the safer default but the owner sets onboarding policy.

**NO worker/payer PII** ever lands here. Admin email is **admin-class** contact PII under the
**same ADR-0004 at-rest discipline** (encrypted + keyed-hash lookup), and — like all PII —
**never** enters events / `ai_jobs` / `audit_logs` / logs / any LLM input. The `admin_user.id`
is the only admin token that appears in events.

Optional **`admin_sessions`** table is **rejected for v1** in favor of the Redis-record session
(see 2.2); revisit only if a DB audit-of-sessions requirement appears (OQ-5).

### 2.2 Session — REUSE the payer rolling/revocable httpOnly-JWT mechanism

The admin session **reuses the proven payer session shape**
([`payer-session.service.ts`](../../apps/api/src/payers/payer-session.service.ts)): a signed
**HS256 JWT** (`sub` = `admin_user.id`, `sid` = server-side session id, **`typ:"admin"`**
audience-pin) + a **revocable Redis record** (`admin_session:<sid>` namespace, distinct from
`payer_session:`/worker), **rolling** refresh past half-life, **httpOnly** cookie (admin web is
a browser surface — httpOnly, `Secure`, `SameSite=Strict`; no token in JS). A worker or payer
JWT can **never** satisfy `AdminAuthGuard` (different `typ` + different Redis namespace), exactly
as the payer guard cannot be satisfied by a worker token. **Fail-safe:** any verify/Redis error
→ `null` → 401.

### 2.3 Auth flow — REUSE email-OTP, **add MFA** for privileged roles

Login **reuses the payer email-OTP infra** ([`payer-otp.service.ts`](../../apps/api/src/payers/payer-otp.service.ts)):
keyed-HMAC code storage, constant-time compare, single-use, **no user-enumeration oracle**,
per-account cooldown + hourly cap + global daily send circuit-breaker, **fail-closed** on Redis
error. On top of email-OTP, **privileged roles (`super_admin`, `ops_admin`, `support`) REQUIRE a
second factor (TOTP)** — `mfa_enrolled` must be `true` and a TOTP step must pass before a session
is minted. `analyst` MAY be email-OTP-only (read-only, no PII) — an **OPEN QUESTION (OQ-1)** for
the security-engineer (recommend: MFA for all admins; the matrix below treats MFA as a
role-conditioned gate). **SSO/OIDC** (e.g. Google Workspace) is an allowed *future* IdP behind the
same session layer — **OPEN QUESTION (OQ-3)**; v1 ships email-OTP + TOTP on the locked stack.

### 2.4 Fail-closed boot — `assertAdminAuthConfig`

Mirroring `assertPayerAuthConfig` in [`main.ts`](../../apps/api/src/main.ts): a new
`assertAdminAuthConfig(config)` **refuses to start** in staging/production if admin auth is
half-configured (no admin JWT secret, dev JWT secret outside dev/test, or a privileged-role MFA
requirement with no TOTP secret/issuer set). A misconfigured env **cannot** silently expose the
admin surface.

---

## Decision 3 — RBAC: roles + a deny-by-default capability matrix

**Decided. The matrix REQUIRES security-engineer sign-off before ADMIN-1.**

Four roles, **least-privilege**, **deny-by-default** (an unlisted capability is denied; an
unknown/`null` role is denied — never defaulted to a privileged role, mirroring the payer
guard's fail-closed `role: null`).

- **`super_admin`** — everything, including feature flags / kill-switches and PII reveal. The
  break-glass role; smallest population.
- **`ops_admin`** — entity actions (suspend payer, grant credits, force-close posting, flag
  worker) + all reads + export. **No** flag/kill-switch toggles. **No** PII reveal.
- **`support`** — all reads + **PII reveal (reason-gated)**. **No** entity-state mutations,
  **no** flags. (Support reveals contact to help a worker; it does not change platform state.)
- **`analyst`** — read-only (events explorer, metrics, entity reads). **No** export of raw
  rows, **no** PII, **no** mutations.

### 3.1 Capability matrix (rows = capabilities, cells = allow/deny, deny-by-default)

| Capability | `super_admin` | `ops_admin` | `support` | `analyst` |
|---|:---:|:---:|:---:|:---:|
| Read events (explorer, filter on the 4 indexes) | ✅ | ✅ | ✅ | ✅ |
| Read entities (workers/payers/jobs/postings — **faceless**, no PII) | ✅ | ✅ | ✅ | ✅ |
| Read metrics / dashboards | ✅ | ✅ | ✅ | ✅ |
| Export (PII-free events / aggregates) | ✅ | ✅ | ❌ | ❌ |
| Suspend / reinstate a payer | ✅ | ✅ | ❌ | ❌ |
| Grant / adjust credits | ✅ | ✅ | ❌ | ❌ |
| Force-close a job posting | ✅ | ✅ | ❌ | ❌ |
| Flag / unflag a worker | ✅ | ✅ | ❌ | ❌ |
| Toggle a feature flag / kill-switch | ✅ | ❌ | ❌ | ❌ |
| **Reveal worker PII (reason-gated, single-subject)** | ✅ | ❌ | ✅ | ❌ |
| Manage admin users (invite / change role / suspend) | ✅ | ❌ | ❌ | ❌ |

✅ = allow, ❌ = deny. **Every cell not marked ✅ is denied.** (Export-for-`support` is denied so
the PII-reveal role cannot also bulk-export; this separation is deliberate — see Decision 4.)

### 3.2 Enforcement mechanism

A **`@RequireAdminRole(...capabilities)`** route decorator + a **`AdminRolesGuard`** that runs
**after** `AdminAuthGuard`, reads `req.admin.role`, and checks it against the capability the
route declares. Deny → **403** (authn succeeded, authz failed — distinct from the guard's 401).
The capability→role mapping (the matrix above) lives in **one** server-side constant (a single
source of truth, like the pricing catalog), unit-tested against this table so a drift is a build
failure. `null`/unknown role → **deny** (fail-closed), never a privileged default.

---

## Decision 4 — PII-reveal policy: reason-gated, role-gated, audited, rate-limited, never bulk

**Decided + MANDATORY security-engineer sign-off. This is the most sensitive admin capability.**

Worker contact PII (`workers.phone_e164`) is encrypted at rest; the only decryptor is
[`PiiCryptoService.decrypt`](../../apps/api/src/common/pii-crypto.service.ts). Support
occasionally needs the real contact to help a worker. This is designed as a **first-class,
narrow, audited privilege** — never a casual read, never bulk.

### 4.1 The controls (all REQUIRED; absence of any = the reveal route does not ship)

| Control | Rule |
|---|---|
| **Role-gated** | Only `support` and `super_admin` (Decision 3). `ops_admin`/`analyst` → 403. |
| **Reason-required** | The request **must** carry a **reason code** from a closed enum (e.g. `worker_support_callback`, `dispute_resolution`, `safety_escalation`) **and** (recommended) a free-text note **stored encrypted/PII-free-of-the-subject**. No reason → 400, no reveal. |
| **Single-subject** | One `worker_id` per call. There is **no list / range / wildcard** reveal endpoint. |
| **Never bulk** | No endpoint returns more than one worker's PII; no export path includes PII (export is PII-free by Decision 3 + §2 #2). |
| **Rate-limited** | Per-admin reveal cap (per hour + per day) in Redis, fail-closed (Redis error → deny), mirroring the OTP send-cap pattern. A breach emits a PII-free alert event + can page ops. |
| **Fully audited** | **Every** reveal — success or denied — emits `admin.pii_viewed` **before** the value is returned, carrying `{ admin_id (actor), worker_id (subject), reason_code }` and **NEVER the revealed value**. The audit row is written even if the downstream response fails (audit-first). |
| **Decrypt at the boundary only** | The plaintext is computed server-side at response time and **never** logged, cached, persisted, or placed in any event/`ai_job`. It exists only in the HTTP response body to the authenticated admin. |

### 4.2 Abuse model + backstops

- **Insider over-reach / scraping by an admin** → the **per-admin rate cap** + **single-subject
  only** + **no bulk/export-of-PII** bound the blast radius; **every** access is attributed to a
  person via `admin.pii_viewed`; the reason code makes "why" answerable and reviewable.
- **Compromised admin session** → MFA on the reveal role (Decision 2.3) + revocable Redis
  session (instant kill) + the rate cap + the audit trail. A stolen `analyst` session reveals
  nothing (no PII capability).
- **Reason-code laundering** (picking a benign reason for a bad reveal) → the reason is recorded
  per-access for **after-the-fact review**; periodic audit of `admin.pii_viewed` by reason +
  volume is an ops process (OQ-4: whether to require a linked ticket id in the reason).
- **Enumeration via reveal** → single-subject + rate cap + the fact that an unknown `worker_id`
  returns the **same** shape as a known-but-no-PII one (no oracle), mirroring the unlock no-oracle
  discipline.

---

## Decision 5 — The event spine is READ-ONLY to admin; every mutation emits a new event

**Decided. Enforced, not just asserted.**

The `events` table is the **immutable audit spine** (insert-only from backend services —
[`schema.ts`](../../packages/db/src/schema.ts), §2 #1). The admin command center makes it
**queryable and explorable**, but:

- **NO admin route may `UPDATE` or `DELETE` an `events` row.** Editing/redacting/deleting an
  audit fact is forbidden — even for `super_admin`. The spine is append-only, full stop.
- **Every admin MUTATION** (suspend payer, grant credits, force-close posting, flag worker,
  toggle kill-switch, reveal PII) **emits a NEW** `createEvent`-built, `validateEvent`-passed
  event (`admin.action_performed` / `admin.pii_viewed`) — the mutation and its event are one
  unit; no admin state change exists without an event (§2 #1).

**How this is enforced/tested:**
1. **Repository shape** — the admin events-read repository exposes **only** `select` over
   `events` (no `update`/`delete` method exists on it). The admin write path goes through the
   existing event-emitting services, never a raw `events` writer.
2. **Build-blocker test** — a test asserts there is **no** admin route/handler that issues a
   Drizzle `update(events)`/`delete(events)`, and that each admin mutation route emits exactly
   one registry-valid event (mirrors the existing guard-contract + event-validation tests).
3. **DB grant posture** — coordinate ADR-0004 so the admin-scoped DB role (when DB RLS lands)
   has **no `UPDATE`/`DELETE` on `events`**; today the spine's insert-only convention + the
   repository shape are the enforced controls.

---

## Decision 6 — The new admin events (PII-free, versioned, additive)

**Decided. Registered additively in `@badabhai/event-schema`; nothing existing is mutated (§2 #8).**

A new **`admin` event domain** + an **`admin` `ActorType`** + an **`admin_session` `SubjectType`**
are added to the enums **additively** (today `ACTOR_TYPES` has `ops`/`system` but **not** `admin`,
and `SUBJECT_TYPES` has no admin subject — confirmed in
[`enums.ts`](../../packages/event-schema/src/enums.ts)). Each event is `version: 1`, payload schema
in `payloads.ts`, entry in `EVENT_REGISTRY`. **All four are PII-FREE by construction** — ids +
enums + codes only:

| Event | Subject | Payload (PII-free) | Notes |
|---|---|---|---|
| `admin.session_started` | `admin_session` | `{ admin_id, login_method, mfa_used }` | actor = the admin; no email/IP-raw (ip_hash only, per envelope) |
| `admin.session_revoked` | `admin_session` | `{ admin_id, reason }` (enum: `logout \| timeout \| admin_action`) | revocation is itself audited |
| `admin.action_performed` | the **target entity** (`payer`/`worker`/`job_posting`/…) | `{ admin_id, action_code, target_id }` — **action CODE + target id only, NO values** | one row per governed mutation; the *what-changed* is the action code, never old/new values |
| `admin.pii_viewed` | `worker` | `{ admin_id, worker_id (== subject), reason_code }` — **NEVER the PII value** | the Decision-4 audit fact; emitted **before** the value is returned |

The faceless rule holds: `admin_id`/`target_id`/`worker_id` are opaque UUIDs; admin email,
worker phone/name, and any reveal value **never** appear. `admin.action_performed` carries an
**action code**, never the changed values, so the spine learns *that* a payer was suspended (and
by whom) without leaking anything sensitive — consistent with how `pricing.*` records changed
field **keys** not values.

> **Versioning (§2 #8):** these are net-new event names, so there is nothing to break; if any
> payload must change incompatibly later, **bump the version** in `EVENT_REGISTRY` (the existing
> per-name versioning strategy) — never mutate a shipped payload.

---

## Decision 7 — OBS-4: migrate the ops reads `InternalServiceGuard` → `AdminAuthGuard`

**Decided. Backward-compatible, dual-accept transition; rollback is a flag flip.**

Today `apps/web` reaches the API two ways (see [`api.ts`](../../apps/web/src/lib/api.ts)): plain
`apiGet` (public, **unguarded** — `/workers`, `/events`, `/ai-jobs`, `/reach`, `/pricing`,
`/pace`) and `apiGetInternal`/`apiPostInternal` (shared `INTERNAL_SERVICE_TOKEN`). Neither is a
person; the console itself has **no login**. OBS-4 puts the console behind admin login and moves
its reads under the admin principal **without breaking anything mid-migration**.

**Rollout (additive, layered, reversible):**

1. **ADMIN-1 lands `AdminAuthGuard`** alongside (not replacing) `InternalServiceGuard`. The
   admin route group is net-new; nothing existing changes yet.
2. **Dual-accept window** — the ops read routes accept **either** a valid admin session **or**
   the existing `INTERNAL_SERVICE_TOKEN` (a composite guard: pass if **either** succeeds). The
   console begins sending the admin session; the secret still works. **Zero downtime.**
3. **`apps/web` behind admin login** (ADMIN-7) — every page requires an admin session; the
   server-side data client attaches the admin session instead of (or alongside) the secret.
4. **Retire the secret on the read routes** — once the console is fully on admin sessions and a
   bake period passes, drop the `InternalServiceGuard` acceptance on those routes, leaving
   **`AdminAuthGuard` only**. The shared secret remains **only** for genuine service-to-service
   callers (if any) — and money routes are out of scope here (they stay as-is, tracked under
   TD33/TD50, untouched by OBS-4).

**Backward-compatibility guarantee:** at no step is a working caller cut off — the composite
guard accepts the old credential until the new one is fully adopted. **Rollback:** the dual-
accept is gated behind a config flag (`ADMIN_AUTH_ENFORCED`); flipping it back re-admits the
secret-only path instantly, with no schema change to revert. The `admin_users`/event additions
are additive, so a rollback of *enforcement* never requires a data rollback.

---

## Decision 8 — Phasing + gates

**Decided. ADMIN-1 is the hard gate; it MAY NOT BUILD until this ADR is accepted + the
security-engineer signs the RBAC matrix (Decision 3) + the PII policy (Decision 4) + the
`admin_users` design (Decision 2).**

| Phase | Scope | Gate to ENTER |
|---|---|---|
| **ADMIN-0 — this ADR** | the decision artifact (surface, identity, RBAC, PII policy, spine-RO, events, OBS-4, phasing). **No code.** | — (you are here) |
| **ADMIN-1 — auth + RBAC + DB (THE HARD GATE)** | `admin_users` table (+ enums) migration; `AdminAuthGuard` (4th principal, reuse payer session); MFA for privileged roles (enforced at session-mint, must-fix #1); `assertAdminAuthConfig` fail-closed boot (must-fix #2); `@RequireAdminRole` + `AdminRolesGuard` (one-role-per-route test, must-fix #4); the capability-matrix constant + its drift test (must-fix #5); the **spine-immutability build-blocker test (must-fix #3)**; the 4 admin events registered. | **Owner ACCEPTS this ADR + resolves OQ-1/OQ-2/OQ-6 + security-engineer signs the matrix + PII policy + table design (signed off WITH CONDITIONS 2026-06-27 — must-fix #1–5 are in this scope).** |
| **ADMIN-2 — events query API** (∥ ADMIN-3) | read-only `/admin/events` query API riding `events_event_name_idx` / `events_occurred_at_idx` / `events_subject_idx` / `events_correlation_id_idx`; correlation/causation traversal; **no** PII. | ADMIN-1 merged + green. |
| **ADMIN-3 — entity actions** (∥ ADMIN-2) | the governed mutations (suspend payer, grant credits, force-close posting, flag worker, kill-switch toggle), each behind `@RequireAdminRole` + emitting `admin.action_performed`; the **PII-reveal** route (Decision 4) emitting `admin.pii_viewed`. | ADMIN-1 merged + green. |
| **ADMIN-4..7 — UI** | the admin area in `apps/web`: events explorer, entity dashboards, action UIs (RBAC-conditioned), the reason-gated reveal UI, and (ADMIN-7) the **admin-login gate over the whole console** + OBS-4 cutover. | ADMIN-2/3 landing per surface. |
| **ADMIN-8 — security gate** | `bb-security-review` PASS on the realized admin surface (authz matrix, PII-reveal, no-PII-in-events, no-spine-mutation, session hardening) + the OBS-4 secret retirement. | All of ADMIN-1..7 merged + green. |

**SEED-1 note:** the synthetic worker/event pool (SEED-1) feeds the **events explorer + metrics
in dev/staging** so the portal can be built and demoed without real data — it is a dev fixture,
not a live-data dependency, and it never relaxes the PII or spine-RO rules.

---

## EXPLICITLY OUT — hard boundary (do not drift)

- **No admin code** until ADMIN-1's gate (owner ACCEPT + security-engineer sign-off). This ADR
  authorizes **design only**.
- **No spine mutation, ever.** No admin `UPDATE`/`DELETE` on `events` (Decision 5) — not even
  `super_admin`. Every admin mutation is a **new** event.
- **No raw PII in events / `ai_jobs` / `audit_logs` / logs / LLM input.** The PII reveal returns
  the value **only** in the response to the authenticated, reason-supplying, rate-limited admin,
  and **emits a PII-free audit event** (Decision 4/6). No bulk, no export-of-PII.
- **No principal conflation.** `AdminAuthGuard` is a **distinct 4th** principal (`typ:"admin"`,
  own Redis namespace); a worker/payer/ops-secret credential can **never** satisfy it, and no
  route is reachable by two principal classes.
- **No new app, no new framework, no new datastore.** Extend `apps/web`; reuse the locked stack
  (Next.js + NestJS + Drizzle + Redis/JWT). Adding the admin area is **not** a stack change (§3).
- **No mutation of a shipped event payload / DB column.** Additive only (§2 #8): `admin_users`
  (+ enums), the 4 PII-free events, the `admin` actor/domain + `admin_session` subject, the admin
  route group, the composite (dual-accept) guard on the read routes.
- **No money-route change.** OBS-4 covers the **read** routes only; the unlock/reveal +
  `job-postings/:id/plan` money routes stay on their current guard (TD33/TD50), untouched.
- **No SSO / no real second-factor provider** wired by this ADR — email-OTP + TOTP on the locked
  stack for v1; SSO is a deferred OPEN QUESTION.

---

## OPEN QUESTIONS — require owner / security-engineer sign-off before ADMIN-1

- **OQ-1 [security-engineer] — MFA scope.** Is MFA required for **all** admin roles, or only the
  privileged three (`super_admin`/`ops_admin`/`support`) with `analyst` on email-OTP alone?
  *Architect recommendation: MFA for all admins.*
- **OQ-2 [owner] — admin onboarding default.** Does `admin_users.status` default to `active` on
  create, or to a `pending`/invite-then-activate flow (mirroring `payers.status` default
  `pending`)? *Recommendation: invite-then-activate.*
- **OQ-3 [owner/security-engineer] — SSO.** Defer SSO/OIDC (e.g. Google Workspace) to a later
  phase, or require it for v1? *Recommendation: defer; email-OTP + TOTP for v1.*
- **OQ-4 [security-engineer] — reveal reason rigor.** Should the PII-reveal reason require a
  **linked ticket/case id** (not just a reason code + note), to make every reveal traceable to a
  worker request? *Recommendation: require a ticket id once a ticketing system exists; reason code
  + note in the interim.*
- **OQ-5 [security-engineer] — session store.** Redis-record session (recommended, reuses the
  payer mechanism) vs a DB `admin_sessions` table (DB-auditable sessions at the cost of a hot-path
  DB hit). *Recommendation: Redis for v1; add `admin_sessions` only if a DB audit-of-sessions
  requirement appears.*
- **OQ-6 [security-engineer] — kill-switch surface.** Which feature flags / kill-switches are
  `super_admin`-toggleable from the portal (e.g. the OTP global send cap = 0 pause, payer-email
  kill-switch, `AI_ENABLE_REAL_CALLS`), and which stay **env-only / deploy-gated**? *Recommendation:
  expose only operational pauses already designed as runtime knobs; keep real-provider enables
  env/deploy-gated per §5/§7.*
- **OQ-7 [owner] — admin audit retention / review cadence. RESOLVED (owner, 2026-06-27):** the
  **owner reviews `admin.pii_viewed` + `admin.action_performed` weekly**, with **1-year retention**
  of those audit events. This is the process control that makes reason-gating meaningful and is the
  standing condition that **unblocks the ADMIN-3 PII-reveal route** (the reveal route may ship once
  this cadence is in effect). Process, not code — but a precondition for ADMIN-3's reveal.

---

## STOP — sign-off required before ANY implementation

**This is a design artifact. Nothing here is built or authorized to build.** Before a single line
of `admin_users`, `AdminAuthGuard`, the admin route group, the events-query API, the entity
actions, or the PII-reveal:

1. **The owner must ACCEPT this ADR** (especially Decision 1 surface, Decision 2 the 4th
   principal + admin-class PII, and Decision 7 the OBS-4 cutover).
2. **The security-engineer must SIGN OFF** the **RBAC capability matrix (Decision 3)**, the
   **PII-reveal policy (Decision 4)**, and the **`admin_users` table design (Decision 2)** — this
   creates a highly-privileged principal with a PII-decrypt capability.
3. **Resolve OQ-1, OQ-2, OQ-4, OQ-5, OQ-6** at least, before ADMIN-1 starts.

**Do not proceed past this line without recorded owner + security-engineer sign-off.**

---

## Related

- ADR-0019 (self-serve payer portal — the 3rd principal `PayerAuthGuard`, the new-PII-class
  precedent, the surface-vs-trust-boundary reasoning this ADR mirrors-and-inverts)
- ADR-0010 (contact unlock + reveal — the no-oracle / no-bulk / rate-cap disclosure discipline the
  PII-reveal reuses) + [contact-unlock threat model](../security/contact-unlock-threat-model.md)
- ADR-0004 (PII at rest + RLS — the at-rest discipline `admin_users` inherits; the DB grant
  posture Decision 5 coordinates) + [rls-plan.md](../../infra/supabase/rls-plan.md)
- The event spine: [`packages/event-schema`](../../packages/event-schema/src) +
  [`packages/db/src/schema.ts`](../../packages/db/src/schema.ts) (`events`, the 4 indexes)
- The principals: [`worker-auth.guard.ts`](../../apps/api/src/auth/worker-auth.guard.ts) /
  [`payer-auth.guard.ts`](../../apps/api/src/payers/payer-auth.guard.ts) /
  [`internal-service.guard.ts`](../../apps/api/src/common/guards/internal-service.guard.ts) /
  [`payer-session.service.ts`](../../apps/api/src/payers/payer-session.service.ts) /
  [`payer-otp.service.ts`](../../apps/api/src/payers/payer-otp.service.ts) /
  [`pii-crypto.service.ts`](../../apps/api/src/common/pii-crypto.service.ts) /
  [`main.ts`](../../apps/api/src/main.ts) (`assertPayerAuthConfig`)
- The console: [`apps/web/src/lib/api.ts`](../../apps/web/src/lib/api.ts)
- CLAUDE.md §2 invariants 1, 2, 7, 8; §3 locked stack; §7 escalation; §8 deferred
