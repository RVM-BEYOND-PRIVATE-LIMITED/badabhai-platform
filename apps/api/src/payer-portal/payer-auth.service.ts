import {
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
import type { RequestContext } from "../common/request-context";
import { EventsService } from "../events/events.service";
import { PayersRepository } from "../payers/payers.repository";
import { PayerSessionService } from "../payers/payer-session.service";
import { PayerOtpService, type PayerOtpIssued } from "../payers/payer-otp.service";
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
    private readonly otp: PayerOtpService,
    private readonly sessions: PayerSessionService,
    private readonly events: EventsService,
    private readonly pii: PiiCryptoService,
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
    }

    // Issue a code to the canonical stored contact (uniform for new + existing — no
    // overwrite of an existing account; the response is identical either way, XB-H).
    const issued = await this.issueForExistingAccount(id, dto.email, ctx, false);
    return this.codeResponse(issued);
  }

  /** POST /payer/login/request — issue a code; NO-ENUMERATION across known/unknown emails. */
  async requestLogin(dto: PayerLoginRequestDto, ctx: RequestContext): Promise<PayerAuthCodeResponse> {
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
  }

  /** POST /payer/login/verify — verify the code then mint a session (only for a real account). */
  async verifyLogin(dto: PayerLoginVerifyDto, ctx: RequestContext): Promise<PayerSessionResponse> {
    // Verify FIRST (single message on failure — no enumeration, constant-time, single-use).
    await this.otp.verify(this.emailHash(dto.email), dto.code);

    // A reserved code for an UNKNOWN email (issued for timing parity) can verify, but a
    // session is minted ONLY for a real account — otherwise return the SAME 401 (no oracle).
    const account = await this.payers.findByEmail(dto.email);
    if (!account) throw new UnauthorizedException("Incorrect or expired code");

    const session = await this.sessions.create(account.id);
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
      ...(issued.devCode ? { dev_otp: issued.devCode } : {}),
    };
  }
}
