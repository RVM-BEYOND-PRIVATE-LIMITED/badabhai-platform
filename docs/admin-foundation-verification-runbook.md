# Admin foundation verification — the mandatory gate before ADMIN-4

> **Owner ruling, 2026-08-03: run this before writing a single React component.**
> If any step fails, **stop**. Classify it as a **backend defect**, hand it to the backend
> stabilization thread with reproducible evidence, and do **not** work around it in the UI.

This proves the ADR-0038 foundation — bootstrap → email → OTP → TOTP → session → refresh →
logout → re-login → MFA challenge → events → capabilities — actually holds on a clean
database, rather than trusting the handoff brief.

**Time:** ~15 minutes. **Destructive:** yes, step 1 deletes local volumes.

---

## 0. Why some of this is already covered (and why you still run it)

| Step | Already pinned by an automated test | What only a live run proves |
|---|---|---|
| 4 delivery | [`admin-login-chain.test.ts`](../apps/api/src/admin/admin-login-chain.test.ts) — the request reaches a real sender | that a real SMTP transport actually accepts it |
| 5 OTP verify | [`admin-auth.service.test.ts`](../apps/api/src/admin/admin-auth.service.test.ts) | the Redis-backed code survives a real round trip |
| 11 MFA challenge | [`admin-mfa.test.ts`](../apps/api/src/admin/admin-mfa.test.ts) | a real authenticator app's clock agrees with ours |
| 13 capabilities | [`admin-roles.guard.test.ts`](../apps/api/src/admin/admin-roles.guard.test.ts) | the wire shape the portal will consume |
| 2, 3, 7, 8, 9, 10, 12 | — | **only** the live run covers these end to end |

The unit tests use fakes at the transport and store seams by design. This run is the one
place the real Postgres, the real Redis, a real SMTP server and a real authenticator app are
all in the loop at once.

---

## 1. A completely empty database

```bash
docker compose down -v          # DESTROYS local volumes — local only, never a shared box
pnpm db:up                      # postgres + redis
pnpm db:migrate                 # full migration chain onto an empty DB
```

`down -v` is the point: a bootstrap that only works against *your* long-lived dev database is
not evidence. If the migration chain does not apply cleanly from empty, that is a backend
defect on its own — report it and stop.

> **This is exactly where the gate failed on its first run (2026-08-03), and it is why the
> step exists.** 26 of the 64 migrations `REVOKE`/`GRANT` on `anon`, `authenticated` and
> `service_role` — the Supabase PostgREST roles. Supabase ships them; the plain
> `pgvector/pgvector:pg16` container does not, so the chain died on `0004` with
> `role "anon" does not exist` and **zero** tables created. `pnpm db:up && pnpm db:migrate`
> had therefore never worked from empty; every developer database predated `0004` or was
> created against Supabase. Fixed by
> [`infra/docker/postgres-init/00-supabase-roles.sql`](../infra/docker/postgres-init/00-supabase-roles.sql),
> which the container runs automatically on an empty data dir — you do not need to do
> anything, but if you see that error, check the volume mount survived.
>
> **If `db:migrate` fails, do not trust its output.** `drizzle-kit migrate` reports a failed
> migration as a **silent exit 1** with no message (TD133). To see the real error:
> ```js
> // packages/db/diag.mjs — throwaway
> import postgres from "postgres"; import { drizzle } from "drizzle-orm/postgres-js";
> import { migrate } from "drizzle-orm/postgres-js/migrator";
> const sql = postgres(process.env.DATABASE_URL, { max: 1 });
> try { await migrate(drizzle(sql), { migrationsFolder: "./migrations" }); }
> catch (e) { console.error(e.message, "\ncause:", e.cause); }
> finally { await sql.end(); }
> ```

## 2. Start the mail catcher

```bash
pnpm mail:up                    # mailpit — SMTP on 1025, web UI on 8025
```

`EMAIL_PROVIDER` is **real-only** (`zeptomail | smtp | auto`) — there is no mock or console
arm anywhere in the config, deliberately, because a console-printing email channel is one env
var away from being a production account takeover. Mailpit is a real SMTP server, so the API
takes its ordinary production `EMAIL_PROVIDER=smtp` code path; the message is simply delivered
locally. **Do not** substitute `ZEPTOMAIL_SANDBOX_MODE` — it runs the full request but
deliberately does not deliver, so there is no message to read the code out of.

Point the API at it, on top of the usual local env
([docs/environment-variables.md](environment-variables.md)):

```bash
EMAIL_PROVIDER=smtp
SMTP_HOST=localhost
SMTP_PORT=1025
SMTP_USER=dev
SMTP_PASS=dev
EMAIL_FROM_ADDRESS=no-reply@badabhai.local
```

> `PAYER_LOGIN_METHOD=whatsapp` is **not** a substitute. It dodges the *boot* guard only; the
> admin send still fails at delivery time, opaquely, because admin one-time codes have no
> channel but email.

## 3. Bootstrap the first Super Admin

`PII_ENCRYPTION_KEY` and `PII_HASH_PEPPER` **must be the values the API runs with** — a row
written under a different key or pepper looks fine and then cannot be logged into.

