/**
 * #2787 (parent #2754) — the first sign-in message to each company a Campus import batch moved.
 *
 * WHY. In the dummy-company pilot (#2754, 18 Nov 2026) a phone user had to find a misleading link
 * to reach the SMS code. Each moved company is told, once, how to sign in on BadaBhai: by SMS code
 * on its proven phone, or by email code (and then confirm its phone) when no phone was proven.
 *
 * WHEN. A separate step, `import-campus-companies.cli.ts --notify --batch <key>`, run after the
 * batch is applied and `--report` shows no unexplained difference (runbook). Without `--send` it is
 * a read-only preview; with `--send` it delivers. Owner rulings of 19 Nov 2026: every company the
 * batch placed (created OR matched), English only, a step of its own.
 *
 * ONCE PER COMPANY PER CHANNEL, EVER. `company_import_notices` is unique on (payer, channel): a
 * channel already `sent` is never sent again, by this batch or a later one. A `failed` or `skipped`
 * notice is tried again by the next `--send` run, so an SMS skipped for `template_missing` today
 * goes out once the approved template id is passed. Each (payer, channel) is decided under a
 * transaction-scoped advisory lock, so two operators running at once cannot both send. The send
 * happens inside that transaction: a crash after delivery and before commit leaves the notice
 * unsent and the next run sends it again (at least once, never silently lost).
 *
 * SMS. A welcome text is not a sign-in code, so it needs its OWN approved DLT template (the worker
 * sign-in template carries only a code). The template is fixed text with NO variable: a DLT
 * variable is capped at 30 characters, too short for the sign-in address, and the address must be
 * whitelisted in the template anyway. Until the operator passes `--sms-template-id`, every SMS is
 * `skipped` with `template_missing`. Only a PROVEN phone gets one: an unproven phone cannot sign in
 * by SMS code, so telling it to would be wrong.
 *
 * PRIVACY. The address and the number exist only inside the outbound message. The log, the send
 * log and the event carry ids, the channel and closed reason codes.
 */
import { and, eq, inArray, sql } from "drizzle-orm";
import {
  companyImportNotices,
  companyImportRows,
  payerPhoneProofs,
  payers,
  type CompanyImportNoticeChannel,
  type Database,
} from "@badabhai/db";
import type { EventsService } from "../../events/events.service";
import type { EmailMessage } from "../../notifications/email-notification.service";
import type { BatchRecord } from "./import-ledger.repository";

/** Why a notice was not delivered. Closed codes: stored in the send log, printed in the summary. */
export type MoveNoticeSkipReason =
  | "account_archived"
  | "account_suspended"
  | "no_email"
  | "undeliverable_address"
  | "phone_not_proven"
  | "template_missing";

export type MoveNoticeOutcome = "sent" | "would_send" | "already_sent" | "failed" | MoveNoticeSkipReason;

export type SignInBy = "sms_code" | "email_code";

export interface MoveNoticeEmail {
  send(message: EmailMessage): Promise<void>;
}

export interface MoveNoticeSms {
  sendTemplate(input: { phoneE164: string; templateId: string; variables: readonly string[] }): Promise<void>;
}

export interface MoveNoticeDeps {
  db: Database;
  pii: { decrypt(token: string): string };
  email: MoveNoticeEmail;
  sms: MoveNoticeSms;
  events: EventsService;
}

export interface MoveNoticeOptions {
  /** The company sign-in address on BadaBhai (payer-web), printed in the email. */
  signInUrl: string;
  /** The approved DLT template of the welcome SMS, or null until one is approved. */
  smsTemplateId: string | null;
  runBy: string;
  /** false: a read-only preview (`would_send`); true: deliver and log. */
  send: boolean;
}

export type MoveNoticeSummary = Record<CompanyImportNoticeChannel, Partial<Record<MoveNoticeOutcome, number>>>;

/** The reason code of a failed delivery (stored in the send log). */
export const SEND_FAILED = "send_failed";

/** True when migration `company_import_notices` is applied. `--notify` refuses without it. */
export async function moveNoticeLogExists(db: Database): Promise<boolean> {
  const rows = (await db.execute(sql`
    SELECT to_regclass('public.company_import_notices') IS NOT NULL AS ok`)) as unknown as { ok: boolean }[];
  return rows[0]?.ok === true;
}

/** Accept an https address, or http only for a local stack. */
export function parseSignInUrl(raw: string): string {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error("--signin-url must be a full address, e.g. https://payer.example.in/login");
  }
  const local = url.hostname === "localhost" || url.hostname === "127.0.0.1";
  if (url.protocol !== "https:" && !(url.protocol === "http:" && local)) {
    throw new Error("--signin-url must be https (http only for localhost)");
  }
  if (url.username || url.password) throw new Error("--signin-url must not carry credentials");
  return url.toString();
}

