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
 * The minimal surface {@link throwIfWorkerDeleted} needs. Narrower than `WorkersRepository` on
 * purpose: the helper is a pure function over an existence probe, so it stays trivially testable
 * and cannot reach a PII-bearing column even by accident.
 */
export interface WorkerExistenceProbe {
  existsById(id: string): Promise<boolean>;
}

/**
 * Enforce the 410 contract in ONE place. Both callers — {@link WorkerAuthGuard} (every worker
 * route) and the unguarded `POST /auth/token/refresh` cold-start path — must apply IDENTICAL
 * semantics, so the rule lives here rather than being copy-pasted into two files where a later
 * edit could silently desync them.
 *
 * Throws {@link WorkerAccountDeletedException} **iff** the row is DEFINITIVELY absent.
 *
 * FAIL-SAFE: a probe ERROR leaves existence UNKNOWN, which is treated as PRESENT — a Postgres
 * incident must never 410-storm every worker route (least of all `POST /auth/logout`, which has
 * to survive a DB outage). The degradation is now LOGGED rather than silent: without this line a
 * persistently failing probe would disable the whole deleted-account signal with no operator
 * signal at all.
 *
 * PII-FREE (CLAUDE.md §2): logs the error NAME only — never the worker id, the token, or the
 * error message, which can carry query text or parameter values. Mirrors the same restraint in
 * `OptionalWorkerAuthGuard`.
 */
export async function throwIfWorkerDeleted(
  workers: WorkerExistenceProbe,
  workerId: string,
  logger: Logger,
): Promise<void> {
  let exists: boolean;
  try {
    exists = await workers.existsById(workerId);
  } catch (err) {
    logger.warn(
      `worker existence probe unavailable (request allowed through, no 410 emitted): ` +
        `${err instanceof Error ? err.name : "unknown error"}`,
    );
    return;
  }
  if (!exists) throw new WorkerAccountDeletedException();
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
 */
export class WorkerAccountSuspendedException extends HttpException {
  constructor() {
    super(
      { code: WORKER_ACCOUNT_SUSPENDED_CODE, message: WORKER_ACCOUNT_SUSPENDED_MESSAGE },
      HttpStatus.FORBIDDEN,
    );
  }
}

/**
 * The minimal surface {@link isWorkerSuspended} needs. `findSelfView` projects the status
 * ONLY — no name, phone, or any PII column can reach this helper.
 */
export interface WorkerStatusProbe {
  findSelfView(
    id: string,
  ): Promise<{ status: string; deletionScheduledAt: Date | null } | undefined>;
}

/**
 * #2562 — is this worker's durable status `suspended`?
 *
 * Runs AFTER {@link throwIfWorkerDeleted} at every site, so a deleted row has already been
 * answered with the reserved 410. A status read error fails OPEN (the request is allowed
 * through) for the same reason the existence probe does: a Postgres blip must not become a
 * fleet-wide lockout. The durable status row remains the authority, so the next request
 * closes the window once the DB is reachable again.
 *
 * Callers decide how to refuse. The per-request gates (the worker guard, token refresh and
 * PIN unlock) deliberately answer with their EXISTING neutral 401 shape: those surfaces
 * already drive the app's signed-out path, and a distinct status there would trap a
 * suspended worker on a screen that only knows "wrong PIN" / "expired session". The
 * sign-in and PIN-reset-confirm paths, where no session exists yet, throw
 * {@link WorkerAccountSuspendedException} so the refusal is explicit.
 */
export async function isWorkerSuspended(
  workers: WorkerStatusProbe,
  workerId: string,
  logger: Logger,
): Promise<boolean> {
  try {
    const row = await workers.findSelfView(workerId);
    return row?.status === "suspended";
  } catch (err) {
    logger.warn(
      `worker status probe unavailable (request allowed through, no suspension emitted): ` +
        `${err instanceof Error ? err.name : "unknown error"}`,
    );
    return false;
  }
}