```bash
pnpm --filter @badabhai/db db:bootstrap:admin -- --email you@example.com --name "Your Name"    # DRY RUN
pnpm --filter @badabhai/db db:bootstrap:admin -- --email you@example.com --name "Your Name" --with-totp --apply
```

**Verify all three:**

1. It prints the created admin's id and role `super_admin`.
2. `--with-totp` prints a TOTP seed **once**. Enrol it in your authenticator now — it is shown
   once and recoverable from nowhere.
3. **Run it a second time.** It must **refuse** and exit **0**, not create a second super_admin.
   This is the security property; a second row here is a critical finding.

> **Break-glass hygiene** (owner, 2026-08-03): never run this where stdout is centrally
> logged — the seed is printed. Restrict it to trusted operators. Recovery for a lost device
> is [ADR-0038 §4](decisions/0038-admin-bootstrap-and-notification-layer.md).

## 4–7. Deliver, verify, enrol, get a session

```bash
API=http://localhost:3001
EMAIL=you@example.com

# 4. delivery
curl -s -X POST $API/admin/login/request -H 'content-type: application/json' \
  -d "{\"email\":\"$EMAIL\"}"
# expect: {"status":"code_sent","resend_in_seconds":N}
# then READ THE CODE at http://localhost:8025
```

The response is **identical for a known, unknown and suspended email** — that is the
no-enumeration property (XB-H), not a bug. The only place the code exists is the inbox.

```bash
# 5. OTP  ->  6. enrolment material (first login only)
curl -s -X POST $API/admin/login/verify -H 'content-type: application/json' \
  -d "{\"email\":\"$EMAIL\",\"code\":\"<from mailpit>\"}"
# expect: {"status":"mfa_required","needs_enrollment":true,"enrollment":{...otpauth_uri}}
# NOTE: no access_token here. A session before MFA would defeat the second factor.
```

If you bootstrapped `--with-totp`, `needs_enrollment` is **false** and there is no `enrollment`
block — you already hold the seed. Either way, add the secret to an authenticator app.

```bash
# 7. session
curl -s -X POST $API/admin/mfa/verify -H 'content-type: application/json' \
  -d "{\"email\":\"$EMAIL\",\"code\":\"<6-digit TOTP>\"}"
# expect: {"access_token":"...","token_type":"Bearer","expires_in_seconds":N,...}
TOKEN=<access_token>
```

## 8–11. Refresh, logout, re-login, MFA challenge

```bash
# 8. refresh — a NEW token, same session
curl -s -X POST $API/admin/refresh -H "authorization: Bearer $TOKEN"

# 9. logout — 204, empty body
curl -s -o /dev/null -w '%{http_code}\n' -X POST $API/admin/logout -H "authorization: Bearer $TOKEN"

# 9b. the old token must now be DEAD — this is the assertion, not the 204
curl -s -o /dev/null -w '%{http_code}\n' $API/admin/me -H "authorization: Bearer $TOKEN"   # expect 401
```

Step 9b is the one that matters. A logout that returns 204 while leaving the token usable is a
session-fixation bug, and only the follow-up request exposes it.

```bash
# 10 + 11. re-login: request -> read code -> verify. This time expect
#   {"status":"mfa_required","needs_enrollment":false}   <- NO enrollment block
```

`needs_enrollment: false` on the second login is the MFA challenge working: the seed persisted,
and the admin is being asked for a second factor rather than handed a fresh one. **If a
re-login ever returns `needs_enrollment: true`, stop** — that is an MFA reset on every login,
i.e. no second factor at all.

## 12. Audit / event emission

```bash
curl -s "$API/admin/events?limit=20" -H "authorization: Bearer $TOKEN"
```

Expect `admin.session_started` from each login and `admin.session_revoked` from the logout.

**Also confirm what is NOT there:** no email address, no one-time code, no TOTP secret, no
session token in any payload. The events spine is the audit source the portal will render
(the richer `audit_logs` record is a separate backend item — `audit_logs` has **zero writers**
today, so do not build against it).

## 13. Capability resolution

```bash
curl -s $API/admin/me -H "authorization: Bearer $TOKEN"
# expect: {"admin_id":"...","role":"super_admin","capabilities":[ ...all nine... ]}
```

This list is what the portal renders role-aware UI against, so it never carries its own copy of
`ADMIN_CAPABILITY_MATRIX`. It is a **rendering hint, never enforcement** — every route
re-checks `@RequireAdminRole` independently, so a client that forges a longer list gets 403s.

Sanity-check the shape with a lesser role if you create one: `analyst` must return exactly
`["read_events"]`, and no role but `super_admin` may show `toggle_kill_switch` or
`manage_admins`.

---

## Pass / fail

**PASS** = all 13 observed, with your own eyes, on a database created in step 1. Record the
date and the commit SHA in the portal thread, then begin Phase 1.

**FAIL** = stop at the first failure. File it against the backend thread with the request, the
response, the API log line, and the step number. Do not proceed and do not compensate in the
frontend —

> **Platform rule (owner, 2026-08-03):** frontend code must never compensate for backend
> inconsistencies. Every backend defect is corrected at its source. UI may present errors
> gracefully; it must not contain business logic that masks a server-side flaw.

## Teardown

```bash
pnpm mail:down
docker compose down          # add -v to discard the database too
```
