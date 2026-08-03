# ADR-0038: Admin bootstrap — breaking the closed loop that made the Admin Portal unreachable

- **Status:** Accepted — owner ruling 2026-08-03 (Decision 1: bootstrap CLI, no hardcoded email).
- **Date:** 2026-08-03
- **Relates:** [ADR-0025](0025-admin-ops-portal.md) (ADMIN-1/3a — the admin principal, guards, capability matrix, `admin.action_performed`) · [ADR-0004](0004-pii-at-rest-and-rls.md) (PII at rest) · [ADR-0037](0037-payer-lifecycle-and-suspension.md) (the verification sweep that surfaced this) · TD33/TD50 (the `InternalServiceGuard` ops interim, blocked on this)

## Context

The 2026-08-03 lifecycle verification sweep found that **no admin can authenticate**, and that this is not a configuration gap but a structural one.

**`admin_users` rows are created by exactly one path: `POST /admin/invite`.** That route sits behind `AdminAuthGuard` plus the `manage_admins` capability — so creating the first admin requires an already-authenticated admin. A closed loop with no entry point.

**Admin email delivery is a no-op stub.** `AdminOtpService.issueAndSend` reserves the code in Redis and logs `"admin login code issued … (delivery deferred)"`. The code is correctly never returned to the client (real-only, no echo), so it reaches no human. The class docstring states this outright.

The consequence is that the entire ADMIN-3a surface — `AdminAuthGuard`, `AdminRolesGuard`, the capability matrix, the value-free `admin.action_performed` spine — **shipped complete and unreachable**. It also blocks everything downstream: ADMIN-4..8 (the portal UI) has nothing to log into, and the Decision 6 migration of the ops `InternalServiceGuard` routes onto an authenticated admin principal would take the ops console *offline* rather than securing it.

A third finding came out of the same reading. **The admin's TOTP secret lived in Redis with no TTL and no persistence guarantee** (`admin_mfa_secret:<id>`). `AdminMfaSecretStore`'s own docstring records this as a deviation forced by "no migration in ADMIN-1 scope" and asks for an encrypted column. It is not cosmetic: a Redis flush or eviction permanently locks out every enrolled admin, with **no recovery path at all**, because the secret is displayed once at enrolment and never returned again.

## Decision

### 1. A bootstrap CLI, not an HTTP endpoint

`pnpm --filter @badabhai/db db:bootstrap:admin -- --email <addr> [--name <name>] [--with-totp] --apply`

**Why not an endpoint.** A bootstrap route is a permanent unauthenticated path that mints a `super_admin`. Even guarded by "only if none exists" it is one logic bug from total compromise, it must be exposed on the public listener, and in an access log it is indistinguishable from an attack. A CLI requires shell access to the deployment *and* the database credentials — a materially higher bar, and an attacker who already has both does not need the endpoint.

**No hardcoded email** (the owner's explicit ruling). The address is an argument, so one build bootstraps any deployment and no environment-specific identity is baked into the image or the repository.

**One-time by construction.** It refuses if **any** `super_admin` row exists, in **any** status. Not just `active`: allowing it to run while the only `super_admin` is `suspended` would make *"suspend the super_admin, then bootstrap a new one"* a privilege-escalation path for anyone with shell access — precisely the population the gate exists to bound. The refusal **exits 0**, because on a re-run of a deployment script it is the expected outcome and a non-zero exit would fail a pipeline that is behaving correctly.

**Fully initialized** means `role = super_admin` **and** `status = 'active'`. The invite flow deliberately creates `pending` admins that an existing admin activates — but there is no existing admin here, so a `pending` bootstrap would recreate the very deadlock this breaks.

Every subsequent admin comes from the invite flow, which is capability-gated and audited.

### 2. The TOTP secret moves to an encrypted column

`admin_users.mfa_secret_enc` (AES-256-GCM, migration 0063). `AdminMfaSecretStore` keeps its interface; only its backing store changes, exactly as its docstring anticipated.

The short-lived `admin_mfa_pending:<id>` marker **stays in Redis** — that one is genuinely ephemeral and TTL-bounded by design. The split is the point: durable state in the database, ephemeral state in the cache.

**Done now because zero admins are enrolled** (none can log in). After the portal ships this would need a re-enrolment drill across every admin.

### 3. The admin's name is stored, encrypted

`admin_users.name_enc` — ADMIN-class PII, so the same at-rest discipline as the email (ADR-0004). Deliberately **not** hashed: unlike the email it is never a lookup key, so there is no reason to make it searchable.

## Consequences

**Unblocks the dependency chain** that the verification sweep documented: bootstrap → admin login works → ADMIN-4..8 has a principal → the ops `InternalServiceGuard` routes can migrate onto it (Decision 6) and stop emitting `actor_id: null` on privileged writes.

**Still required for a usable login: real admin email delivery.** The bootstrap creates the account; the OTP that authenticates it is still not delivered. That is the principal-agnostic notification layer (owner Decision 2), which also consolidates the two existing ZeptoMail implementations (`payers/zeptomail-email-login-channel.ts` and `payer-portal/member-invite.mailer.ts`, 510 lines with duplicated transport resolution, sandbox handling, opaque-error contract and hash-prefix logging). **Until it lands, the bootstrapped admin can be created but not logged in.**

**Deploy order:** apply migration 0063, then ship the API build, then run the CLI. The migration is expand-only (two nullable columns) and safe ahead of the build.

**Operational note.** `--with-totp` prints the seed and its `otpauth://` URI to stdout **once**; it is stored encrypted and never returned again. Run it somewhere the output is not captured to a shared log.

## Alternatives rejected

**A seed script with the email in an env var.** Same hardcoding problem one layer out, and env vars leak into process listings and crash dumps far more readily than an argv you type once.

**An `ADMIN_BOOTSTRAP_TOKEN`-guarded HTTP endpoint.** Adds a long-lived, high-value secret whose only job is to create a root account — a worse thing to protect than the account itself, and it must be rotated or removed after use, which nobody does.

**Leaving the TOTP secret in Redis and having the CLI write there.** Would have added `ioredis` as a dependency of `packages/db` purely to persist to a store that cannot be relied on, while leaving the lockout risk in place.
