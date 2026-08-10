import {
  type CanActivate,
  type ExecutionContext,
  ForbiddenException,
  Injectable,
  SetMetadata,
  UnauthorizedException,
} from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import type { Request } from "express";
import type { ConsentPurpose } from "@badabhai/types";
import { ConsentRepository } from "../consent/consent.repository";

/** Reflector metadata key for the purpose declared by {@link RequireConsentPurpose}. */
export const CONSENT_PURPOSE_KEY = "consent_purpose";

/**
 * Declares the DPDP PURPOSE a route requires, on top of the blanket "has consented at all"
 * check {@link ConsentGuard} already performs. Pair it with that guard, which must itself run
 * after {@link WorkerAuthGuard}:
 *
 *   @UseGuards(WorkerAuthGuard, ConsentGuard)
 *   @RequireConsentPurpose("voice_processing")
 *   @Post("transcribe") ...
 *
 * Method-level beats class-level (`getAllAndOverride`), so a controller can carry a default
 * purpose and one route can narrow or widen it.
 */
export const RequireConsentPurpose = (
  purpose: ConsentPurpose,
): MethodDecorator & ClassDecorator => SetMetadata(CONSENT_PURPOSE_KEY, purpose);

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
 *
 * PURPOSE-AWARE since V9, and the default is the one thing to get right. A route may
 * additionally declare {@link RequireConsentPurpose}, in which case the latest row must also
 * CARRY that purpose — the fail-closed shape `MessagingConsentService` already uses for
 * `whatsapp_messaging`, lifted into the guard so a route gets it by declaration instead of by
 * remembering to inject a service.
 *
 * A ROUTE THAT DECLARES NO PURPOSE KEEPS ITS EXACT PRE-V9 MEANING — any active consent passes.
 * This deliberately differs from {@link import("../admin/admin-roles.guard").AdminRolesGuard},
 * where missing metadata is a 403: that guard shipped with its decorator, so a bare route was
 * always a misconfiguration. This one has been mounted on a dozen controllers since long before
 * purposes were enforceable, and reading "no declaration" as "deny" would 403 every worker on
 * every profiling, chat and resume route the moment this file merged. Backward compatibility
 * (CLAUDE.md §3) is not a nicety here — it is the difference between a gate and an outage.
 * Deny-by-default still holds where it is meaningful: a route that DOES declare a purpose is
 * denied unless the worker's consent carries that exact string.
 */
@Injectable()
export class ConsentGuard implements CanActivate {
  constructor(
    private readonly consents: ConsentRepository,
    private readonly reflector: Reflector,
  ) {}

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

    const required = this.reflector.getAllAndOverride<ConsentPurpose | undefined>(
      CONSENT_PURPOSE_KEY,
      [context.getHandler(), context.getClass()],
    );
    // `purposes` is NOT NULL in the schema, but `?? []` is kept deliberately: a row written
    // before the column existed, or read through a partial select, must deny rather than throw.
    if (required !== undefined && !(latest.purposes ?? []).includes(required)) {
      // The SAME message as a missing consent, on purpose. A worker who consented to profiling
      // but not to recording must not learn which purposes exist by diffing 403 bodies.
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
