import { Inject, Injectable, Logger } from "@nestjs/common";
import { randomBytes } from "node:crypto";
import type { ServerConfig } from "@badabhai/config";
import { SERVER_CONFIG } from "../config/config.module";
import { PiiCryptoService } from "../common/pii-crypto.service";
import { ADMIN_INVITE_MAILER, type AdminInviteMailer } from "./admin-invite.mailer";

/** Bytes of entropy in an accept token. 32 bytes = 256 bits, base64url-encoded to 43 chars. */
const TOKEN_BYTES = 32;

const MS_PER_HOUR = 60 * 60 * 1000;

/**
 * The admin accept-link seam: mint / hash / expire / render / deliver.
 *
 * Extracted from {@link AdminActionsService} rather than inlined there because that service
 * is the audited ACTION surface — suspend, reinstate, grant credits — and the token lifecycle
 * is a different concern with a different hazard profile. Keeping it here means the rules
 * about where a raw bearer token may travel live in ONE file, next to the mailer seam that is
 * the only legitimate destination, instead of being spread across a 600-line service.
 *
 * PRIVACY (CLAUDE.md §2, HARD): the raw token and the accept URL are bearer secrets. This
 * class may hand them to the mailer and return them to the caller; it must NEVER log or event
 * either. Only the keyed HMAC is ever persisted.
 */
@Injectable()
export class AdminInviteService {
  private readonly logger = new Logger(AdminInviteService.name);

  constructor(
    @Inject(SERVER_CONFIG) private readonly config: ServerConfig,
    @Inject(ADMIN_INVITE_MAILER) private readonly mailer: AdminInviteMailer,
    private readonly pii: PiiCryptoService,
  ) {}

  /**
   * Mint a single-use accept token: 256 bits from the OS CSPRNG, base64url so it survives a
   * query string without escaping. `randomBytes`, never `Math.random` — this string is the
   * only thing standing between a stranger and an admin account.
   */
  mintToken(): string {
    return randomBytes(TOKEN_BYTES).toString("base64url");
  }

  /**
   * The keyed HMAC that is stored and matched. Keyed (not a bare SHA-256) so that a leaked
   * database backup does not let an attacker precompute hashes for candidate tokens — the
   * same reasoning that makes `email_hash` an HMAC throughout this schema.
   */
  hashToken(rawToken: string): string {
    return this.pii.hmac(rawToken);
  }

  /** When a link minted `now` stops working (ADMIN_INVITE_TTL_HOURS, default 48h). */
  expiryFrom(now: Date): Date {
    return new Date(now.getTime() + this.config.ADMIN_INVITE_TTL_HOURS * MS_PER_HOUR);
  }

  /**
   * Render the accept link. With no ADMIN_INVITE_ACCEPT_URL configured this returns a
   * deliberately unusable `mock://` URL rather than guessing an origin: a link pointing at
   * the wrong host looks real, gets shared, and fails confusingly, whereas `mock://` tells the
   * operator immediately that the base is unset. The mock mailer never transmits it, so the
   * raw token still never leaves the process on that path.
   */
  buildAcceptUrl(rawToken: string): string {
    const base = this.config.ADMIN_INVITE_ACCEPT_URL;
    const q = `token=${encodeURIComponent(rawToken)}`;
    if (!base) return `mock://admin-invite/accept?${q}`;
    return `${base}${base.includes("?") ? "&" : "?"}${q}`;
  }

  /**
   * Deliver the accept link, swallowing transport failure by design.
   *
   * The invite row and its audit event are already COMMITTED when this runs. Throwing here
   * would surface an error for an invite that genuinely exists, and — because the write is
   * already durable — would roll nothing back; the super_admin would be left believing the
   * invite failed while a pending row sat in the table holding that email's unique slot. The
   * accept link is returned to them in the response regardless, so a failed send degrades to
   * "share this link yourself", which is the mock-mailer behaviour anyway.
   *
   * Logs an opaque admin id + status only — never the email, the token, or the link.
   */
  async deliver(email: string, acceptUrl: string, adminId: string): Promise<void> {
    try {
      await this.mailer.send({
        email,
        acceptUrl,
        expiresInHours: this.config.ADMIN_INVITE_TTL_HOURS,
      });
    } catch {
      this.logger.warn(
        `admin invite email delivery failed admin_id=${adminId} status=send_failed ` +
          `(the invite is live; the accept link was returned to the inviter)`,
      );
    }
  }
}
