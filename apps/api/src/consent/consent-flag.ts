import { Logger } from "@nestjs/common";

import type { ConsentRepository } from "./consent.repository";

/** The only thing the compose needs — kept structural so a caller can pass a double. */
type ConsentReader = Pick<ConsentRepository, "findLatestByWorker">;

const logger = new Logger("ConsentFlag");

/**
 * TD62 — compose the ADDITIVE `consent_accepted` signal onto a MINTED login payload.
 *
 * ACTIVE consent = a latest `worker_consents` row exists and is not revoked. The boolean is
 * never PII and changes no event; §6's server-side gate (ConsentGuard / ConsentNotRevokedGuard)
 * remains the authoritative one — this only lets the app route a never-onboarded worker to
 * /consent instead of the shell.
 *
 * FAIL-OPEN BY OMISSION (review F1), and that is the whole reason this is a shared function:
 * every caller reaches it AFTER the session has already been minted server-side (and, on the
 * OTP/PIN-reset paths, after the one-time code has been CONSUMED). A consent-read blip must
 * therefore never turn a server-side success into a 500 — the worker would burn another OTP
 * against the TD60 daily cap to recover. On a read failure the field is OMITTED entirely (not
 * `false`), and the app's tri-state treats absent as unknown / pass-through.
 *
 * Callers: {@link AuthController.withConsentFlag} (/auth/otp/verify, /auth/test-login) and
 * PinService.resetConfirm (/auth/pin/reset/confirm). PinService.verifyPin deliberately does
 * NOT use this — it derives the same boolean from the consent row its A5 gate already fetched
 * on the success path, so it costs no second query.
 */
export async function withConsentAccepted<T extends { worker_id: string }>(
  consents: ConsentReader,
  login: T,
): Promise<T & { consent_accepted?: boolean }> {
  try {
    const latest = await consents.findLatestByWorker(login.worker_id);
    return { ...login, consent_accepted: latest != null && latest.revokedAt === null };
  } catch (err) {
    // Swallowed BUT NEVER SILENT. Every mint path now shares this catch, so an unlogged
    // failure would degrade consent routing platform-wide with no signal anywhere — the
    // logins keep succeeding, the field just quietly stops appearing. PII-free by
    // construction: the error TYPE only, never its message (which can carry query text),
    // and the opaque worker id — the same posture as DevicesService's best-effort catch.
    logger.warn(
      `consent_accepted omitted for worker=${login.worker_id}; the session is already minted and stands (errorType: ${
        err instanceof Error ? err.name : "unknown"
      })`,
    );
    return { ...login };
  }
}
