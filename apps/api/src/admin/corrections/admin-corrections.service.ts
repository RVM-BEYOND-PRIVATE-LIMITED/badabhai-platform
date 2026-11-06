import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import { randomUUID } from "node:crypto";
import type { Database, WorkerAdminOverrideFactKey } from "@badabhai/db";
import type { PayloadInputOf } from "@badabhai/event-schema";
import type { RequestContext } from "../../common/request-context";
import { PiiCryptoService } from "../../common/pii-crypto.service";
import { EventsService } from "../../events/events.service";
import { WorkersRepository } from "../../workers/workers.repository";
import { WorkersService } from "../../workers/workers.service";
import { WorkerPreferencesService } from "../../profiles/worker-preferences.service";
import type { AuthenticatedAdmin } from "../admin-auth.guard";
import { ADMIN_ACTION_CODES, type AdminActionCode } from "../admin-action-codes";
import { AdminActionsRepository } from "../admin-actions.repository";
import { AdminCorrectionsRepository } from "./admin-corrections.repository";
import { AdminCorrectionEffectsService } from "./admin-correction-effects.service";
import { AdminCorrectionFactsService } from "./admin-correction-facts.service";
import {
  correctionValueSchema,
  isCorrectableFact,
  isLockedField,
  type AdminCorrectionCreateDto,
  type AdminCorrectionHistoryItem,
  type AdminCorrectionResult,
  type AdminCorrectionRevertDto,
} from "./admin-corrections.dto";

/** The `{corrected, previous}` envelope (ADR-0062 §3.1), encrypted as ONE token. */
interface CorrectionEnvelope {
  corrected: unknown;
  previous: unknown;
}

/**
 * #2561 — the ADMIN CORRECTION layer (ADR-0062 §3.1–§3.4).
 *
 * One correction = one transaction containing: the override row (with the `{corrected,
 * previous}` envelope encrypted), the EXISTING domain writer for the field, the written reason on
 * `audit_logs`, one `admin.action_performed`, and the `admin.candidate_field_corrected` event.
 * A revert writes `previous` back through the same writer, marks the row superseded with
 * `superseded_by = NULL`, and emits the revert event. A re-correction keeps the ORIGINAL
 * `previous` (the last non-admin value) and points the old row at its replacement.
 *
 * PR 1 exposes the LOCATION group only; the value switch is intentionally small and PR 2 widens
 * it per field group. A key outside the group is refused by the DTO; a locked field is refused
 * with a named 400 before any write.
 */
@Injectable()
export class AdminCorrectionService {
  constructor(
    private readonly repo: AdminCorrectionsRepository,
    private readonly actions: AdminActionsRepository,
    private readonly workers: WorkersRepository,
    private readonly workerService: WorkersService,
    private readonly preferences: WorkerPreferencesService,
    private readonly pii: PiiCryptoService,
    private readonly events: EventsService,
    // #2561 PR 2 — the per-field domain writers and previous-value readers.
    private readonly facts: AdminCorrectionFactsService,
    // #2561 PR 3 — the after-save effects (read table, matching, résumé, push).
    private readonly effects: AdminCorrectionEffectsService,
  ) {}

  /** POST /admin/candidates/:id/corrections */
  async correct(
    admin: AuthenticatedAdmin,
    workerId: string,
    dto: AdminCorrectionCreateDto,
    ctx: RequestContext,
  ): Promise<AdminCorrectionResult> {
    this.assertEditable(dto.fact_key);
    const factKey = dto.fact_key as WorkerAdminOverrideFactKey;
    const value = this.parseValue(dto.fact_key, dto.value);

    const worker = await this.workers.findById(workerId);
    if (!worker) throw new NotFoundException("Worker not found");

    const overrideId = randomUUID();
    let changed = false;
    let sourceEventId = "";
    await this.repo.withTransaction(async (tx) => {
      const live = await this.repo.findLive(tx, workerId, factKey);
      // Re-correcting keeps the ORIGINAL previous (the last non-admin value): a later
      // correction must not make revert restore another admin's correction.
      const previous =
        live === undefined
          ? await this.baseValue(tx, workerId, dto.fact_key)
          : this.envelope(live.valueEnc).previous;

      const envelope: CorrectionEnvelope = { corrected: value, previous };
      await this.writeDomain(dto.fact_key, workerId, value, tx, ctx, false, overrideId);
      // FREE the live slot first: the partial unique index admits one live row, and the
      // self-FK cannot point at the replacement until that row exists. Link it after insert.
      if (live !== undefined) await this.repo.supersede(tx, live.id, null);
      await this.repo.insert(tx, {
        id: overrideId,
        workerId,
        factKey,
        valueEnc: this.pii.encrypt(JSON.stringify(envelope)),
        adminId: admin.id,
        reasonCode: dto.reason_code,
        reasonText: dto.reason_text,
      });
      if (live !== undefined) await this.repo.linkSupersededBy(tx, live.id, overrideId);
      await this.writeAudit(tx, admin.id, workerId, ADMIN_ACTION_CODES.candidate_field_corrected, dto);
      sourceEventId = await this.emitCorrected(
        tx,
        admin.id,
        workerId,
        dto.fact_key,
        overrideId,
        ctx,
      );
      changed = true;
    });
    // AFTER COMMIT — the store is corrected; the derived surfaces converge best-effort.
    if (changed) {
      await this.effects.afterCorrection({
        workerId,
        factKey,
        eventName: "admin.candidate_field_corrected",
        sourceEventId,
        ctx,
      });
    }
    return { worker_id: workerId, fact_key: dto.fact_key, override_id: overrideId, changed };
  }

