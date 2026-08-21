import { HttpException, HttpStatus } from "@nestjs/common";

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
 * Thrown by {@link WorkerAuthGuard} (and the in-controller equivalent on the unguarded
 * `POST /auth/token/refresh` path) when a token VALIDATES but the resolved worker row has been
 * deleted out of band (e.g. a backend dev removed the row directly, bypassing
 * `AccountDeletionService` — which revokes every session first, so a normally-deleted worker
 * would already fail auth with a 401, never reach here).
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
