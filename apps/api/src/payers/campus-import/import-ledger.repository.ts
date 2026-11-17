/**
 * #2754 item 4 — the import ledger: `company_import_batches` and `company_import_rows`.
 *
 * Every write the import makes to BadaBhai is recorded here IN THE SAME TRANSACTION, so the ledger
 * and the data cannot disagree: a company either has its row and its account, or neither.
 *
 * IDEMPOTENCE. `company_import_rows` is unique on (source system, kind, source id) across batches.
 * A record whose row says `created` or `matched` is done and is never touched again by a later
 * run; a record that was `held`, `skipped`, `exception` or `rolled_back` may be tried again, and
 * its row is updated in place (the batch that last tried it owns it).
 */
import { and, eq, sql } from "drizzle-orm";
import {
  companyImportBatches,
  companyImportRows,
  type CompanyImportRowKind,
  type CompanyImportRowState,
  type Database,
} from "@badabhai/db";

export const CAMPUS_SOURCE = "campus" as const;

/** States after which a record is finished: a later run leaves it alone. */
export const FINISHED_STATES: ReadonlySet<CompanyImportRowState> = new Set(["created", "matched"]);

export interface BatchIdentity {
  batchKey: string;
  bundleFormat: string;
  bundleVersion: number;
  bundleGeneratedAt: Date;
  manifestSha256: string;
  isTest: boolean;
  runBy: string;
  manifestCounts: Record<string, unknown>;
}

export interface OpenBatch {
  id: string;
  batchKey: string;
  isTest: boolean;
  resumed: boolean;
}

export interface LedgerRow {
  id: string;
  batchId: string;
  state: CompanyImportRowState;
  targetId: string | null;
  reason: string | null;
}

export interface LedgerWrite {
  batchId: string;
  kind: CompanyImportRowKind;
  sourceId: string;
  companySourceId: string | null;
  state: CompanyImportRowState;
  targetId: string | null;
  reason: string | null;
  /** Ids, counts and codes only. Never a name, phone, email or GSTIN. */
  detail: Record<string, unknown>;
}

export class CampusImportRefusal extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CampusImportRefusal";
  }
}

/** True when migration `company_import` is applied. The CLI refuses `--apply` without it. */
export async function importLedgerExists(db: Database): Promise<boolean> {
  const rows = (await db.execute(sql`
    SELECT to_regclass('public.company_import_batches') IS NOT NULL
       AND to_regclass('public.company_import_rows') IS NOT NULL AS ok`)) as unknown as {
    ok: boolean;
  }[];
  return rows[0]?.ok === true;
}

/**
 * Open the named batch, or resume it. Resuming is allowed only for the SAME bundle (same manifest
 * sha256) and the same test flag, and never for a batch that was rolled back: a rolled-back key is
 * spent, so a new run needs a new key.
 */
export async function openBatch(db: Database, identity: BatchIdentity): Promise<OpenBatch> {
  return db.transaction(async (raw) => {
    const tx = raw as unknown as Database;
    const inserted = await tx
      .insert(companyImportBatches)
      .values({
        batchKey: identity.batchKey,
        sourceSystem: CAMPUS_SOURCE,
        bundleFormat: identity.bundleFormat,
        bundleVersion: identity.bundleVersion,
        bundleGeneratedAt: identity.bundleGeneratedAt,
        manifestSha256: identity.manifestSha256,
        isTest: identity.isTest,
        runBy: identity.runBy,
        manifestCounts: identity.manifestCounts,
      })
      .onConflictDoNothing({ target: companyImportBatches.batchKey })
      .returning({ id: companyImportBatches.id });
    if (inserted[0]) {
      return { id: inserted[0].id, batchKey: identity.batchKey, isTest: identity.isTest, resumed: false };
    }
    const [existing] = await tx
      .select({
        id: companyImportBatches.id,
        manifestSha256: companyImportBatches.manifestSha256,
        isTest: companyImportBatches.isTest,
        state: companyImportBatches.state,
      })
      .from(companyImportBatches)
      .where(eq(companyImportBatches.batchKey, identity.batchKey))
      .limit(1);
    if (!existing) throw new Error("batch insert hit a conflict but no row was found");
    if (existing.state === "rolled_back") {
      throw new CampusImportRefusal(
        `batch ${identity.batchKey} was rolled back; run again under a new --batch key`,
      );
    }
    if (existing.manifestSha256 !== identity.manifestSha256) {
      throw new CampusImportRefusal(
        `batch ${identity.batchKey} was opened with another bundle; use a new --batch key`,
      );
    }
    if (existing.isTest !== identity.isTest) {
      throw new CampusImportRefusal(
        `batch ${identity.batchKey} was opened ${existing.isTest ? "with" : "without"} --test; keep the same flag`,
      );
    }
    return { id: existing.id, batchKey: identity.batchKey, isTest: existing.isTest, resumed: true };
  });
}

/** Mark the batch applied once every record has been tried. */
export async function markBatchApplied(db: Database, batchId: string): Promise<void> {
  await db
    .update(companyImportBatches)
    .set({ state: "applied", appliedAt: new Date() })
    .where(and(eq(companyImportBatches.id, batchId), eq(companyImportBatches.state, "applying")));
}

/**
 * The ledger row of one source record, LOCKED for the rest of `tx`, so two runs of the same batch
 * (two terminals by mistake) cannot both write the same company.
 */
export async function lockRow(
  tx: Database,
  kind: CompanyImportRowKind,
  sourceId: string,
): Promise<LedgerRow | undefined> {
  const [row] = await tx
    .select({
      id: companyImportRows.id,
      batchId: companyImportRows.batchId,
      state: companyImportRows.state,
      targetId: companyImportRows.targetId,
      reason: companyImportRows.reason,
    })
    .from(companyImportRows)
    .where(
      and(
        eq(companyImportRows.sourceSystem, CAMPUS_SOURCE),
        eq(companyImportRows.kind, kind),
        eq(companyImportRows.sourceId, sourceId),
      ),
    )
    .for("update")
    .limit(1);
  return row;
}

/**
 * Write the outcome of one source record. A finished row (`created`, `matched`) is never
 * overwritten: the update's WHERE refuses it, and the caller has already skipped it under the lock.
 */
export async function writeRow(tx: Database, write: LedgerWrite): Promise<void> {
  const now = new Date();
  await tx
    .insert(companyImportRows)
    .values({
      batchId: write.batchId,
      sourceSystem: CAMPUS_SOURCE,
      kind: write.kind,
      sourceId: write.sourceId,
      companySourceId: write.companySourceId,
      targetId: write.targetId,
      state: write.state,
      reason: write.reason,
      detail: write.detail,
    })
    .onConflictDoUpdate({
      target: [companyImportRows.sourceSystem, companyImportRows.kind, companyImportRows.sourceId],
      set: {
        batchId: write.batchId,
        companySourceId: write.companySourceId,
        targetId: write.targetId,
        state: write.state,
        reason: write.reason,
        detail: write.detail,
        updatedAt: now,
      },
      setWhere: sql`${companyImportRows.state} NOT IN ('created', 'matched')`,
    });
}
