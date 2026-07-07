import {
  BadRequestException,
  Body,
  Controller,
  ForbiddenException,
  Get,
  HttpCode,
  Inject,
  Post,
  Req,
  UnauthorizedException,
  UseGuards,
} from "@nestjs/common";
import type { Request } from "express";
import type { ServerConfig } from "@badabhai/config";
import { SERVER_CONFIG } from "../config/config.module";
import { Ctx, type RequestContext } from "../common/request-context";
import { ZodValidationPipe } from "../common/pipes/zod-validation.pipe";
import { IpRateLimit } from "../common/rate-limit/ip-rate-limit.service";
import { PiiCryptoService } from "../common/pii-crypto.service";
import { WorkersRepository } from "../workers/workers.repository";
import { AuthService } from "./auth.service";
import { OtpService } from "./otp.service";
import { SessionService } from "./session.service";
import { AccountDeletionService } from "./account-deletion.service";
import { ConsentNotRevokedGuard } from "./consent.guard";
import { ConsentRepository, isConsentAccepted } from "../consent/consent.repository";
import {
  WorkerAuthGuard,
  CurrentWorker,
  type AuthenticatedWorker,
} from "./worker-auth.guard";
import {
  OtpRequestSchema,
  OtpVerifySchema,
  TokenRefreshSchema,
  AccountDeleteConfirmSchema,
  type OtpRequestDto,
  type OtpVerifyDto,
  type TokenRefreshDto,
  type AccountDeleteConfirmDto,
  type AccountDeleteRequestResponse,
  type LoginResponse,
  type MeResponse,
  type OtpRequestResponse,
  type RefreshResponse,
  type TokenRefreshResponse,
  type SessionResponse,
  type SessionInfo,
} from "./auth.dto";
import type { SessionView } from "./session.service";

/** Map an internal SessionView (epoch-ms) to the wire SessionInfo (ISO-8601). */
function toSessionInfo(view: SessionView): SessionInfo {
  return {
    tier: view.tier,
    expires_at: new Date(view.expiresAtMs).toISOString(),
    requires_otp_after:
      view.requiresOtpAfterMs === null ? null : new Date(view.requiresOtpAfterMs).toISOString(),
  };
}

/** Bearer token from the Authorization header (the guard already validated it). */
function bearer(req: Request): string {
  const header = req.header("authorization") ?? "";
  const [, value] = header.split(" ");
  if (!value) throw new UnauthorizedException("Missing bearer token");
  return value.trim();
}

@Controller("auth")
export class AuthController {
  constructor(
    private readonly auth: AuthService,
    private readonly sessions: SessionService,
    private readonly workers: WorkersRepository,
    private readonly ipRateLimit: IpRateLimit,
    private readonly otp: OtpService,
    private readonly pii: PiiCryptoService,
    private readonly accountDeletion: AccountDeletionService,
    private readonly consents: ConsentRepository,
    @Inject(SERVER_CONFIG) private readonly config: ServerConfig,
  ) {}

  @Post("otp/request")
  @HttpCode(200)
  async requestOtp(
    @Body(new ZodValidationPipe(OtpRequestSchema)) dto: OtpRequestDto,
    @Req() req: Request,
    @Ctx() ctx: RequestContext,
  ): Promise<OtpRequestResponse> {
    // Per-IP hourly cap BEFORE issuing — a network-level abuse backstop on top of
    // the per-phone cooldown/cap. Fails closed (429) if Redis is down.
    await this.ipRateLimit.assertWithinHourlyIpCap(
      "otp_request",
      req.ip ?? "unknown",
      this.config.OTP_MAX_SENDS_PER_HOUR,
    );
    return this.auth.requestOtp(dto.phone, ctx);
  }

  @Post("otp/verify")
  @HttpCode(200)
  verifyOtp(
    @Body(new ZodValidationPipe(OtpVerifySchema)) dto: OtpVerifyDto,
    @Ctx() ctx: RequestContext,
  ): Promise<LoginResponse> {
    return this.auth.verifyOtp(dto.phone, dto.otp, ctx, dto.device_info);
  }

