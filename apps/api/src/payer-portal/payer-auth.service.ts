import {
  ForbiddenException,
  HttpException,
  HttpStatus,
  Inject,
  Injectable,
  Logger,
  UnauthorizedException,
} from "@nestjs/common";
import type { ServerConfig } from "@badabhai/config";
import type { PayerLoginMethodEnum } from "@badabhai/event-schema";
import { SERVER_CONFIG } from "../config/config.module";
import { PiiCryptoService } from "../common/pii-crypto.service";
import { OtpSendCapExceededException } from "../common/otp-send-cap";
import type { RequestContext } from "../common/request-context";
import { EventsService } from "../events/events.service";
import { PayersRepository } from "../payers/payers.repository";
import { PayerOrgsRepository } from "../payers/payer-orgs.repository";
import { PayerSessionService } from "../payers/payer-session.service";
import { PayerOtpService, type PayerOtpIssued } from "../payers/payer-otp.service";
import { FreeTierService } from "../match/free-tier.service";
import type {
  PayerSignupDto,
  PayerLoginRequestDto,
  PayerLoginVerifyDto,
  PayerAuthCodeResponse,
  PayerSessionResponse,
  PayerRefreshResponse,
} from "./payer-auth.dto";

/**
 * Self-serve PAYER auth orchestration (ADR-0019 Decision B — closes R16/LC-1/TD33). The
 * payer analogue of {@link import("../auth/auth.service").AuthService}, for the THIRD
 * principal. Signup create-or-gets the account (emitting `payer.created` once), then a
 * code is issued over the config-selected {@link PayerOtpService} channel; verify mints a
 * revocable {@link PayerSessionService} session and emits `payer.session_started`.
 *
 * XB-H (no user-enumeration): signup and login-request return a DELIBERATELY identical,
 * account-state-INDEPENDENT response. A login-request for an UNKNOWN email still runs the
 * identical OTP reserve (cooldown/cap/store) via {@link PayerOtpService.issueWithoutDelivery}
 * so its timing/response matches a known one; a delivery failure (which only occurs for a
 * KNOWN account) is swallowed to the same neutral body; and verify mints a session ONLY for
 * a real account, returning the SAME "incorrect or expired" 401 otherwise.
 *
 * PRIVACY (B-R2): the raw email/phone/org-name are accepted, encrypted at rest in `payers`,
 * and NEVER logged or put in an event — only the opaque `payer_id` + role/method enums.
 */
@Injectable()
export class PayerAuthService {
  private readonly logger = new Logger(PayerAuthService.name);

  constructor(
    @Inject(SERVER_CONFIG) private readonly config: ServerConfig,
    private readonly payers: PayersRepository,
    private readonly orgs: PayerOrgsRepository,
    private readonly otp: PayerOtpService,
    private readonly sessions: PayerSessionService,
    private readonly events: EventsService,
    private readonly pii: PiiCryptoService,
    // ADR-0036 §8 — the free-tier credit grant. MatchModule is @Global.
    private readonly freeTier: FreeTierService,
  ) {}

  private get method(): PayerLoginMethodEnum {
    return this.config.PAYER_LOGIN_METHOD;
  }

  /** POST /payer/signup — create-or-get the account, emit `payer.created` (once), issue a code. */
  async signup(dto: PayerSignupDto, ctx: RequestContext): Promise<PayerAuthCodeResponse> {
    const { id, created } = await this.payers.createOrGet({
      role: dto.role,
      email: dto.email,
      orgName: dto.org_name,
      phone: dto.phone,
    });

    if (created) {
      await this.events.emit({
        event_name: "payer.created",
        actor: { actor_type: "payer", actor_id: id },
        subject: { subject_type: "payer", subject_id: id },
        payload: { payer_id: id, role: dto.role, method: this.method },
        idempotencyKey: `payer.created:${id}`, // once-only per account
        correlationId: ctx.correlationId,
        requestId: ctx.requestId,
      });
      // Every new payer founds a SOLO org with themselves as OWNER (ADR-0027 / B5). Idempotent
      // + only on the created path — an existing account is never mutated here (XB-H). The org's
      // own `org.created` audit event ships with the member lifecycle in B5.3; today the org is a
      // deterministic 1:1 consequence of `payer.created` (which is evented above).
      await this.orgs.ensureSoloOrg(id);
      // ADR-0036 §8 — the FREE TIER. A new payer starts with
      // `match_config.free_unlock_credits` unlock credits, so they can see whether the
      // supply is real before being asked for money.
      //
      // Only on the `created` path, and idempotent regardless: the grant is keyed
      // `free_tier_grant:<payerId>` and the existing `credit_ledger_idempotency_key_uq`
      // makes it exactly-once, so a retried signup and the D6 backfill converge on one
      // grant. `grantQuietly` swallows + logs — a payer whose ACCOUNT was created must
      // not get a 500 because a credit grant hiccuped, and the grant is repairable by
      // re-running `db:grant:free-tier` while the signup is not.
      await this.freeTier.grantQuietly(id);
    }

    // Issue a code to the canonical stored contact (uniform for new + existing — no
    // overwrite of an existing account; the response is identical either way, XB-H).
    try {
      const issued = await this.issueForExistingAccount(id, dto.email, ctx, false);
      return this.codeResponse(issued);
    } catch (err) {
      return this.neutralOnSendCapBreach(err, ctx);
    }
  }

