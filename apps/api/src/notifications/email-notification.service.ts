import { Inject, Injectable, Logger } from "@nestjs/common";
import { createTransport, type Transporter } from "nodemailer";
import { isDevEnv, type ServerConfig } from "@badabhai/config";
import { SERVER_CONFIG } from "../config/config.module";
import { PiiCryptoService } from "../common/pii-crypto.service";

/** Network/parse timeout for the ZeptoMail HTTPS send (the codebase fetch pattern). */
const ZEPTOMAIL_TIMEOUT_MS = 10_000;

/** Which real transport a single delivery resolves to. */
export type ResolvedEmailTransport = "zeptomail" | "smtp";

/**
 * WHO an email is being sent to and WHY. Both are closed vocabularies and both appear in
 * logs, which is the point: `principal=admin purpose=login_code status=failed` is a triage
 * line. A free-text purpose would eventually carry a name or an address into the log.
 */
export type EmailPrincipal = "worker" | "payer" | "agency" | "admin";
export type EmailPurpose = "login_code" | "team_invite";

export interface EmailMessage {
  /** The recipient address. Used to send and to derive a log hash — never logged raw. */
  to: string;
  subject: string;
  html: string;
  text: string;
  principal: EmailPrincipal;
  purpose: EmailPurpose;
}

/**
 * ADR-0038 Decision 2 — THE single outbound-email pipeline, for every principal.
 *
 * WHAT THIS REPLACED. ZeptoMail was implemented TWICE — once in the payer login channel and
 * once in the org-member invite mailer — with the transport resolution, the credential
 * satisfiability check, the `Zoho-enczapikey` prefix-stripping workaround, the sandbox flag,
 * the response interpretation, the SMTP fallback and the opaque-error contract duplicated
 * line for line in both. Two copies of a delivery pipeline is two places for a provider
 * quirk to be fixed in one and not the other, and the admin principal had NEITHER: its
 * `issueAndSend` reserved a code and logged "delivery deferred", so no admin could ever log
 * in. Consolidating was the prerequisite for giving admins a real sender.
 *
 * WHAT THIS OWNS: transport selection, credentials, sandbox, retries, timeouts, the opaque
 * failure contract, and the PII-safe log line.
 *
 * WHAT CALLERS OWN: the subject and the body. Deliberately — a shared template registry
 * would put every principal's copy in one file and invite exactly the cross-principal
 * mistake (a worker's SMS copy in an admin email) that keeping composition local prevents.
 *
 * PRIVACY (CLAUDE.md §2, HARD): the recipient address, the one-time code and the invite link
 * live ONLY inside the outbound message. This class logs an 8-char HMAC prefix of the
 * address plus closed enums — never the address, the body, the subject, or a provider
 * response body. {@link send} throws an OPAQUE error on ANY failure so a caller cannot
 * accidentally surface a provider message to a user.
 */
@Injectable()
export class EmailNotificationService {
  private readonly logger = new Logger(EmailNotificationService.name);

  constructor(
    @Inject(SERVER_CONFIG) private readonly config: ServerConfig,
    private readonly pii: PiiCryptoService,
  ) {}