  /** POST /admin/candidates/:id/corrections/:factKey/revert */
  async revert(
    admin: AuthenticatedAdmin,
    workerId: string,
    factKeyRaw: string,
    dto: AdminCorrectionRevertDto,
    ctx: RequestContext,
  ): Promise<AdminCorrectionResult> {
    this.assertEditable(factKeyRaw);
    const factKey = factKeyRaw as WorkerAdminOverrideFactKey;
    const worker = await this.workers.findById(workerId);
    if (!worker) throw new NotFoundException("Worker not found");

    let overrideId = "";
    let changed = false;
    let sourceEventId = "";
    await this.repo.withTransaction(async (tx) => {
      const live = await this.repo.findLive(tx, workerId, factKey);
      if (live === undefined) return;
      const previous = this.envelope(live.valueEnc).previous;
      await this.writeDomain(factKey, workerId, previous, tx, ctx, true, live.id);
      await this.repo.supersede(tx, live.id, null);
      await this.writeAudit(tx, admin.id, workerId, ADMIN_ACTION_CODES.candidate_field_reverted, dto);
      sourceEventId = await this.emitReverted(tx, admin.id, workerId, factKey, live.id, ctx);
      overrideId = live.id;
      changed = true;
    });
    if (!changed) {
      throw new ConflictException("No live correction to revert for this field");
    }
    await this.effects.afterCorrection({
      workerId,
      factKey,
      eventName: "admin.candidate_field_reverted",
      sourceEventId,
      ctx,
    });
    return { worker_id: workerId, fact_key: factKey, override_id: overrideId, changed };
  }

  /** GET /admin/candidates/:id/corrections — metadata only, never a corrected value. */
  async history(
    workerId: string,
  ): Promise<{ worker_id: string; items: AdminCorrectionHistoryItem[] }> {
    const worker = await this.workers.findById(workerId);
    if (!worker) throw new NotFoundException("Worker not found");
    const rows = await this.repo.history(workerId);
    return {
      worker_id: workerId,
      items: rows.map((row) => ({
        override_id: row.id,
        fact_key: row.factKey,
        admin_id: row.adminId,
        reason_code: row.reasonCode,
        reason_text: row.reasonText,
        created_at: row.createdAt,
        superseded_at: row.supersededAt,
        superseded_by_id: row.supersededById,
        live: row.supersededAt === null,
      })),
    };
  }

  private assertEditable(factKey: string): void {
    if (isLockedField(factKey)) {
      throw new BadRequestException(
        "This field cannot be edited through the correction layer (locked)",
      );
    }
    if (!isCorrectableFact(factKey)) {
      throw new BadRequestException("This field is not open for correction yet");
    }
  }

  private parseValue(factKey: string, value: unknown): unknown {
    const parsed = correctionValueSchema(factKey as Parameters<typeof correctionValueSchema>[0]).safeParse(value);
    if (!parsed.success) {
      throw new BadRequestException(
        `Invalid value for ${factKey}: ${parsed.error.issues.map((i) => i.message).join("; ")}`,
      );
    }
    return parsed.data;
  }

  private envelope(token: string): CorrectionEnvelope {
    const env = JSON.parse(this.pii.decrypt(token)) as CorrectionEnvelope;
    return { corrected: env.corrected, previous: env.previous ?? null };
  }

  private async baseValue(
    tx: Database,
    workerId: string,
    factKey: string,
  ): Promise<unknown> {
    switch (factKey) {
      case "current_city":
        return this.repo.baseCity(tx, workerId);
      case "preferred_locations":
        return this.repo.basePreferredLocations(tx, workerId);
      default:
        if (!isCorrectableFact(factKey)) {
          throw new BadRequestException("This field is not open for correction yet");
        }
        return this.facts.readPrevious(
          tx,
          workerId,
          factKey as WorkerAdminOverrideFactKey,
        );
    }
  }

