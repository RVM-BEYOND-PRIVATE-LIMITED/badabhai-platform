/**
 * The admin CREDENTIAL EPOCH (security review B2) — `password_set_at` in epoch milliseconds, or
 * 0 for an admin who has never set a password.
 *
 * Every admin session JWT carries it as the `pwe` claim, and every trusted-device record stores
 * it; both are valid ONLY while it EQUALS the row's current epoch. Setting, changing or resetting
 * a password moves the epoch, so every outstanding session and device dies at once — sessions are
 * Redis keys by sid and nothing indexes them by admin, so this is the only way to reach them all.
 *
 * WHY EQUALITY ON AN EPOCH, NOT `iat < password_set_at`: `iat` is whole seconds and rolling
 * refresh re-mints it, so a stolen session refreshing at ≥ 1 Hz always held a token from the same
 * second as a reset and survived it. An epoch copied from the row the session was VALIDATED
 * against cannot move forward without a fresh first factor.
 *
 * BACKWARD COMPATIBLE: a pre-0142 token has no `pwe`, which reads as 0 — valid exactly while the
 * admin has never set a password (every admin at deploy time), and dead the moment they do.
 */
export function passwordEpochOf(passwordSetAt: Date | null | undefined): number {
  return passwordSetAt ? passwordSetAt.getTime() : 0;
}

/**
 * True only when a presented epoch (a JWT `pwe` claim, a device record's `pwe`) equals the row's
 * CURRENT epoch. An absent claim counts as 0; anything that is not a finite number never matches.
 */
export function epochMatches(presented: unknown, passwordSetAt: Date | null | undefined): boolean {
  const claimed = presented === undefined ? 0 : presented;
  return (
    typeof claimed === "number" &&
    Number.isFinite(claimed) &&
    claimed === passwordEpochOf(passwordSetAt)
  );
}
