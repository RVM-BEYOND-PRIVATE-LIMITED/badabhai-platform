# Worker app — optional biometric unlock (#2451)

Face ID / Touch ID / fingerprint is an **optional convenience** layered on top of
the existing 4-digit PIN. It is never required and never replaces the PIN.

## Flow

1. After a successful set-PIN, the worker is asked once:
   "Agli baar Face ID/fingerprint se login karein?" — "Haan, on karein" /
   "Abhi nahi". Nothing is enabled without that explicit choice.
2. The same preference is available later in **Settings → Fingerprint / Face ID
   se login**. Turning it off is immediate.
3. On cold start and lifecycle re-lock the `/pin` screen auto-triggers the OS
   prompt once when the worker opted in. A visible CTA retries after a cancel.
4. Cancel, failure, lockout, missing enrolment or unavailable hardware always
   falls back to the ordinary PIN keypad. No state traps the worker.

## Security boundary

- The biometric check is a **local gate only**. On success the app reads the
  persisted refresh token from `SecureTokenStore` and runs the existing
  `AuthSessionManager.refresh()` → `POST /auth/token/refresh` path. No token is
  minted locally and no server auth is bypassed (ADR-0026 holds).
- `biometricOnly: true` is set, so the OS device passcode cannot open BadaBhai.
- Biometric data is never read, stored, logged, emitted, or transmitted. Only a
  boolean `enabled` preference lives in `SecureTokenStore`.
- The preference is wiped by `SecureTokenStore.clear()` and every logout /
  logout-all / forced re-auth / fresh OTP path, so a second worker on the same
  handset cannot inherit the first worker's unlock.
- Post-unlock routing still has exactly one owner (the router), preserving the
  #349 rule; a failed refresh after a biometric success follows the same neutral
  PIN fallback and N-failure OTP escape as a failed PIN unlock.

## Platform wiring

- Android: `USE_BIOMETRIC` and a `FlutterFragmentActivity` host (BiometricPrompt
  is fragment-based).
- iOS: `NSFaceIDUsageDescription`.
- Dependency: `local_auth` (abstracted behind `core/auth/biometric_service.dart`
  so tests can fake success, cancel, unavailable and enrollment changes).