  /** POST /payer/login/request — issue a code; NO-ENUMERATION across known/unknown emails. */
  async requestLogin(dto: PayerLoginRequestDto, ctx: RequestContext): Promise<PayerAuthCodeResponse> {
    try {
      const account = await this.payers.findByEmail(dto.email);
      let issued: PayerOtpIssued;
      if (account) {
        issued = await this.issueForExistingAccount(account.id, dto.email, ctx, true);
      } else {
        // UNKNOWN email: run the IDENTICAL reserve (cooldown/cap/store) WITHOUT delivery so
        // the observable timing/response + 429s match a known account. No event is emitted
        // (no subject), and that asymmetry is not caller-observable (the body is identical).
        issued = await this.otp.issueWithoutDelivery(this.emailHash(dto.email));
      }
      return this.codeResponse(issued);
    } catch (err) {
      return this.neutralOnSendCapBreach(err, ctx);
    }
  }

  /** POST /payer/login/verify — verify the code then mint a session (only for a real account). */
  async verifyLogin(dto: PayerLoginVerifyDto, ctx: RequestContext): Promise<PayerSessionResponse> {
    // Verify FIRST (single message on failure — no enumeration, constant-time, single-use).
    await this.otp.verify(this.emailHash(dto.email), dto.code);

    // A reserved code for an UNKNOWN email (issued for timing parity) can verify, but a
    // session is minted ONLY for a real account — otherwise return the SAME 401 (no oracle).
    const account = await this.payers.findByEmail(dto.email);
    if (!account) throw new UnauthorizedException("Incorrect or expired code");

    // Guarantee the payer's solo org + owner membership (ADR-0027 / B5). Cheap common case
    // (1 read → org already exists via signup or the B5.1 backfill); only a gap payer created
    // BEFORE B5.2 shipped has none, and is repaired here on first login. Idempotent, fail-safe.
    if (!(await this.orgs.resolveOrgForPayer(account.id))) {
      await this.orgs.ensureSoloOrg(account.id);
    }

    // ADR-0037 — a SUSPENDED payer proves mailbox control but gets no session.
    //
    // The 403 is deliberately DISTINCT from the 401 an unknown/expired code returns, and
    // that costs no enumeration: to reach this line the caller has already presented a
    // valid single-use code for a real account, so they have proven both that the account
    // exists and that they control its mailbox. There is no oracle left to protect — and
    // TD110 records what the alternative costs: payer login was down end-to-end and stayed
    // invisible precisely because the client collapses every verify failure into one
    // neutral message. A suspended payer must be able to learn WHY.
    if (account.status === "suspended") {
      throw new ForbiddenException("Account is suspended");
    }

    // First successful verification promotes the payer to `active`. The pending→active
    // predicate lives in the WHERE clause (see PayersRepository.activate), so this is
    // idempotent on every later login and structurally cannot resurrect a suspended row.
    // The event fires ONLY on the transition, so it marks first-verification exactly once.
    if (await this.payers.activate(account.id)) {
      await this.events.emit({
        event_name: "payer.activated",
        actor: { actor_type: "payer", actor_id: account.id },
        subject: { subject_type: "payer", subject_id: account.id },
        payload: { payer_id: account.id, previous_status: "pending", new_status: "active" },
        correlationId: ctx.correlationId,
        requestId: ctx.requestId,
      });
    }

    // Carry the role onto the session (ADR-0022) so PayerRoleGuard gates agent-only routes
    // without a DB hit; pre-ADR-0022 sessions (no role) resolve it via the guard's fallback.
    // (The session `org_id`/`org_role` claim lands with the member API + PayerOrgRoleGuard in B5.3.)
    const session = await this.sessions.create(account.id, account.role);
    await this.events.emit({
      event_name: "payer.session_started",
      actor: { actor_type: "payer", actor_id: account.id },
      subject: { subject_type: "payer", subject_id: account.id },
      payload: { payer_id: account.id, method: this.method, is_new_payer: false },
      correlationId: ctx.correlationId,
      requestId: ctx.requestId,
    });

    return {
      access_token: session.token,
      token_type: "Bearer",
      expires_in_seconds: session.expiresInSeconds,
      payer_id: account.id,
      role: account.role,
      is_new_payer: false,
    };
  }