const escapeHtml = (s: string): string =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/** The email, in English (ruling 19 Nov 2026). No secret, no code: only how to sign in. */
export function composeMoveEmail(input: {
  signInUrl: string;
  signInBy: SignInBy;
  phoneLast4: string | null;
}): Pick<EmailMessage, "subject" | "text" | "html"> {
  const subject = "Your company account has moved to BadaBhai";
  const intro =
    "Your company account on BadaBhai Campus has moved to BadaBhai. Your live jobs and any unused " +
    "CV views (now credits) have moved with it.";
  const how =
    input.signInBy === "sms_code"
      ? [
          `To sign in, open ${input.signInUrl} and enter your mobile number` +
            (input.phoneLast4 ? ` ending in ${input.phoneLast4}` : "") +
            ". We will send you a code by SMS.",
        ]
      : [
          `To sign in, open ${input.signInUrl} and enter this email address. We will email you a code.`,
          "Then add your mobile number on the Account page and confirm it with a code, so you can " +
            "sign in by SMS next time.",
        ];
  const outro = "If you did not expect this message, contact BadaBhai support.";
  const url = escapeHtml(input.signInUrl);
  const htmlHow =
    input.signInBy === "sms_code"
      ? `<p>To sign in, open <a href="${url}">${url}</a> and enter your mobile number` +
        (input.phoneLast4 ? ` ending in <strong>${escapeHtml(input.phoneLast4)}</strong>` : "") +
        ". We will send you a code by SMS.</p>"
      : `<p>To sign in, open <a href="${url}">${url}</a> and enter this email address. We will email you a code.</p>` +
        "<p>Then add your mobile number on the Account page and confirm it with a code, so you can sign in by SMS next time.</p>";
  return {
    subject,
    text: [intro, ...how, outro].join("\n\n"),
    html: `<p>${intro}</p>${htmlHow}<p>${outro}</p>`,
  };
}

interface Recipient {
  payerId: string;
  status: string;
  email: string | null;
  phoneE164: string | null;
  phoneProven: boolean;
}

/** The companies the batch placed: its own `company` ledger rows that wrote or reused an account. */
async function placedPayerIds(db: Database, batchId: string): Promise<string[]> {
  const rows = await db
    .select({ targetId: companyImportRows.targetId })
    .from(companyImportRows)
    .where(
      and(
        eq(companyImportRows.batchId, batchId),
        eq(companyImportRows.kind, "company"),
        inArray(companyImportRows.state, ["created", "matched"]),
      ),
    );
  return [...new Set(rows.map((r) => r.targetId).filter((id): id is string => id !== null))];
}

async function readRecipient(db: Database, pii: MoveNoticeDeps["pii"], payerId: string): Promise<Recipient | null> {
  const [row] = await db
    .select({
      status: payers.status,
      emailEnc: payers.emailEnc,
      phoneEnc: payers.phoneEnc,
      phoneHash: payers.phoneHash,
      proofHash: payerPhoneProofs.phoneHash,
    })
    .from(payers)
    .leftJoin(payerPhoneProofs, eq(payerPhoneProofs.payerId, payers.id))
    .where(eq(payers.id, payerId))
    .limit(1);
  if (!row) return null;
  return {
    payerId,
    status: row.status,
    email: row.emailEnc ? pii.decrypt(row.emailEnc) : null,
    phoneE164: row.phoneEnc ? pii.decrypt(row.phoneEnc) : null,
    // The proof must be for the phone the account holds NOW (a changed phone drops its proof, but
    // check anyway: SMS sign-in keys on this match).
    phoneProven: row.phoneHash !== null && row.proofHash !== null && row.proofHash === row.phoneHash,
  };
}

/** Why this channel cannot be delivered to this company, or null when it can. */
export function skipReason(
  r: Pick<Recipient, "status" | "email" | "phoneE164" | "phoneProven">,
  channel: CompanyImportNoticeChannel,
  smsTemplateId: string | null,
): MoveNoticeSkipReason | null {
  if (r.status === "archived") return "account_archived";
  if (r.status === "suspended") return "account_suspended";
  if (channel === "email") {
    if (!r.email) return "no_email";
    // `.invalid` is reserved (RFC 2606): the dummy companies of a synthetic pilot bundle.
    if (/\.invalid$/i.test(r.email)) return "undeliverable_address";
    return null;
  }
  if (!r.phoneE164 || !r.phoneProven) return "phone_not_proven";
  if (!smsTemplateId) return "template_missing";
  return null;
}

