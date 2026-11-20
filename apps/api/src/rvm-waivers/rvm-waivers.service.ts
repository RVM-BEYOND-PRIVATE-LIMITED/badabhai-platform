import { Injectable, Logger, ServiceUnavailableException } from "@nestjs/common";
import type { Database, RvmApplicantWaiverRow, RvmWaiverScope, RvmWaiverSource } from "@badabhai/db";
import type { PayloadInputOf } from "@badabhai/event-schema";
import { ADMIN_ACTION_CODES } from "../admin/admin-action-codes";
import { decodeEntityCursor, encodeEntityCursor } from "../admin/admin-entities.cursor";
import { sqlStateOf } from "../common/db-error";
import { PiiCryptoService } from "../common/pii-crypto.service";
import type { RequestContext } from "../common/request-context";
import { CreditRulesService } from "../credit-rules/credit-rules.service";
import { EventsService } from "../events/events.service";
import { isBarredPayerStatus } from "../payers/payer-barred-status";
import type { TenantKey } from "../payers/payer-tenant-scope";
import { PayerTenantScopeService } from "../payers/payer-tenant-scope.service";
import { RvmWaiversRepository, type RvmWaiverWithUses } from "./rvm-waivers.repository";

/** The company named does not exist, is barred, or has no tenant. A neutral 404. */
export class WaiverCompanyNotFoundError extends Error {
  constructor() {
    super("company not found");
    this.name = "WaiverCompanyNotFoundError";
  }
}

/** The job named does not exist or is not this company's. A neutral 404. */
export class WaiverPostingNotFoundError extends Error {
  constructor() {
    super("posting not found");
    this.name = "WaiverPostingNotFoundError";
  }
}

/** #2778 — a set sent an end date while RVM_WAIVER_END_DATES_ENABLED is off. A 400. */
export class WaiverEndDatesOffError extends Error {
  constructor() {
    super("end dates on waivers are not switched on");
    this.name = "WaiverEndDatesOffError";
  }
}

/** #2778 — the end date is before today (India time), or sent with a clear. A 400. */
export class WaiverEndDateInvalidError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WaiverEndDateInvalidError";
  }
}

/**
 * #2778 — the scope already has a waiver in force with ANOTHER end date (or none, where one was
 * sent, or the reverse). Nothing was written: clear it, then set it again with the new date. A 409.
 */
export class WaiverEndDateDiffersError extends Error {
  constructor() {
    super("the waiver in force has another end date");
    this.name = "WaiverEndDateDiffersError";
  }
}

/** Today in India as `YYYY-MM-DD` (UTC+05:30, no daylight saving). */
export function istDayOf(at: Date): string {
  return new Date(at.getTime() + 330 * 60_000).toISOString().slice(0, 10);
}

/** Who is making a change: a Campus staff member (name given) or a BadaBhai admin (by id). */
export type WaiverActor =
  | { readonly kind: "campus"; readonly staffRef: string; readonly staffLabel: string }
  | { readonly kind: "admin"; readonly adminId: string };

/** Set (`active: true`) or clear (`active: false`) the waiver of one company or one job. */
export interface SetWaiverInput {
  readonly scope: RvmWaiverScope;
  readonly companyId: string;
  /** Required for a job waiver, absent for a company waiver (the DTOs enforce it). */
  readonly postingId: string | null;
  readonly active: boolean;
  readonly reason: string;
  readonly actor: WaiverActor;
  /**
   * #2778 — the last day (`YYYY-MM-DD`, India time) a NEW waiver applies; absent or null for one
   * that runs until cleared. Only with RVM_WAIVER_END_DATES_ENABLED on, only on a set.
   */
  readonly endsOn?: string | null;
}

/** A waiver as the routes show it: names decrypted, with the opens it paid for. */
export interface WaiverView {
  readonly waiverId: string;
  readonly scope: RvmWaiverScope;
  readonly companyId: string;
  readonly postingId: string | null;
  readonly active: boolean;
  readonly source: RvmWaiverSource;
  readonly setByRef: string;
  readonly setByLabel: string | null;
  readonly reason: string;
  readonly setAt: Date;
  readonly clearedAt: Date | null;
  readonly clearedByRef: string | null;
  readonly clearedByLabel: string | null;
  readonly clearReason: string | null;
  readonly waivedOpens: number;
  /** #2778 — the last day it applies, or null (no end date, or end dates switched off). */
  readonly endsOn: string | null;
  /** #2778 — its last day has passed: it frees nobody, though it stays `active` until cleared. */
  readonly ended: boolean;
}