  /** POST /payer/refresh — mint a fresh JWT for the already-validated payer+session. */
  async refresh(payerId: string, sid: string): Promise<PayerRefreshResponse> {
    const fresh = await this.sessions.mint(payerId, sid);
    return {
      access_token: fresh.token,
      token_type: "Bearer",
      expires_in_seconds: fresh.expiresInSeconds,
    };
  }

  /** POST /payer/logout — revoke the current session. */
  async logout(sid: string): Promise<void> {
    await this.sessions.revoke(sid);
  }

  // ---------------------------------------------------------------------------

  /**
   * Issue + deliver a code for an EXISTING account, reading the canonical stored contact
   * (so the `whatsapp` channel uses the on-file phone). A delivery failure is swallowed to
   * the neutral response — surfacing it would be an existence oracle (we only deliver for a
   * known account); 429/503 propagate (existence-independent). Optionally emits
   * `payer.login_requested` (login path) — never on the signup path (it has `payer.created`).
   */
  private async issueForExistingAccount(
    payerId: string,
    email: string,
    ctx: RequestContext,
    emitRequested: boolean,
  ): Promise<PayerOtpIssued> {
    const row = await this.payers.findById(payerId);
    const contact = row ? this.payers.decryptContact(row) : null;

    let issued: PayerOtpIssued;
    try {
      issued = await this.otp.issueAndSend({
        emailHash: this.emailHash(email),
        email: contact?.email ?? email,
        phone: contact?.phone ?? null,
        payerId,
      });
    } catch (err) {
      // Swallow ONLY a delivery failure (502) → neutral. 429 (cooldown/cap) and 503 (Redis)
      // are existence-independent (the unknown-email branch hits the same codes) → propagate.
      if (err instanceof HttpException && err.getStatus() === HttpStatus.BAD_GATEWAY) {
        this.logger.warn(`payer login code delivery failed (neutralized) payer=${payerId.slice(0, 8)}…`);
        issued = { resendInSeconds: this.config.OTP_RESEND_COOLDOWN_SECONDS };
      } else {
        throw err;
      }
    }

    if (emitRequested) {
      await this.events.emit({
        event_name: "payer.login_requested",
        actor: { actor_type: "payer", actor_id: payerId },
        subject: { subject_type: "payer", subject_id: payerId },
        payload: { payer_id: payerId, method: this.method },
        correlationId: ctx.correlationId,
        requestId: ctx.requestId,
      });
    }
    return issued;
  }

  private emailHash(email: string): string {
    // DTOs already trim+lowercase the email; PayersRepository hashes the same normalized
    // form, so this keyed HMAC matches the stored `email_hash` lookup key.
    return this.pii.hmac(email);
  }

  private codeResponse(issued: PayerOtpIssued): PayerAuthCodeResponse {
    return {
      status: "code_sent",
      resend_in_seconds: issued.resendInSeconds,
    };
  }

  /**
   * OTP-5 no-enumeration handler for the GLOBAL daily send circuit-breaker breach. The
   * breaker trips on the existence-INDEPENDENT reserve path (run identically for a known
   * and an unknown account), so a breach surfaces as the same {@link OtpSendCapExceededException}
   * either way. Here we emit the PII-free `payer.otp_send_cap_exceeded` breach event ONCE
   * and DEGRADE to the SAME neutral "code_sent"-shaped response the unknown-account path
   * already returns — so the response is BYTE-IDENTICAL for a known vs unknown account
   * (XB-H). Any OTHER error (cooldown/cap 429, 503) is re-thrown unchanged; those already
   * propagate identically across both branches, so they are not an oracle. The breach
   * payload is AGGREGATE — no payer id, email, IP, or code.
   */
  private async neutralOnSendCapBreach(
    err: unknown,
    ctx: RequestContext,
  ): Promise<PayerAuthCodeResponse> {
    if (!(err instanceof OtpSendCapExceededException)) throw err;
    await this.events.emit({
      event_name: "payer.otp_send_cap_exceeded",
      actor: { actor_type: "system" },
      subject: { subject_type: "payer" },
      payload: {
        channel: err.breach.channel,
        cap: "global_daily",
        limit: err.breach.limit,
        window: err.breach.window,
      },
      correlationId: ctx.correlationId,
      requestId: ctx.requestId,
    });
    // The neutral "code_sent" response the unknown-account path returns (no code is ever echoed).
    return {
      status: "code_sent",
      resend_in_seconds: this.config.OTP_RESEND_COOLDOWN_SECONDS,
    };
  }
}
