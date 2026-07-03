import { Inject, Injectable, Logger } from "@nestjs/common";
import { createTransport, type Transporter } from "nodemailer";
import type { ServerConfig } from "@badabhai/config";
import { SERVER_CONFIG } from "../config/config.module";
import { PiiCryptoService } from "../common/pii-crypto.service";

/** DI token for the active org-invite mailer (mock by default; real only behind the gate). */
export const MEMBER_INVITE_MAILER = Symbol("MEMBER_INVITE_MAILER");

/** Network/parse timeout for the ZeptoMail HTTPS send (mirrors ZeptoMailEmailLoginChannel). */
const ZEPTOMAIL_TIMEOUT_MS = 10_000;

/**
 * A single org-invite delivery. `email` is the invitee's raw address; `acceptUrl` is the
 * accept link carrying the single-use RAW token as a query param. BOTH are PII / bearer
 * secrets — a mailer may put them ONLY into the outbound email (their legitimate purpose)
 * and MUST NEVER log/event either.
 */
export interface MemberInviteDelivery {
  email: string;
  acceptUrl: string;
}

/** The org-invite mailer seam — the real vs mock transport swap point (ADR-0027 / B5.4). */
export interface MemberInviteMailer {
  send(input: MemberInviteDelivery): Promise<void>;
}

/**
 * DEFAULT (alpha) org-invite mailer — a NO-OP send. The raw token / accept link NEVER leaves
 * the process (there is no external call), so this is byte-safe with respect to the PII
 * boundary: it logs ONLY an 8-char email-HASH prefix + a status token (never the email, the
 * token, or the link). The accept flow is still fully live — the invited member's token hash
 * is persisted, so an operator with the raw token (surfaced only in the invite return path in
 * a real send) can accept. Real delivery is {@link RealMemberInviteMailer}, chosen only when
 * MEMBER_INVITES_ENABLE_REAL is set + the email provider is configured.
 */
@Injectable()
export class MockMemberInviteMailer implements MemberInviteMailer {
  private readonly logger = new Logger(MockMemberInviteMailer.name);

  constructor(private readonly pii: PiiCryptoService) {}

  async send(input: MemberInviteDelivery): Promise<void> {
    const emailHashPrefix = this.pii.hmac(input.email).slice(0, 8);
    // PII-free: hash prefix + status only — NEVER the email, the token, or the accept link.
    this.logger.log(
      `mock org-invite email NOT sent (MEMBER_INVITES_ENABLE_REAL off) email_hash=${emailHashPrefix} status=mock`,
    );
  }
}

/** Which real transport this mailer resolves to for a single delivery. */
type ResolvedTransport = "zeptomail" | "smtp";

/**
 * REAL org-invite mailer (ADR-0027 / B5.4) — reuses the payer email provider (EMAIL_PROVIDER +
 * its ZeptoMail/SMTP creds, the analogue of {@link import("../payers/zeptomail-email-login-channel").ZeptoMailEmailLoginChannel}).
 * Selected ONLY behind MEMBER_INVITES_ENABLE_REAL (the module factory returns the mock
 * otherwise), so this class is never exercised in the alpha default path.
 *
 * PRIVACY (CLAUDE.md §2, HARD): the invitee email + the accept link (carrying the raw token)
 * appear ONLY inside the outbound email body/recipient — the legitimate purpose — and are
 * NEVER logged/evented. On success/failure this logs ONLY the 8-char email-HASH prefix + a
 * status/provider token. `send` THROWS an OPAQUE error on ANY failure (no email, token, link,
 * or provider response body in the message) so the caller surfaces a generic delivery failure.
 */
@Injectable()
export class RealMemberInviteMailer implements MemberInviteMailer {
  private readonly logger = new Logger(RealMemberInviteMailer.name);

  constructor(
    @Inject(SERVER_CONFIG) private readonly config: ServerConfig,
    private readonly pii: PiiCryptoService,
  ) {}

  async send(input: MemberInviteDelivery): Promise<void> {
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
      const reason = err instanceof Error ? err.message : "unknown";
      // OPAQUE reason only — NEVER the email, the accept link, or the token.
      this.logger.warn(
        `org-invite email send failed email_hash=${emailHashPrefix} provider=${transport} sandbox=${sandbox} status=failed:${reason}`,
      );
      throw new Error("invite email delivery failed");
    }

