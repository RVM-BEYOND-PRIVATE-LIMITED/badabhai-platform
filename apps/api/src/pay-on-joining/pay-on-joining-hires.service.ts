import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import type { ServerConfig } from "@badabhai/config";
import type { Database, PayOnJoiningHire } from "@badabhai/db";
import {
  POJ_HIRE_FIELDS,
  type PayloadInputOf,
  type PojHireField,
  type PojRecordChange,
} from "@badabhai/event-schema";
import { decodeEntityCursor, encodeEntityCursor } from "../admin/admin-entities.cursor";
import { ADMIN_ACTION_CODES, type AdminActionCode } from "../admin/admin-action-codes";
import type { AuthenticatedAdmin } from "../admin/admin-auth.guard";
import type { AdminPage } from "../admin/admin-entities.dto";
import { redactQueryParams, sqlStateOf } from "../common/db-error";
import type { RequestContext } from "../common/request-context";
import { SERVER_CONFIG } from "../config/config.module";
import { EventsService } from "../events/events.service";
import type {
  CreatePojHireDto,
  ListPojHiresQueryDto,
  PojHireView,
  PojHireWriteResult,
  UpdatePojHireDto,
} from "./pay-on-joining-hires.dto";
import {
  PayOnJoiningHiresRepository,
  type PojHireUpdate,
  type PojHireWrite,
} from "./pay-on-joining-hires.repository";
import { partnerSharePaise } from "./pay-on-joining.share";
import { paymentStateOf } from "./pay-on-joining.state";

/** The row column behind each field key an admin writes. */
const COLUMN_OF = {
  factory_payer_id: "factoryPayerId",
  job_posting_id: "jobPostingId",
  worker_id: "workerId",
  partner_payer_id: "partnerPayerId",
  joined_on: "joinedOn",
  stay_checked_on: "stayCheckedOn",
  stayed_30_days: "stayed30Days",
  fee_paise: "feePaise",
  invoiced_on: "invoicedOn",
  factory_paid_on: "factoryPaidOn",
  partner_paid_on: "partnerPaidOn",
  note: "note",
} as const satisfies Record<PojHireField, keyof PayOnJoiningHire>;

type HireFields = Pick<PayOnJoiningHire, (typeof COLUMN_OF)[PojHireField]>;

/** A foreign key a write can trip, by constraint name, and the field the admin should fix. */
const FIELD_OF_FOREIGN_KEY: Record<string, PojHireField> = {
  pay_on_joining_hires_factory_payer_id_payers_id_fk: "factory_payer_id",
  pay_on_joining_hires_partner_payer_id_payers_id_fk: "partner_payer_id",
  pay_on_joining_hires_job_posting_id_job_postings_id_fk: "job_posting_id",
  pay_on_joining_hires_worker_id_workers_id_fk: "worker_id",
};

/**
 * #2753 item 11 — the pay-on-joining pilot's hire record. RECORDS ONLY: no write here raises an
 * invoice, moves money, pays a partner or judges whether a factory qualifies (the owner picks the
 * pilot's factories by hand). Reached only through `PayOnJoiningFlagGuard`, so with
 * `PAY_ON_JOINING_RECORDS_ENABLED` off none of it runs.
 *
 * THE SHARE IS THE SERVER'S. On create the percent is COPIED from `POJ_PARTNER_SHARE_PERCENT` onto
 * the row and the share computed from it; on an edit that changes the fee the share is recomputed
 * with the percent STORED on the row, so moving the setting never rewrites a recorded hire. No
 * client field carries either (the bodies are `.strict()`).
 *
 * ONE TRANSACTION PER WRITE: the row, its `audit_logs` row, `pay_on_joining.recorded` and
 * `admin.action_performed` commit together or not at all. The events carry ids, paise integers and
 * closed values; the note never leaves the row, and a failed write's bound parameters (which hold
 * it) are stripped before the error can reach a log.
 */
@Injectable()
export class PayOnJoiningHiresService {
  constructor(
    private readonly repo: PayOnJoiningHiresRepository,
    private readonly events: EventsService,
    @Inject(SERVER_CONFIG) private readonly config: ServerConfig,
  ) {}

  /** GET — newest first, keyset paged; filter by factory, partner and payment state. */
  async list(dto: ListPojHiresQueryDto): Promise<AdminPage<PojHireView>> {
    const rows = await this.repo.list(
      {
        factoryPayerId: dto.factory_payer_id,
        partnerPayerId: dto.partner_payer_id,
        paid: dto.paid,
      },
      decodeEntityCursor(dto.cursor),
      dto.limit + 1,
    );
    const hasMore = rows.length > dto.limit;
    const page = hasMore ? rows.slice(0, dto.limit) : rows;
    const last = page[page.length - 1];
    return {
      items: page.map((row) => PayOnJoiningHiresService.view(row)),
      nextCursor:
        hasMore && last ? encodeEntityCursor({ createdAt: last.sortKey, id: last.id }) : null,
    };
  }