  /**
   * Deliver one message. Resolves on success; throws an OPAQUE `Error` on any failure.
   *
   * RETRY POLICY: exactly ONE retry, and only for a transport-level failure (network,
   * timeout, 5xx) — never for a rejection. A provider that says "no" says it again, so
   * retrying a rejection only doubles the latency of a request that is already going to
   * fail, and on the payer OTP path that latency is the enumeration signal TD130 tracks.
   * The retry is what makes a single dropped packet not surface as a failed login.
   */
  async send(message: EmailMessage): Promise<void> {
    const hashPrefix = this.pii.hmac(message.to).slice(0, 8);
    const transport = this.resolveTransport();
    // A leftover ZEPTOMAIL_SANDBOX_MODE=true on a DEPLOYED box must never silently
    // swallow a transactional email (#813/#814): sandbox is honoured only inside
    // development/test. `isDevEnv()` — NOT the parsed `config.NODE_ENV`, which
    // fail-OPENs to "development" on an unset/mangled var (the exact R14 trap) —
    // reads the raw env, so a box with NODE_ENV unset gets the override rather than
    // a free pass. Warn loudly rather than trust the flag, so a misconfig is visible
    // in the log instead of surfacing as an OTP that "sent" (2xx) but never arrived.
    if (this.config.ZEPTOMAIL_SANDBOX_MODE && !isDevEnv()) {
      this.logger.warn(
        "ZEPTOMAIL_SANDBOX_MODE=true IGNORED outside development/test — delivering for real (#813/#814)",
      );
    }
    const sandbox = this.sandboxActive() && transport === "zeptomail";
    const tag =
      `principal=${message.principal} purpose=${message.purpose} ` +
      `email_hash=${hashPrefix} provider=${transport} sandbox=${sandbox}`;

    let lastReason = "unknown";
    for (let attempt = 1; attempt <= 2; attempt += 1) {
      try {
        if (transport === "zeptomail") {
          await this.sendViaZeptoMail(message);
        } else {
          await this.sendViaSmtp(message);
        }
        this.logger.log(`email sent ${tag} attempt=${attempt} status=sent`);
        return;
      } catch (err) {
        lastReason = err instanceof Error ? err.message : "unknown";
        // A REJECTION is final: the provider understood us and refused. Retrying a bad
        // address or a disabled agent just burns another round-trip.
        if (err instanceof EmailRejectedError || attempt === 2) break;
        this.logger.warn(`email send retrying ${tag} attempt=${attempt} reason=${lastReason}`);
      }
    }

    // OPAQUE reason class only — never the address, the body, or the provider response.
    this.logger.error(`email send failed ${tag} status=failed:${lastReason}`);
    throw new Error("email delivery failed");
  }

  /**
   * Resolve the transport from `EMAIL_PROVIDER`. "auto" prefers ZeptoMail when its full
   * credential set is present, else SMTP — the same satisfiability logic the boot guard
   * (`emailProviderBlockedReason`) uses, so the two cannot disagree about whether the
   * selected provider is usable. EMAIL_PROVIDER is REAL-ONLY, so the default arm is
   * unreachable and throws (fail closed) rather than silently picking one.
   */
  private resolveTransport(): ResolvedEmailTransport {
    switch (this.config.EMAIL_PROVIDER) {
      case "zeptomail":
        return "zeptomail";
      case "smtp":
        return "smtp";
      case "auto":
        return this.hasZeptoMailCreds() ? "zeptomail" : "smtp";
      default:
        throw new Error("real email transport selected with an unmapped EMAIL_PROVIDER");
    }
  }

