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

/**
 * DEFENSE-IN-DEPTH consent gate for session RESUME / refresh (A5 · ADR-0026 amendment).
 *
 * Blocks a worker whose consent was REVOKED from extending/resuming a session — while, UNLIKE
 * {@link ConsentGuard}, ALLOWING a NEVER-consented worker through. That asymmetry is deliberate:
 * the pre-consent onboarding window (login → consent → chat) mints a session BEFORE consent is
 * captured, and refreshing during that window must keep working. The profiling routes still
 * carry {@link ConsentGuard}, which denies a never-consented worker until they accept, so §6 is
 * never relaxed on the processing path. What this adds is narrow: once a worker has WITHDRAWN
 * consent, the refresh path can no longer silently keep their live session alive.
 *
 * MUST run AFTER {@link WorkerAuthGuard} (reads `req.worker`; never a client-supplied id).
 * "Revoked" = the LATEST `worker_consents` row exists AND has `revokedAt` set → 403, PII-free
 * message. (The guard-less `POST /auth/token/refresh` enforces the SAME rule in the controller,
 * since the worker there is resolved from the refresh token, not an authenticated request.)
 */
@Injectable()
export class ConsentNotRevokedGuard implements CanActivate {
  constructor(private readonly consents: ConsentRepository) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const req = context.switchToHttp().getRequest<Request>();
    const worker = req.worker;
    if (!worker) {
      throw new UnauthorizedException("No authenticated worker on request");
    }
    const latest = await this.consents.findLatestByWorker(worker.id);
    if (latest && latest.revokedAt !== null) {
      throw new ForbiddenException("consent required");
    }
    return true;
  }
}
