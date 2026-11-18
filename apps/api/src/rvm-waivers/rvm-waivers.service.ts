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

        if (input.active) {
          if (live) return { row: live, active: true, changed: false };
          const row = await this.repo.insert(tx, {
            scope: input.scope,
            tenant,
            jobPostingId: postingId,
            source: who.source,
            setByRef: who.ref,
            setByLabelEnc: who.labelEnc,
            reason: input.reason,
          });
          await this.record(tx, "payer.rvm_waiver_set", row, input.actor, input.reason, ctx);
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

      const uses = out.row ? await this.repo.usesOf([out.row.id]) : new Map<string, number>();
      return {
        waiver: out.row ? this.view({ ...out.row, waivedOpens: uses.get(out.row.id) ?? 0 }) : null,
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
