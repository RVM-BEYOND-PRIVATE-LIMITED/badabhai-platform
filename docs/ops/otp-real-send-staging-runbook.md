# OTP Real-Send Staging Runbook (OTP-7)

Reconstructed from `.github/workflows/staging-cd.yml`'s own comments, `auth.service.ts`, and
`tests/e2e/payer-capacity.e2e.test.ts` — the file was deleted in the 2026-08-05 docs purge
(`eb151468`) but is cited 3 times by that workflow plus once from the e2e suite it explains why
cannot run automatically (`docs/audit/22_REMEDIATION_BACKLOG.md` BL-20,
`docs/audit/24_RISK_REGISTER.md` R46).

**Status: this is a launch-gate, and per the repo's own issue tracker it is still OPEN** —
`issues.txt` lists "`[TD2/Q1] Provision Fast2SMS staging creds + staging-first live-send proof
(OTP-7)`" (`area:infra, launch-gate, P1`, opened 2026-07-16) as unresolved as of this
reconstruction. This runbook documents the procedure `staging-cd.yml`'s comments describe;
whether it has actually been executed against a live staging box is a separate, unverified
question this reconstruction cannot answer from static code alone.

## Why this exists as a *manual* check, not an automated one

`staging-cd.yml` deploys a **real-only** OTP posture — worker OTP is real Fast2SMS, payer OTP is
real ZeptoMail, with no console/mock fallback in either path (`assertAuthConfig` /
`assertPayerAuthConfig` fail closed at boot without real credentials). Sending a real OTP is real
provider spend, and the automated smoke step in `staging-cd.yml` can only poll `/health` — there
is no echoed code anywhere in a real-only send, so a script cannot read the OTP back out and
complete a round trip. `tests/e2e/payer-capacity.e2e.test.ts` states the same constraint from the
test-suite side: its capacity suite is `describe.skip`'d in CI with the comment "this suite mints
an authenticated payer session via OTP login, which now requires a real ZeptoMail code (no dev
echo) — it cannot run in automated CI. The end-to-end proof is the manual OTP-7 staging check."

**The proof therefore has to be a human, with a real phone and a real inbox, actually receiving
and entering a code.**

## Preconditions

1. The `staging` GitHub Environment is fully wired (see
   `docs/ops/staging-service-deploy-runbook.md`'s required-secrets table) — every Fast2SMS and
   ZeptoMail credential is real, not a placeholder.
2. `staging-cd.yml` has been run at least once and its automated smoke passed (`/health` returns
   200 on `STAGING_API_BASE_URL`) — this proves the box is reachable and booted with the real
   credentials present (a missing credential would have failed the boot, not just this check).
3. A tester has access to a **real phone number** (for Fast2SMS) and a **real inbox** (for
   ZeptoMail) that are safe to use for a staging-environment test send — i.e. not a production
   worker/payer's real contact info. Staging is meant to be team-restricted and
   synthetic-data-only; use a team member's own number/inbox for this check, never a scraped or
   guessed one.

## Procedure

1. **Worker OTP (Fast2SMS) round trip:**
   - Against `STAGING_API_BASE_URL`, initiate a worker OTP login with the tester's real phone
     number (`POST /auth/otp/request` or the equivalent worker-app flow pointed at the staging
     base URL).
   - Confirm an SMS actually arrives at that phone (not a mock/console value — there is none to
     fall back to).
   - Complete `POST /auth/otp/verify` with the received code and confirm a real session is
     minted (a 200 with a session, not a 401/429).
2. **Payer OTP (ZeptoMail) round trip:**
   - Same shape, over the payer email-OTP flow (`PAYER_LOGIN_METHOD=email_otp` is the default),
     against the tester's real inbox.
   - Confirm the email actually arrives (check spam/sandbox-mode behavior — `ZEPTOMAIL_SANDBOX_MODE`
     must be `false` for a real external send; a sandboxed send may not reach a real inbox at
     all, which would produce a false negative on this check, not a pass).
3. **Record the result.** This runbook does not prescribe where — at minimum, note the date, who
   ran it, and pass/fail, since the next reader (including a future re-run of this exact
   procedure) needs to know whether the credentials currently wired are still live and correct,
   not just that they once were.

## What a pass proves, and what it does not

A pass proves the box's Fast2SMS/ZeptoMail credentials are valid, reachable, and correctly wired
end-to-end for both login channels **at the moment of the check**. It does **not** prove:

- The credentials will still be valid later (a key can be revoked/rotated by the provider
  independently of this repo).
- Real-send spend limits are correctly protecting the platform — the global daily circuit
  breakers (`OTP_GLOBAL_MAX_SENDS_PER_DAY` for worker SMS, `PAYER_OTP_GLOBAL_MAX_SENDS_PER_DAY`
  for payer email) are a separate concern from "does a send succeed at all," and this procedure
  sends at most one or two OTPs — nowhere near either ceiling.
- Any other real-provider gate (payments, AI, WhatsApp) — `staging-cd.yml` forces all three false
  and this runbook does not touch them.

## What this runbook does not cover

Provisioning the Fast2SMS/ZeptoMail credentials themselves (a human, out-of-band task against
each provider's own dashboard — not a repo action); the automated `/health`-only smoke
(`docs/ops/staging-service-deploy-runbook.md`); enabling real sends in any environment beyond
staging (a separate, joint AI-Systems/DevOps/human sign-off action per CLAUDE.md §7 — never
unilateral, and never simply "reuse staging's credentials" in another environment).