    this.logger.log(
      `org-invite email sent email_hash=${emailHashPrefix} provider=${transport} sandbox=${sandbox} status=sent`,
    );
  }

  // ---------------------------------------------------------------------------

  /** Resolve the real transport from EMAIL_PROVIDER; "auto" prefers ZeptoMail when its creds are set. */
  private resolveTransport(): ResolvedTransport {
    switch (this.config.EMAIL_PROVIDER) {
      case "zeptomail":
        return "zeptomail";
      case "smtp":
        return "smtp";
      case "auto":
        return this.hasZeptoMailCreds() ? "zeptomail" : "smtp";
      default:
        throw new Error("real invite mailer selected with an unmapped EMAIL_PROVIDER");
    }
  }

  private hasZeptoMailCreds(): boolean {
    return Boolean(
      this.config.ZEPTOMAIL_API_TOKEN &&
        this.config.ZEPTOMAIL_MAIL_AGENT &&
        this.config.EMAIL_FROM_ADDRESS &&
        this.config.ZEPTOMAIL_API_URL,
    );
  }

  // --- ZeptoMail HTTPS API ----------------------------------------------------

  private async sendViaZeptoMail(input: MemberInviteDelivery): Promise<void> {
    const apiUrl = this.config.ZEPTOMAIL_API_URL;
    const token = this.config.ZEPTOMAIL_API_TOKEN;
    const fromAddress = this.config.EMAIL_FROM_ADDRESS;
    const mailAgent = this.config.ZEPTOMAIL_MAIL_AGENT;
    if (!apiUrl || !token || !fromAddress || !mailAgent) {
      throw new Error("zeptomail not fully configured");
    }

    const body: Record<string, unknown> = {
      from: { address: fromAddress, name: this.config.EMAIL_FROM_NAME ?? undefined },
      to: [{ email_address: { address: input.email } }],
      subject: RealMemberInviteMailer.subject(),
      // The accept link lives ONLY here (the legitimate purpose); never logged.
      htmlbody: RealMemberInviteMailer.htmlBody(input.acceptUrl),
      textbody: RealMemberInviteMailer.textBody(input.acceptUrl),
    };
    if (this.config.EMAIL_REPLY_TO) {
      body.reply_to = [{ address: this.config.EMAIL_REPLY_TO }];
    }
    if (this.config.ZEPTOMAIL_SANDBOX_MODE) {
      body.sandbox = true;
    }

    let res: Response;
    try {
      res = await fetch(apiUrl, {
        method: "POST",
        headers: {
          Authorization: `Zoho-enczapikey ${RealMemberInviteMailer.sendMailToken(token)}`,
          "Content-Type": "application/json",
          Accept: "application/json",
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(ZEPTOMAIL_TIMEOUT_MS),
      });
    } catch {
      throw new Error("zeptomail transport error");
    }

    if (!res.ok) {
      throw new Error(`zeptomail http ${res.status}`);
    }

    let parsed: unknown;
    try {
      parsed = await res.json();
    } catch {
      throw new Error("zeptomail bad response");
    }
    if (!RealMemberInviteMailer.zeptoMailAccepted(parsed)) {
      throw new Error("zeptomail rejected");
    }
  }

  /** Accept any parsed object without an explicit `error` field (robust to the varying success shape). */
  private static zeptoMailAccepted(parsed: unknown): boolean {
    if (typeof parsed !== "object" || parsed === null) return false;
    const obj = parsed as Record<string, unknown>;
    if ("error" in obj && obj.error != null) return false;
    return true;
  }

  /** Strip a pasted `Zoho-enczapikey ` prefix so both the raw token and full-header form work. */
  private static sendMailToken(token: string): string {
    return token.replace(/^\s*Zoho-enczapikey\s+/i, "");
  }

  // --- SMTP (nodemailer) ------------------------------------------------------

  private async sendViaSmtp(input: MemberInviteDelivery): Promise<void> {
    const host = this.config.SMTP_HOST;
    const user = this.config.SMTP_USER;
    const pass = this.config.SMTP_PASS;
    const fromAddress = this.config.EMAIL_FROM_ADDRESS;
    if (!host || !user || !pass || !fromAddress) {
      throw new Error("smtp not fully configured");
    }
    const port = this.config.SMTP_PORT ?? 587;

    const transporter: Transporter = createTransport({
      host,
      port,
      secure: port === 465,
      auth: { user, pass },
    });

    const from = this.config.SMTP_FROM ?? this.fromHeader(fromAddress);
    try {
      await transporter.sendMail({
        from,
        to: input.email,
        subject: RealMemberInviteMailer.subject(),
        // The accept link lives ONLY in the body (the legitimate purpose); never logged.
        text: RealMemberInviteMailer.textBody(input.acceptUrl),
        html: RealMemberInviteMailer.htmlBody(input.acceptUrl),
        ...(this.config.EMAIL_REPLY_TO ? { replyTo: this.config.EMAIL_REPLY_TO } : {}),
      });
    } catch {
      throw new Error("smtp send error");
    }
  }

  private fromHeader(fromAddress: string): string {
    const name = this.config.EMAIL_FROM_NAME;
    return name ? `${name} <${fromAddress}>` : fromAddress;
  }

  // --- Rendered email (the ONLY place the accept link may appear) -------------

  private static subject(): string {
    return "You've been invited to a BadaBhai team";
  }

  private static textBody(acceptUrl: string): string {
    return `You have been invited to join a team on BadaBhai. Open this link to accept: ${acceptUrl}. The link expires in a few days. If you did not expect this, you can ignore this email.`;
  }

  private static htmlBody(acceptUrl: string): string {
    return [
      "<p>You have been invited to join a team on BadaBhai.</p>",
      `<p><a href="${acceptUrl}">Accept the invite</a></p>`,
      "<p>The link expires in a few days. If you did not expect this, you can ignore this email.</p>",
    ].join("");
  }
}
