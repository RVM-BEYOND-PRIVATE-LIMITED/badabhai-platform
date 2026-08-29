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

On the box:

```bash
docker compose -f docker-compose.yml -f docker-compose.staging.yml --profile api \
  logs api --since 30m | grep -E "OTP refused|cap reached|failing closed"
```

| `reason` slug | What it means | Lever |
|---|---|---|
| `deleted_phone_tombstone` | Number was hard-deleted; re-registration cool-down still running | §3 |
| `resend_cooldown` | Within `OTP_RESEND_COOLDOWN_SECONDS` (30s) of the last send | wait |
| `phone_hourly_cap` | `OTP_MAX_SENDS_PER_HOUR` (5) for **this number** this UTC hour | §2 |
| `phone_daily_cap` | `OTP_MAX_SENDS_PER_DAY` (10) for **this number** this UTC day | §2 |
| `Global daily cap reached scope=…` | `OTP_GLOBAL_MAX_SENDS_PER_DAY` — **platform-wide**, everyone is 429ing | §4 |
| `…failing closed` | Redis is unreachable; limiters reject rather than uncap | §5 |

**A 429 with no matching line is not an OTP throttle.** Check the per-device sender cap
(`ratelimit:sender:otp_request:…`) and anything in front of the API.

---

## 2. The knobs, and where they actually live

⚠️ **Before #1306 none of these reached production.** There is no `env_file:` on the api service,
no `dotenv` in `apps/api` or `packages/config`, and none of these names were in the compose
overlay or the CI `envs:` bridge. Setting them in a GitHub secret or the box's `.env` did
**nothing** — every environment silently ran the zod defaults, including the "env-only, no
redeploy" kill-switch, which had never been armable.

They are now declared in `docker-compose.staging.yml`. To change one on the box:

```bash
# 1. export it (or add it to the project .env compose reads for interpolation)
export OTP_GLOBAL_MAX_SENDS_PER_DAY=0

# 2. recreate the api container so the new value is baked into its env
export API_IMAGE=<the sha- tag currently deployed>   # both image pins are required
export AI_SERVICE_IMAGE=<the sha- tag currently deployed>
docker compose -f docker-compose.yml -f docker-compose.staging.yml --profile api \
  up -d --no-deps api

# 3. confirm the process actually sees it
docker compose -f docker-compose.yml -f docker-compose.staging.yml --profile api \
  exec api printenv OTP_GLOBAL_MAX_SENDS_PER_DAY
```

Step 3 is not optional. The failure mode this runbook was written for is a knob that looks set
and is not.

| Var | Default | Scope |
|---|---|---|
| `OTP_MAX_SENDS_PER_DEVICE_PER_HOUR` | 200 | one handset (`X-Device-Id`), per UTC hour |
| `OTP_MAX_SENDS_PER_HOUR` | 5 | one phone number, per UTC hour |
| `OTP_MAX_SENDS_PER_DAY` | 10 | one phone number, per UTC day |
| `OTP_RESEND_COOLDOWN_SECONDS` | 30 | one phone number, between sends |
| `OTP_MAX_VERIFY_PER_DEVICE_PER_HOUR` | 1000 | one handset, verify calls (= sends x OTP_MAX_ATTEMPTS) |
| `OTP_GLOBAL_MAX_SENDS_PER_DAY` | 10000 | **whole platform**, per UTC day |
| `ACCOUNT_DELETION_COOLDOWN_SECONDS` | 604800 | post-deletion tombstone TTL |

Keep the compose defaults in sync with `packages/config/src/server.ts` — that file is
authoritative, the compose block mirrors it.

---

## 3. Deleted-phone tombstone (`reason=deleted_phone_tombstone`)

Hard-deleting an account sets `deleted_phone:<phoneHash>` with a 7-day TTL (ADR-0026 Phase 5,
DPDP re-registration cool-down). Any OTP send to that number returns the neutral 429 for a week.

**This is the QA trap.** With `TEST_IMMEDIATE_DELETE_ENABLED` armed on staging (#1264), every test
number QA deletes is unreachable for 7 days — and switching to *another* recently-deleted test
number does not help. It presents exactly as "429 on the first send to a fresh number", which is
how #1306 was reported. Note the tombstone is keyed **per phone hash**: it can only explain the
symptom for a number that was itself deleted. A genuinely new number 429ing is a different cause.

### Clear the tombstones (unblocks the numbers immediately)

`SCAN`, never `KEYS` — `KEYS` blocks the single-threaded Redis that also holds every worker
session.

```bash
# INSPECT FIRST — count what you are about to delete
docker compose -f docker-compose.yml -f docker-compose.staging.yml --profile api \
  exec redis redis-cli --scan --pattern 'deleted_phone:*' | wc -l

# then delete
docker compose -f docker-compose.yml -f docker-compose.staging.yml --profile api \
  exec redis sh -c "redis-cli --scan --pattern 'deleted_phone:*' | xargs -r -n 100 redis-cli DEL"
```

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
3. The counter is `ratelimit:global:…:<YYYYMMDD>` and self-expires at UTC midnight. Deleting that
   key resets the day's budget — do it only after you know why it filled.

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
docker compose -f docker-compose.yml -f docker-compose.staging.yml --profile api \
  exec redis redis-cli PING
docker compose -f docker-compose.yml -f docker-compose.staging.yml --profile api \
  exec redis redis-cli INFO stats | grep -E "evicted_keys|rejected_connections"
docker compose -f docker-compose.yml -f docker-compose.staging.yml --profile api \
  exec redis redis-cli INFO memory | grep -E "used_memory_human|maxmemory"
```

This Redis runs `noeviction` with no `maxmemory` and also holds every worker session — a full
Redis 429s the limiters, 503s the OTP path and 401s every session at once. `evicted_keys > 0` or
memory near a ceiling is the finding.

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
