import {
  type CanActivate,
  type ExecutionContext,
  Inject,
  Injectable,
  Logger,
  SetMetadata,
  UnauthorizedException,
  createParamDecorator,
} from "@nestjs/common";
import type { Request, Response } from "express";
import type { ServerConfig } from "@badabhai/config";
import { SERVER_CONFIG } from "../config/config.module";
import { ConsentRepository } from "../consent/consent.repository";
import { WorkersRepository } from "../workers/workers.repository";
import { SessionService } from "./session.service";
import {
  readWorkerAccountState,
  WorkerAccountDeletedException,
} from "./worker-account-deleted.exception";

/**
 * #2562 — opt a route OUT of the suspension refusal. Used ONLY for the DPDP exits: account
 * deletion request/confirm/cancel and consent withdrawal. A suspended worker must still be
 * able to erase their data or withdraw consent; every other worker route stays refused.
 */
export const ALLOW_SUSPENDED_KEY = "allow_suspended_worker" as const;
export const AllowSuspended = () => SetMetadata(ALLOW_SUSPENDED_KEY, true);

/** The authenticated worker attached to the request by {@link WorkerAuthGuard}. */
export interface AuthenticatedWorker {
  id: string;
  sid: string;
  /** ADR-0026 Phase 2 — the bound trusted-device row uuid (the token `did` claim), if any. */
  deviceId?: string;
  /** #2562 — epoch-ms of the OTP that minted this session family (PIN-reset watermark input). */
  createdAtMs?: number;
}

// Augment Express's Request with the authenticated worker (global namespace).
declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      worker?: AuthenticatedWorker;
    }
  }
}

/**
 * Guards worker-only routes. Reads `Authorization: Bearer <jwt>`, validates +
 * touches the session, and attaches `req.worker = { id, sid }`. A missing/invalid
 * token → 401.
 *
 * ROLLING TOKEN: when the current token is past its half-life, a fresh JWT is
 * minted and returned in the `x-session-token` response header so an active
 * client transparently keeps a fresh token without a separate refresh call.
 *
 * A5 residual (ADR-0026 amendment): the half-life re-mint is CONSENT-GATED — a worker
 * whose latest consent is REVOKED no longer gets a silent fresh full-TTL token, so a
 * revoked worker's residual access is bounded by the CURRENT token's remaining TTL.
 * The request itself still passes (logout keeps working for revoked workers), and a
 * NEVER-consented worker keeps the re-mint (the pre-consent onboarding window — the
 * same asymmetry as ConsentNotRevokedGuard). Cost: ONE consent read at most once per
 * half-life, never on the ordinary per-request path.
 *
 * FAIL-SAFE BOTH WAYS: the three Postgres reads here (the account-existence and suspension
 * probes below, and the consent read on the re-mint branch) are the guard's ONLY Postgres
 * dependencies
 * (validateAndTouch is Redis-only, mint is pure JWT), so a read error must never turn
 * into a 500/410 on `[W]`-only routes — POST /auth/logout and /auth/logout-all are exactly
 * the routes that must survive a DB incident. On ANY consent-read error the guard
 * WITHHOLDS the extension (no re-mint without proof of not-revoked — the security
 * property holds) and lets the already-authenticated request pass, the same
 * degradation shape validateAndTouch applies to a Redis error (request outcome,
 * never a 500). The existence probe degrades the same way: an UNKNOWN existence (a DB error)
 * is treated as "present" so a DB blip never 410-storms every worker route; #2562's
 * suspension probe degrades identically.
 *
 * OUT-OF-BAND DELETION → 410 (not 401): a VALID session whose worker ROW is gone means the row
 * was deleted directly in the DB, bypassing AccountDeletionService (which revokes every session
 * FIRST — so a normally-deleted worker has no session left and already fails the 401 above). That
 * one case throws {@link WorkerAccountDeletedException} (410 `WORKER_ACCOUNT_DELETED`), reserved
 * exclusively for it, so the client can tell "silently re-authenticate" (401) apart from "this
 * account is gone, hard-logout" (410). An invalid/expired token stays 401 — deliberately unchanged.
 */
@Injectable()
export class WorkerAuthGuard implements CanActivate {
  private readonly logger = new Logger(WorkerAuthGuard.name);

