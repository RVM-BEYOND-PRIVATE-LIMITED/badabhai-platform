import { Inject, Injectable } from "@nestjs/common";
import { and, eq, inArray, isNull } from "drizzle-orm";
import {
  workerAdminOverrides,
  type Database,
  type WorkerAdminOverrideFactKey,
} from "@badabhai/db";
import { DATABASE } from "../database/database.module";
import { PiiCryptoService } from "../common/pii-crypto.service";
import { EventsService } from "../events/events.service";
import type { RequestContext } from "../common/request-context";

/** The encrypted `{corrected, previous}` envelope (ADR-0062 §3.1). */
export interface CorrectionEnvelope {
  corrected: unknown;
  previous: unknown;
}

export interface LiveCorrection {
  id: string;
  factKey: WorkerAdminOverrideFactKey;
  adminId: string;
  reasonCode: string;
  reasonText: string;
  createdAt: Date;
  corrected: unknown;
}

/**
 * #2561 — the READ side of the correction layer, and the worker-self-edit supersede.
 *
 * It lives in the `@Global` WorkersModule (not the admin module) because the four application
 * points — the worker summary, the payer candidate projection, the résumé inputs and the
 * candidate read-table projector — must read it without importing the admin surface, and the
 * worker edit paths must supersede a correction inside their OWN transaction. The WRITE side
 * (create/revert with a reason, audit and admin action) is `AdminCorrectionService`, which uses
 * this same store.
 */
@Injectable()
export class EffectiveFactsService {
  constructor(
    @Inject(DATABASE) private readonly db: Database,
    private readonly pii: PiiCryptoService,
    private readonly events: EventsService,
  ) {}

  /** Decrypt one stored envelope. Throws on a malformed token — never serves a half value. */
  private envelope(token: string): CorrectionEnvelope {
    const parsed = JSON.parse(this.pii.decrypt(token)) as unknown;
    if (typeof parsed !== "object" || parsed === null) {
      throw new Error("admin correction envelope is not an object");
    }
    const env = parsed as { corrected?: unknown; previous?: unknown };
    if (!("corrected" in env)) throw new Error("admin correction envelope has no corrected value");
    return { corrected: env.corrected, previous: env.previous ?? null };
  }

  /** The live correction of every fact for one worker, corrected value only. */
  async resolve(workerId: string): Promise<ReadonlyMap<WorkerAdminOverrideFactKey, unknown>> {
    const rows = await this.db
      .select({
        factKey: workerAdminOverrides.factKey,
        valueEnc: workerAdminOverrides.valueEnc,
      })
      .from(workerAdminOverrides)
      .where(
        and(
          eq(workerAdminOverrides.workerId, workerId),
          isNull(workerAdminOverrides.supersededAt),
        ),
      );
    const out = new Map<WorkerAdminOverrideFactKey, unknown>();
    for (const row of rows) out.set(row.factKey, this.envelope(row.valueEnc).corrected);
    return out;
  }

  /** Batch form for a list read (one query, no N+1). */
  async resolveMany(
    workerIds: readonly string[],
  ): Promise<ReadonlyMap<string, ReadonlyMap<WorkerAdminOverrideFactKey, unknown>>> {
    const out = new Map<string, Map<WorkerAdminOverrideFactKey, unknown>>();
    if (workerIds.length === 0) return out;
    const rows = await this.db
      .select({
        workerId: workerAdminOverrides.workerId,
        factKey: workerAdminOverrides.factKey,
        valueEnc: workerAdminOverrides.valueEnc,
      })
      .from(workerAdminOverrides)
      .where(
        and(
          inArray(workerAdminOverrides.workerId, [...workerIds]),
          isNull(workerAdminOverrides.supersededAt),
        ),
      );
    for (const row of rows) {
      const map = out.get(row.workerId) ?? new Map();
      map.set(row.factKey, this.envelope(row.valueEnc).corrected);
      out.set(row.workerId, map);
    }
    return out;
  }

  /** Every live correction's metadata for one worker (no decrypted value leaves this method). */
  async liveFor(workerId: string): Promise<LiveCorrection[]> {
    const rows = await this.db
      .select()
      .from(workerAdminOverrides)
      .where(
        and(
          eq(workerAdminOverrides.workerId, workerId),
          isNull(workerAdminOverrides.supersededAt),
        ),
      );
    return rows.map((row) => ({
      id: row.id,
      factKey: row.factKey,
      adminId: row.adminId,
      reasonCode: row.reasonCode,
      reasonText: row.reasonText,
      createdAt: row.createdAt,
      corrected: this.envelope(row.valueEnc).corrected,
    }));
  }

  /**
   * OWNER RULING A1 — a worker's OWN explicit edit supersedes the live correction for the same
   * fact, in the same transaction as that edit. Marks each live row superseded by none (a
   * supersede, not a revert) and emits `worker.admin_correction_superseded` per row. Interview
   * extraction, form inference, résumé import and `ai_service` writes NEVER call this.
   */
  async supersedeByWorkerEdit(
    workerId: string,
    factKeys: readonly WorkerAdminOverrideFactKey[],
    opts: { tx: Database; ctx: RequestContext },
  ): Promise<void> {
    const keys = [...new Set(factKeys)];
    if (keys.length === 0) return;
    const rows = await opts.tx
      .update(workerAdminOverrides)
      .set({ supersededAt: new Date(), supersededById: null })
      .where(
        and(
          eq(workerAdminOverrides.workerId, workerId),
          inArray(workerAdminOverrides.factKey, keys),
          isNull(workerAdminOverrides.supersededAt),
        ),
      )
      .returning({ id: workerAdminOverrides.id, factKey: workerAdminOverrides.factKey });
    for (const row of rows) {
      await this.events.emit({
        event_name: "worker.admin_correction_superseded",
        actor: { actor_type: "worker", actor_id: workerId },
        subject: { subject_type: "worker", subject_id: workerId },
        payload: { worker_id: workerId, fact_key: row.factKey, override_id: row.id },
        correlationId: opts.ctx.correlationId,
        requestId: opts.ctx.requestId,
        idempotencyKey: `worker.admin_correction_superseded:${row.id}`,
        tx: opts.tx,
      });
    }
  }
}
