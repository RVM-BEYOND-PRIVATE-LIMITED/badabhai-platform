# OTP Throttles — Operations Runbook

Owner: Backend Platform. Companion to `docs/observability-runbook.md`.

Written out of #1306, where OTP send returned **429 → "OTP bhejne ki limit ho gayi"** on the
*first* send to a freshly-changed number. This runbook exists so the next person answers that
question from logs in two minutes instead of reasoning about it from the code.

---

## 1. First: which throttle actually fired?

The client cannot tell you. `auth_api.dart` maps **every** 429 to the same Hindi string, and the
API returns byte-identical neutral 429s across all throttles on purpose — no enumeration oracle.

The server can. `OtpService.refused()` logs a PII-free line on every refusal:

```
OTP refused phone_hash=<8char> reason=<slug>
```

### First, on the box: the compose preamble (every command below needs it)

`docker-compose.staging.yml` pins both service images as `${API_IMAGE:?}` / `${AI_SERVICE_IMAGE:?}`,
and **compose interpolates the whole file before it filters by service or profile** — so *every*
command in this runbook, including a read-only `logs`, aborts with `required variable API_IMAGE is
missing a value` unless both are exported. Do this once per shell:

```bash
cd ~/deployments/badabhai-platform     # wherever the project lives on the box

# The currently-deployed immutable tags. Read them off the running containers so you
# cannot accidentally pin a different build than the one you are debugging.
export API_IMAGE=$(docker inspect --format '{{.Config.Image}}' $(docker compose ls -q 2>/dev/null; echo) 2>/dev/null || true)
# If that comes back empty, read them directly:
docker ps --format '{{.Names}}\t{{.Image}}' | grep -E 'api|ai-service'
# then set them explicitly from that output:
#   export API_IMAGE=ghcr.io/<owner>/badabhai-platform/badabhai-api:sha-<short7>
#   export AI_SERVICE_IMAGE=ghcr.io/<owner>/badabhai-platform/badabhai-ai-service:sha-<short7>

# Shorthand used for the rest of this runbook:
alias dc='docker compose -f docker-compose.yml -f docker-compose.staging.yml --profile api'
```

Then:

```bash
dc logs api --since 30m | grep -E "OTP refused|cap reached|failing closed"
```

| `reason` slug | What it means | Lever |
|---|---|---|
| `deleted_phone_tombstone` | Number was hard-deleted; re-registration cool-down still running | §3 |
| `resend_cooldown` | Within `OTP_RESEND_COOLDOWN_SECONDS` (30s) of the last send | wait |
| `phone_hourly_cap` | `OTP_MAX_SENDS_PER_HOUR` (5) for **this number** this UTC hour | §2 |
| `phone_daily_cap` | `OTP_MAX_SENDS_PER_DAY` (10) for **this number** this UTC day | §2 |
| `Global daily cap reached scope=…` | `OTP_GLOBAL_MAX_SENDS_PER_DAY` — **platform-wide**, everyone is 429ing | §4 |
| `…failing closed` | Redis is unreachable; limiters reject rather than uncap | §5 |

**A 429 with no matching line is not an OTP throttle** — `OtpService` logs all of its own
refusals, so a silent 429 came from the per-device sender cap in the controller (which refuses
without a `reason` line) or from something in front of the API.

The sender cap's Redis keys are `ratelimit:dev:<scope>:<hash>:<YYYYMMDDHH>` when the caller sent
an `X-Device-Id`, and `ratelimit:ip:<scope>:…` when it did not (`senderOf` falls back to the
address). There is **no** `ratelimit:sender:` namespace — scanning for one returns nothing and
would wrongly clear the per-device cap as a suspect:

```bash
dc exec redis redis-cli --scan --pattern 'ratelimit:dev:otp_request:*' | head
dc exec redis redis-cli --scan --pattern 'ratelimit:ip:otp_request:*'  | head
```

---

## 2. The knobs, and where they actually live

⚠️ **Before #1306 none of these reached production.** There is no `env_file:` on the api service,
no `dotenv` in `apps/api` or `packages/config`, and none of these names were in the compose
overlay or the CI `envs:` bridge. Setting them in a GitHub secret or the box's `.env` did
**nothing** — every environment silently ran the zod defaults, including the "env-only, no
redeploy" kill-switch, which had never been armable.

They are now declared in `docker-compose.staging.yml`. To change one on the box:

```bash
# 1. PERSIST it in the project .env that compose reads for interpolation.
#    NOT a bare `export` — see the warning below.
echo 'OTP_GLOBAL_MAX_SENDS_PER_DAY=0' >> .env

# 2. recreate the api container so the new value is baked into its env
#    (the §1 preamble must already be sourced for the image pins)
dc up -d --no-deps api

# 3. confirm the process actually sees it
dc exec api printenv OTP_GLOBAL_MAX_SENDS_PER_DAY
```

⚠ **Persist it, do not just `export` it.** A shell `export` lives only in that SSH session, and the
container keeps the value only until it is next recreated. The staging deploy job recreates the api
container on **every merge to `main`** — so a kill-switch armed by `export` is silently disarmed by
the next unrelated PR that lands, with no alert and no log line saying the pause ended. Writing it
to the project `.env` survives the redeploy, because that is the file compose interpolates from.

⚠ **Audit the box before trusting the defaults.** These names became live only in #1306; before
that they were declared nowhere, so anything already sitting in the box's `.env` or shell profile
was inert and may never have been cleaned up. A stale `OTP_MAX_SENDS_PER_DEVICE_PER_HOUR=20` left
over from the #1035 investigation would now take effect and silently reinstate the very outage
#1306 fixed. Check once, before you trust any value in the table below:

```bash
grep -E '^(OTP_|ACCOUNT_DELETION_)' .env 2>/dev/null || echo '(nothing pinned in .env — defaults apply)'
dc exec api printenv | grep -E '^(OTP_|ACCOUNT_DELETION_)' | sort
```

Step 3 is not optional. The failure mode this runbook was written for is a knob that looks set
and is not.

| Var | Default | Scope | Principals affected |
|---|---|---|---|
| `OTP_MAX_SENDS_PER_DEVICE_PER_HOUR` | 200 | one handset (`X-Device-Id`), per UTC hour | worker + **test-login seam** |
| `OTP_MAX_SENDS_PER_HOUR` | 5 | one phone/email, per UTC hour | ⚠ worker + **admin** + **payer** |
| `OTP_MAX_SENDS_PER_DAY` | 10 | one phone number, per UTC day | worker |
| `OTP_RESEND_COOLDOWN_SECONDS` | 30 | one phone/email, between sends | ⚠ worker + **admin** + **payer** |
| `OTP_MAX_VERIFY_PER_DEVICE_PER_HOUR` | 1000 | one handset, verify calls | worker |
| `OTP_GLOBAL_MAX_SENDS_PER_DAY` | 10000 | **whole platform**, per UTC day | worker SMS only |
| `PAYER_OTP_GLOBAL_MAX_SENDS_PER_DAY` | 2000 | **whole platform**, per UTC day | payer email only |
| `ACCOUNT_DELETION_COOLDOWN_SECONDS` | 604800 | post-deletion tombstone TTL | worker |

⚠ **Two of these are not worker-only.** `OTP_MAX_SENDS_PER_HOUR` and `OTP_RESEND_COOLDOWN_SECONDS`
are read by all three OTP principals — `OtpService` (worker SMS), `AdminOtpService`
(`admin-otp.service.ts`) and `PayerOtpService` (`payer-otp.service.ts`). Raising
`OTP_MAX_SENDS_PER_HOUR` to unblock worker sign-ins **also loosens the admin-portal and payer-portal
OTP send caps by the same factor**, on channels with their own spend. If you only mean to move the
worker budget, prefer `OTP_MAX_SENDS_PER_DAY` (worker-only) or the per-device cap, and say in the
incident log that you knowingly moved a shared knob.

Two more knobs are also derived or paired, and moving one alone is a defect:

- `OTP_MAX_VERIFY_PER_DEVICE_PER_HOUR` **must** stay `OTP_MAX_SENDS_PER_DEVICE_PER_HOUR ×
  OTP_MAX_ATTEMPTS`. A handset inside its send budget can legitimately produce that many verifies,
  so raising the send cap alone makes *verify* the binding constraint — the worse failure, where a
  worker holds a valid code they cannot spend. There is a test on this ratio; it will fail you.
- The device cap is shared with `POST /auth/test-login`, whose own ceiling is
  `TEST_LOGIN_MAX_PER_DAY` (200/day). That day ceiling currently binds first; do not raise it
  without giving test-login its own sender knob.