/** The answer to a set or clear: the scope's waiver after the call, and whether it changed. */
export interface SetWaiverResult {
  /** The active waiver (set), the one just cleared, or the newest one of the scope; null for none. */
  readonly waiver: WaiverView | null;
  readonly active: boolean;
  /** False when the scope was already in the asked state: nothing was written. */
  readonly changed: boolean;
}

export interface WaiverPage {
  readonly waivers: readonly WaiverView[];
  readonly nextCursor: string | null;
}

const UNDEFINED_TABLE = "42P01";

/**
 * #2750 item 5 (brief 4C.7, B2-37, B6-04, B6-05) — the placement team's waiver of the contact
 * cost. Under the credit rules an RVM student who applied costs one credit to open; a waiver on a
 * COMPANY frees every RVM student who applied to any of its jobs, a waiver on a JOB frees the RVM
 * students who applied to that job. Everyone else still pays.
 *
 * Two doors, one service: Campus's placement team through the Campus service route (#154 calls
 * it), and a BadaBhai super admin through `/admin/waivers`. Both:
 *   - answer 404 while the `credit_rules` switch is off everywhere (nothing reads the tables before
 *     their migration), and 503 with the switch on and the tables missing;
 *   - name the company by its id and store it as its TENANT key (`resolveReadOnly`: a Campus or
 *     admin call is not the company's own, so it heals no org);
 *   - serialise every change of one scope, write the row change and its event (and, for an
 *     admin, its audit row) in ONE transaction;
 *   - are idempotent by state: setting an active waiver again, or clearing a cleared one, writes
 *     nothing and answers `changed: false`. A new reason needs a clear and a new set.
 *
 * Staff names are stored ENCRYPTED (owner ruling 2026-11-17): a Campus name is encrypted here; an
 * admin's is copied from `admin_users.name_enc` as the ciphertext it already is.
 *
 * END DATES (#2778, owner decision 2026-11-19). With RVM_WAIVER_END_DATES_ENABLED on, a set may
 * carry `endsOn`, the last day (India time) the new waiver applies. From the next day it frees
 * nobody (the repository's price reads), drops out of the in-force list, and shows `ended`; the
 * row is not touched. Setting a scope whose waiver has ended retires it (a clear by the same
 * person, with the reason "Ended on …; replaced by a new waiver") and sets the new one; setting a
 * scope whose waiver is still in force with ANOTHER end date is refused (409), never ignored. Off,
 * a dated set is refused (400) and every path here is what it was before #2778.
 */
@Injectable()
export class RvmWaiversService {
  private readonly logger = new Logger(RvmWaiversService.name);

  constructor(
    private readonly repo: RvmWaiversRepository,
    private readonly creditRules: CreditRulesService,
    private readonly tenancy: PayerTenantScopeService,
    private readonly crypto: PiiCryptoService,
    private readonly events: EventsService,
  ) {}