  constructor(
    private readonly session: SessionService,
    @Inject(SERVER_CONFIG) private readonly config: ServerConfig,
    private readonly consents: ConsentRepository,
    // @Global WorkersRepository (workers.module.ts) — resolves in every importing module's
    // injector with no new module import and no cycle (AccountDeletionService already injects it
    // here). Backs the out-of-band-deletion existence probe.
    private readonly workers: WorkersRepository,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const req = context.switchToHttp().getRequest<Request>();
    const res = context.switchToHttp().getResponse<Response>();

    const token = WorkerAuthGuard.extractBearer(req);
    if (!token) throw new UnauthorizedException("Missing or malformed Authorization header");

    // #2562 — validate WITHOUT sliding the TTL first. The account gates run before the
    // session is touched, so a suspended worker's request cannot extend the session it is
    // about to be refused on.
    const validated = await this.session.validate(token);
    if (!validated) throw new UnauthorizedException("Invalid or expired session");

    // ONE primary-key read covers both the out-of-band deletion 410 and the suspension gate.
    // FAIL-SAFE: an unavailable probe is `unknown` and lets the request through (a Postgres
    // incident must never 401/410 every worker route); only a definitive row state acts.
    const accountState = await readWorkerAccountState(
      this.workers,
      validated.workerId,
      this.logger,
    );
    if (accountState === "deleted") throw new WorkerAccountDeletedException();

    // #2562 — the DPDP exits (account deletion + consent withdrawal) stay reachable while
    // suspended. Every other route is refused with the SAME neutral 401 as an expired session
    // so the worker app's existing re-auth path runs instead of trapping them on a 403 screen.
    const allowSuspended =
      Reflect.getMetadata(ALLOW_SUSPENDED_KEY, context.getHandler()) === true;
    if (accountState === "suspended" && !allowSuspended) {
      throw new UnauthorizedException("Invalid or expired session");
    }

    // #2562 — the durable sweep watermark. A family minted before the last admin sweep is
    // dead even if its Redis record survived a partial delete or an in-flight rotation.
    const revokedAtMs = await this.session.sessionsRevokedAtMs(validated.workerId);
    if (revokedAtMs !== null && validated.createdAtMs < revokedAtMs) {
      throw new UnauthorizedException("Invalid or expired session");
    }

    if (!(await this.session.touchSession(validated.workerId, validated.sid))) {
      throw new UnauthorizedException("Invalid or expired session");
    }

    req.worker = {
      id: validated.workerId,
      sid: validated.sid,
      deviceId: validated.deviceId,
      createdAtMs: validated.createdAtMs,
    };

    // Rolling refresh: past the half-life, hand back a fresh token via a header. Preserve
    // the device binding (`did`) so the rolled token stays bound to the same device.
    const fullTtl = this.config.SESSION_TTL_DAYS * 86400;
    if (validated.remainingSeconds < fullTtl / 2) {
      // A5 residual: SKIP the re-mint for a REVOKED-consent worker (latest row exists AND
      // revokedAt is stamped). Never-consented (no row) and active consent both re-mint.
      // FAIL-SAFE: a consent-read error also SKIPS the re-mint (consent state unknown →
      // withhold the extension) but never fails the already-authenticated request — a
      // PG blip must not 500 logout/logout-all past the token half-life.
      let allowRemint = false;
      try {
        const latest = await this.consents.findLatestByWorker(validated.workerId);
        allowRemint = !latest || latest.revokedAt === null;
      } catch {
        allowRemint = false;
      }
      if (allowRemint) {
        const fresh = await this.session.mint(
          validated.workerId,
          validated.sid,
          validated.deviceId,
        );
        res.setHeader("x-session-token", fresh.token);
      }
    }

    return true;
  }

  private static extractBearer(req: Request): string | null {
    const header = req.header("authorization");
    if (!header) return null;
    const [scheme, value] = header.split(" ");
    if (scheme?.toLowerCase() !== "bearer" || !value) return null;
    return value.trim() || null;
  }
}

/**
 * Param decorator surfacing the authenticated worker attached by
 * {@link WorkerAuthGuard}. Use only on guarded routes.
 *
 *   @Get("me") me(@CurrentWorker() worker: AuthenticatedWorker) { ... }
 */
export const CurrentWorker = createParamDecorator(
  (_data: unknown, ctx: ExecutionContext): AuthenticatedWorker => {
    const req = ctx.switchToHttp().getRequest<Request>();
    if (!req.worker) {
      // Should never happen: the guard runs first and throws on no worker.
      throw new UnauthorizedException("No authenticated worker on request");
    }
    return req.worker;
  },
);