  /** POST — record one hire. The percent is the setting's, copied; the share is computed here. */
  async create(
    admin: AuthenticatedAdmin,
    dto: CreatePojHireDto,
    ctx: RequestContext,
  ): Promise<PojHireWriteResult> {
    const percent = this.config.POJ_PARTNER_SHARE_PERCENT;
    const values: PojHireWrite = {
      factoryPayerId: dto.factory_payer_id,
      jobPostingId: dto.job_posting_id ?? null,
      workerId: dto.worker_id,
      partnerPayerId: dto.partner_payer_id ?? null,
      joinedOn: dto.joined_on,
      stayCheckedOn: dto.stay_checked_on ?? null,
      stayed30Days: dto.stayed_30_days ?? null,
      feePaise: dto.fee_paise,
      partnerSharePercent: percent,
      partnerSharePaise: partnerSharePaise(dto.fee_paise, percent),
      invoicedOn: dto.invoiced_on ?? null,
      factoryPaidOn: dto.factory_paid_on ?? null,
      partnerPaidOn: dto.partner_paid_on ?? null,
      note: dto.note ?? null,
      createdByAdminId: admin.id,
      updatedByAdminId: admin.id,
    };
    PayOnJoiningHiresService.assertRecordRules(values as HireFields);
    // The keys the admin actually set (a key sent as null set nothing).
    const changedFields = POJ_HIRE_FIELDS.filter((key) => {
      const value = (dto as Record<string, unknown>)[key];
      return value !== undefined && value !== null;
    });

    const row = await this.write(() =>
      this.repo.withTransaction(async (tx) => {
        const inserted = await this.repo.insert(tx, values);
        await this.recordWrite(tx, admin, inserted, "created", changedFields, ctx);
        return inserted;
      }),
    );
    return { hire: PayOnJoiningHiresService.view(row), changed: true };
  }

  /**
   * PATCH — edit one hire under its row lock. Only the keys whose value MOVES count: an edit that
   * moves nothing writes, audits and emits nothing (`changed: false`). A fee change recomputes the
   * share with the row's STORED percent.
   */
  async update(
    admin: AuthenticatedAdmin,
    id: string,
    dto: UpdatePojHireDto,
    ctx: RequestContext,
  ): Promise<PojHireWriteResult> {
    return this.write(() =>
      this.repo.withTransaction(async (tx) => {
        const current = await this.repo.lockById(tx, id);
        if (!current) throw new NotFoundException("Hire record not found");

        const next: HireFields = { ...current };
        const set: PojHireUpdate = {};
        const changedFields: PojHireField[] = [];
        for (const key of POJ_HIRE_FIELDS) {
          const value = (dto as Record<string, unknown>)[key];
          if (value === undefined) continue;
          const column = COLUMN_OF[key];
          if (current[column] === value) continue;
          (next as Record<string, unknown>)[column] = value;
          (set as Record<string, unknown>)[column] = value;
          changedFields.push(key);
        }
        if (changedFields.length === 0) {
          return { hire: PayOnJoiningHiresService.view(current), changed: false };
        }

        PayOnJoiningHiresService.assertRecordRules(next);
        if (changedFields.includes("fee_paise")) {
          // The STORED percent, never today's setting: a recorded hire keeps its terms.
          set.partnerSharePaise = partnerSharePaise(next.feePaise, current.partnerSharePercent);
        }
        set.updatedByAdminId = admin.id;
        const updated = await this.repo.update(tx, id, set);
        await this.recordWrite(tx, admin, updated, "updated", changedFields, ctx);
        return { hire: PayOnJoiningHiresService.view(updated), changed: true };
      }),
    );
  }

  // ----- helpers ---------------------------------------------------------------

  /**
   * The rules a record must keep whatever the write. Integrity only — never eligibility, pricing
   * or a payment rule (the pilot is run by hand):
   *   - the 30-day check has a date and an outcome, or neither (also a DB CHECK);
   *   - a partner payment needs a partner (not a DB CHECK: the partner FK's SET NULL must stay
   *     able to clear the partner);
   *   - the factory cannot be its own partner.
   */
  private static assertRecordRules(row: HireFields): void {
    if ((row.stayCheckedOn === null) !== (row.stayed30Days === null)) {
      throw new BadRequestException(
        "stay_checked_on and stayed_30_days go together: set both, or clear both",
      );
    }
    if (row.partnerPaidOn !== null && row.partnerPayerId === null) {
      throw new BadRequestException("partner_paid_on needs a partner_payer_id");
    }
    if (row.partnerPayerId !== null && row.partnerPayerId === row.factoryPayerId) {
      throw new BadRequestException("partner_payer_id cannot be the factory itself");
    }
  }

