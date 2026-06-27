import { Inject, Injectable, Logger } from "@nestjs/common";
import type { ServerConfig } from "@badabhai/config";
import { createTransport, type Transporter } from "nodemailer";
import { SERVER_CONFIG } from "../config/config.module";
import { PiiCryptoService } from "../common/pii-crypto.service";
import type { PayerLoginChannel, PayerLoginCodeDelivery } from "./payer-login-channel";

/** Network/parse timeout for the ZeptoMail HTTPS send (the codebase fetch pattern). */
const ZEPTOMAIL_TIMEOUT_MS = 10_000;

/** Which real transport this channel resolves to for a single delivery. */
type ResolvedTransport = "zeptomail" | "smtp";

/**
 * REAL payer email-OTP delivery channel (OTP-2; ADR-0019 B-R1) — the email analogue of
 * {@link import("../sms/fast2sms.provider").Fast2SmsProvider}. The payer email channel is
 * REAL-ONLY: this is the ONLY `email_otp` channel (the alpha mock was removed), so the boot
 * guard guarantees the required creds for the selected `EMAIL_PROVIDER`.
 *
 * Two transports behind one seam, chosen per `EMAIL_PROVIDER`:
 *   - "zeptomail" → the ZeptoMail Email Sending HTTPS API (Zoho-enczapikey auth).
 *   - "smtp"      → a generic SMTP relay via nodemailer.
 *   - "auto"      → ZeptoMail when its creds are fully set, else SMTP (same satisfiability
 *                   logic as `emailProviderBlockedReason`).
 *
 * PRIVACY (CLAUDE.md §2, HARD): the one-time `code` appears ONLY inside the outbound email
 * body (its legitimate purpose) and is NEVER logged/evented. This channel logs ONLY the
 * 8-char email-HASH prefix + a status token + the provider/sandbox flag — never the raw
 * email, the code, the request body, or the provider response body. `deliver` THROWS an
 * OPAQUE error on ANY send failure so {@link import("./payer-otp.service").PayerOtpService}
 * rolls back the reserved code (a failed send leaves no dangling code).
 */
@Injectable()
export class ZeptoMailEmailLoginChannel implements PayerLoginChannel {
  readonly method = "email_otp" as const;
  readonly mock = false;
  private readonly logger = new Logger(ZeptoMailEmailLoginChannel.name);

  constructor(
    @Inject(SERVER_CONFIG) private readonly config: ServerConfig,
    private readonly pii: PiiCryptoService,
  ) {}

  async deliver(input: PayerLoginCodeDelivery): Promise<void> {
    const emailHashPrefix = this.pii.hmac(input.email).slice(0, 8);
    const transport = this.resolveTransport();
    const sandbox = Boolean(this.config.ZEPTOMAIL_SANDBOX_MODE) && transport === "zeptomail";

    try {
      if (transport === "zeptomail") {
        await this.sendViaZeptoMail(input);
      } else {
        await this.sendViaSmtp(input);
      }
    } catch (err) {
      // OPAQUE reason only — NEVER the email, the code, the request, or the response body.
      const reason = err instanceof Error ? err.message : "unknown";
      this.logger.warn(
        `payer email login send failed email_hash=${emailHashPrefix} provider=${transport} sandbox=${sandbox} status=failed:${reason}`,
      );
      // Re-throw OPAQUE so PayerOtpService rolls back the reserved code (rollback contract).
      throw new Error("email delivery failed");
    }

    this.logger.log(
      `payer email login code sent email_hash=${emailHashPrefix} provider=${transport} sandbox=${sandbox} status=sent`,
    );
  }

  // ---------------------------------------------------------------------------