  /**
   * Write the value through the SAME writer the worker path uses. `source: "admin_correction"`
   * tells the writer NOT to supersede the override this transaction is creating. A revert of a
   * city that had no value clears it through the repository (the writer only sets a value).
   */
  private async writeDomain(
    factKey: string,
    workerId: string,
    value: unknown,
    tx: Database,
    ctx: RequestContext,
    reverting: boolean,
    overrideId: string,
  ): Promise<void> {
    switch (factKey) {
      case "current_city": {
        if (typeof value === "string") {
          await this.workerService.setLocation(workerId, { city: value }, ctx, {
            tx,
            source: "admin_correction",
          });
          return;
        }
        if (value === null) {
          await this.workers.updateLocation(workerId, { currentCity: null }, tx);
          return;
        }
        throw new BadRequestException("A city correction must be a city name");
      }
      case "preferred_locations": {
        if (!Array.isArray(value) || value.some((v) => typeof v !== "string")) {
          throw new BadRequestException("A preferred-locations correction must be a city list");
        }
        await this.preferences.setForWorker(
          workerId,
          // `touched_only` disables the old-build default skip: an admin's explicit list —
          // including an empty one on revert — is an ANSWER, never an untouched default.
          { preferred_cities: value as string[], touched_only: true },
          ctx,
          { tx, source: "admin_correction" },
        );
        return;
      }
      default:
        void reverting;
        if (!isCorrectableFact(factKey)) {
          throw new BadRequestException("This field is not open for correction yet");
        }
        await this.facts.write(
          tx,
          ctx,
          workerId,
          factKey as WorkerAdminOverrideFactKey,
          value,
          overrideId,
        );
    }
  }

  private writeAudit(
    tx: Database,
    adminId: string,
    workerId: string,
    action: AdminActionCode,
    dto: { reason_code: string; reason_text: string },
  ): Promise<void> {
    return this.actions.writeAuditReason(tx, {
      adminId,
      workerId,
      action,
      reasonCode: dto.reason_code,
      reasonText: dto.reason_text,
    });
  }

  private async emitCorrected(
    tx: Database,
    adminId: string,
    workerId: string,
    factKey: string,
    overrideId: string,
    ctx: RequestContext,
  ): Promise<string> {
    const payload: PayloadInputOf<"admin.candidate_field_corrected"> = {
      admin_id: adminId,
      worker_id: workerId,
      fact_key: factKey as never,
      override_id: overrideId,
    };
    const event = await this.events.emit({
      event_name: "admin.candidate_field_corrected",
      actor: { actor_type: "admin", actor_id: adminId },
      subject: { subject_type: "worker", subject_id: workerId },
      payload,
      correlationId: ctx.correlationId,
      requestId: ctx.requestId,
      idempotencyKey: `admin.candidate_field_corrected:${overrideId}`,
      tx,
    });
    await this.emitAction(
      tx,
      adminId,
      workerId,
      ADMIN_ACTION_CODES.candidate_field_corrected,
      ctx,
    );
    return event.event_id;
  }

  private async emitReverted(
    tx: Database,
    adminId: string,
    workerId: string,
    factKey: string,
    overrideId: string,
    ctx: RequestContext,
  ): Promise<string> {
    const payload: PayloadInputOf<"admin.candidate_field_reverted"> = {
      admin_id: adminId,
      worker_id: workerId,
      fact_key: factKey as never,
      override_id: overrideId,
    };
    const event = await this.events.emit({
      event_name: "admin.candidate_field_reverted",
      actor: { actor_type: "admin", actor_id: adminId },
      subject: { subject_type: "worker", subject_id: workerId },
      payload,
      correlationId: ctx.correlationId,
      requestId: ctx.requestId,
      idempotencyKey: `admin.candidate_field_reverted:${overrideId}`,
      tx,
    });
    await this.emitAction(tx, adminId, workerId, ADMIN_ACTION_CODES.candidate_field_reverted, ctx);
    return event.event_id;
  }

  private emitAction(
    tx: Database,
    adminId: string,
    workerId: string,
    actionCode: AdminActionCode,
    ctx: RequestContext,
  ): Promise<unknown> {
    return this.events.emit({
      event_name: "admin.action_performed",
      actor: { actor_type: "admin", actor_id: adminId },
      subject: { subject_type: "worker", subject_id: workerId },
      payload: {
        admin_id: adminId,
        action_code: actionCode,
        target_type: "worker",
        target_id: workerId,
      } satisfies PayloadInputOf<"admin.action_performed">,
      correlationId: ctx.correlationId,
      requestId: ctx.requestId,
      idempotencyKey: `admin_action:${actionCode}:${adminId}:${workerId}:${ctx.requestId}`,
      tx,
    });
  }
}
