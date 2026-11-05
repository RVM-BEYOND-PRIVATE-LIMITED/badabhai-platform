import { HttpException, HttpStatus, Logger } from "@nestjs/common";

/**
 * The RESERVED error code for "a valid worker session resolved a worker whose row no longer
 * exists in the DB". It is a typed constant (never a magic string) so the guard that throws it
 * and the tests that assert it share ONE definition, and a client can key on it with certainty.
 *
 * CONTRACT INVARIANT: HTTP 410 + this code are reserved EXCLUSIVELY for the deleted-worker case.
 * No other route/condition may return 410, so the worker app can treat a 410 as an unambiguous
 * "your account was deleted server-side → hard-logout" signal.
 */
export const WORKER_ACCOUNT_DELETED_CODE = "WORKER_ACCOUNT_DELETED" as const;

/**
 * Neutral, PII-FREE message (CLAUDE.md §2): no phone, name, id, or any worker-identifying
 * detail — it is safe to log, surface, or return on the wire. The machine-readable signal is
 * the `code`; the message is human copy only.
 */
const WORKER_ACCOUNT_DELETED_MESSAGE = "This account no longer exists.";

/**
 * Thrown at three sites, all meaning "this account no longer exists":
 *
 *   1. {@link WorkerAuthGuard} (and the in-controller equivalent on the unguarded
 *      `POST /auth/token/refresh` path) when a token VALIDATES but the resolved worker row has
 *      been deleted out of band (e.g. a backend dev removed the row directly, bypassing
 *      `AccountDeletionService` — which revokes every session first, so a normally-deleted
 *      worker fails these with a 401 and never reaches here).
 *   2. `PinService.verifyPin` (a2, #1176) — the same probe, straight off a refresh token that
 *      still resolves.
 *   3. `PinService.verifyPin` (a0, #2113) — a NORMAL erasure: the presented refresh token no
 *      longer resolves (the erasure revoked it), but it was a live device-bound tip when the
 *      erasure COMPLETED, so a `refresh_erased:<sha256(token)>` tombstone written after the hard
 *      delete says so. Keyed only on the credential; a hit implies the row is definitively gone.
 *
 * Sites 2 and 3 are the ratified exceptions to /auth/pin/verify's neutral 401 (ADR-0026 Phase-3
 * Finding-3 addendum, owner ruling 2026-10-08). The 410-exclusivity invariant above holds at
 * every site: each fires only once the row is known to be gone.
 *
 * Maps to HTTP 410 Gone with the structured body `{ code, message }`. The global
 * `AllExceptionsFilter` nests that under `error`, so the wire shape is
 * `{ statusCode: 410, error: { code: "WORKER_ACCOUNT_DELETED", message }, requestId, path,
 * timestamp }` — the codebase's consistent error envelope. A 401 (invalid/expired token) is
 * DELIBERATELY unchanged and distinct from this 410, so the client can tell "re-authenticate
 * silently" (401) apart from "this account is gone, hard-logout" (410).
 */
export class WorkerAccountDeletedException extends HttpException {
  constructor() {
    super(
      { code: WORKER_ACCOUNT_DELETED_CODE, message: WORKER_ACCOUNT_DELETED_MESSAGE },
      HttpStatus.GONE,
    );
  }
}

/**
 * The RESERVED error code for "this worker account is suspended by an admin". Distinct from
 * the 410 deletion signal: suspension is reversible, so a client must NOT hard-delete its
 * local state on it. The body is PII-free — a closed code plus human copy.
 */
export const WORKER_ACCOUNT_SUSPENDED_CODE = "WORKER_ACCOUNT_SUSPENDED" as const;
const WORKER_ACCOUNT_SUSPENDED_MESSAGE = "This account is suspended.";

/**
 * #2562 — a suspended worker is refused at OTP sign-in, PIN reset confirmation, and by the
 * per-request gate that closes existing sessions. 403 (not 401) so the status is not
 * indistinguishable from an expired token on a fresh sign-in; the worker app can key on the
 * code when it grows suspended-specific copy.
 *
 * DPDP (owner ruling 5 Nov 2026): phone-code verification still returns the SAME 403 shape,
 * but adds a short-lived `restricted_token` that opens only the five DPDP exits. Old app
 * builds ignore the extra field and behave exactly as before.
 */
export interface SuspendedRestrictedToken {
  token: string;
  expiresInSeconds: number;
}

export class WorkerAccountSuspendedException extends HttpException {
  constructor(restricted?: SuspendedRestrictedToken) {
    super(
      {
        code: WORKER_ACCOUNT_SUSPENDED_CODE,
        message: WORKER_ACCOUNT_SUSPENDED_MESSAGE,
        ...(restricted
          ? {
              restricted_token: restricted.token,
              restricted_expires_in_seconds: restricted.expiresInSeconds,
            }
          : {}),
      },
      HttpStatus.FORBIDDEN,
    );
  }
}

/**
 * The minimal surface {@link readWorkerAccountState} needs. `findSelfView` projects the
 * status and the deletion marker ONLY — no name, phone, or any PII column can reach this
 * helper.
 */
export interface WorkerAccountProbe {
  findSelfView(
    id: string,
  ): Promise<{ status: string; deletionScheduledAt: Date | null } | undefined>;
}

/** The durable states a request gate must distinguish, plus an unavailable probe. */
export type WorkerAccountState = "present" | "deleted" | "suspended" | "unknown";

/**
 * #2562 — ONE primary-key read for both gates. The guard previously took an `existsById`
 * probe and then a second `findSelfView` for suspension; this reads the same row once and
 * returns the state the caller needs.
 *
 * A probe ERROR is `unknown` and callers fail OPEN, exactly like the old existence probe: a
 * Postgres incident must not turn every worker route into a 401/410 storm. `deleted` is
 * definitive (the row is gone); `suspended` is the durable reversible status.
 */
export async function readWorkerAccountState(
  workers: WorkerAccountProbe,
  workerId: string,
  logger: Logger,
): Promise<WorkerAccountState> {
  try {
    const row = await workers.findSelfView(workerId);
    if (row === undefined) return "deleted";
    if (row.status === "suspended") return "suspended";
    return "present";
  } catch (err) {
    logger.warn(
      `worker account probe unavailable (request allowed through, no account gate): ` +
        `${err instanceof Error ? err.name : "unknown error"}`,
    );
    return "unknown";
  }
}