Keep the compose defaults in sync with `packages/config/src/server.ts` — that file is
authoritative, the compose block mirrors it.

---

## 3. Deleted-phone tombstone (`reason=deleted_phone_tombstone`)

The DPDP deletion path — the grace-elapse sweep that erases an account once its ADR-0031 window
runs out — sets `deleted_phone:<phoneHash>` with a 7-day TTL (ADR-0026 Phase 5, DPDP
re-registration cool-down). Any OTP send to that number returns the neutral 429 for a week.

Note the tombstone is keyed **per phone hash**: it can only explain the symptom for a number that
was itself deleted. A genuinely new number 429ing is a different cause.

### The QA trap — FIXED, and what to expect now

This **used to** be the first thing to suspect. With `TEST_IMMEDIATE_DELETE_ENABLED` armed
(#1264), the QA "Delete account (test)" button set the same tombstone, so every test number QA
deleted was unreachable for 7 days — and switching to *another* recently-deleted test number did
not help. It presented exactly as "429 on the first send to a fresh number", which is how #1306
was reported.

**`POST /auth/account/delete/immediate` no longer sets the tombstone.** It calls
`AccountDeletionService.execute` with `setReregistrationCooldown: false`, so a number deleted
through the QA button can re-register immediately. The erasure itself is unchanged and still
complete — sessions revoked, storage swept, row removed, event emitted; only the cool-down is
skipped. The graced DPDP path passes no options and still sets it: that control is not weakened.

So on a current build, `reason=deleted_phone_tombstone` after a QA delete means something is
wrong — most likely the box is running an image that predates this change. Check the deployed
`GIT_COMMIT_SHA` on `/health` before hunting further. A tombstone from a REAL (graced) deletion is
still expected and still correct.

Tombstones written before this shipped do not expire retroactively — clear them with §3's
commands below.

### Clear the tombstones (unblocks the numbers immediately)

`SCAN`, never `KEYS` — `KEYS` blocks the single-threaded Redis that also holds every worker
session.

```bash
# INSPECT FIRST — count what you are about to delete, and eyeball a few
dc exec redis redis-cli --scan --pattern 'deleted_phone:*' | wc -l
dc exec redis redis-cli --scan --pattern 'deleted_phone:*' | head

# then delete
dc exec redis sh -c "redis-cli --scan --pattern 'deleted_phone:*' | xargs -r -n 100 redis-cli DEL"
```

`deleted_phone:` is the only key namespace with that prefix (the pattern cannot over-match another
limiter's keys), and `xargs -r` is a no-op on empty input, so the delete is safe to run when the
scan returns nothing.

The key is a keyed HMAC blind index — it is **not** reversible to a phone number, so you cannot
clear one specific tester's number by inspection. Clearing all of them on staging is the intended
move; on production it re-opens registration for anyone inside their cool-down, so treat it as an
anti-abuse decision, not a cleanup.

### Or disable the cool-down entirely

`ACCOUNT_DELETION_COOLDOWN_SECONDS=0` disables it on **both** sides as of #1306 — the write
(`AccountDeletionService` mints no key) and the read (`OtpService` does not consult one). Before
#1306 only the write honoured it, so `0` left already-minted keys refusing sends for their full
remaining TTL, and the switch looked broken for a week.

**`0` does not erase existing keys** — it stops them being consulted. Combine with the SCAN above
if you also want the residue gone.

---

## 4. Global breaker (`Global daily cap reached`)

`OTP_GLOBAL_MAX_SENDS_PER_DAY` bounds **real Fast2SMS sends platform-wide per UTC day**. It is the
spend ceiling and the worker-SMS kill-switch (`0` = paused). The admin kill-switch surface reports
it as `worker_otp_sms`.

**This is a shared fuse — treat tripping it as an incident, not a rate limit.** Once exhausted,
every worker on the platform 429s until UTC midnight; it does not single out whoever burned it.
That is why #1306 raised it from 2000 to 10000: with the per-network ceiling removed and the
per-device one rotatable, ~2000 requests bought a single actor a day-long platform sign-in outage.

If it trips:

1. Confirm it is real spend and not a loop — check the send-rate over the last hour.
2. If abuse: `OTP_GLOBAL_MAX_SENDS_PER_DAY=0` halts all real spend immediately (§2 to apply it).
3. The counter is **`otp:global_sendcount:<YYYYMMDD>`** (`OtpService.globalSendCountKey`) and
   self-expires at UTC midnight. Deleting it resets the day's budget — do that only once you know
   why it filled.

   ```bash
   dc exec redis redis-cli GET  "otp:global_sendcount:$(date -u +%Y%m%d)"
   dc exec redis redis-cli TTL  "otp:global_sendcount:$(date -u +%Y%m%d)"
   # only after you know why:
   dc exec redis redis-cli DEL  "otp:global_sendcount:$(date -u +%Y%m%d)"
   ```

   ⚠ **Not `ratelimit:global:*`.** That namespace belongs to `IpRateLimit.assertWithinGlobalDailyCap`,
   which backs the D-3 test-login ceiling — a different limiter. Deleting it does nothing to the OTP
   spend budget and quietly resets the test-login seam's daily ceiling instead.

Revisit the ceiling against real volume: when organic daily sends routinely exceed ~20% of it, the
headroom that makes it safe is gone.

---

## 5. Redis unhealthy (`failing closed`)

Every OTP limiter **fails closed** by design — a Redis outage must never uncap the auth path.
Note the two different status codes, because they point at different code:

- **429** from the sender cap (`IpRateLimit`) — reads as a rate limit to the user.
- **503** from `OtpService`'s own Redis errors — reads as "temporarily unavailable".

An intermittently-unhealthy Redis therefore produces **phone-independent 429s on the very first
send**, which is another exact match for the #1306 symptom. Check before touching any cap:

```bash
dc exec redis redis-cli PING
dc exec redis redis-cli INFO memory  | grep -E "used_memory_human|maxmemory_human|maxmemory_policy"
dc exec redis redis-cli INFO stats   | grep -E "rejected_connections|expired_keys"
dc exec redis redis-cli INFO clients | grep -E "connected_clients|blocked_clients"
free -h                              # the BOX's memory — this Redis has no maxmemory of its own
```

This Redis runs `noeviction` with **no `maxmemory`** and also holds every worker session — a full
Redis 429s the limiters, 503s the OTP path and 401s every session at once.

⚠ **Do not look for `evicted_keys`.** Under `noeviction` with no ceiling it is *structurally always
0*, so reading it as "Redis is healthy" is exactly backwards — that config is precisely the one
where Redis grows until the **host** runs out and the OOM killer takes it, evicting nothing on the
way. The real signals are `used_memory_human` climbing against `free -h` on the box,
`rejected_connections > 0`, and `maxmemory_policy:noeviction` with `maxmemory:0` confirming there
is no safety valve.

The largest self-inflicted keyspace on this path is idempotency reservations
(`otp_idem:*`, 180s TTL) — one per distinct `Idempotency-Key`, written on the unauthenticated
verify route ahead of a rotatable cap. If memory is climbing, count them:

```bash
dc exec redis redis-cli --scan --pattern 'otp_idem:*' | wc -l
```

---

## 6. What the caps do and do not defend (#1306)

Ranked by what it costs an abuser to step over:

| Gate | Bypass cost | Who it binds in practice |
|---|---|---|
| Per-device (`X-Device-Id`, 200/hr) | **~zero** — pick a new uuid | honest clients; runaway retry loops |
| Per-phone (5/hr, 10/day) + cooldown | **cannot** for a given number | anyone texting one number |
| Global daily (10000) | **cannot** | the platform's daily bill |

`X-Device-Id` is an unauthenticated, caller-chosen header (`senderOf` accepts any 8–256 char
string; no attestation). **The per-device cap is not a security boundary** — it is a runaway-client
breaker, sized so no human reaches it but a stuck loop does. Do not tighten it expecting it to stop
an abuser; it will only start 429ing QA again.

The per-network ceilings (`otp_request_net`, `otp_verify_net`) were **removed** in #1306. Keyed on
`req.ip` with `TRUST_PROXY_HOP_COUNT=0` and no reverse proxy, that bucket is the NAT egress address
— under carrier CGNAT, thousands of unrelated workers share one. It could only bind honest traffic
while an abuser rotated device ids past it. `OTP_MAX_SENDS_PER_IP_PER_HOUR` still exists and is
read by the D-3 `test_login_net` ceiling only.

**Real spend is bounded by the per-phone caps and the global fuse. Nothing else.** Any future
proposal to tighten a caller-keyed cap should start here.
