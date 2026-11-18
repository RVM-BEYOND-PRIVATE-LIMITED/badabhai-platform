import { Inject, Injectable } from "@nestjs/common";
import { and, desc, eq, lt, or, type SQL } from "drizzle-orm";
import { hires, type Database } from "@badabhai/db";
import type { ApplicantPostingKind, HireStatus } from "@badabhai/types";
import { DATABASE } from "../database/database.module";
import type { EntityCursor } from "../admin/admin-entities.cursor";
import type { TenantKey } from "../payers/payer-tenant-scope";
import type { HireState } from "./hire-state";

/**
 * One hire record's key: the company (its TENANT key, as the stage board resolves it), the worker
 * and the posting. `hires_tenant_worker_posting_uq` — every source writes through it.
 */
export interface HireKey {
  readonly tenantPayerId: TenantKey;
  readonly workerId: string;
  readonly postingKind: ApplicantPostingKind;
  readonly postingId: string;
}

/** A locked row: its id and the state the rules read. */
export interface HeldHire extends HireState {
  readonly id: string;
}

/** One row of `GET /admin/hires`: ids, the status, the per-source timestamps and the day. */
export interface AdminHireRow {
  readonly id: string;
  readonly tenantPayerId: string;
  readonly workerId: string;
  readonly postingKind: ApplicantPostingKind;
  readonly postingId: string;
  readonly status: HireStatus;
  readonly companyMarkedAt: Date | null;
  readonly companyAnsweredAt: Date | null;
  readonly workerAnsweredAt: Date | null;
  readonly deskConfirmedAt: Date | null;
  readonly hiredOn: string | null;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

const STATE_COLUMNS = {
  id: hires.id,
  status: hires.status,
  companyMarkedAt: hires.companyMarkedAt,
  companyAnsweredAt: hires.companyAnsweredAt,
  workerAnsweredAt: hires.workerAnsweredAt,
  deskConfirmedAt: hires.deskConfirmedAt,
  hiredOn: hires.hiredOn,
} as const;

function keyWhere(key: HireKey): SQL {
  return and(
    eq(hires.tenantPayerId, key.tenantPayerId),
    eq(hires.workerId, key.workerId),
    eq(hires.postingKind, key.postingKind),
    eq(hires.postingId, key.postingId),
  )!;
}

/**
 * `hires` (#2753 item 9). Rows only: every rule is {@link import("./hire-state").nextHireState}'s,
 * and the service decides when to call. Every write runs on the CALLER's transaction, so a hire
 * commits (or rolls back) with the stage, answer or desk action that said it.
 */
@Injectable()
export class HiresRepository {
  constructor(@Inject(DATABASE) private readonly db: Database) {}

  /** The record for `key`, locked for the rest of the transaction; `null` when there is none. */
  async lockByKey(key: HireKey, tx: Database): Promise<HeldHire | null> {
    const [row] = await tx
      .select(STATE_COLUMNS)
      .from(hires)
      .where(keyWhere(key))
      .limit(1)
      .for("update");
    return row ?? null;
  }

  /**
   * The FIRST write of a record. `null` when a row already exists — one a concurrent transaction
   * committed after {@link lockByKey} saw none (the insert waited on it).
   */
  async insert(key: HireKey, state: HireState, at: Date, tx: Database): Promise<string | null> {
    const [row] = await tx
      .insert(hires)
      .values({ ...key, ...state, createdAt: at, updatedAt: at })
      .onConflictDoNothing({
        target: [hires.tenantPayerId, hires.workerId, hires.postingKind, hires.postingId],
      })
      .returning({ id: hires.id });
    return row?.id ?? null;
  }

  /** Store the state the rules decided. The caller holds the row lock from {@link lockByKey}. */
  async update(id: string, state: HireState, at: Date, tx: Database): Promise<void> {
    await tx
      .update(hires)
      .set({ ...state, updatedAt: at })
      .where(eq(hires.id, id));
  }

  /**
   * One page of `GET /admin/hires`, newest record first: keyset on `(created_at, id)` DESC, the
   * admin entity lists' order and cursor. `limit` is the caller's page size plus one.
   */
  async listForAdmin(
    filter: { readonly status?: HireStatus },
    cursor: EntityCursor | null,
    limit: number,
  ): Promise<AdminHireRow[]> {
    const clauses: SQL[] = [];
    if (filter.status) clauses.push(eq(hires.status, filter.status));
    if (cursor) {
      // The typed operators, never a `sql` template: they encode the Date for the driver (the
      // admin-entities keyset note).
      const at = new Date(cursor.createdAt);
      clauses.push(
        or(lt(hires.createdAt, at), and(eq(hires.createdAt, at), lt(hires.id, cursor.id)))!,
      );
    }
    return this.db
      .select({
        id: hires.id,
        tenantPayerId: hires.tenantPayerId,
        workerId: hires.workerId,
        postingKind: hires.postingKind,
        postingId: hires.postingId,
        status: hires.status,
        companyMarkedAt: hires.companyMarkedAt,
        companyAnsweredAt: hires.companyAnsweredAt,
        workerAnsweredAt: hires.workerAnsweredAt,
        deskConfirmedAt: hires.deskConfirmedAt,
        hiredOn: hires.hiredOn,
        createdAt: hires.createdAt,
        updatedAt: hires.updatedAt,
      })
      .from(hires)
      .where(clauses.length > 0 ? and(...clauses) : undefined)
      .orderBy(desc(hires.createdAt), desc(hires.id))
      .limit(limit);
  }
}