  /** Current worker identity + status (worker-authenticated). */
  @Get("me")
  @UseGuards(WorkerAuthGuard)
  async me(@CurrentWorker() worker: AuthenticatedWorker): Promise<MeResponse> {
    const row = await this.workers.findById(worker.id);
    return {
      worker_id: worker.id,
      status: row?.status ?? "active",
      // Finding #172-#1 — the KEY returning-worker signal: the cold-start PIN-unlock path resolves
      // the session then reads /me, so the app gates routing to /consent from here. PII-free
      // boolean (== ConsentGuard admit) via the shared ConsentRepository predicate.
      consent_accepted: await this.consents.hasAcceptedConsent(worker.id),
    };
  }

  /** Mint a fresh rolling token for the current session. */
  @Post("refresh")
  @HttpCode(200)
  @UseGuards(WorkerAuthGuard, ConsentNotRevokedGuard)
  async refresh(
    @Req() req: Request,
    @CurrentWorker() worker: AuthenticatedWorker,
  ): Promise<RefreshResponse> {
    const fresh = await this.sessions.refresh(bearer(req));
    if (!fresh) throw new UnauthorizedException("Invalid or expired session");
    return {
      access_token: fresh.token,
      token_type: "Bearer",
      expires_in_seconds: fresh.expiresInSeconds,
      // Finding #172-#1 — additive, PII-free consent-gate signal (== ConsentGuard admit). Derived
      // after the null-check so the 401 path skips the query. ConsentNotRevokedGuard already
      // blocked a revoked worker, so this is only ever true/false (accepted / never-consented).
      consent_accepted: await this.consents.hasAcceptedConsent(worker.id),
    };
  }

  /** Revoke the current session (logout). */
  @Post("logout")
  @HttpCode(204)
  @UseGuards(WorkerAuthGuard)
  async logout(@CurrentWorker() worker: AuthenticatedWorker): Promise<void> {
    await this.sessions.revoke(worker.sid, worker.id);
  }

  /**
   * Silent rotation of the opaque refresh token (ADR-0026 Phase 1). NO guard — the
   * refresh token in the body IS the credential (the access JWT may have expired). The
   * `Idempotency-Key` header is REQUIRED so an honest double-refresh (flaky-network
   * retry) returns the same rotated pair instead of tripping reuse-detection. A
   * missing/reused/invalid token ⇒ 401.
   */
  @Post("token/refresh")
  @HttpCode(200)
  async tokenRefresh(
    @Body(new ZodValidationPipe(TokenRefreshSchema)) dto: TokenRefreshDto,
    @Req() req: Request,
  ): Promise<TokenRefreshResponse> {
    const idempotencyKey = req.header("idempotency-key")?.trim();
    if (!idempotencyKey) {
      throw new BadRequestException("Idempotency-Key header is required");
    }

    // A5 (ADR-0026 amendment): block a session RESUME for a worker whose consent was REVOKED.
    // Resolve the worker from the refresh token WITHOUT rotating/consuming it, then deny only on
    // a REVOKED consent — a NEVER-consented worker (still in the pre-consent onboarding window)
    // is allowed through, mirroring ConsentNotRevokedGuard on /auth/refresh. An unresolvable
    // token skips the check and falls through to the neutral 401 below (no consent oracle for a
    // token we cannot tie to a worker).
    let consentAccepted = false;
    const resolved = await this.sessions.resolveRefreshToken(dto.refresh_token);
    if (resolved) {
      const latest = await this.consents.findLatestByWorker(resolved.workerId);
      if (latest && latest.revokedAt !== null) {
        throw new ForbiddenException("consent required");
      }
      // Finding #172-#1 — reuse the row just read for the additive, PII-free consent_accepted
      // signal (== ConsentGuard admit). Past the revoked check this is only true/false.
      consentAccepted = isConsentAccepted(latest);
    }

    const outcome = await this.sessions.refreshByToken(dto.refresh_token, idempotencyKey);
    if (!outcome.ok) {
      // invalid / reuse_detected / requires_otp all collapse to a 401 (no oracle on which).
      throw new UnauthorizedException("Invalid or expired refresh token");
    }

    const { minted } = outcome;
    return {
      access_token: minted.access.token,
      token_type: "Bearer",
      expires_in_seconds: minted.access.expiresInSeconds,
      refresh_token: minted.refresh.token,
      refresh_expires_in_seconds: minted.refresh.expiresInSeconds,
      session: toSessionInfo(minted.session),
      consent_accepted: consentAccepted,
    };
  }

