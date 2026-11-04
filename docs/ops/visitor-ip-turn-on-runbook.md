# Visitor-IP rate limits — turn-on and rollback runbook (#2542, TD25)

**What this arms.** Every per-IP cap in the api (`ratelimit:ip:*` in Redis) is keyed on `req.ip`.
With `TRUST_PROXY_HOP_COUNT=0` (the default) `req.ip` is the socket peer, so on the box every
request that came through nginx shares ONE bucket, and every payer-web server-side call shares
payer-web's container address. Setting the `production` secret `TRUST_PROXY_HOP_COUNT=1` makes
the api trust exactly one `X-Forwarded-For` hop:

- app / browser traffic to the api host: `req.ip` = the address nginx appended (the visitor);
- payer-web server-side calls: payer-web forwards the visitor (the last entry nginx appended to
  ITS request, public addresses only) as its own `X-Forwarded-For`, so `req.ip` = the visitor;
- admin-web: tunnel-only (`127.0.0.1:3003`, no nginx block) and forwards nothing, so its calls
  stay in one bucket shared by the admins. Direct `/admin/*` hits on the api host through nginx
  get per-visitor buckets.

**Design S (owner ruling, 2026-11-04).** No secret, no api middleware. The accepted residual: a
process on the box's compose network can claim any address by setting `X-Forwarded-For`. What
makes hop 1 safe for everyone else is that nothing else reaches the api or payer-web: both
publish on `127.0.0.1` only (#2542, enforced by `published-port-binding-compose.guard.test.ts`)
and the firewall admits only 80/443.

**Dormant until step 5.** Merging the PR changes nothing: the secret is absent, the bridge
exports an empty string, compose's `${TRUST_PROXY_HOP_COUNT:-0}` resolves it to 0. The bridge is
`ci.yml` deploy `env:` + `envs:` → box shell → `docker-compose.staging.yml` (api). The deploy
preflight (`scripts/deploy/staging-deploy.sh`) refuses any value except empty / `0` / `1`
before a container moves: 2 or more would trust an entry the client wrote.

Hosts below: `API` = `43-204-36-199.sslip.io`, `PAYER` = `payer.43-204-36-199.sslip.io`.

## Pre-checks (all read-only)

1. **The loopback binds are live.** The first deploy after the #2542 PR recreates the api and
   payer-web. On the box:

   ```bash
   docker ps --format '{{.Names}}\t{{.Ports}}' | grep -E 'badabhai-api|payer-web'
   # expect 127.0.0.1:3001->3001/tcp and 127.0.0.1:3333->3002/tcp — no 0.0.0.0 / ::: entry
   bash scripts/deploy/r38-port-audit.sh   # api + payer-web must NOT be listed as offenders
   ```

   The audit still lists the stale `adminer` (`0.0.0.0:8080`) and compose `postgres`
   (`0.0.0.0:5432/5433`) containers. The owner left them in place and the risk is logged. The
   firewall is what keeps them unreachable.

2. **Firewall.** In the Lightsail console, only 80/443 (plus SSH) accept inbound traffic. From
   OUTSIDE the box, each of these must fail (time out or be refused):

   ```bash
   # a raw TCP connect, so non-HTTP ports (postgres) are tested too; prints only what is OPEN
   for p in 3001 3333 3003 8000 8080 5432 5433; do timeout 5 bash -c "</dev/tcp/43.204.36.199/$p" 2>/dev/null && echo "OPEN $p"; done
   ```

3. **nginx matches the recorded facts** (`docs/environment-variables.md`, Reverse proxy):

   ```bash
   sudo nginx -T 2>/dev/null | grep -nE 'server_name|listen|location|proxy_pass|proxy_set_header|real_ip|default_server'
   ```

   - The API and PAYER `:443` blocks each have ONE `location /`, with
     `proxy_pass http://127.0.0.1:3001` (payer: `127.0.0.1:3333`) and
     `proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;`.
   - No `real_ip_header` / `set_real_ip_from`.
   - The port-80 blocks only redirect.
   - There is no admin-web block.
   - **If any other `location` that proxies has appeared, it must set `X-Forwarded-For` itself.**
     A `location` with its own `proxy_set_header` drops ALL inherited ones. Without the
     directive, nginx passes the client's own header through and hop 1 trusts it.

4. **The api reads 0 today.** `docker exec badabhai-api printenv TRUST_PROXY_HOP_COUNT` → `0`.

5. **DNS goes straight to the box** (a CDN would be a second hop and make 1 wrong):

   ```bash
   dig +short 43-204-36-199.sslip.io; dig +short payer.43-204-36-199.sslip.io   # both 43.204.36.199
   curl -sI https://43-204-36-199.sslip.io/health | grep -iE '^(via|cf-ray|x-cache|x-amz-cf-id):'   # nothing
   ```

6. **payer-web forwards the visitor.** The payer-web change from the #2542 work is on main and
   deployed: `curl -s https://PAYER/health` reports a `build` at or after that merge.

## Baseline (on the box, in the same UTC hour as the checks below)

Keys are `ratelimit:ip:<scope>:<hmac32>:<YYYYMMDDHH>`. The address is HMAC'd and never visible.
`SCAN` is non-blocking and read-only. Never use `KEYS`.

```bash
H=$(date -u +%Y%m%d%H)
snap() { docker exec badabhai-redis redis-cli --scan --pattern "ratelimit:ip:$1:*:$H" | sort; }
for s in invite_click payer_auth admin_auth; do printf '%-13s %s\n' "$s" "$(snap "$s" | wc -l)"; done
```

Expect very few keys per scope today: nginx's address plus a container address. That small
count is the bug, observed.

## Turn on

```bash
gh secret set TRUST_PROXY_HOP_COUNT --env production --body 1     # an ENVIRONMENT secret
```

Then redeploy. **Re-run the deploy job of the LATEST main run.** Re-running an older run's job
deploys that older commit.

```bash
RUN=$(gh run list --workflow ci.yml --branch main --event push --limit 1 --json databaseId -q '.[0].databaseId')
JOB=$(gh run view "$RUN" --json jobs -q '.jobs[] | select(.name=="Deploy to AWS Lightsail") | .databaseId')
gh run rerun "$RUN" --job "$JOB" && gh run watch "$RUN"
gh run view "$RUN" --json jobs -q '.jobs[] | select(.name=="Deploy to AWS Lightsail") | .conclusion'   # success
```

Read the **job** conclusion, not the run's. Then confirm on the box:
`docker exec badabhai-api printenv TRUST_PROXY_HOP_COUNT` → `1`.

## Verify — no logs needed

Use two different public networks: **A** = a phone on mobile data (hotspot), **B** = office or
home wifi. Use an unknown, well-formed code (`000000000000`). Both routes answer it neutrally and
count it against the `invite_click` scope **before** they look the code up:

- `GET /r/<code>` on the api host;
- payer-web's `/i/<code>` page, which pings `POST /invites/<code>/click` server-side.

Do not follow the `/r/` redirect (`curl` without `-L`).

```bash
# on the box, before each network's probes:  snap invite_click > /tmp/before.txt
# from A:
for i in 1 2 3; do curl -s -o /dev/null -w '%{http_code}\n' https://43-204-36-199.sslip.io/r/000000000000; done   # 302
for i in 1 2;   do curl -s -o /dev/null -w '%{http_code}\n' https://payer.43-204-36-199.sslip.io/i/000000000000; done
# on the box, after:
snap invite_click > /tmp/after.txt
comm -13 /tmp/before.txt /tmp/after.txt | while read -r k; do echo "$(docker exec badabhai-redis redis-cli GET "$k") $k"; done
```

| Probe                      | Expected at hop 1                                       | What hop 0 would show          |
| -------------------------- | ------------------------------------------------------- | ------------------------------ |
| A: `/r/` ×3                | ONE new key `KA`, value 3                               | nginx's old key +3, no new key |
| A: `/i/` ×2                | **the same `KA`** → 5 (payer-web forwarded A's address) | payer-web's container key +2   |
| B: `/r/` ×1, then `/i/` ×1 | ONE new key `KB` (≠ `KA`), value 2                      | the two shared keys again      |

So after A's five probes the diff should show ONE new key with value **5**. The count is what
identifies `KA` even if other visitors create keys at the same time.

- If A's new key reads **3**, `/r/` was counted per visitor but `/i/` went into another key
  (payer-web's container key, which is not new and so is not in the diff): the api hop is
  working but payer-web is not forwarding. That is not dangerous (portal calls stay in
  one bucket), so file it against payer-web rather than rolling back.
- If `/r/` creates no new key, the hop count did not take (re-check `printenv`) or nginx is not
  appending.

### Spoof probe (from B, the fixed network, after `KB` is known)

Run it from **B**: a phone on mobile data can change its public address mid-probe (carrier CGNAT),
which would look like a spoof. Each forged header is sent a DISTINCTIVE number of times, so a
spoofed key cannot be mistaken for a real visitor's key that reads 1.

```bash
# on the box: snap invite_click > /tmp/before.txt
for i in 1 2 3 4;     do curl -s -o /dev/null -w '%{http_code}\n' -H 'X-Forwarded-For: 198.51.100.7' https://43-204-36-199.sslip.io/r/000000000000; done
for i in 1 2 3 4 5 6; do curl -s -o /dev/null -w '%{http_code}\n' -H 'X-Forwarded-For: 198.51.100.8' https://payer.43-204-36-199.sslip.io/i/000000000000; done
# on the box: snap invite_click > /tmp/after.txt, then the same comm/GET loop as above
```

**Expected: `KB` goes up by exactly 10 (2 → 12) and NO new key appears.** nginx appends B's real
address after the forged one. The api takes the rightmost entry, and payer-web reads only the last
one.

**A new key reading 4 (the api took the forged value) or 6 (payer-web did) means a forged address
became a rate-limit identity. Roll back immediately.**

## Rollback

```bash
gh secret set TRUST_PROXY_HOP_COUNT --env production --body 0    # or: gh secret delete TRUST_PROXY_HOP_COUNT --env production
```

Then re-run the LATEST main run's deploy job, as above, and confirm `printenv` → `0`.

- Recovery time is one deploy, about 10 minutes. There is no box-side shortcut: a manual
  compose `up` needs every bridged secret in that shell, and a box `.env` / `export` of this name
  no longer wins over the bridged value.
- No data to migrate. The buckets go back to the shared address keys, and the per-visitor keys
  expire at the end of the UTC hour.
- The loopback binds stay. They do not depend on the hop count, and nginx needs nothing else.
  Reverting them is a code revert of the #2542 PR, for a separate reason.

## After verification — follow-ups (owner decisions, each a code change)

Neither cap below is declared in compose today, so each runs its zod default in
`packages/config/src/server.ts`. Changing one is a code change, or a compose pass-through added
first.

- **`ADMIN_AUTH_MAX_PER_IP_PER_HOUR` 200 → about 20.** It was raised to 200 only because the
  bucket was global (R73). After turn-on:
  - admin-web's calls still share ONE bucket (its container). That bucket now holds only the
    admins, because admin-web is tunnel-only. 20 has to cover all admins' sign-ins in an hour
    together, at 1–3 calls each.
  - Direct `/admin/*` hits through nginx get a bucket per visitor.
- **`REFERRAL_CLICK_MAX_PER_IP_PER_HOUR` (600).** Sized for one shared bucket. Resize it per
  visitor, but keep carrier CGNAT in mind: one public IPv4 can front a whole factory gate of
  phones. An over-cap click is shed silently; it never breaks the page.
- **`PAYER_AUTH_MAX_PER_IP_PER_HOUR`.** The production secret was raised (#2509) for the same
  shared-bucket reason. Revisit it.
- Record the turn-on in the TD25 row of `docs/registers/tech-debt-register.md` and the
  architecture log, including the date. `profile.qr_scanned` dedupe and consent `ip_hash`
  evidence switch from nginx's address to the visitor's from that date (R78).
- **Optional nginx hardening:** add `proxy_set_header X-Forwarded-Host $host;` to both server
  blocks. At hop 1 Express also trusts `X-Forwarded-Host`, which nginx does not set today, so a
  client's own value would reach `req.hostname`. Nothing in the api reads it (a fence test,
  `forwarded-request-fields.fence.test.ts`, fails if that changes), so this is belt and braces.
