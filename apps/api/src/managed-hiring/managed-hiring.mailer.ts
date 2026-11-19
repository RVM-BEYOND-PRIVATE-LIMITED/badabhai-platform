import { Injectable, Logger } from "@nestjs/common";
import { PiiCryptoService } from "../common/pii-crypto.service";
import { EmailNotificationService } from "../notifications/email-notification.service";
import { PayersRepository } from "../payers/payers.repository";
import { MANAGED_HIRING_TERMS } from "./managed-hiring-tier";

/** The order changes a company is told about (#2751 item 9). */
export type ManagedHiringNoticeKind = "activated" | "met" | "extended" | "closed_unmet";

export interface ManagedHiringNotice {
  readonly kind: ManagedHiringNoticeKind;
  readonly confirmedCount: number;
  readonly targetCount: number;
  /** The deadline (activated) or the extension's end (extended). */
  readonly until: Date | null;
}

/** The email for one notice. Pure: no I/O. Every text carries the terms line; none promises a hire. */
export function composeManagedHiringNotice(n: ManagedHiringNotice): {
  subject: string;
  lines: string[];
} {
  const when = n.until ? formatIstDay(n.until) : null;
  switch (n.kind) {
    case "activated":
      return {
        subject: "Your BadaBhai Managed Hiring order has started",
        lines: [
          "We received your payment and your Managed Hiring order has started.",
          `Our team will look for at least ${n.targetCount} workers who confirm by phone that they are interested in your job.`,
          when
            ? `The deadline is the end of ${when} (IST), counted in working days (Monday to Saturday).`
            : "",
          "You can follow the workers who confirmed on your job page.",
        ],
      };
    case "met":
      return {
        subject: "Your BadaBhai Managed Hiring order met its target",
        lines: [
          `${n.confirmedCount} workers confirmed by phone that they are interested in your job (the target was ${n.targetCount}).`,
          "Their details are on your job page. Opening their contacts costs you no credits.",
        ],
      };
    case "extended":
      return {
        subject: "Your BadaBhai Managed Hiring order was extended at no charge",
        lines: [
          `By the deadline ${n.confirmedCount} of ${n.targetCount} workers had confirmed interest.`,
          when
            ? `We have extended your order at no charge until the end of ${when} (IST) and will keep looking.`
            : "We have extended your order at no charge and will keep looking.",
        ],
      };
    case "closed_unmet":
      return {
        subject: "Your BadaBhai Managed Hiring order has ended",
        lines: [
          `The free extension has ended with ${n.confirmedCount} of ${n.targetCount} workers confirmed.`,
          "Our team will contact you about the order.",
        ],
      };
  }
}

function formatIstDay(at: Date): string {
  // The deadline instant is the START of the next IST day: name the day it ends.
  const lastDay = new Date(at.getTime() - 1);
  return new Intl.DateTimeFormat("en-IN", {
    timeZone: "Asia/Kolkata",
    weekday: "short",
    day: "numeric",
    month: "short",
    year: "numeric",
  }).format(lastDay);
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/**
 * #2751 item 9 — tell the company each time its Managed Hiring order changes (owner choice
 * 2026-11-18: an email plus the status on the order route). The recipient is the email on file of
 * the login that bought the order; a phone-only login gets no email (its status still shows on the
 * order route). Decrypted here, at the boundary, never logged.
 *
 * BEST-EFFORT BY CONTRACT: the change has committed when this runs. A failure is logged with the
 * opaque order id and the error class, and swallowed.
 */
@Injectable()
export class ManagedHiringMailer {
  private readonly logger = new Logger(ManagedHiringMailer.name);

  constructor(
    private readonly payers: PayersRepository,
    private readonly pii: PiiCryptoService,
    private readonly email: EmailNotificationService,
  ) {}

  async notify(
    recipientPayerId: string,
    orderId: string,
    notice: ManagedHiringNotice,
  ): Promise<void> {
    try {
      const row = await this.payers.findById(recipientPayerId);
      if (!row || row.emailEnc === null) {
        this.logger.log(
          `managed hiring notice skipped order=${orderId} kind=${notice.kind} reason=${row ? "no_email" : "no_row"}`,
        );
        return;
      }
      const to = this.pii.decrypt(row.emailEnc);
      const { subject, lines } = composeManagedHiringNotice(notice);
      const body = [...lines.filter((l) => l.length > 0), MANAGED_HIRING_TERMS];
      await this.email.send({
        to,
        subject,
        text: body.join("\n\n"),
        html: body.map((l) => `<p>${escapeHtml(l)}</p>`).join(""),
        principal: "payer",
        purpose: "managed_hiring_update",
      });
    } catch (err) {
      this.logger.error(
        `managed hiring notice failed order=${orderId} kind=${notice.kind} reason=${err instanceof Error ? err.name : "unknown"}`,
      );
    }
  }
}
