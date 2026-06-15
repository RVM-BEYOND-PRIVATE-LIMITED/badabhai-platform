import {
  type CanActivate,
  type ExecutionContext,
  ForbiddenException,
  Injectable,
  UnauthorizedException,
} from "@nestjs/common";
import type { Request } from "express";
import { ConsentRepository } from "../consent/consent.repository";

/**
 * Gates worker actions behind an ACTIVE, accepted DPDP consent (CLAUDE.md §2
 * invariant 6: no profiling/processing of a worker before `consent.accepted`).
 *
 * MUST run AFTER {@link WorkerAuthGuard}: it reads `req.worker` (the authenticated
 * worker that guard attaches) and never trusts a client-supplied worker id. Order
 * the guards `@UseGuards(WorkerAuthGuard, ConsentGuard)` so auth runs first.
 *
 * "Active" = the worker's LATEST `worker_consents` row exists and is not revoked
 * (`revokedAt IS NULL`). `worker_consents` is append-only (a revoke stamps
 * `revokedAt`, a re-consent inserts a newer row), so the latest row is the current
 * state. No active consent → 403, with NO PII in the message (only the worker's
 * own opaque id, which the caller already authenticated as).
 */
@Injectable()
export class ConsentGuard implements CanActivate {
  constructor(private readonly consents: ConsentRepository) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const req = context.switchToHttp().getRequest<Request>();
    const worker = req.worker;
    // Defense-in-depth: WorkerAuthGuard runs first and attaches req.worker; if it
    // is absent the guards were misordered (or auth was skipped) — fail closed.
    if (!worker) {
      throw new UnauthorizedException("No authenticated worker on request");
    }

    const latest = await this.consents.findLatestByWorker(worker.id);
    if (!latest || latest.revokedAt !== null) {
      throw new ForbiddenException("worker has not accepted consent");
    }
    return true;
  }
}