  /**
   * @throws NotFoundException — the `credit_rules` switch is off everywhere.
   * @throws WaiverCompanyNotFoundError — no such company, it is barred, or it has no tenant.
   * @throws WaiverPostingNotFoundError — a job waiver names a posting that is not this company's.
   * @throws ServiceUnavailableException — the tables are missing (the migration is not applied).
   */
  async set(input: SetWaiverInput, ctx: RequestContext): Promise<SetWaiverResult> {
    this.creditRules.assertLive();
    const endsOn = await this.checkEndsOn(input);
    const tenant = await this.tenantOf(input.companyId);
    const postingId = input.scope === "job" ? input.postingId : null;
    if (input.scope === "job") {
      if (postingId === null || (await this.repo.postingOwner(postingId)) !== tenant) {
        throw new WaiverPostingNotFoundError();
      }
    }
    const who = await this.who(input.actor);

    try {
      const out = await this.repo.withTransaction(async (tx) => {
        await this.repo.lockScope(tx, input.scope, postingId ?? tenant);
        const live = await this.repo.findActive(tx, input.scope, tenant, postingId);
        // #2778 — empty while end dates are off: then every live waiver is in force, as before.
        const liveEnd = live ? ((await this.repo.endsOf([live.id], tx)).get(live.id) ?? null) : null;

        if (input.active) {
          if (live && !liveEnd?.ended) {
            // In force already. The same end date (or none on both) is a no-op; another one is
            // refused, never silently ignored: a new end date is a clear and a new set.
            if ((liveEnd?.endsOn ?? null) !== endsOn) throw new WaiverEndDateDiffersError();
            return { row: live, active: true, changed: false };
          }
          if (live && liveEnd) {
            // #2778 — its last day has passed, so it frees nobody, but it still holds the scope's one
            // active slot. Retire it (a clear by the same person, saying why) and set the new one.
            const retireReason = `Ended on ${liveEnd.endsOn}; replaced by a new waiver`;
            const retired = await this.repo.clear(tx, live.id, {
              clearedByRef: who.ref,
              clearedByLabelEnc: who.labelEnc,
              clearReason: retireReason,
              at: new Date(),
            });
            if (!retired) throw new Error("rvm_applicant_waivers: the ended waiver was not cleared");
            await this.record(tx, "payer.rvm_waiver_cleared", retired, input.actor, retireReason, ctx);
          }
          const row = await this.repo.insert(tx, {
            scope: input.scope,
            tenant,
            jobPostingId: postingId,
            source: who.source,
            setByRef: who.ref,
            setByLabelEnc: who.labelEnc,
            reason: input.reason,
          });
          if (endsOn !== null) {
            await this.repo.insertEndDate(tx, { waiverId: row.id, tenant, endsOn });
          }
          await this.record(tx, "payer.rvm_waiver_set", row, input.actor, input.reason, ctx, endsOn);
          return { row, active: true, changed: true };
        }

        if (!live) {
          const latest = await this.repo.findLatest(tx, input.scope, tenant, postingId);
          return { row: latest ?? null, active: false, changed: false };
        }
        const cleared = await this.repo.clear(tx, live.id, {
          clearedByRef: who.ref,
          clearedByLabelEnc: who.labelEnc,
          clearReason: input.reason,
          at: new Date(),
        });
        if (!cleared) throw new Error("rvm_applicant_waivers: the waiver was not cleared");
        await this.record(tx, "payer.rvm_waiver_cleared", cleared, input.actor, input.reason, ctx);
        return { row: cleared, active: false, changed: true };
      });

      const ids = out.row ? [out.row.id] : [];
      const [uses, ends] = await Promise.all([this.repo.usesOf(ids), this.repo.endsOf(ids)]);
      return {
        waiver: out.row
          ? this.view({
              ...out.row,
              waivedOpens: uses.get(out.row.id) ?? 0,
              end: ends.get(out.row.id) ?? null,
            })
          : null,
        active: out.active,
        changed: out.changed,
      };
    } catch (err) {
      throw this.missingTableAs503(err);
    }
  }

  /**
   * One page of waivers, newest first: active only unless `includeCleared`, one company's when
   * `companyId` is given (an unknown company is an empty page, not a 404: a list says nothing).
   */
  async list(filter: {
    companyId?: string;
    includeCleared?: boolean;
    cursor?: string;
    limit: number;
  }): Promise<WaiverPage> {
    this.creditRules.assertLive();
    let tenant: TenantKey | undefined;
    if (filter.companyId !== undefined) {
      const scope = await this.tenancy.resolveReadOnly(filter.companyId.toLowerCase());
      if (scope === null) return { waivers: [], nextCursor: null };
      tenant = scope.tenantKey;
    }
    try {
      const rows = await this.repo.list({
        ...(tenant ? { tenant } : {}),
        includeCleared: filter.includeCleared ?? false,
        after: decodeEntityCursor(filter.cursor),
        limit: filter.limit + 1,
      });
      const page = rows.slice(0, filter.limit);
      const last = page.at(-1);
      return {
        waivers: page.map((r) => this.view(r)),
        nextCursor:
          rows.length > filter.limit && last
            ? encodeEntityCursor({ createdAt: last.createdAt.toISOString(), id: last.id })
            : null,
      };
    } catch (err) {
      throw this.missingTableAs503(err);
    }
  }

  /**
   * #2778 — the end date a set may carry: null for none. Refused (400) while end dates are off, on
   * a clear, or before today in India; 503 with the switch on and the table missing.
   */
  private async checkEndsOn(input: SetWaiverInput): Promise<string | null> {
    const endsOn = input.endsOn ?? null;
    if (endsOn === null) return null;
    if (!this.repo.endDatesEnabled) throw new WaiverEndDatesOffError();
    if (!input.active) throw new WaiverEndDateInvalidError("ends_on is only sent with active: true");
    if (endsOn < istDayOf(new Date())) {
      throw new WaiverEndDateInvalidError("ends_on is before today (India time)");
    }
    if (!(await this.repo.endDatesReadable())) {
      this.logger.error("rvm_waiver_end_dates missing; apply the rvm_waiver_end_dates migration");
      throw new ServiceUnavailableException();
    }
    return endsOn;
  }

