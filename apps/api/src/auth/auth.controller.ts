import { BadRequestException, Body, Controller, ForbiddenException, Get, HttpCode, HttpException, HttpStatus, Inject, Logger, NotFoundException, Post, Req, UnauthorizedException, UseGuards } from "@nestjs/common";
import type { Request } from "express";
import type { ServerConfig } from "@badabhai/config";
import { SERVER_CONFIG } from "../config/config.module";
import { Ctx, type RequestContext } from "../common/request-context";
import { ZodValidationPipe } from "../common/pipes/zod-validation.pipe";
import { OtpRequestIdempotency } from "./otp-request-idempotency.service";
import { IpRateLimit } from "../common/rate-limit/ip-rate-limit.service";
import { senderOf } from "../common/rate-limit/request-sender";
import { PiiCryptoService } from "../common/pii-crypto.service";
import { WorkersRepository } from "../workers/workers.repository";
import { AuthService } from "./auth.service";
import { OtpService } from "./otp.service";
import { SessionService } from "./session.service";
import { AccountDeletionService } from "./account-deletion.service";
import { ConsentNotRevokedGuard } from "./consent.guard";
import { ConsentRepository } from "../consent/consent.repository";
import { withConsentAccepted } from "../consent/consent-flag";
import { WorkerAuthGuard, CurrentWorker, type AuthenticatedWorker } from "./worker-auth.guard";
import { throwIfWorkerDeleted } from "./worker-account-deleted.exception";
import { TestLoginGuard } from "./test-login.guard";
import {
  OtpRequestSchema,
  OtpVerifySchema,
  TestLoginSchema,
  TokenRefreshSchema,
  AccountDeleteConfirmSchema,
  type OtpRequestDto,
  type OtpVerifyDto,
  type TestLoginDto,
  type TokenRefreshDto,
  type AccountDeleteConfirmDto,
  type AccountDeleteRequestResponse,
  type AccountDeleteConfirmResponse,
  type AccountDeleteCancelResponse,
  type AccountDeleteImmediateResponse,
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
  private readonly logger = new Logger(AuthController.name);

  constructor(
    private readonly auth: AuthService,
    private readonly sessions: SessionService,
    private readonly workers: WorkersRepository,
    private readonly ipRateLimit: IpRateLimit,
    private readonly otp: OtpService,
    private readonly pii: PiiCryptoService,
    private readonly accountDeletion: AccountDeletionService,
    private readonly consents: ConsentRepository,
    private readonly otpIdempotency: OtpRequestIdempotency,
    @Inject(SERVER_CONFIG) private readonly config: ServerConfig,
  ) {}

  /**
   * Send a login code.
   *
   * `Idempotency-Key` IS HONOURED HERE (#1019) and everything below it — the per-IP cap
   * included — runs inside that guard. The client retries a transport failure up to three
   * times under ONE key, and this route used to count every attempt as a fresh request: one
   * tap could spend three of a per-phone hourly budget of five, send three paid SMS, and
   * push the platform-wide daily breaker toward the ceiling that 429s every worker on every
   * device until UTC midnight. The header is OPTIONAL — unlike `/auth/token/refresh`, which
   * can require it because every caller is our own client; requiring it on the front door
   * would break callers that never sent one (§3).
   */
  @Post("otp/request")
  @HttpCode(200)
  async requestOtp(
    @Body(new ZodValidationPipe(OtpRequestSchema)) dto: OtpRequestDto,
    @Req() req: Request,
    @Ctx() ctx: RequestContext,
  ): Promise<OtpRequestResponse> {
    return this.otpIdempotency.runOnce({
      scope: "otp_request",
      phoneE164: dto.phone,
      idempotencyKey: req.header("idempotency-key"),
      // A duplicate that lands while the first attempt is still sending gets the cooldown it
      // would have got, without a second send. `success: true` is honest at this point: an
      // attempt IS in flight, and if it fails the worker asks again after the cooldown.
      inFlight: () => ({
        success: true as const,
        channel: "sms" as const,
        resend_in_seconds: this.config.OTP_RESEND_COOLDOWN_SECONDS,
      }),
      work: async () => {
        // TWO CAPS BEFORE ISSUING, and the ORDER is deliberate (#1035).
        //
        // FIRST, THE SENDER — the handset that asked, via `X-Device-Id`, falling back to the
        // address for a client that sends none. This is the gate that is supposed to trip:
        // it separates two workers standing on one factory wifi, which is the thing the
        // address cannot do. Keyed on the address it was the NAT egress bucket, so a handful
        // of legitimate sign-ins locked out everyone else behind the same CGNAT pool and
        // changing your phone number did not help, because the number was never the key.
        //
        // SECOND, THE NETWORK — a crude flood ceiling, ~50× the sender cap, that a real
        // shared wifi must never reach. Its own scope (`otp_request_net`) so it cannot
        // collide with the address bucket the fallback above still writes.
        //
        // Sender first so a device that has already spent its allowance does NOT also charge
        // the bucket its neighbours share. Both fail closed (429) if Redis is down.
        await this.ipRateLimit.assertWithinHourlySenderCap(
          "otp_request",
          senderOf(req),
          this.config.OTP_MAX_SENDS_PER_DEVICE_PER_HOUR,
        );
        await this.ipRateLimit.assertWithinHourlyIpCap(
          "otp_request_net",
          req.ip ?? "unknown",
          this.config.OTP_MAX_SENDS_PER_IP_PER_HOUR,
        );
        return this.auth.requestOtp(dto.phone, ctx);
      },
    });
  }

  /**
   * IDEMPOTENT UNDER `Idempotency-Key` (#1023), on the same retry ladder as the send routes.
   *
   * `auth_api.dart` already sends this route with `idempotent: true`, so `AuthedClient` mints
   * ONE key and reuses it across up to three transport retries — and the server ignored it.
   * `OtpService.verify` increments `otp:attempts:<phoneHash>` per CALL and DELETES the code once
   * `OTP_MAX_ATTEMPTS` is exceeded, so a worker on a flaky link who typed the CORRECT code could
   * have it counted two or three times and be told "Too many attempts, request a new code".
   *
   * Worse, and the case the guard actually rescues: when attempt 1 SUCCEEDS and only its
   * response is lost, the code is already consumed — single-use by design — so the retry finds
   * nothing and returns 401. The worker is told the code they typed correctly is wrong. Replaying
   * the stored session is the only answer that is true to what happened.
   *
   * SECRET AT REST. The 200 here is a `LoginResponse` carrying an access JWT and a refresh
   * token, so the outcome is stored as CIPHERTEXT (`secret: true`) — the same rule
   * `SessionService` follows for the pair its own refresh grace caches, and the same 180s
   * window. Replaying needs the used code AND that exact 128-bit key AND the ability to
   * decrypt: essentially the legitimate client.
   *
   * The whole `withConsentAccepted` compose is inside `work`, so what is replayed is the exact
   * response the first attempt produced rather than a session re-derived later against a
   * consent record that may since have changed.
   *
   * NO OPTIMISTIC `inFlight` ANSWER IS POSSIBLE, unlike the send routes. There is no session to
   * hand back until the first attempt finishes, and the one thing this must never do is answer
   * "wrong code" for a code that is being verified right now. So a duplicate that lands mid-flight
   * gets the retryable 503 the OTP path already uses for a transient fault — it consumes no
   * attempt, makes no claim about the code, and the next rung of the ladder finds the stored
   * outcome. It is a narrow window in practice: a verify is Redis reads plus a JWT mint, with no
   * provider call to outlive the client's 15s timeout the way a Fast2SMS send can.
   */
  @Post("otp/verify")
  @HttpCode(200)
  async verifyOtp(
    @Body(new ZodValidationPipe(OtpVerifySchema)) dto: OtpVerifyDto,
    @Req() req: Request,
    @Ctx() ctx: RequestContext,
  ): Promise<LoginResponse> {
    // TWO CAPS BEFORE THE RESERVATION (#1132), and OUTSIDE `runOnce` on purpose — the one place
    // in this file a limiter runs in FRONT of the idempotency reservation rather than inside the
    // guarded work. `runOnce` reserves with `SET NX` BEFORE it runs the work (correctly — see its
    // header), so on this UNAUTHENTICATED route that Redis write used to be the first thing to
    // run, ahead of every control there was. An unauthenticated caller could therefore mint one
    // non-evictable idempotency key per distinct key/phone into a `noeviction` Redis and wedge it
    // — the platform-wide 429/503/401 lockout #1019 exists to end. Capping here means the
    // reservation is only ever written for a caller already inside its device+network budget.
    //
    // KEYED ON THE HANDSET FIRST, exactly as /auth/otp/request (#1035): `senderOf(req)` is the
    // device the client named via `X-Device-Id`, the address only as a fallback for a caller that
    // sent none. Keyed on `req.ip` this would be the NAT egress / carrier-CGNAT bucket, and a
    // handful of legitimate sign-ins would lock out everyone else behind the same pool — the exact
    // outage #1035 fixed on the send route. Same device-then-network ORDER as the send
    // route, but its OWN scopes (`otp_verify` / `otp_verify_net`) and its OWN knobs — a verify
    // is not a send, and each send licenses up to OTP_MAX_ATTEMPTS of them, so the send budget
    // is the wrong ceiling here (see the derivation on OTP_MAX_VERIFY_PER_DEVICE_PER_HOUR). The
    // rate-limit namespace (`ratelimit:…`) cannot collide with the idempotency one (`otp_idem:…`).
    //
    // ONE LOGICAL VERIFY CAN SPEND UP TO THREE UNITS, because these run OUTSIDE `runOnce` while
    // `AuthedClient` reuses one key across three transport retries — the price of capping ahead
    // of the reservation, and the reason the verify budget carries headroom the send budget does
    // not need.
    await this.ipRateLimit.assertWithinHourlySenderCap(
      "otp_verify",
      senderOf(req),
      this.config.OTP_MAX_VERIFY_PER_DEVICE_PER_HOUR,
    );
    await this.ipRateLimit.assertWithinHourlyIpCap(
      "otp_verify_net",
      req.ip ?? "unknown",
      this.config.OTP_MAX_VERIFY_PER_IP_PER_HOUR,
    );
    return this.otpIdempotency.runOnce({
      scope: "otp_verify",
      phoneE164: dto.phone,
      idempotencyKey: req.header("idempotency-key"),
      secret: true,
      inFlight: () => {
        throw new HttpException(
          "This is temporarily unavailable; please retry shortly",
          HttpStatus.SERVICE_UNAVAILABLE,
        );
      },
      work: async () => {
        const login = await this.auth.verifyOtp(dto.phone, dto.otp, ctx, dto.device_info);
        return withConsentAccepted(this.consents, login);
      },
    });
  }

  /**
   * D-3 — the GATED test-login mint seam (staging smoke / e2e ONLY). Invisible by
   * default: {@link TestLoginGuard} answers a NEUTRAL 404 while TEST_LOGIN_ENABLED
   * is off and a neutral 401 on a wrong/missing `x-test-login-token` — BEFORE the
   * body pipe runs (no shape oracle). assertAuthConfig makes arming the flag in
   * production a BOOT FAILURE, so this handler can never execute there.
   *
   * Mints a REAL worker session for the synthetic test phone through the SAME
   * AuthService seam the OTP verify path uses and returns the SAME LoginResponse
   * shape (incl. the TD62 consent_accepted compose) — so everything downstream
   * (ConsentGuard, tiers, refresh, revocation) treats it exactly like an OTP
   * session. Consent is NEVER created or bypassed here. Emits the distinct
   * `worker.test_login` event.
   *
   * TWO caps, both fail-closed (review L1): the per-IP hour cap (as
   * /auth/otp/request) AND a GLOBAL daily ceiling — the per-IP cap alone would let a
   * token holder rotate IPs for unlimited mints, so the IP-INDEPENDENT backstop is
   * what actually bounds the seam (TEST_LOGIN_MAX_PER_DAY; 0 = kill-switch). The
   * SERVICE additionally refuses any phone outside the reserved synthetic range
   * (review M1) — that is the mint chokepoint, and it answers the same neutral 404.
   */
  @Post("test-login")
  @HttpCode(200)
  @UseGuards(TestLoginGuard)
  async testLogin(
    @Body(new ZodValidationPipe(TestLoginSchema)) dto: TestLoginDto,
    @Req() req: Request,
    @Ctx() ctx: RequestContext,
  ): Promise<LoginResponse> {
    // The SAME sender-then-network pair as /auth/otp/request above, and for the same reason:
    // these are per-CALLER questions, not a per-phone SMS budget. Their own buckets
    // (`test_login` / `test_login_net`), so the seam never competes with real sign-ins — and
    // the GLOBAL daily ceiling below, not either of these, is what actually bounds it.
    await this.ipRateLimit.assertWithinHourlySenderCap(
      "test_login",
      senderOf(req),
      this.config.OTP_MAX_SENDS_PER_DEVICE_PER_HOUR,
    );
    await this.ipRateLimit.assertWithinHourlyIpCap(
      "test_login_net",
      req.ip ?? "unknown",
      this.config.OTP_MAX_SENDS_PER_IP_PER_HOUR,
    );
    await this.ipRateLimit.assertWithinGlobalDailyCap(
      "test_login",
      this.config.TEST_LOGIN_MAX_PER_DAY,
    );
    const login = await this.auth.testLogin(dto.phone, ctx);
    return withConsentAccepted(this.consents, login);
  }

  /**
   * Current worker identity + status (worker-authenticated).
   *
   * ADR-0031: also carries `deletion_scheduled_for` while a deletion is pending — the one
   * seam that reaches EVERY entry path (PIN-unlock and refresh re-bridge a session without
   * ever hitting OTP-verify, so the login-response field alone left a cold-started app with
   * no banner and no cancel action). Read through an EXPLICIT projection (`findSelfView`,
   * not the SELECT-* `findById`) so no PII column is fetched at all. The field is SPREAD in
   * only when the marker is set — absent (never null) means nothing is pending, and the
   * value is never synthesized.
   */
  @Get("me")
  @UseGuards(WorkerAuthGuard)
  async me(@CurrentWorker() worker: AuthenticatedWorker): Promise<MeResponse> {
    const row = await this.workers.findSelfView(worker.id);
    return {
      worker_id: worker.id,
      status: row?.status ?? "active",
      ...(row?.deletionScheduledAt
        ? { deletion_scheduled_for: row.deletionScheduledAt.toISOString() }
        : {}),
    };
  }

  /** Mint a fresh rolling token for the current session. */
  @Post("refresh")
  @HttpCode(200)
  @UseGuards(WorkerAuthGuard, ConsentNotRevokedGuard)
  async refresh(@Req() req: Request): Promise<RefreshResponse> {
    const fresh = await this.sessions.refresh(bearer(req));
    if (!fresh) throw new UnauthorizedException("Invalid or expired session");
    return {
      access_token: fresh.token,
      token_type: "Bearer",
      expires_in_seconds: fresh.expiresInSeconds,
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
    const resolved = await this.sessions.resolveRefreshToken(dto.refresh_token);
    if (resolved) {
      const latest = await this.consents.findLatestByWorker(resolved.workerId);
      if (latest && latest.revokedAt !== null) {
        throw new ForbiddenException("consent required");
      }

      // COLD-START SIGNAL: this is the one worker-authed path with no WorkerAuthGuard (the
      // refresh token in the body IS the credential), so the guard's out-of-band-deletion 410
      // never runs here. When a deleted worker's refresh token survives (a raw row delete does
      // NOT revoke sessions — a normal AccountDeletionService erasure would, so `resolveRefreshToken`
      // would return null and this branch is skipped), return the SAME reserved 410 rather than
      // rotating a fresh token for a ghost, so a cold-started app gets the unambiguous hard-logout
      // signal on its first call. A PRE-CHECK on the already-resolved (read-only, non-consuming)
      // worker id — it never rotates/marks-used/flags-reuse, so it does not touch reuse-detection.
      // FAIL-SAFE like the guard: a DB error leaves existence UNKNOWN → fall through to the normal
      // rotation (never a false 410 during a DB incident).
      await throwIfWorkerDeleted(this.workers, resolved.workerId, this.logger);
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
   * sends via the SHARED AuthService failure-signal seam over the existing gated Fast2SMS
   * OtpService (no new provider, no fork). A successful send emits nothing here
   * (`worker.otp_requested` is a login event; the deletion event is emitted by /confirm),
   * but a delivery failure emits the same PII-free `worker.otp_send_failed` — and a
   * global-cap breach the same `worker.otp_send_cap_exceeded` — monitoring event as the
   * login path (F4, #168). 200 with the cooldown.
   */
  @Post("account/delete/request")
  @HttpCode(200)
  @UseGuards(WorkerAuthGuard)
  async accountDeleteRequest(
    @CurrentWorker() worker: AuthenticatedWorker,
    @Req() req: Request,
    @Ctx() ctx: RequestContext,
  ): Promise<AccountDeleteRequestResponse> {
    const phone = await this.resolvePhone(worker.id);
    // IDEMPOTENT UNDER `Idempotency-Key` (#1023). This reaches `issueAndSendWithSignals`, i.e.
    // the SAME `OtpService.issueAndSend` and therefore the same per-phone hourly (5), per-phone
    // daily (10) and platform-wide `OTP_GLOBAL_MAX_SENDS_PER_DAY` breaker as the login send —
    // and the breaker, once tripped, 429s EVERY worker on EVERY device until UTC midnight.
    //
    // Its contribution is genuinely small: the route is authenticated, deliberate and fires a
    // handful of times a day, and the resend cooldown arming at t≈0.1s refuses the t≈15.3s rung
    // before either INCR — so the realistic amplification is 2 sends per tap, not 3. This is
    // scope-completeness rather than a live outage: the counters are shared, so the route
    // should not be the one place a retry can still spend them.
    //
    // NOT `secret`: the response is `{ success, resend_in_seconds }`, the same shape as the
    // send routes and carrying no credential.
    //
    // Its OWN scope, so a key cannot replay between this and login — the key namespace is
    // per-phone, and this route resolves the very same phone that /auth/otp/request would.
    return this.otpIdempotency.runOnce({
      scope: "account_delete_request",
      phoneE164: phone,
      idempotencyKey: req.header("idempotency-key"),
      inFlight: () => ({
        success: true as const,
        resend_in_seconds: this.config.OTP_RESEND_COOLDOWN_SECONDS,
      }),
      work: async () => {
        const { resendInSeconds } = await this.auth.issueAndSendWithSignals(phone, ctx);
        return { success: true as const, resend_in_seconds: resendInSeconds };
      },
    });
  }

  /**
   * Step-up OTP confirm for DPDP account deletion (ADR-0026 Phase 5, amended by ADR-0031:
   * confirm now SCHEDULES the erasure — it no longer executes it in-request). Re-derives
   * the phone from the TOKEN's worker, verifies the OTP (OtpService.verify throws 401 on a
   * bad/expired code — the step-up gate), then stamps the grace-window due time and returns
   * 200 { scheduled_for }. The hard-delete itself runs in the sweep once the grace elapses;
   * the worker can cancel anytime before then. FAIL-CLOSED: a failed OTP throws BEFORE
   * schedule() ⇒ nothing scheduled. The body carries ONLY the OTP code — identity is the
   * guard's worker.id, never the body.
   */
  @Post("account/delete/confirm")
  @HttpCode(200)
  @UseGuards(WorkerAuthGuard)
  async accountDeleteConfirm(
    @CurrentWorker() worker: AuthenticatedWorker,
    @Body(new ZodValidationPipe(AccountDeleteConfirmSchema)) dto: AccountDeleteConfirmDto,
    @Ctx() ctx: RequestContext,
  ): Promise<AccountDeleteConfirmResponse> {
    const phone = await this.resolvePhone(worker.id);
    // Throws 401/429/503 on a bad/expired code or Redis down (fail closed). Nothing is
    // scheduled unless this resolves — verify is the step-up gate.
    await this.otp.verify(phone, dto.otp);
    const { scheduled_for } = await this.accountDeletion.schedule(worker.id, ctx);
    return { success: true, scheduled_for };
  }

  /**
   * Cancel a pending account deletion during the grace window (ADR-0031). WorkerAuthGuard
   * ONLY — deliberately NO ConsentGuard, mirroring request/confirm: a consent-revoked
   * worker must still be able to manage their own deletion. No body at all — identity is
   * the guard's worker.id (no IDOR). IDEMPOTENT: cancelling with nothing pending is a 200
   * no-op, so the response is ALWAYS { success: true } (whether a deletion was actually
   * pending is recorded by the worker.deletion_cancelled event, never the body).
   */
  @Post("account/delete/cancel")
  @HttpCode(200)
  @UseGuards(WorkerAuthGuard)
  async accountDeleteCancel(
    @CurrentWorker() worker: AuthenticatedWorker,
    @Ctx() ctx: RequestContext,
  ): Promise<AccountDeleteCancelResponse> {
    await this.accountDeletion.cancel(worker.id, ctx);
    return { success: true };
  }

  /**
   * QA-ONLY immediate hard-delete seam (TD — testing). Erases the CALLING worker's account
   * RIGHT NOW — no step-up OTP, no 7-day grace — so QA can reproduce a real account deletion
   * WITHOUT a DBA and without waiting out the DPDP grace window. Identity is ALWAYS the guard's
   * `worker.id`, never a body — a worker can only ever delete their OWN account (no body param
   * exists to smuggle a victim id, no IDOR).
   *
   * GATED, DEFAULT OFF: while TEST_IMMEDIATE_DELETE_ENABLED is off this route answers a NEUTRAL
   * 404 (behaves as if it does not exist), the same invisibility posture as the test-login seam.
   * The env check runs INSIDE the handler (after WorkerAuthGuard), so an unauthenticated/expired
   * token is still the guard's normal 401 — only an AUTHED caller on a DISABLED build sees the 404.
   *
   * ROUTES THROUGH THE SAME `AccountDeletionService.execute` THE GRACED DPDP FLOW USES (#1239 —
   * supersedes the #1187 "raw row delete only" design below `accountDeleteConfirm`'s sweep). A
   * bare `WorkersRepository.hardDelete` here left the account only PARTIALLY erased: the Redis
   * session survived, and resume/voice-note/photo objects in storage were never swept — so a QA
   * "delete" could still surface old data (e.g. a live session, or orphaned storage objects) even
   * though the `workers` row was gone. `execute` performs the SAME complete, idempotent sequence
   * `accountDeleteConfirm`'s grace-elapse sweep runs: revoke all sessions + refresh families FIRST,
   * sweep every storage prefix (resumes / voice notes / photos / feedback attachments /
   * conversations), THEN the atomic transactional DB delete (Postgres cascades the PII children
   * and SET-NULLs the billing FKs — migration 0030), a Redis cool-down tombstone, and the
   * PII-free `worker.account_deleted` event — see `AccountDeletionService` for the full sequence
   * and its fail-open/idempotency contract. A re-run on an already-deleted worker is a clean no-op
   * (execute's own `findById` guard).
   *
   * The ONLY things this seam still skips, on purpose, are the step-up OTP and the 7-day grace
   * window — that is the entire point of "immediate" vs. the real DPDP flow, and neither changes
   * here: no OTP is verified, and the erasure runs synchronously in-request rather than being
   * scheduled.
   *
   * BOOT-REFUSAL (#1187, ruled and implemented): `assertAuthConfig` refuses to boot when this flag
   * is true and the RAW NODE_ENV is not explicitly development/test/staging — the same structural
   * production block TEST_LOGIN_ENABLED carries. OFF-by-default was never sufficient on its own for
   * an irreversible-destruction seam: it left one env var between production and permanent data loss.
   */
  @Post("account/delete/immediate")
  @HttpCode(200)
  @UseGuards(WorkerAuthGuard)
  async accountDeleteImmediate(
    @CurrentWorker() worker: AuthenticatedWorker,
  ): Promise<AccountDeleteImmediateResponse> {
    // Flag OFF (the default) → neutral 404: the seam is invisible on a normal build.
    if (!this.config.TEST_IMMEDIATE_DELETE_ENABLED) throw new NotFoundException("Not found");

    // The SAME complete erasure the graced DPDP flow runs — sessions + refresh families revoked,
    // every storage prefix swept, THEN the atomic DB delete (see the doc comment). Idempotent —
    // a re-run on an already-deleted worker is a clean no-op.
    await this.accountDeletion.execute(worker.id);

    // AUDIT: `execute` already emits the PII-free `worker.account_deleted` event; this line is
    // the QA-box-local marker that the IMMEDIATE (no-OTP, no-grace) seam is what triggered it.
    // PII-FREE (CLAUDE.md §2): an 8-char id prefix only — never the phone, name, or full id.
    // `warn`, not `log`: on any box where this line can appear, someone armed irreversible
    // deletion, and that deserves to stand out in the QA box's logs.
    this.logger.warn(
      `QA immediate delete worker=${worker.id.slice(0, 8)} (complete erasure via AccountDeletionService: sessions revoked, storage swept, row removed); no OTP, no grace`,
    );

    return { ok: true };
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
