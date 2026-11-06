import { Inject, Injectable } from "@nestjs/common";
import { and, desc, eq, inArray, isNull } from "drizzle-orm";
import {
  skills,
  workerAdminOverrides,
  workerAttributes,
  workers,
  type Database,
  type WorkerAdminOverrideFactKey,
} from "@badabhai/db";
import { DATABASE } from "../../database/database.module";

type WorkerAdminOverride = typeof workerAdminOverrides.$inferSelect;

/** One row as the admin history read needs it — metadata only, never the decrypted value. */
export type AdminCorrectionRow = Pick<
  WorkerAdminOverride,
  | "id"
  | "workerId"
  | "factKey"
  | "adminId"
  | "reasonCode"
  | "reasonText"
  | "createdAt"
  | "supersededAt"
  | "supersededById"
>;

/**
 * #2561 — data access for the admin correction layer (ADR-0062 §3.1). The REPLACEMENT rule is
 * the database's: a partial unique index allows one live row per (worker, fact), so a
 * re-correction supersedes the live row and inserts its replacement in one transaction.
 */
@Injectable()
export class AdminCorrectionsRepository {
  constructor(@Inject(DATABASE) private readonly db: Database) {}

  withTransaction<T>(work: (tx: Database) => Promise<T>): Promise<T> {
    return this.db.transaction(work as (tx: unknown) => Promise<T>);
  }

  /** The live correction of one fact, locked for a correction/revert. */
  async findLive(
    tx: Database,
    workerId: string,
    factKey: WorkerAdminOverrideFactKey,
  ): Promise<WorkerAdminOverride | undefined> {
    const [row] = await tx
      .select()
      .from(workerAdminOverrides)
      .where(
        and(
          eq(workerAdminOverrides.workerId, workerId),
          eq(workerAdminOverrides.factKey, factKey),
          isNull(workerAdminOverrides.supersededAt),
        ),
      )
      .for("update")
      .limit(1);
    return row;
  }

  /** The base (non-admin) city, for the FIRST correction's `previous`. */
  async baseCity(tx: Database, workerId: string): Promise<string | null> {
    const [row] = await tx
      .select({ city: workers.currentCity })
      .from(workers)
      .where(eq(workers.id, workerId))
      .limit(1);
    return row?.city ?? null;
  }

  /** The base (non-admin) preferred-locations attribute, for the FIRST correction's `previous`. */
  async basePreferredLocations(tx: Database, workerId: string): Promise<string[]> {
    const [row] = await tx
      .select({ value: workerAttributes.valueTextList })
      .from(workerAttributes)
      .where(
        and(
          eq(workerAttributes.workerId, workerId),
          eq(workerAttributes.attributeKey, "preferred_locations"),
        ),
      )
      .limit(1);
    return Array.isArray(row?.value) ? row.value : [];
  }

  /**
   * The subset of `ids` that exist in the closed skill vocabulary. The admin correction must
   * reject an unknown id with a 400 BEFORE it deletes the old authored rows; letting the FK
   * fire would roll the transaction back with a 500 and a constraint name.
   */
  async existingSkillIds(tx: Database, ids: readonly string[]): Promise<string[]> {
    if (ids.length === 0) return [];
    const rows = await tx
      .select({ skillId: skills.skillId })
      .from(skills)
      .where(inArray(skills.skillId, [...ids]));
    return rows.map((row) => row.skillId);
  }

  async insert(
    tx: Database,
    input: {
      id: string;
      workerId: string;
      factKey: WorkerAdminOverrideFactKey;
      valueEnc: string;
      adminId: string;
      reasonCode: string;
      reasonText: string;
    },
  ): Promise<void> {
    await tx.insert(workerAdminOverrides).values(input);
  }

  /** Mark one row superseded. `supersededById` NULL means a revert or a worker self-edit. */
  async supersede(
    tx: Database,
    id: string,
    supersededById: string | null,
  ): Promise<void> {
    await tx
      .update(workerAdminOverrides)
      .set({ supersededAt: new Date(), supersededById })
      .where(eq(workerAdminOverrides.id, id));
  }

  /**
   * Point an ALREADY-superseded row at its replacement. Split from {@link supersede} because the
   * replacement does not exist yet when the live slot has to be freed: the unique index admits
   * one live row, and the self-FK needs the new id to exist. Order: free → insert → link.
   */
  async linkSupersededBy(tx: Database, id: string, replacementId: string): Promise<void> {
    await tx
      .update(workerAdminOverrides)
      .set({ supersededById: replacementId })
      .where(eq(workerAdminOverrides.id, id));
  }

  /** One worker's correction history, newest first (the reasons stay human-readable). */
  async history(workerId: string): Promise<AdminCorrectionRow[]> {
    return this.db
      .select({
        id: workerAdminOverrides.id,
        workerId: workerAdminOverrides.workerId,
        factKey: workerAdminOverrides.factKey,
        adminId: workerAdminOverrides.adminId,
        reasonCode: workerAdminOverrides.reasonCode,
        reasonText: workerAdminOverrides.reasonText,
        createdAt: workerAdminOverrides.createdAt,
        supersededAt: workerAdminOverrides.supersededAt,
        supersededById: workerAdminOverrides.supersededById,
      })
      .from(workerAdminOverrides)
      .where(eq(workerAdminOverrides.workerId, workerId))
      .orderBy(desc(workerAdminOverrides.createdAt), desc(workerAdminOverrides.id));
  }
}