  /**
   * Resolve the real transport for THIS delivery from `EMAIL_PROVIDER`. "auto" prefers
   * ZeptoMail when its creds are fully set (same satisfiability check as
   * `emailProviderBlockedReason`), else SMTP. EMAIL_PROVIDER is REAL-ONLY (zeptomail/smtp/
   * auto — no "none"/mock), so the default arm is unreachable; it throws (fail closed) if
   * a future provider value is ever added without a transport mapping.
   */
  private resolveTransport(): ResolvedTransport {
    switch (this.config.EMAIL_PROVIDER) {
      case "zeptomail":
        return "zeptomail";
      case "smtp":
        return "smtp";
      case "auto":
        return this.hasZeptoMailCreds() ? "zeptomail" : "smtp";
      default:
        // Unreachable: EMAIL_PROVIDER has no other (e.g. mock) value. Fail closed.
        throw new Error("real email channel selected with an unmapped EMAIL_PROVIDER");
    }
  }

  /** True when the full ZeptoMail cred set is present (mirrors emailProviderBlockedReason). */
  private hasZeptoMailCreds(): boolean {
    return Boolean(
      this.config.ZEPTOMAIL_API_TOKEN &&
        this.config.ZEPTOMAIL_MAIL_AGENT &&
        this.config.EMAIL_FROM_ADDRESS &&
        this.config.ZEPTOMAIL_API_URL,
    );
  }

  // --- ZeptoMail HTTPS API ----------------------------------------------------

