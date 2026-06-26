# OTP real-send activation — staging-first runbook (OTP-7)

> **Status:** PENDING-HUMAN. This is the **owner/devops gate** for turning on real OTP
> delivery. The code (OTP-1…OTP-6) has landed and passed an independent security review
> (zero Critical/High), but **no real send has been made**. Activating real SMS/email is a
> [CLAUDE.md §7](../../CLAUDE.md) escalation — it involves **real provider keys and real
> spend** — so it is performed by a human, **staging-first**, never by an agent and never on
> production until staging passes.

This runbook turns "send a real OTP in staging and prove it's safe" into a copy-paste
checklist. It does **not** contain any secret value — fill credentials from the secret
store, never from (or into) the repo.

---

## 0. Preconditions

- [ ] Approved **Fast2SMS** account: a DLT-registered transactional template + sender id +
      entity id, and the API key. (Worker SMS.)
- [ ] Approved **ZeptoMail** account: a verified sending domain + Mail Agent + an
      `enczapikey` send token, and a from-address on the verified domain. (Payer email.)
      _(Or a real SMTP relay if using `EMAIL_PROVIDER=smtp`/`auto`.)_
- [ ] A **disposable, non-prod staging** API target (never production) with its own Redis +
      Postgres, real `JWT_SECRET` + `PII_*` secrets set (so the boot guards pass).
- [ ] A **controlled** test inbox + a **controlled** test handset you own.
- [ ] Credentials are supplied via the deploy secret store / env — **not** committed, **not**
      pasted into the repo, `.env`, or any doc.

---

## 1. Env to set in staging (names only — values from the secret store)

Worker SMS (Fast2SMS DLT):

```
SMS_PROVIDER=fast2sms
FAST2SMS_API_KEY=…
FAST2SMS_SENDER_ID=…
FAST2SMS_DLT_TEMPLATE_ID=…
FAST2SMS_ENTITY_ID=…
FAST2SMS_ROUTE=dlt
```

Payer email OTP (ZeptoMail HTTPS — recommended; or SMTP/auto):

```
PAYER_LOGIN_METHOD=email_otp
EMAIL_PROVIDER=zeptomail            # or: smtp | auto
ZEPTOMAIL_API_URL=https://api.zeptomail.in/v1.1/email
ZEPTOMAIL_API_TOKEN=…               # secret
ZEPTOMAIL_MAIL_AGENT=…
ZEPTOMAIL_SANDBOX_MODE=true         # start in SANDBOX (no real delivery) for the first pass
EMAIL_FROM_ADDRESS=…                # on the verified domain
EMAIL_FROM_NAME=BadaBhai
EMAIL_REPLY_TO=…                    # optional
# SMTP_* only if EMAIL_PROVIDER=smtp|auto
```

Spend ceiling / kill-switch (keep tight for the first staging run):

```
OTP_GLOBAL_MAX_SENDS_PER_DAY=20            # low cap for the staging proof
PAYER_OTP_GLOBAL_MAX_SENDS_PER_DAY=20
# (set either to 0 to instantly PAUSE that path — the kill-switch)
```

**Boot expectation:** with these set, `assertAuthConfig` + `assertPayerAuthConfig` pass. If a
credential is missing, the API **refuses to boot** (fail closed) — that is correct.

---

## 2. First pass — SANDBOX (no real delivery, full request path)

1. Deploy staging with `ZEPTOMAIL_SANDBOX_MODE=true`.
2. Drive a payer login (`POST /payer/login/request` → `/payer/login/verify`) against the
   controlled email. The full ZeptoMail request fires but ZeptoMail does not deliver.
3. Confirm the request path works (200/202 from the provider; no boot/runtime error).
4. Inspect logs (next section) — they must already be PII-free in sandbox.

Flip `ZEPTOMAIL_SANDBOX_MODE=false` only after the sandbox pass + the log/event audit below.

---

## 3. Real-send pass — one controlled SMS + one controlled email

1. **Worker SMS:** `POST /auth/otp/request` with the controlled handset → read the code from
   the SMS → `POST /auth/otp/verify` → expect a `worker_id` + session. Complete to consent.