  private async tenantOf(companyId: string): Promise<TenantKey> {
    const id = companyId.toLowerCase();
    const status = await this.repo.companyStatus(id);
    if (status === undefined || isBarredPayerStatus(status)) throw new WaiverCompanyNotFoundError();
    const scope = await this.tenancy.resolveReadOnly(id);
    if (scope === null) throw new WaiverCompanyNotFoundError();
    return scope.tenantKey;
  }

  private async who(
    actor: WaiverActor,
  ): Promise<{ source: RvmWaiverSource; ref: string; labelEnc: string | null }> {
    if (actor.kind === "campus") {
      return {
        source: "campus",
        ref: actor.staffRef.toLowerCase(),
        labelEnc: this.crypto.encrypt(actor.staffLabel),
      };
    }
    return { source: "admin", ref: actor.adminId, labelEnc: await this.repo.adminNameEnc(actor.adminId) };
  }

  /** The change's event, and for an admin its audit row, on the change's own transaction. */
  private async record(
    tx: Database,
    eventName: "payer.rvm_waiver_set" | "payer.rvm_waiver_cleared",
    row: RvmApplicantWaiverRow,
    actor: WaiverActor,
    reason: string,
    ctx: RequestContext,
    endsOn: string | null = null,
  ): Promise<void> {
    if (actor.kind === "admin") {
      await this.repo.audit(tx, {
        adminId: actor.adminId,
        action: ADMIN_ACTION_CODES.rvm_waiver_changed,
        waiverId: row.id,
        metadata: {
          change: eventName === "payer.rvm_waiver_set" ? "set" : "cleared",
          scope: row.scope,
          payer_id: row.payerId,
          job_posting_id: row.jobPostingId,
          reason_text: reason,
          // #2778 — only when the new waiver has an end date, so an undated set's row is unchanged.
          ...(endsOn !== null ? { ends_on: endsOn } : {}),
        },
      });
    }
    const payload: PayloadInputOf<typeof eventName> = {
      waiver_id: row.id,
      payer_id: row.payerId,
      scope: row.scope,
      job_posting_id: row.jobPostingId,
      source: actor.kind,
    };
    await this.events.emit({
      event_name: eventName,
      actor:
        actor.kind === "admin"
          ? { actor_type: "admin", actor_id: actor.adminId }
          : { actor_type: "system", actor_id: null },
      subject: { subject_type: "payer", subject_id: row.payerId },
      payload,
      idempotencyKey: `${eventName}:${row.id}`,
      correlationId: ctx.correlationId,
      requestId: ctx.requestId,
      tx,
    });
  }

  private view(row: RvmWaiverWithUses): WaiverView {
    return {
      waiverId: row.id,
      scope: row.scope,
      companyId: row.payerId,
      postingId: row.jobPostingId,
      active: row.active,
      source: row.source,
      setByRef: row.setByRef,
      setByLabel: this.decryptLabel(row.setByLabelEnc, row.id),
      reason: row.reason,
      setAt: row.createdAt,
      clearedAt: row.clearedAt,
      clearedByRef: row.clearedByRef,
      clearedByLabel: this.decryptLabel(row.clearedByLabelEnc, row.id),
      clearReason: row.clearReason,
      waivedOpens: row.waivedOpens,
      endsOn: row.end?.endsOn ?? null,
      ended: row.end?.ended ?? false,
    };
  }

  /** A name that cannot be decrypted (a rotated key) shows as none, never as an error. */
  private decryptLabel(token: string | null, waiverId: string): string | null {
    if (token === null) return null;
    try {
      return this.crypto.decrypt(token);
    } catch {
      this.logger.warn(`waiver staff name could not be decrypted waiver=${waiverId}`);
      return null;
    }
  }

  private missingTableAs503(err: unknown): unknown {
    if (sqlStateOf(err) === UNDEFINED_TABLE) {
      this.logger.error(
        `rvm_applicant_waivers missing (sqlstate=${UNDEFINED_TABLE}); apply the waiver migration`,
      );
      return new ServiceUnavailableException();
    }
    return err;
  }
}
