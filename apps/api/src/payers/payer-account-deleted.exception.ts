import { HttpException, HttpStatus } from "@nestjs/common";

/**
 * The RESERVED error code for "a valid payer session resolved a payer whose row no longer
 * exists in the DB". A typed constant (never a magic string) so the guard that throws it and
 * the tests that assert it share ONE definition, and the payer app can key on it with
 * certainty — it already does, on this exact literal
 * (`apps/payer-app/lib/core/auth/payer_account_deleted_signal.dart`).
 *
 * CONTRACT INVARIANT: HTTP 410 + this code are reserved EXCLUSIVELY for the deleted-payer
 * case. No other payer route/condition may return 410, so the payer app can treat a 410 as an
 * unambiguous "your account is gone server-side → hard-logout, wipe, back to Login" signal.
 * `401` (invalid/expired session) stays DELIBERATELY distinct: the app silently re-auths on a
 * 401 and only ever hard-logs-out on this 410, so the two must never share a code path.
 *
 * The worker-side mirror of this contract is `WORKER_ACCOUNT_DELETED`
 * (`apps/api/src/auth/worker-account-deleted.exception.ts`). Two principals, two codes, one
 * shape — a payer token and a worker token are different Redis namespaces and different JWT
 * `typ`s, so a single shared code would tell a client nothing it could act on.
 */
export const PAYER_ACCOUNT_DELETED_CODE = "PAYER_ACCOUNT_DELETED" as const;

/**
 * Neutral, PII-FREE message (CLAUDE.md §2): no email, phone, org name, payer id, or any
 * payer-identifying detail — safe to log, surface, or return on the wire. The B2B contact
 * columns on `payers` are encrypted at rest precisely so they never reach a place like this.
 * The machine-readable signal is the `code`; the message is human copy only.
 */
const PAYER_ACCOUNT_DELETED_MESSAGE = "This account no longer exists.";

/**
 * Thrown by {@link import("./payer-auth.guard").PayerAuthGuard} when a payer session
 * VALIDATES but the resolved `payers` row has been deleted out of band.
 *
 * WHEN THIS CAN ACTUALLY FIRE, which is narrower than the worker case. There is no managed
 * payer hard-delete today: `PayersRepository` has no delete, `PayerStatus` has no `deleted`
 * state, and the only admin lifecycle op is suspend/reinstate — which already calls
 * `revokeAllForPayer`, so a suspended payer's sessions are dead before the next request and
 * a reinstated one is `active`. This 410 is therefore the escape hatch for exactly one
 * situation: a RAW `DELETE FROM payers` performed directly against the database while
 * sessions are still live in Redis. Redis cannot carry that signal — the session record
 * survives the row — which is why the authority has to be the per-request Postgres read.
 *
 * Maps to HTTP 410 Gone with the structured body `{ code, message }`. The global
 * `AllExceptionsFilter` nests that under `error`, so the wire shape is
 * `{ statusCode: 410, error: { code: "PAYER_ACCOUNT_DELETED", message }, requestId, path,
 * timestamp }` — the codebase's standard envelope, and byte-identical to what the shipped
 * payer client already parses. No filter change is needed or wanted.
 *
 * ── WHY THERE IS NO `throwIfPayerDeleted` HELPER, when the worker side has one ──────────
 * `throwIfWorkerDeleted` exists for two reasons, and NEITHER holds here.
 *
 *   1. TWO CALL SITES. The worker rule runs in `WorkerAuthGuard` AND on the unguarded
 *      `POST /auth/token/refresh` cold-start path, so the semantics had to live in one place
 *      or the two could silently desync. The payer rule has exactly ONE call site: the guard.
 *      There is no unguarded payer refresh route to keep in step with.
 *
 *   2. ITS FAIL-SAFE CANNOT BE MIRRORED HERE, AND MIRRORING IT WOULD BE A SECURITY
 *      REGRESSION. The worker helper treats a probe ERROR as "present" and lets the request
 *      through, because `existsById` is a pure existence probe — nothing else rides on it, so
 *      degrading open costs nothing but the deleted-account signal. The payer equivalent,
 *      `PayersRepository.findAuthFacts`, is NOT a pure existence probe: the same read carries
 *      `status`, and that is the ADR-0037 platform-wide SUSPENSION GATE for all 55 payer
 *      routes. Letting a request through on an unknown status would serve a SUSPENDED payer
 *      for the duration of a Postgres blip — a fail-OPEN on an authz gate, which CLAUDE.md §3
 *      (Fail Closed) forbids outright.
 *
 * The property the fail-safe exists to guarantee — "only a DEFINITIVE row-absent throws the
 * 410; a transient DB error must never manufacture a false one" — is preserved WITHOUT a
 * try/catch, structurally rather than by convention: `findAuthFacts` awaits a drizzle
 * `select()` and destructures the first row, so a driver/connection failure REJECTS the
 * promise and propagates as a 5xx, while `undefined` is only ever reachable via a query that
 * SUCCEEDED and matched zero rows. `undefined` therefore means "the database answered, and
 * the row is not there" — never "the database did not answer". A 410 storm during an
 * incident is not something this guard has to be defended against; it cannot be reached.
 * `payer-auth.guard.test.ts` pins both halves of that so a future refactor of `findAuthFacts`
 * into a swallow-and-return-undefined shape fails the suite rather than shipping a false
 * hard-logout for every payer at once.
 */
export class PayerAccountDeletedException extends HttpException {
  constructor() {
    super(
      { code: PAYER_ACCOUNT_DELETED_CODE, message: PAYER_ACCOUNT_DELETED_MESSAGE },
      HttpStatus.GONE,
    );
  }
}
