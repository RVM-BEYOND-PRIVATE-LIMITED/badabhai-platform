# ADR-0060: Admin password login, optional per-admin 2FA, forgot password, trusted devices and direct admin creation

- **Status:** Accepted. Owner rulings by Prakash, 2026-11-03.
- **Date:** 2026-11-03
- **Owner:** Prakash (Backend Platform, admin module)
- **Needs:** migration `0144` applied to production BEFORE the build that reads it deploys. (Applied by the owner 2026-11-03 under its first number, `0142`; renumbered to `0144` after main gained its own `0142`/`0143`.)
- **Amends:**
  - [ADR-0025](0025-admin-ops-portal.md) login design. Email OTP was the only first factor; a password is now the default one. **OQ-1 "MFA for ALL roles" is OVERRIDDEN:** each admin chooses.
  - [ADR-0038](0038-admin-bootstrap-and-notification-layer.md). Admins can now be created directly with a temporary password, not only by invite link. The bootstrap CLI and the break-glass MFA reset are unchanged.

## 1. Context

Signing in to the admin portal took three steps every time: the email, a 6-digit code sent by email, then an authenticator (TOTP) code. The marker between the second and third steps is single-use, so one wrong authenticator code sent you back to the start.

On 2026-11-03 the only super_admin was locked out. The authenticator seed shown at bootstrap had never been scanned, and recovery needed the break-glass CLI against production.

Onboarding a second admin was also blocked. The invite accept link comes back as `mock://…` in production, because `ADMIN_INVITE_ACCEPT_URL` is not bridged into the api container.

## 2. Rulings (owner, 2026-11-03)

| # | Ruling |
|---|---|
| **A1** | **Sign in with email + password.** |
| **A2** | **Two-step verification is optional, per admin, and starts OFF.** Each admin has an on/off switch on their own Account page. Off: email + password only. On: password, then the authenticator code. Turning it on shows a QR code and needs one valid code. Turning it off needs a valid current code. |
| **A3** | **"Trust this device for 30 days"** (2FA-on admins) skips the authenticator step on that browser. It is dropped on any password change, authenticator reset or re-enrolment. `ADMIN_TRUSTED_DEVICE_DAYS=0` turns the feature off. |
| **A4** | **Forgot password:** enter the email, get a code by email, enter it with a new password. A reset never signs anyone in and never skips the authenticator. It signs out every existing session. |
| **A5** | **Any signed-in admin can set or change their own password** on the Account page. Changing it signs out their other sessions and devices. |
| **A6** | **A super_admin can create an admin directly** with email, name, role and a temporary password. The account is active at once and must replace the password at first sign-in. 2FA starts off. |
| **A7** | **The email-code login and invites stay** for admins without a password. Nothing existing is removed. |

## 3. Design

- **Storage.** `admin_users` gains five additive columns:
  - `password_hash` (scrypt + salt + pepper, the `password-v1` token shared with payer passwords, #2497);
  - `password_set_at`;
  - `password_pepper_version`;
  - `must_change_password`;
  - `mfa_enabled`, default false and not backfilled. Everyone starts with two-step off, including an admin who already has an authenticator set up. Turning it back on from the Account page shows a fresh QR code.

  No new secret. No box change.
- **The 2FA gate.** One function serves both first factors, password and emailed code:
  - `ADMIN_MFA_REQUIRED=false` → no authenticator for anyone. This is the old global off-switch.
  - Otherwise, an admin with `mfa_enabled=false` gets the session straight after the first factor.
  - Otherwise: a trusted device signs in directly; if not trusted, the authenticator is asked (enrolment first if needed).

  `ADMIN_MFA_REQUIRED` now means "honour each admin's switch" (true, default) or "off for everyone" (false).
- **Policy.** 8–128 characters, at least one letter and one digit. This is the payer policy. The server is the authority.
- **Brute force.** The per-IP cap on public admin auth routes stays. On top of it, each account is locked for 15 minutes after 5 wrong passwords (Redis, fail-closed). Every miss returns the same neutral 401: unknown email, wrong password, no password set, locked, pending or suspended. A dummy scrypt runs on paths that have no real hash to check.
- **Authenticator guessing.** The authenticator step has its own per-admin counter, with the same limits as passwords. Only a correct authenticator code clears it; a correct password never does. So a leaked password cannot be used to guess the authenticator code without limit.
- **Sessions (credential epoch).** Every admin JWT carries `pwe`: the admin's `password_set_at` in milliseconds, or 0 when no password is set.
  - The guard re-reads the row on every request and requires `pwe` to equal it exactly. A password reset or change therefore signs out every older session, including a token refreshed in the same second.
  - A token without `pwe` (minted before this change) stays valid only while the admin has no password.
  - The change endpoint returns a fresh session carrying the new epoch.
- **Failure counters** use one atomic Redis script: increment, and set the expiry only if the key has none. A failed write can never leave an account locked permanently.
- **Trusted device.**
  - The token is 32 random bytes, kept in an httpOnly, SameSite=Strict cookie by the portal.
  - Redis stores only a keyed HMAC of it, with a TTL of `ADMIN_TRUSTED_DEVICE_DAYS`.
  - The device counts only while its stored credential epoch equals the admin's current one, and its fingerprint matches the current authenticator secret.
  - A Redis miss or error means the device is not trusted.
- **Reset codes** use the admin OTP service under their own namespace. A login code cannot reset a password, and a reset code cannot sign in. The reset email is sent after the response, so a known address takes as long as an unknown one.
- **Temporary passwords.** An account created with a temporary password cannot sign in by emailed code (409). It must use the password door, which forces the change.
- **Residuals** are logged in the risks register:
  - R72 (accepted): a stolen session can set a first password and turn on two-step.
  - R73 (open): pre-existing email-timing and shared rate-limit issues on admin sign-in. The timing half was fixed on 2026-11-04: the login code email is now also sent after the response. The shared rate-limit half is #2542.
- **Events.** Each action emits `admin.action_performed` with a new code: `admin_created`, `admin_password_set`, `admin_password_reset`, `admin_device_trusted`, `admin_mfa_enabled` or `admin_mfa_disabled`. `action_code` is a free string, so the event schema is unchanged. `admin.session_started` still marks every sign-in.

## 4. Consequences

- **Default sign-in is email + password.** That is one factor for the highest-privilege principal; the owner accepted this risk explicitly. What bounds it:
  - account lockout plus the per-IP cap;
  - neutral errors;
  - session revocation on any credential change;
  - every admin can turn 2FA on;
  - the Admins page already shows who has an authenticator set up.
- **Recommendation, not a rule:** super_admins should keep 2FA on.
- **Rollout order:** apply `0144`, then merge. The admin repository selects whole rows, so code that knows the new columns fails against a database without them.