2. **Payer email:** `POST /payer/login/request` with the controlled inbox → read the code
   from the email → `POST /payer/login/verify` → expect a payer session.
3. Capture **redacted** evidence (mask the phone/email; never paste the code): the provider
   message id / status, a screenshot of the received SMS/email with the address masked.

---

## 4. PII-free proof (the gate that must pass)

For the requests above, assert **none** of the following ever appears in logs, the `events`
table, `ai_jobs`, or `audit_logs` — only hash-prefixes + status:

- [ ] **Logs:** grep the API logs for the test phone, email, and the OTP code → **absent**.
      Only `phone_hash=<8 chars>` / `email_hash=<8 chars>` + a status token appear.
- [ ] **Events:** query `events` for the run's `correlation_id`. `worker.otp_requested`,
      `worker.created`, `worker.otp_verified`, `payer.session_started` carry ids/hashes only —
      no phone, email, or code. If a breach fired (see §5), `*.otp_send_cap_exceeded` carries
      only `{channel, cap, limit, window}`.
- [ ] **`ai_jobs` / `audit_logs`:** untouched by the OTP path (no row carries phone/email/code).

If **any** raw phone/email/code is found in a log/event/table → **STOP, this is a Critical,
do not proceed to production.**

---

## 5. Caps + kill-switch checks

- [ ] **Per-account cooldown:** a second `request` within `OTP_RESEND_COOLDOWN_SECONDS` → 429
      neutral throttle.
- [ ] **Per-hour cap:** exceed `OTP_MAX_SENDS_PER_HOUR` for one account → 429.
- [ ] **Max attempts:** wrong code `OTP_MAX_ATTEMPTS` times → lock; a single neutral message.
- [ ] **Global daily breaker:** set the global cap low (e.g. 1), send twice → the 2nd is
      blocked with the neutral throttle, and exactly one PII-free `*.otp_send_cap_exceeded`
      event is emitted.
- [ ] **Kill-switch:** set `OTP_GLOBAL_MAX_SENDS_PER_DAY=0` (and/or `PAYER_OTP_…=0`) → the next
      real send is blocked immediately (no redeploy). Set `EMAIL_PROVIDER=none` → payer reverts
      to the mock channel. Restore afterwards.
- [ ] **No-enumeration (payer):** `request` for a **non-existent** email returns the same
      `code_sent`-shaped response as a real one; a breach returns the same neutral response for
      both. No observable difference.

---

## 6. Go / No-Go

| Check | Result | Evidence |
| ----- | ------ | -------- |
| Boot with real creds (fail-closed when missing) | ☐ pass / ☐ fail | |
| Sandbox request path | ☐ pass / ☐ fail | |
| Real SMS delivered + login completes | ☐ pass / ☐ fail | |
| Real email delivered + login completes | ☐ pass / ☐ fail | |
| Logs PII-free (hash-prefix only) | ☐ pass / ☐ fail | |
| Events/ai_jobs/audit_logs PII-free | ☐ pass / ☐ fail | |
| Caps fire (cooldown/hour/attempts/global) | ☐ pass / ☐ fail | |
| Kill-switch reverts to mock/blocks | ☐ pass / ☐ fail | |
| No-enumeration parity | ☐ pass / ☐ fail | |

- **Decision:** ☐ GO (owner may flip production)  ☐ NO-GO (file the failures)
- **Signed-off by:** ____________________   **Date:** __________
- **Staging target / run id:** ____________________

Only on **GO** does the owner set the production env (real creds, generous-but-bounded global
caps, `ZEPTOMAIL_SANDBOX_MODE=false`) and enable real OTP in production. Keep the kill-switch
(`…_GLOBAL_MAX_SENDS_PER_DAY=0`, `EMAIL_PROVIDER=none`) documented for on-call.

---

## Cross-links

- Tech-debt: [TD2](../registers/tech-debt-register.md) (OTP providers — paying down).
- Open question: [Q1](../registers/open-questions.md) (real OTP provider selection).
- Code: `apps/api/src/sms/fast2sms.provider.ts`,
  `apps/api/src/payers/zeptomail-email-login-channel.ts`,
  `apps/api/src/common/otp-send-cap.ts`, and the boot guards in
  `packages/config/src/server.ts`.
