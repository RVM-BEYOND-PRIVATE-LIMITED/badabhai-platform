# TD25a — Reverse-proxy harness for `TRUST_PROXY_HOP_COUNT`

A local nginx that fronts the API **exactly like one honest edge hop** (it
**APPENDS** the connecting peer to `X-Forwarded-For` via
`$proxy_add_x_forwarded_for` — never replaces it). It exists to prove, on a
laptop, the two failure modes of the TD25 trust-proxy seam
([`apps/api/src/main.ts`](../../../apps/api/src/main.ts) lines 56–65):

- **hop count too LOW (0 behind a proxy):** `req.ip` = the proxy → every client
  collapses into ONE per-IP rate bucket (self-DoS + invisible abuse).
- **hop count too HIGH (or blanket `true` — banned):** the client's forged
  `X-Forwarded-For` prefix becomes `req.ip` → unlimited rotatable rate-limit
  identities (real SMS spend abuse once real OTP is live).

The CI-proven twin of this harness is the in-process regression suite
[`apps/api/src/common/rate-limit/trust-proxy-hop-count.test.ts`](../../../apps/api/src/common/rate-limit/trust-proxy-hop-count.test.ts)
(11 tests) — that suite is the durable net; this harness is the full-stack
(real nginx + real Redis) QA rig.

## Topology

```
you / curl containers ──> nginx :8088 (harness, appends XFF) ──> api :3001
                                                 └── postgres + redis (compose)
```

## How to run

Profile-gated — **nothing here starts under plain `docker compose up` or
`pnpm db:up`** (which names only `postgres redis`).

```bash
pnpm db:up && pnpm db:migrate            # postgres + redis + schema

# CORRECT single-hop config (the topology this harness emulates):
TRUST_PROXY_HOP_COUNT=1 docker compose --profile proxy-harness up --build
# PowerShell: $env:TRUST_PROXY_HOP_COUNT="1"; docker compose --profile proxy-harness up --build

curl http://localhost:8088/health        # smoke: through the proxy to the API
```

`TRUST_PROXY_HOP_COUNT` defaults to `0` in compose (`${TRUST_PROXY_HOP_COUNT:-0}`,
same fail-safe default as the config schema) — run **without** setting it to
reproduce the hop=0 collapse bug below.

## Two-client QA scenario (per-IP OTP cap, `OTP_MAX_SENDS_PER_HOUR` default 5)

Two curls from the host share one IP, so play each client from its **own
container** (each gets a distinct IP on the compose network — find the network
name with `docker network ls`, typically `<repo-dir>_default`):

```bash
NET=badabhai-platform_default   # adjust to your `docker network ls` output

# Client A: spam OTP requests (vary the phone to dodge the per-phone cooldown;
# the per-IP cap counts regardless of phone). 6th request in the hour → 429.
docker run --rm --network $NET curlimages/curl -s -o /dev/null -w "%{http_code}\n" \
  -X POST http://proxy:8080/auth/otp/request \
  -H "Content-Type: application/json" -d '{"phone":"+919000000001"}'
# ... repeat with +919000000002 … +919000000006

# Client B (separate container = separate IP): a single request.
docker run --rm --network $NET curlimages/curl -s -o /dev/null -w "%{http_code}\n" \
  -X POST http://proxy:8080/auth/otp/request \
  -H "Content-Type: application/json" -d '{"phone":"+919000000099"}'
```

Expected outcomes (the signal under test is **429 vs non-429**; with the
compose file's dummy Fast2SMS creds the *send* leg may itself fail — that does
not affect the cap check, which runs first):

| Run                                | Client A (6th req) | Client B (1st req) | Proves                                                       |
| ---------------------------------- | ------------------ | ------------------ | ------------------------------------------------------------ |
| `TRUST_PROXY_HOP_COUNT=1`          | 429                | non-429            | Per-client buckets: A's spam never touches B                  |
| hop unset (=0) behind the proxy    | 429                | **429**            | The collapse bug: everyone shares the proxy's ONE bucket      |
| hop=1 + A adds `-H "X-Forwarded-For: 1.2.3.4"` (rotate it per request) | still 429 on A's 6th | non-429 | Forged XFF ignored: nginx APPENDS A's real IP; rightmost wins |

Note: raw IPs are HMAC-hashed (`hashIp`) before any Redis key or log line — you
cannot (and should not) grep an IP in logs to verify; the 429 differential IS
the observation.

## Hop-count → topology mapping

Deploy-time lookup for the `TRUST_PROXY_HOP_COUNT` value (parent TD25 owns the
production value; pick the row that matches the real edge):

| Topology                                                                  | `TRUST_PROXY_HOP_COUNT` |
| ------------------------------------------------------------------------- | ----------------------- |
| No proxy — clients hit the API directly                                    | `0` (default, fail-safe) |
| ONE trusted edge that APPENDS XFF (this harness; a single LB/nginx/ingress) | `1`                     |
| N trusted hops, EACH appending XFF (e.g. CDN→LB→API where both append)      | `N` (count them exactly) |
| Blanket Express `trust proxy: true`                                         | **NEVER** — spoofable XFF = rotatable rate-limit identity |

Rules of thumb:

- Count only hops that **append** to `X-Forwarded-For`. A hop that **replaces**
  the header resets the chain — count from that hop outward.
- Too low ⇒ shared-bucket collapse; too high ⇒ forged prefix wins. Both are
  pinned empirically (Express 5.2.1) in the regression suite's observed table.
- Changing the value is an env-only change, but re-run the two-client scenario
  above against the new edge before trusting it.

## Verification status

- **2026-07-16 (authoring machine):** `docker info` — daemon **unavailable**, so
  this harness is **committed but locally unverified**. The Layer-1 regression
  suite (11/11 green, real Nest+Express 5.2.1 HTTP server, observed-truth pins)
  is the proven net; run the scenario table above on the first docker-capable
  machine and record the evidence here.
