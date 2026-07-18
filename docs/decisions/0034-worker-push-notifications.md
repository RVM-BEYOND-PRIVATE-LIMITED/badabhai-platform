# ADR-0034 — Server-initiated push notifications for the worker app (FCM)

- **Status:** **ACCEPTED (rev-2) + BUILT** 2026-07-17 — approved by Divyanshu (owner-delegated),
  including the `revokeAll` device-revocation change. Ships **INERT**: `PUSH_ENABLE_REAL=false`
  binds the mock provider, so nothing leaves the process until it is armed staging-first. §8
  records what the adversarial review changed and why.
- **Date:** 2026-07-17
- **Deviation from D3, deliberate:** the OAuth2 access token is minted with `node:crypto`
  (RS256 sign + token exchange, ~20 lines) rather than adding `google-auth-library`. Same HTTP v1
  REST call, **no new dependency** — matching StorageService's Mode A posture. A mis-signed
  assertion fails loudly (Google 400/401), so there is no quiet failure mode.
- **Scope ruled by owner (2026-07-17):** **SECURITY ALERTS ONLY** — `worker.device_registered` and
  `worker.logged_out_all`. Resume/profile/voice pushes are explicitly **deferred**. New-device
  alerts go to the worker's **OTHER** devices, not the one that just logged in.
- **Deciders:** Owner (Akshit), TL (Prakash), Backend (Divyanshu), Mobile (Rishi)
- **Supersedes / amends:** nothing. Additive to [ADR-0026](0026-production-worker-auth-pin-and-tiered-sessions.md)
  (trusted devices + `push_token` ingest) and the Alerts feed (`NOTIFICATION_TEMPLATES`).
- **§7 escalation:** YES — a **new external provider** (Firebase Cloud Messaging), a **new
  component** (push sender + queue), and a **real credential** (Firebase service account).

---

## 1. Context — what exists today, verified

The **receive half is already complete and wired on Android.** This ADR does not rebuild it.