  /**
   * Whether sandbox (accept-but-do-not-deliver) is in effect. Honoured ONLY inside
   * development/test (`isDevEnv()`, same raw-env fail-closed check as
   * `health.controller.ts`'s storage gate and the R14 boot guards) — a deployed box
   * must always deliver its transactional emails. A leftover
   * `ZEPTOMAIL_SANDBOX_MODE=true` on one was making every payer OTP return
   * `code_sent` (2xx) while ZeptoMail delivered nothing (#813/#814); outside
   * development/test the flag is ignored (real delivery) rather than trusted.
   */
  private sandboxActive(): boolean {
    return Boolean(this.config.ZEPTOMAIL_SANDBOX_MODE) && isDevEnv();
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

  // --- ZeptoMail HTTPS API ---------------------------------------------------

  private async sendViaZeptoMail(message: EmailMessage): Promise<void> {
    const apiUrl = this.config.ZEPTOMAIL_API_URL;
    const token = this.config.ZEPTOMAIL_API_TOKEN;
    const fromAddress = this.config.EMAIL_FROM_ADDRESS;
    const mailAgent = this.config.ZEPTOMAIL_MAIL_AGENT;
    // The boot guard guarantees these in non-dev; re-check so a misconfig fails CLOSED.
    if (!apiUrl || !token || !fromAddress || !mailAgent) {
      throw new EmailRejectedError("zeptomail not fully configured");
    }

    const body: Record<string, unknown> = {
      // NOTE: the ZeptoMail v1.1 send API selects the Mail Agent purely from the send-mail
      // token in the Authorization header — there is NO body field for it.
      // ZEPTOMAIL_MAIL_AGENT is retained only as a boot-time presence check, not sent.
      from: { address: fromAddress, name: this.config.EMAIL_FROM_NAME ?? undefined },
      to: [{ email_address: { address: message.to } }],
      subject: message.subject,
      htmlbody: message.html,
      textbody: message.text,
    };
    if (this.config.EMAIL_REPLY_TO) body.reply_to = [{ address: this.config.EMAIL_REPLY_TO }];
    // ZeptoMail does NOT deliver when this is set, but the full request path still
    // runs — so it is applied ONLY when sandbox is active (never in production, #814).
    if (this.sandboxActive()) body.sandbox = true;

    let res: Response;
    try {
      res = await fetch(apiUrl, {
        method: "POST",
        headers: {
          Authorization: `Zoho-enczapikey ${EmailNotificationService.sendMailToken(token)}`,
          "Content-Type": "application/json",
          Accept: "application/json",
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(ZEPTOMAIL_TIMEOUT_MS),
      });
    } catch {
      // Network/timeout — RETRYABLE (a dropped packet is not a refusal).
      throw new Error("zeptomail transport error");
    }

    // 4xx is a refusal (bad address, bad token); 5xx is the provider failing — retry it.
    if (!res.ok) {
      const reason = `zeptomail http ${res.status}`;
      throw res.status >= 500 ? new Error(reason) : new EmailRejectedError(reason);
    }

    let parsed: unknown;
    try {
      parsed = await res.json();
    } catch {
      throw new EmailRejectedError("zeptomail bad response");
    }
    if (!EmailNotificationService.zeptoMailAccepted(parsed)) {
      throw new EmailRejectedError("zeptomail rejected");
    }
  }

  /**
   * Interpret the ZeptoMail send response. A 2xx is the primary success signal; on a logical
   * failure ZeptoMail returns an `error` object. Accept any parsed object WITHOUT an explicit
   * `error` — robust to the varying `data`/`code`/`message` success shape (e.g. `EM_104`)
   * while still failing closed on an explicit error body.
   */
  private static zeptoMailAccepted(parsed: unknown): boolean {
    if (typeof parsed !== "object" || parsed === null) return false;
    const obj = parsed as Record<string, unknown>;
    if ("error" in obj && obj.error != null) return false;
    return true;
  }

  /**
   * The ZeptoMail Authorization header is `Zoho-enczapikey <send-mail-token>`. A common setup
   * mistake is pasting the FULL header value — including the prefix the dashboard shows —
   * into the token env var, which would produce a doubled `Zoho-enczapikey Zoho-enczapikey …`
   * header that ZeptoMail rejects with a 500 and no delivery. Strip any leading prefix so
   * BOTH the raw token and the full-header form authenticate.
   */
  private static sendMailToken(token: string): string {
    return token.replace(/^\s*Zoho-enczapikey\s+/i, "");
  }

  // --- SMTP (nodemailer) -----------------------------------------------------

  private async sendViaSmtp(message: EmailMessage): Promise<void> {
    const host = this.config.SMTP_HOST;
    const user = this.config.SMTP_USER;
    const pass = this.config.SMTP_PASS;
    const fromAddress = this.config.EMAIL_FROM_ADDRESS;
    if (!host || !user || !pass || !fromAddress) {
      throw new EmailRejectedError("smtp not fully configured");
    }
    const port = this.config.SMTP_PORT ?? 587;

    const transporter: Transporter = createTransport({
      host,
      port,
      secure: port === 465,
      auth: { user, pass },
    });

    try {
      await transporter.sendMail({
        from: this.config.SMTP_FROM ?? this.fromHeader(fromAddress),
        to: message.to,
        subject: message.subject,
        text: message.text,
        html: message.html,
        ...(this.config.EMAIL_REPLY_TO ? { replyTo: this.config.EMAIL_REPLY_TO } : {}),
      });
    } catch {
      // Opaque + retryable: an SMTP failure is usually transient, and the underlying error
      // routinely quotes the recipient address back at us.
      throw new Error("smtp send error");
    }
  }

  private fromHeader(fromAddress: string): string {
    const name = this.config.EMAIL_FROM_NAME;
    return name ? `${name} <${fromAddress}>` : fromAddress;
  }
}

/**
 * A FINAL failure: the provider understood the request and refused it (bad address, bad
 * credentials, 4xx, an explicit error body). Distinguished from a transport failure purely
 * so {@link EmailNotificationService.send} knows not to retry — retrying a refusal cannot
 * succeed and doubles the latency of a request already destined to fail.
 */
export class EmailRejectedError extends Error {}