  /**
   * The audit row and both events, on the write's own transaction. The audit and the action carry
   * the changed KEYS; the domain event carries the record's ids, money and state after the write.
   */
  private async recordWrite(
    tx: Database,
    admin: AuthenticatedAdmin,
    row: PayOnJoiningHire,
    change: PojRecordChange,
    changedFields: readonly PojHireField[],
    ctx: RequestContext,
  ): Promise<void> {
    const actionCode =
      change === "created"
        ? ADMIN_ACTION_CODES.pay_on_joining_hire_created
        : ADMIN_ACTION_CODES.pay_on_joining_hire_updated;
    await this.repo.writeAudit(tx, {
      adminId: admin.id,
      hireId: row.id,
      action: actionCode,
      changedFields,
    });
    const payload: PayloadInputOf<"pay_on_joining.recorded"> = {
      hire_id: row.id,
      change,
      changed_fields: [...changedFields],
      factory_payer_id: row.factoryPayerId,
      partner_payer_id: row.partnerPayerId,
      job_posting_id: row.jobPostingId,
      worker_id: row.workerId,
      fee_paise: row.feePaise,
      partner_share_percent: row.partnerSharePercent,
      partner_share_paise: row.partnerSharePaise,
      stayed_30_days: row.stayed30Days,
      payment_state: paymentStateOf(row),
    };
    await this.events.emit({
      event_name: "pay_on_joining.recorded",
      actor: { actor_type: "admin", actor_id: admin.id },
      subject: { subject_type: "payer", subject_id: row.factoryPayerId },
      payload,
      correlationId: ctx.correlationId,
      requestId: ctx.requestId,
      // The change kind is part of the key, so a create and an edit sharing one request id are
      // still two events (the action's key carries its code for the same reason).
      idempotencyKey: `pay_on_joining.recorded:${change}:${row.id}:${ctx.requestId}`,
      tx,
    });
    await this.emitAction(tx, admin.id, actionCode, row, ctx);
  }

  private emitAction(
    tx: Database,
    adminId: string,
    actionCode: AdminActionCode,
    row: PayOnJoiningHire,
    ctx: RequestContext,
  ): Promise<unknown> {
    const payload: PayloadInputOf<"admin.action_performed"> = {
      admin_id: adminId,
      action_code: actionCode,
      target_type: "pay_on_joining_hire",
      target_id: row.id,
    };
    return this.events.emit({
      event_name: "admin.action_performed",
      actor: { actor_type: "admin", actor_id: adminId },
      subject: { subject_type: "payer", subject_id: row.factoryPayerId },
      payload,
      correlationId: ctx.correlationId,
      requestId: ctx.requestId,
      idempotencyKey: `admin_action:${actionCode}:${adminId}:${row.id}:${ctx.requestId}`,
      tx,
    });
  }

  /**
   * Run a write and translate what the database refused into the admin's answer:
   *   23505 on the hire key → 409; 23503 → 400 naming the field whose id names nothing;
   *   23514 → 400. Anything else is rethrown with its bound parameters stripped, because they are
   * the row being written and the row carries the admin's note.
   */
  private async write<T>(run: () => Promise<T>): Promise<T> {
    try {
      return await run();
    } catch (err) {
      const code = sqlStateOf(err);
      const constraint = PayOnJoiningHiresService.constraintOf(err);
      if (code === "23505" && constraint === "pay_on_joining_hires_hire_uq") {
        throw new ConflictException(
          "This hire is already recorded for this factory, worker and job",
        );
      }
      if (code === "23503") {
        const field = constraint === undefined ? undefined : FIELD_OF_FOREIGN_KEY[constraint];
        throw new BadRequestException(
          field === undefined ? "A referenced id does not exist" : `${field} names no record`,
        );
      }
      if (code === "23514") {
        throw new BadRequestException("The record breaks one of its rules");
      }
      throw redactQueryParams(err, "pay-on-joining hire write");
    }
  }

  /** The violated constraint's name, from the driver error under drizzle's wrapper. */
  private static constraintOf(err: unknown): string | undefined {
    for (const candidate of [err, (err as { cause?: unknown } | null)?.cause]) {
      const name = (candidate as { constraint_name?: unknown } | null | undefined)?.constraint_name;
      if (typeof name === "string") return name;
    }
    return undefined;
  }

  static view(row: PayOnJoiningHire): PojHireView {
    return {
      id: row.id,
      factory_payer_id: row.factoryPayerId,
      job_posting_id: row.jobPostingId,
      worker_id: row.workerId,
      partner_payer_id: row.partnerPayerId,
      joined_on: row.joinedOn,
      stay_checked_on: row.stayCheckedOn,
      stayed_30_days: row.stayed30Days,
      fee_paise: row.feePaise,
      partner_share_percent: row.partnerSharePercent,
      partner_share_paise: row.partnerSharePaise,
      invoiced_on: row.invoicedOn,
      factory_paid_on: row.factoryPaidOn,
      partner_paid_on: row.partnerPaidOn,
      note: row.note,
      payment_state: paymentStateOf(row),
      created_by_admin_id: row.createdByAdminId,
      updated_by_admin_id: row.updatedByAdminId,
      created_at: row.createdAt,
      updated_at: row.updatedAt,
    };
  }
}