| Piece | Where | State |
| --- | --- | --- |
| Native FCM SDK | [`android/app/build.gradle:61-62`](../../apps/worker-app/android/app/build.gradle#L61-L62) — `firebase-bom:34.15.0` + `firebase-messaging` | **Present** (native, not the Dart plugin) |
| Message receiver | [`MyFirebaseMessagingService.kt`](../../apps/worker-app/android/app/src/main/kotlin/com/badabhai/workerapp/MyFirebaseMessagingService.kt) — renders a tray notification | **Present** |
| Notification channel | `bb_default_channel`, [`FirebaseManager.kt:22`](../../apps/worker-app/android/app/src/main/kotlin/com/badabhai/workerapp/FirebaseManager.kt#L22) | **Present** |
| Runtime permission | `POST_NOTIFICATIONS`, `MainActivity.kt` | **Present** |
| Token **ingest** contract | `push_token` (optional, ≤512) on [`devices.dto.ts:18`](../../apps/api/src/auth/devices.dto.ts#L18) → `worker_devices.push_token` (migration 0029) | **Present, always NULL** |

A Firebase-console test push displays on a device **today**. Two gaps stop it being useful:

1. **The client never forwards its token.** [`FirebaseManager.kt:45-54`](../../apps/worker-app/android/app/src/main/kotlin/com/badabhai/workerapp/FirebaseManager.kt#L45-L54)
   acquires it and drops it; [`MyFirebaseMessagingService.kt:21`](../../apps/worker-app/android/app/src/main/kotlin/com/badabhai/workerapp/MyFirebaseMessagingService.kt#L21)
   is a literal `TODO`. So `worker_devices.push_token` is NULL for every row.
2. **There is no server-side sender.** No `firebase-admin` anywhere in `apps/api`, no push queue.

### The constraint that shapes everything below

**There is no event dispatcher in this codebase.** `EventsService` exposes only `emit`/`emitMany`;
the `events` table is the audit spine (§1) and **nothing subscribes to it**. The Alerts feed is a
**pull**: [`notifications.repository.ts`](../../apps/api/src/notifications/notifications.repository.ts)
*queries* events by an allowlist of names, scoping to a worker via three legs (subject, actor, or
`payload->>'worker_id'`), and **deliberately never selects the payload** (§2 defence in depth).

Building a general event dispatcher is an architecture change in its own right. This ADR
**does not build one** (see §5, Alternatives).

---

## 2. Decision summary

| # | Decision |
| --- | --- |
| D1 | Token bridge via **MethodChannel from the existing native Kotlin → Dart → ApiClient**. **No new pubspec package.** *(Owner approval needed if we instead add `firebase_messaging`.)* |
| D2 | New worker-authed route **`PATCH /auth/devices/me/push-token`**; device resolved from the session's `did` claim, **never a body id**. |
| D3 | Sender = **FCM HTTP v1 over `fetch`**, OAuth2 access token minted via `google-auth-library`. New `apps/api/src/push/` module behind a `PushProvider` seam (Real + Mock), mirroring `SMS_PROVIDER`. |
| D4 | Gated by **`PUSH_ENABLE_REAL` (default `false`)** + a service-account credential; `assertPushConfig` fails closed at boot. **Not** `MESSAGING_ENABLE_REAL` (that is WhatsApp / ADR-0020). |
| D5 | Fan-out = **outbox sweep over the `events` table**, reusing `NOTIFICATION_TEMPLATES` as the single source of truth, extended with a `push: boolean` field. |
| D6 | Delivery async via **BullMQ**, never inline. Token invalidated on FCM `UNREGISTERED`. |
| D7 | Push copy is **static, server-rendered, faceless** — the event payload never reaches FCM. |
| D8 | **iOS is OUT of scope.** |
| D9 | Kill-switch `PUSH_GLOBAL_MAX_SENDS_PER_DAY=0`; rollback is additive-only. |

---

## 3. Decisions in detail

### D1 — Token bridge: MethodChannel (recommended), no new package

The native SDK **already holds the token**. Two ways to get it to the API:

- **(a) MethodChannel — RECOMMENDED.** A `badabhai.workerapp/push` channel hands the token from
  Kotlin to Dart; Dart calls `ApiClient`. **No new pubspec dependency.** Consistent with the
  app's existing native-only Firebase posture and with the `badabhai.workerapp/downloads`
  channel precedent.
- **(b) Add the `firebase_messaging` Flutter plugin.** Read the token in Dart directly. This is a
  **NEW PUBSPEC PACKAGE and requires explicit owner approval** (standing rule). It also duplicates
  a native SDK that is already present, and the pubspec already carries a comment about FlutterFire
  plugin/symbol conflicts — adding a second Firebase plugin invites that class of breakage.

> **Recommendation: (a).** If the owner prefers (b), that is the approval this ADR is asking for.

**Both token sources must be wired** (they fire at different times):
- `FirebaseManager` on app start (token exists before any rotation), and
- `MyFirebaseMessagingService.onNewToken` (rotation, fires **outside** any login).

> **⚠ Rev-2 correction — `onNewToken` CANNOT call a MethodChannel.**
> `MyFirebaseMessagingService` is a standalone background `<service>`
> ([`AndroidManifest.xml:50-56`](../../apps/worker-app/android/app/src/main/AndroidManifest.xml#L50-L56))
> with the `MESSAGING_EVENT` filter. Android starts it **with no Flutter engine alive** when the app
> is backgrounded or killed — which is exactly when a token rotates. A MethodChannel needs a live
> engine, so rev-1's "onNewToken → Dart" path would silently no-op in the very case it exists for.
>
> **Implementation (Rishi):** `onNewToken` writes the token to `SharedPreferences` natively and
> does nothing else. On the next app start / resume, the Dart side reads the pending token over the
> MethodChannel and `PATCH`es it, clearing the pending flag on success. This keeps "no new package"
> intact. **A rotation is therefore delivered late (next app open), not instantly — accepted**, and
> it is why the server must never assume a token is fresh (D6 invalidation still applies).

### D2 — Token lifecycle

Today the token can only ride `POST /auth/otp/verify` inside `device_info`. That is insufficient:
**`onNewToken` rotation fires outside login**, and there is no route to update a device post-login.
A rotated token silently dead-ends and the worker stops receiving pushes.

**New route:**

```
PATCH /auth/devices/me/push-token     @UseGuards(WorkerAuthGuard)
body: { push_token: string (1..512) }   // .strict()
→ 204 No Content
```

- **Identity from the session, never the body.** The worker comes from `WorkerAuthGuard`; the
  **device** comes from the session's `did` claim (ADR-0026 Phase 2). No `worker_id`/`device_id`
  in the body — a body id here would be a direct IDOR onto another worker's device row.
- **No `did` on the session** (login without `device_info`) → **204 no-op**. Deliberate: a device
  row is created only at login with `device_info`; minting one from a bare token would create an
  unbound, un-revocable push target.
- **Idempotent**: same token ⇒ no write, no event. Client dedupes too (only send on change).
- **Consent:** `WorkerAuthGuard` only. Registering a delivery address is not AI processing, and a
  worker who revoked consent must still receive **security** notifications (`worker.logged_out_all`).
  *Consent is enforced at the FAN-OUT instead* — see D5.
- **Revoked device** ⇒ 204 no-op (never re-arm a revoked device).
- **Invalidation:** on FCM `UNREGISTERED`, the token is nulled on that device row (D6).

### D3 / D4 — The sender, and how it is gated

**Library choice: FCM HTTP v1 via `fetch`, with `google-auth-library` for the OAuth2 token.**

FCM v1 needs a short-lived OAuth2 bearer minted from a service-account JWT. Hand-rolling RS256 JWT
→ token exchange is security-sensitive and not worth owning, so we take the one focused, official
dependency for **credential minting only** and call the REST API with `fetch`. This mirrors
`StorageService`'s deliberate **Mode A** posture (REST + `fetch` + service credential, no vendor
SDK) rather than pulling the whole `firebase-admin` surface into the API.

*Alternative — `firebase-admin`:* batteries-included (retries, batch, typed error codes) but a much
larger dependency whose messaging is the only part we would use. Recorded as the fallback if v1
plumbing proves fiddly.

**Shape** — new `apps/api/src/push/`:

| File | Role |
| --- | --- |
| `push.provider.ts` | `PushProvider` interface + `PUSH_PROVIDER` DI token — the seam (mirrors `SMS_PROVIDER`) |
| `fcm.provider.ts` | Real FCM v1 sender. All FCM specifics isolated here |
| `mock.provider.ts` | Default when `PUSH_ENABLE_REAL=false` — logs a PII-free line, sends nothing |
| `push.service.ts` | Resolve target devices, render copy from the allowlist, cap check, emit events |
| `push.processor.ts` | BullMQ consumer (`PUSH_QUEUE`) |
| `push-outbox.processor.ts` | The repeatable sweep (D5) |

**Config gate — new keys in `packages/config/src/server.ts`:**

```ts
// Master gate for REAL FCM sends. booleanFromString so a falsey string stays OFF —
// fail-safe to mock, exactly like AI_ENABLE_REAL_CALLS / PAYMENTS_ENABLE_REAL.
PUSH_ENABLE_REAL: booleanFromString,                       // default false
// Firebase service-account JSON (the real secret). Never committed; staging-first.
FCM_SERVICE_ACCOUNT_JSON: z.string().min(1).optional(),
FCM_PROJECT_ID: z.string().min(1).optional(),
// Global daily send ceiling AND kill-switch. min(0) is deliberate: 0 = PAUSED.
PUSH_GLOBAL_MAX_SENDS_PER_DAY: z.coerce.number().int().min(0).default(5000),
```

> **⚠ Rev-2 — the ceiling must NOT silently drop security alerts.**
> A numeric ceiling copied from the OTP path is wrong here: OTP caps bound **real money** (paid
> SMS), whereas FCM is free, and under the ruled scope **every push is a security alert**. A cap
> that silently discards them would mean the one message class that must always arrive is the
> first thing dropped — and it drops them *preferentially*, since a breach hits whatever is queued
> at the time. Therefore:
> - `type: "security"` sends are **exempt from the numeric ceiling** (they are unbounded by count).
> - `PUSH_GLOBAL_MAX_SENDS_PER_DAY = 0` remains an **absolute kill-switch** that halts everything
>   including security — the deliberate "stop the world" lever, env-only, no redeploy.
> - A breach is **loud**: it emits `worker.push_send_failed` with `reason: "quota"`. A send is
>   never dropped silently.

```ts
// Fails CLOSED at boot: a half-configured real provider must never run silently as mock.
export function assertPushConfig(config: ServerConfig): void { /* mirrors assertMessagingConfig */ }
```

> **DO NOT reuse `MESSAGING_ENABLE_REAL` / `WHATSAPP_*`.** That is the WhatsApp invite funnel
> (ADR-0020) — a different system with a different provider and a different spend profile.
> Conflating them would make one kill-switch silently govern two unrelated outbound channels.

**Credential handling (§7 — human decision):** the service-account JSON is a real secret. It should
be a **GitHub environment secret** forwarded to the box the same way CD-1b forwards the other 12
(`env:` + `envs:` passthrough in `ci.yml`), and referenced as a `${VAR:?}` fail-loud entry in
`docker-compose.staging.yml`. **Real sends staging-first.**

> **⚠ Rev-2 — the raw JSON will NOT survive that passthrough.** A service-account key is
> multi-line JSON containing a PEM private key with embedded newlines and quotes; the drone-ssh
> `envs:` bridge exports shell variables and mangles it. **Store it base64-encoded**
> (`FCM_SERVICE_ACCOUNT_B64`), decode in `loadServerConfig`, and validate at boot that it parses
> and carries `client_email` + `private_key` — fail closed if not, so a mangled paste is caught at
> boot rather than at the first send. **Rotation:** the key is replaceable without a migration
> (swap the secret, redeploy); revoke the old key in the Firebase console. **Leak-prevention:** the
> decoded credential and every FCM response body are excluded from logs — the FCM error path must
> log only a status + a `reason` enum, never the response body (which echoes the token) and never
> the credential.

### D5 — Fan-out: an outbox sweep over the events table

**Trigger set = `NOTIFICATION_TEMPLATES`, extended with one field.** The allowlist in
[`notifications.dto.ts:51`](../../apps/api/src/notifications/notifications.dto.ts#L51) is already
the §2 safety boundary for the in-app feed. Push reuses **the same map** so the two can never drift:

```ts
interface NotificationTemplate {
  type: NotificationType;
  title: string;
  body: string;
  push: boolean;   // NEW — does this template also go out as a push?
}
```

Proposed `push` values (**product call — please confirm**):

| Event | push | Why |
| --- | --- | --- |
| `resume.generated` | ✅ | The core "your thing is ready" moment |
| `resume.regenerated` | ✅ | Same |
| `profile.confirmed` | ✅ | Milestone |
| `voice_note.transcription_completed` | ✅ | Async work finished |
| `worker.device_registered` | ✅ | **Security** — a new-device login must reach the real owner |
| `worker.logged_out_all` | ✅ | **Security** |
| `application.submitted` | ❌ | The worker *just did this*. Pushing their own action back is noise |

**Mechanism — PRODUCER-SIDE ENQUEUE.** *(Rev-2: the outbox sweep is **withdrawn** — see §8.)*

The owner narrowed scope to **two security events**, both emitted inside the auth domain
(`DevicesService.registerOnLogin` and `SessionService.revokeAll`). That collapses the sweep's only
real justification ("don't touch every producer"), while its costs stay: a first-arm backfill of
every historical event, a lossy `occurred_at` watermark, an unindexed re-scan of the audit spine
every 60s, and — worst for this use case — **up to 60s of latency on a SIM-swap warning.**

So: the **two producers enqueue directly**, at the moment they emit their event.

1. The producer emits its event as today (unchanged), then enqueues a `PUSH_QUEUE` job.
2. **Targeting is explicit per event** (no generic worker resolution — the "reuse the feed's 3-leg
   query" idea in rev-1 was wrong; that query runs worker→events, and the inverse does not exist):
   - `worker.device_registered` → **every other** non-revoked device of that worker, **excluding
     the device that just registered** (owner ruling: warn the OTHER phones).
   - `worker.logged_out_all` → the devices revoked by that operation. This is the ONE case allowed
     to target just-revoked devices, because warning them is the entire point.
3. **Skip** workers inside the ADR-0031 deletion-grace window.
4. Best-effort: a queue failure must never fail the login/logout that triggered it.

No watermark, no backfill, no sweep, no scheduler, no `/health` probe — the whole risk class is
deleted rather than mitigated. Delivery is immediate, which is what a security alert requires.

**Dedupe / audit — new table `push_deliveries`** (additive migration):

```
push_deliveries(id, event_id → events.id, device_id → worker_devices.id,
                status, attempted_at, failure_reason)
UNIQUE (event_id, device_id)      -- the dedupe key: a given event pushes to a device at most once
```

It stores **`device_id`, never the token**.

**RLS / grant posture (rev-2).** `push_deliveries` is a worker-linked identity-adjacent table, so it
carries the **same posture as its siblings** (`worker_devices`, `worker_credentials`): RLS enabled,
**no** permissive policy for `anon`/`authenticated`, reachable only by the service role. Ship it in
the same migration, not as a follow-up — a new identity table that silently lacks RLS is exactly
the drift [infra/supabase/rls-plan.md](../../infra/supabase/rls-plan.md) exists to prevent.

**DPDP erasure (ADR-0031) — mandatory, not incidental.** `push_deliveries` is a new table holding
worker-linked rows, so its erasure path must be stated, not assumed. `device_id` references
`worker_devices.id`, and `worker_devices.worker_id` is already
`references(() => workers.id, { onDelete: "cascade" })`
([`schema.ts:272`](../../packages/db/src/schema.ts#L272)). So `push_deliveries.device_id` **MUST**
be declared `onDelete: "cascade"` too, giving `workers → worker_devices → push_deliveries` — one
`DELETE` on the worker erases the chain, with no new leg needed in
`AccountDeletionService`. **A test must assert this**: a hard-delete leaves zero `push_deliveries`
rows, exactly as the existing cascade tests do. `event_id` references `events.id` and is
**deliberately NOT cascaded** — the audit spine outlives the worker by design (its rows are
PII-free), so that FK is `set null` / retained per the existing events posture.

> ### ⚠ Feedback-loop hazard — call it out explicitly
> The sweep reads `events`, and a send **emits** an event (D6). If a push-emitted event were ever
> given `push: true`, the sweep would push it, emit again, and **loop forever**. Two guards, both
> mandatory: (1) `worker.push_sent` / `worker.push_send_failed` are **never** added to
> `NOTIFICATION_TEMPLATES`; (2) the sweep hard-excludes the `worker.push_*` prefix, and a test
> asserts the allowlist and that prefix are disjoint.

### D5b — MANDATORY prerequisites (rev-2): three defects found by review

These are **not optional hardening**. Without all three, this feature ships a cross-account PII
leak and silently stops working. Each was verified against the code.

**(1) Every OTP login currently WIPES the stored push token.**
[`devices.repository.ts:49,66`](../../apps/api/src/auth/devices.repository.ts#L49-L66) writes
`pushToken: input.pushToken ?? null` on **both** the insert and the touch path. A login whose
`device_info` omits `push_token` — which is every login today, and every login from any client that
hasn't shipped the bridge — **nulls a perfectly good token**. Combined with a client that only
sends on change, it is never restored.
→ **Fix:** only overwrite when a non-null token is supplied
(`...(input.pushToken ? { pushToken: input.pushToken } : {})`). Backward compatible; a test must
assert a token SURVIVES a login that carries none.

**(2) `push_token` is not unique across workers — a shared handset leaks security alerts.**
`worker_devices` has `uniqueIndex(worker_id, device_hash)` only
([`schema.ts:292`](../../packages/db/src/schema.ts#L292)); nothing constrains `push_token`. One
phone, two workers (A logs out, B logs in — normal in this market, shared/handed-down handsets):
FCM issues the **same token** to that install, so it now sits on **both** rows. A's
"new device login" alert is delivered to **B's phone**. That is a §2 cross-account disclosure, and
it is *worse* for security copy than for anything else.
→ **Fix:** registering a token (login **or** the PATCH route) must **null that token on every other
device row that holds it** — a token addresses exactly one install, so a second holder is by
definition stale. Add a partial index on `push_token WHERE push_token IS NOT NULL` for the lookup.
A test must assert the cross-worker steal case.

**(3) `logout-all` does not stop pushes — the panic button leaks.**
`SessionService.revokeAll` ([`session.service.ts:805`](../../apps/api/src/auth/session.service.ts#L805))
kills Redis sessions and refresh families **only**; `worker_devices` rows keep `revoked_at = NULL`
and their tokens. So a worker who hits "log out everywhere" because their phone was **stolen**
leaves that handset receiving every future push, indefinitely.
→ **Fix:** `revokeAll` must also mark the worker's device rows revoked. Future fan-out targets
non-revoked devices only, so the panic button actually works; re-login re-trusts the device
(`registerOrTouch` already clears `revoked_at`,
[`devices.repository.ts:62`](../../apps/api/src/auth/devices.repository.ts#L62)). The
`worker.logged_out_all` alert is the documented exception that targets those just-revoked rows.

### D6 — §1 event-first, delivery, and invalidation

**A send emits an event** (§1: an outbound message to a worker is a real state change). Two **new**
registry entries in `packages/event-schema` — new entries, never a mutated payload (§8):

```ts
worker.push_sent        v1  { worker_id, source_event_id, type, device_count }   .strict()
worker.push_send_failed v1  { worker_id, source_event_id, reason }               .strict()
```

`reason` is a closed enum (`unregistered` | `invalid_argument` | `quota` | `transport` |
`provider_error`). **No push_token, no copy, no device hash** in either payload.

**Delivery:** always async on `PUSH_QUEUE` — never inline in a request. Retries with backoff;
terminal failures recorded on `push_deliveries` and emitted once.

**Token invalidation:** FCM v1 returns `404 NOT_FOUND` / `errorCode: UNREGISTERED` for a dead token.
On that (and only that) → **null `push_token` on the device row** and mark the delivery failed.
A transport blip must never null a good token.

### D7 — §2 PII: what may cross Google's wire

The FCM payload transits Google infrastructure. **That raises the bar, not lowers it.**

- **Copy is STATIC and server-rendered from `NOTIFICATION_TEMPLATES`.** The event payload is
  **never** read into the push — structurally identical to the feed's guarantee, where the
  repository refuses to select `payload` at all.
- **Never** in a push: employer/company name, job title, pay, phone, the worker's name, any
  free text. ADR-0024 rules employer identity **hidden from workers**; a faceless static string
  cannot breach it by construction.
- **The FCM `data` block carries** `type` (the coarse enum), a closed-enum `route`, and a
  `target` handle (below). **No `worker_id`, no event id, no employer, no identity of any kind** —
  nothing that could correlate a device to a person if the payload were observed.
- **⚠ Rev-2 — the `target` handle is REQUIRED, and it is why "no ids" needed nuance.**
  D5b.2 closes the shared-handset leak at *registration* time, but a residual race remains: a push
  already enqueued for worker A can be delivered *after* worker B logs in on that handset and
  inherits the token. With a payload carrying no identifier at all, the client **cannot tell the
  push was not for it**, so it renders A's security alert on B's screen.
  → `worker_devices` gains an opaque random `push_target` (uuid, rotated on each registration). The
  sender includes it; the client drops any message whose `target` ≠ its own stored value. It is
  **not** a worker id and is not correlatable to a person — it is a per-install nonce, so it
  satisfies the rule above while making the leak client-side suppressible. Belt **and** braces,
  deliberately, because the payload here is security copy.
- **`push_token`** stays raw at rest (it must remain usable) but **never** enters an event, log,
  `ai_jobs`, or `audit_log`. The existing lines hold this today
  ([`devices.dto.ts:11`](../../apps/api/src/auth/devices.dto.ts#L11), the ADR-0026 payloads,
  `devices.service.test.ts` asserting `push_token` never appears in a listing) — **keep them**, and
  extend the same rule to `push_deliveries` (device_id only).
- **⚠ Rev-2 correction — sends MUST be DATA-ONLY.** If the server sends an FCM `notification`
  block, Android renders it in the tray **itself** and `onMessageReceived` is never called while
  the app is backgrounded — so any client-side privacy control is structurally unreachable, and the
  lock-screen follow-up below could never work. Therefore the sender emits a **data-only** message
  (`data: { type, route }`, no `notification` block); `MyFirebaseMessagingService.onMessageReceived`
  runs in every state and renders it. This is a hard requirement of D7, not a preference.
- **Client (Rishi, same change):** render with `VISIBILITY_PRIVATE` so the text is hidden on the
  lock screen, and handle the `route` on tap — today
  [`MyFirebaseMessagingService.kt:31-39`](../../apps/worker-app/android/app/src/main/kotlin/com/badabhai/workerapp/MyFirebaseMessagingService.kt#L31-L39)
  always opens the launcher intent and ignores `data`, so a tap goes nowhere useful.
- **`route` is a CLOSED ENUM**, never a free string — an open `route` would re-introduce exactly the
  ids D7 bans. Allowed values: `devices` | `home`.

### D8 — iOS: OUT of scope

The receive half is **Android-only**: no APNs auth key, no iOS Firebase config, and while the
`platform` enum accepts `"ios"` nothing implements it. iOS is deliberately **excluded**. The sender
is platform-agnostic by design (FCM fans out to APNs once configured), so iOS is a later **additive**
step — it needs its own APNs credential and therefore its own §7 decision.

### D9 — Rollback, kill-switch, blast radius

- **Default OFF.** `PUSH_ENABLE_REAL=false` ⇒ the Mock provider; nothing is sent. The sweep's
  repeatable job is **not registered at all** when off — zero background work in the default state.
- **Kill-switch:** `PUSH_GLOBAL_MAX_SENDS_PER_DAY=0` ⇒ instant halt of all real sends, env-only,
  **no redeploy** (the `OTP_GLOBAL_MAX_SENDS_PER_DAY` prior art).
- **Rollback:** revert the module + the config keys. The migration is **additive**
  (`push_deliveries` is new; `push_token` already exists), so no down-migration is required and no
  shipped payload changes. Reverting cannot break login, the feed, or downloads.
- **Blast radius if it misbehaves:** worst case is unwanted notifications — it touches no money, no
  ranking, no PII at rest, and no existing request path.

---

## 4. Consequences

**Positive** — workers learn their resume is ready without opening the app (retention); the
security events (`device_registered`, `logged_out_all`) reach a real owner during a SIM-swap /
account-takeover attempt; one allowlist drives both the feed and push, so copy cannot drift.

**Negative / accepted** — a new external dependency on Google FCM and a real credential to steward;
a new table and a background sweep to operate; up to the sweep interval (~60s) of latency, accepted
for this product; notification fatigue is a real risk if the `push: true` set grows unchecked —
which is exactly why it is a reviewed allowlist and not a default-on rule.

---

## 5. Alternatives considered

| Option | Verdict |
| --- | --- |
| **General event dispatcher** (subscribe to the event spine) | **Rejected for now.** A real architecture change; the audit spine is not a message bus. This ADR's sweep is deliberately *not* a dispatcher — it is a single-purpose projector over a static allowlist, a far smaller commitment that can be deleted without trace. |
| **Producer-side enqueue** (each emit site also enqueues a push) | **Rejected.** Touches every producer and drifts silently the first time someone adds an event and forgets — the exact failure the allowlist exists to prevent. |
| **Hook inside `EventsService.emit`** | **Rejected.** Couples the audit spine to the push queue; an audit write must never fail because push is down, and every test that emits would need a queue mock. |
| **`firebase-admin`** | Fallback if HTTP v1 plumbing proves fiddly (see D3). |
| **`firebase_messaging` Flutter plugin** | Needs owner approval; duplicates the native SDK (see D1). |

---

## 7b. Testing strategy (rev-2 — was missing entirely)

Every item below is a **required** test, not a nice-to-have. The first four encode the defects that
review found; without them a later refactor silently reopens a PII leak.

| Must assert | Why |
| --- | --- |
| A token **survives** a login whose `device_info` carries none | D5b.1 — the silent-wipe regression |
| Registering a token **nulls it on every other worker's row** holding it | D5b.2 — the cross-account leak |
| `logout-all` leaves **no non-revoked device** with a live token | D5b.3 — the panic button |
| Client **drops** a message whose `target` ≠ its own | D7 — the residual shared-handset race |
| `worker.device_registered` targets **every device EXCEPT** the new one | The owner's SIM-swap ruling |
| A worker in the ADR-0031 grace window gets **no push** | Erasure posture |
| Hard-delete leaves **zero** `push_deliveries` rows | Cascade (D5) |
| Push copy contains **no** employer/company/pay/name | §2 — mirror the existing `notifications.service.test.ts` copy guard |
| `PUSH_ENABLE_REAL=false` ⇒ the real provider is **never constructed** and nothing is sent | The gate is inert by default |
| The queue job payload carries **no token, no name, no copy** | §2 refs-only |

> **Build trap:** `packages/event-schema/src/event-schema.test.ts` asserts an **exact event count**
> ("exposes all N event names"). Adding the two `worker.push_*` events **will fail it** until the
> number is bumped — expected, not a regression. *(Same trap the ADR-0032 photo work hit at
> 102 → 104.)* Add the two smuggle-rejection tests alongside it: neither payload may accept a
> `push_token`.

---

## 8. Revision log

**Rev-1 → Rev-2 (2026-07-17), after a 4-lens adversarial review + owner scope ruling.**

Owner rulings applied: scope narrowed to **security alerts only**; new-device alerts go to the
worker's **other** devices; **no new pubspec package** (native bridge).

Design changes forced by the review — all three verified against code, not theoretical:

| Was (rev-1) | Now (rev-2) | Why |
| --- | --- | --- |
| Outbox sweep over `events` | **Producer-side enqueue** (D5) | With 2 auth-domain events the sweep bought nothing and cost a first-arm backfill flood, a lossy watermark, an unindexed spine re-scan, and ~60s latency on a **SIM-swap warning**. Whole risk class deleted. |
| "Reuse the feed's 3-leg worker resolution" | **Explicit per-event targeting** (D5) | The claim was **false**: the feed query runs worker→events; the inverse does not exist. |
| Login stores the token | **Never null on a token-less login** (D5b.1) | `pushToken ?? null` wipes a good token on every login that omits one. |
| `push_token` unconstrained | **Steal-on-register + partial index** (D5b.2) | A shared handset put one token on two workers' rows → **A's security alert delivered to B's phone**. |
| `logout-all` untouched | **Also revokes device rows** (D5b.3) | The panic button left a **stolen** handset receiving pushes forever. |
| `onNewToken` → MethodChannel | **Persist natively, forward on next app start** (D1) | The FCM service runs with **no Flutter engine**; rev-1's path would no-op exactly when it mattered. |
| `notification` or data payload | **Data-only, mandatory** (D7) | A `notification` block is rendered by Android itself, making the lock-screen privacy control unreachable. |
| `route` free string | **Closed enum** (D7) | An open field re-introduces the ids D7 bans. |
| `push_deliveries` FK unspecified | **`onDelete: cascade`** (D5) | Erasure (ADR-0031) would otherwise strand rows. |

Findings **accepted as known limits**, not fixed: token rotation is delivered late (next app open);
a worker who denies `POST_NOTIFICATIONS` still registers a token and sends are dropped by the OS;
copy is Hinglish-only.

---

## 6. Open questions — please rule before build

**Ruled (2026-07-17):** ~~token bridge~~ → native, no new package. ~~push set~~ → **security only**.
~~new-device targeting~~ → **other devices**. ~~go-ahead~~ → Divyanshu approved rev-1 scope.

**Still open:**

1. **Re-confirm rev-2.** The three defects in D5b change behaviour *outside* the push module — they
   touch `devices.repository` (token retention + steal-on-register) and `SessionService.revokeAll`
   (device revocation on logout-all). **`revokeAll` revoking devices is a real behaviour change to
   an existing security flow** and deserves an explicit yes, not an implied one.
2. **Credential:** who provisions the Firebase service account, and is the
   GitHub-environment-secret → box passthrough the right home? *(§7 — real secret. **Not needed to
   build**; only to switch on.)*
3. **iOS:** confirm **out of scope**.
4. **Sender library:** confirm **HTTP v1 + `google-auth-library`** over `firebase-admin`.
5. **Deferred set:** resume/profile/voice pushes are parked. Re-open when? *(Product — note the
   producer-side design means adding them later touches those producers; if the set grows past a
   handful, revisit the sweep.)*

---

## 7. References

- [ADR-0024](0024-worker-visible-job-fields-pii.md) — employer identity hidden from workers
- [ADR-0026](0026-production-worker-auth-pin-and-tiered-sessions.md) — trusted devices, `did` claim, `push_token` ingest
- [ADR-0020](0020-whatsapp-invite-funnel-and-reengagement.md) — WhatsApp funnel (**a different system**)
- [ADR-0031](0031-account-deletion-grace-window.md) — repeatable-sweep prior art
- `apps/api/src/notifications/` — the Alerts feed + `NOTIFICATION_TEMPLATES`
- CLAUDE.md §1 (event-first), §2 (no raw PII), §7 (escalation), §8 (backward compatibility)