  /**
   * Revoke EVERY active session for the current worker (logout-all). 204 No Content —
   * the count is recorded in the PII-free `worker.logged_out_all` event, not the body.
   */
  @Post("logout-all")
  @HttpCode(204)
  @UseGuards(WorkerAuthGuard)
  async logoutAll(@CurrentWorker() worker: AuthenticatedWorker): Promise<void> {
    await this.sessions.revokeAll(worker.id);
  }

  /** Tier + expiry introspection for the current session (ADR-0026). */
  @Get("session")
  @UseGuards(WorkerAuthGuard)
  async session(@CurrentWorker() worker: AuthenticatedWorker): Promise<SessionResponse> {
    const view = await this.sessions.describe(worker.id, worker.sid);
    if (!view) throw new UnauthorizedException("Invalid or expired session");
    const info = toSessionInfo(view);
    return {
      tier: info.tier,
      expires_at: info.expires_at,
      requires_otp_after: info.requires_otp_after,
    };
  }

  /**
   * Step-up OTP request for DPDP account deletion (ADR-0026 Phase 5). Identity ALWAYS from
   * the guard's `worker.id` — never a body — so a worker can only ever target their OWN
   * account. Decrypts the token-bound worker's phone (mirrors how login resolves it) and
   * reuses the existing gated Fast2SMS OtpService (no new provider, no fork). Reuses OTP, so
   * it emits no new event; the deletion event is emitted by /confirm. 200 with the cooldown.
   */
  @Post("account/delete/request")
  @HttpCode(200)
  @UseGuards(WorkerAuthGuard)
  async accountDeleteRequest(
    @CurrentWorker() worker: AuthenticatedWorker,
  ): Promise<AccountDeleteRequestResponse> {
    const phone = await this.resolvePhone(worker.id);
    const { resendInSeconds } = await this.otp.issueAndSend(phone);
    return { success: true, resend_in_seconds: resendInSeconds };
  }

  /**
   * Step-up OTP confirm for DPDP account deletion (ADR-0026 Phase 5). Re-derives the phone
   * from the TOKEN's worker, verifies the OTP (OtpService.verify throws 401 on a bad/expired
   * code — the step-up gate), then runs the irreversible erasure orchestration and returns
   * 204. FAIL-CLOSED: a failed OTP throws BEFORE execute() ⇒ no deletion. The body carries
   * ONLY the OTP code — identity is the guard's worker.id, never the body.
   */
  @Post("account/delete/confirm")
  @HttpCode(204)
  @UseGuards(WorkerAuthGuard)
  async accountDeleteConfirm(
    @CurrentWorker() worker: AuthenticatedWorker,
    @Body(new ZodValidationPipe(AccountDeleteConfirmSchema)) dto: AccountDeleteConfirmDto,
  ): Promise<void> {
    const phone = await this.resolvePhone(worker.id);
    // Throws 401/429/503 on a bad/expired code or Redis down (fail closed). No deletion runs
    // unless this resolves — verify is the step-up gate.
    await this.otp.verify(phone, dto.otp);
    await this.accountDeletion.execute(worker.id);
  }

  /**
   * Resolve a worker's E.164 phone from the TOKEN-bound worker row by decrypting the stored
   * ciphertext (mirrors how OTP/login resolve it). The plaintext is read transiently to feed
   * the OTP send/verify and is NEVER logged, evented, or returned. A 401 if the worker row is
   * gone (e.g. a deleted-then-reused session) — fail closed, no oracle.
   */
  private async resolvePhone(workerId: string): Promise<string> {
    const row = await this.workers.findById(workerId);
    if (!row) throw new UnauthorizedException("Invalid or expired session");
    return this.pii.decrypt(row.phoneE164);
  }
}