async function priorState(db: Database, payerId: string, channel: CompanyImportNoticeChannel): Promise<string | null> {
  const [row] = await db
    .select({ state: companyImportNotices.state })
    .from(companyImportNotices)
    .where(and(eq(companyImportNotices.payerId, payerId), eq(companyImportNotices.channel, channel)))
    .limit(1);
  return row?.state ?? null;
}

async function deliver(
  deps: MoveNoticeDeps,
  r: Recipient,
  channel: CompanyImportNoticeChannel,
  signInBy: SignInBy,
  opts: MoveNoticeOptions,
): Promise<boolean> {
  try {
    if (channel === "email") {
      await deps.email.send({
        to: r.email!,
        ...composeMoveEmail({
          signInUrl: opts.signInUrl,
          signInBy,
          phoneLast4: signInBy === "sms_code" && r.phoneE164 ? r.phoneE164.slice(-4) : null,
        }),
        principal: "payer",
        purpose: "move_notice",
      });
    } else {
      await deps.sms.sendTemplate({ phoneE164: r.phoneE164!, templateId: opts.smsTemplateId!, variables: [] });
    }
    return true;
  } catch {
    // The providers throw opaque errors that name no address or number; the code is enough.
    return false;
  }
}

/** One (company, channel), decided and delivered under an advisory lock in one transaction. */
async function notifyOne(
  deps: MoveNoticeDeps,
  batch: BatchRecord,
  r: Recipient,
  channel: CompanyImportNoticeChannel,
  opts: MoveNoticeOptions,
): Promise<MoveNoticeOutcome> {
  const signInBy: SignInBy = r.phoneProven && r.phoneE164 ? "sms_code" : "email_code";
  if (!opts.send) {
    if ((await priorState(deps.db, r.payerId, channel)) === "sent") return "already_sent";
    return skipReason(r, channel, opts.smsTemplateId) ?? "would_send";
  }
  return deps.db.transaction(async (raw) => {
    const tx = raw as unknown as Database;
    await tx.execute(
      sql`SELECT pg_advisory_xact_lock(hashtextextended(${`company_import_notice:${r.payerId}:${channel}`}, 0))`,
    );
    if ((await priorState(tx, r.payerId, channel)) === "sent") return "already_sent" as const;

    const skip = skipReason(r, channel, opts.smsTemplateId);
    const delivered = skip === null ? await deliver(deps, r, channel, signInBy, opts) : false;
    const state = delivered ? "sent" : skip !== null ? "skipped" : "failed";
    const reason = delivered ? null : (skip ?? SEND_FAILED);
    const now = new Date();
    await tx
      .insert(companyImportNotices)
      .values({
        batchId: batch.id,
        payerId: r.payerId,
        channel,
        state,
        reason,
        attempts: 1,
        runBy: opts.runBy,
        sentAt: delivered ? now : null,
      })
      .onConflictDoUpdate({
        target: [companyImportNotices.payerId, companyImportNotices.channel],
        set: {
          state,
          reason,
          attempts: sql`${companyImportNotices.attempts} + 1`,
          runBy: opts.runBy,
          sentAt: delivered ? now : null,
          updatedAt: now,
        },
      });
    if (delivered) {
      await deps.events.emit({
        event_name: "payer.move_notice_sent",
        actor: { actor_type: "system", actor_id: null },
        subject: { subject_type: "payer", subject_id: r.payerId },
        payload: { payer_id: r.payerId, batch_id: batch.id, channel, sign_in_by: signInBy },
        correlationId: batch.id,
        requestId: `campus-import:${batch.batchKey}:notify`,
        idempotencyKey: `payer.move_notice_sent:${r.payerId}:${channel}`,
        tx,
      });
    }
    return delivered ? ("sent" as const) : skip !== null ? skip : ("failed" as const);
  });
}

/**
 * Tell every company the batch placed how to sign in, once per channel. Never throws for one
 * company's delivery: a failure is logged as `failed` and the next run retries it.
 */
export async function notifyMovedCompanies(
  deps: MoveNoticeDeps,
  batch: BatchRecord,
  opts: MoveNoticeOptions,
): Promise<MoveNoticeSummary> {
  const summary: MoveNoticeSummary = { email: {}, sms: {} };
  const bump = (channel: CompanyImportNoticeChannel, outcome: MoveNoticeOutcome) => {
    summary[channel][outcome] = (summary[channel][outcome] ?? 0) + 1;
  };
  for (const payerId of await placedPayerIds(deps.db, batch.id)) {
    const r = await readRecipient(deps.db, deps.pii, payerId);
    if (!r) continue; // erased since the import: nothing to tell, and its log went with it
    for (const channel of ["email", "sms"] as const) {
      bump(channel, await notifyOne(deps, batch, r, channel, opts));
    }
  }
  return summary;
}