  private async sendViaZeptoMail(input: PayerLoginCodeDelivery): Promise<void> {
    const apiUrl = this.config.ZEPTOMAIL_API_URL;
    const token = this.config.ZEPTOMAIL_API_TOKEN;
    const fromAddress = this.config.EMAIL_FROM_ADDRESS;
    const mailAgent = this.config.ZEPTOMAIL_MAIL_AGENT;
    // The boot guard guarantees these in non-dev; guard anyway so a misconfig fails CLOSED.
    if (!apiUrl || !token || !fromAddress || !mailAgent) {
      throw new Error("zeptomail not fully configured");
    }

    const subject = ZeptoMailEmailLoginChannel.subject();
    const body: Record<string, unknown> = {
      // NOTE: the ZeptoMail v1.1 send API selects the Mail Agent purely from the send-mail
      // token in the Authorization header — there is NO body field for it. (An earlier
      // `mail_agent_alias` field was non-standard and could be rejected by ZeptoMail.)
      // ZEPTOMAIL_MAIL_AGENT is retained only as a boot-time presence check, not sent.
      from: { address: fromAddress, name: this.config.EMAIL_FROM_NAME ?? undefined },
      to: [{ email_address: { address: input.email } }],
      subject,
      // The code lives ONLY here (the legitimate purpose); never logged.
      htmlbody: ZeptoMailEmailLoginChannel.htmlBody(input.code),
      textbody: ZeptoMailEmailLoginChannel.textBody(input.code),
    };
    if (this.config.EMAIL_REPLY_TO) {
      body.reply_to = [{ address: this.config.EMAIL_REPLY_TO }];
    }
    // Honor sandbox: ZeptoMail does NOT deliver when this flag is set, but the full request
    // path is still exercised (the documented sandbox toggle on the send body).
    if (this.config.ZEPTOMAIL_SANDBOX_MODE) {
      body.sandbox = true;
    }

    let res: Response;
    try {
      res = await fetch(apiUrl, {
        method: "POST",
        headers: {
          Authorization: `Zoho-enczapikey ${ZeptoMailEmailLoginChannel.sendMailToken(token)}`,
          "Content-Type": "application/json",
          Accept: "application/json",
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(ZEPTOMAIL_TIMEOUT_MS),
      });
    } catch {
      // Transport/network/timeout failure — OPAQUE (no email, no code, no body).
      throw new Error("zeptomail transport error");
    }

    if (!res.ok) {
      throw new Error(`zeptomail http ${res.status}`);
    }

    // ZeptoMail returns 2xx with a JSON body; treat an error/non-success body as a failure.
    let parsed: unknown;
    try {
      parsed = await res.json();
    } catch {
      throw new Error("zeptomail bad response");
    }
    if (!ZeptoMailEmailLoginChannel.zeptoMailAccepted(parsed)) {
      throw new Error("zeptomail rejected");
    }
  }

  /**
   * Interpret the ZeptoMail send response. A 2xx response is the primary success signal;
   * on a logical failure ZeptoMail returns an `error` object (and/or a non-2xx status, which
   * the caller already rejects). So we accept any parsed object that does NOT carry an
   * explicit `error` field — robust to the exact `data`/`code`/`message` success shape, which
   * varies (e.g. `EM_104`), while still failing closed on an explicit error body.
   */
  private static zeptoMailAccepted(parsed: unknown): boolean {
    if (typeof parsed !== "object" || parsed === null) return false;
    const obj = parsed as Record<string, unknown>;
    if ("error" in obj && obj.error != null) return false;
    return true;
  }

  /**
   * The ZeptoMail Authorization header is `Zoho-enczapikey <send-mail-token>`. A common setup
   * mistake is pasting the FULL header value — including the `Zoho-enczapikey ` prefix that the
   * ZeptoMail dashboard/docs show — into ZEPTOMAIL_API_TOKEN. The code would then prepend the
   * prefix again, producing a doubled `Zoho-enczapikey Zoho-enczapikey …` header that ZeptoMail
   * rejects (HTTP 500, nothing delivered). Strip any leading prefix so BOTH the raw token and
   * the full-header form authenticate correctly.
   */
  private static sendMailToken(token: string): string {
    return token.replace(/^\s*Zoho-enczapikey\s+/i, "");
  }

  // --- SMTP (nodemailer) ------------------------------------------------------

  private async sendViaSmtp(input: PayerLoginCodeDelivery): Promise<void> {
    const host = this.config.SMTP_HOST;
    const user = this.config.SMTP_USER;
    const pass = this.config.SMTP_PASS;
    const fromAddress = this.config.EMAIL_FROM_ADDRESS;
    // The boot guard guarantees these in non-dev; guard anyway so a misconfig fails CLOSED.
    if (!host || !user || !pass || !fromAddress) {
      throw new Error("smtp not fully configured");
    }
    const port = this.config.SMTP_PORT ?? 587;

    const transporter: Transporter = createTransport({
      host,
      port,
      secure: port === 465, // implicit TLS on 465; STARTTLS otherwise
      auth: { user, pass },
    });

    const from = this.config.SMTP_FROM ?? this.fromHeader(fromAddress);
    try {
      await transporter.sendMail({
        from,
        to: input.email,
        subject: ZeptoMailEmailLoginChannel.subject(),
        // The code lives ONLY in the body (the legitimate purpose); never logged.
        text: ZeptoMailEmailLoginChannel.textBody(input.code),
        html: ZeptoMailEmailLoginChannel.htmlBody(input.code),
        ...(this.config.EMAIL_REPLY_TO ? { replyTo: this.config.EMAIL_REPLY_TO } : {}),
      });
    } catch {
      // nodemailer rejection — OPAQUE (no email, no code, no provider detail).
      throw new Error("smtp send error");
    }
  }

  /** A display From header (`Name <address>`) when EMAIL_FROM_NAME is set, else the bare address. */
  private fromHeader(fromAddress: string): string {
    const name = this.config.EMAIL_FROM_NAME;
    return name ? `${name} <${fromAddress}>` : fromAddress;
  }

  // --- Rendered email (the ONLY place the code may appear) --------------------

  private static subject(): string {
    return "Your BadaBhai login code";
  }

  private static textBody(code: string): string {
    return `Your BadaBhai login code is ${code}. It expires shortly. If you did not request it, ignore this email.`;
  }

  private static htmlBody(code: string): string {
    return [
      "<p>Your BadaBhai login code is:</p>",
      `<p style="font-size:24px;font-weight:bold;letter-spacing:3px;">${code}</p>`,
      "<p>It expires shortly. If you did not request it, you can ignore this email.</p>",
    ].join("");
  }
}
