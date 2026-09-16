import { Inject, Injectable } from "@nestjs/common";
import { and, desc, eq } from "drizzle-orm";
import {
  type Database,
  workerResumeImports,
  type WorkerResumeImport,
  type NewWorkerResumeImport,
} from "@badabhai/db";
import type {
  ResumeExtractionMethodName,
  ResumeImportFailureName,
  ResumeImportRouteName,
} from "@badabhai/types";
import { DATABASE } from "../../database/database.module";

/**
 * Reads and writes for `worker_resume_import` (ADR-0041, phase RI-1).
 *
 * EVERY READ IS WORKER-SCOPED, and there is no `findById` without one. That is not politeness
 * about layering — this row points at a document holding a worker's employers and past salaries,
 * so a repository method that could fetch one by id alone is a method a controller could reach
 * with an id from a request body. The type system is doing the ownership check here: you cannot
 * ask this class a question that omits the worker.
 */
@Injectable()
export class ResumeImportRepository {
  constructor(@Inject(DATABASE) private readonly db: Database) {}

  async create(input: NewWorkerResumeImport): Promise<WorkerResumeImport> {
    const inserted = await this.db.insert(workerResumeImports).values(input).returning();
    const row = inserted[0];
    if (!row) throw new Error("Failed to create résumé import");
    return row;
  }

  /**
   * One import, but only this worker's.
   *
   * `undefined` covers both "no such row" and "not yours", deliberately — the caller turns both
   * into the same 404 so the route is not an existence oracle for another worker's imports.
   */
  async findForWorker(id: string, workerId: string): Promise<WorkerResumeImport | undefined> {
    const rows = await this.db
      .select()
      .from(workerResumeImports)
      .where(and(eq(workerResumeImports.id, id), eq(workerResumeImports.workerId, workerId)))
      .limit(1);
    return rows[0];
  }

  /** This worker's most recent import, if any. Served by `wri_worker_recent_idx`. */
  async findLatestForWorker(workerId: string): Promise<WorkerResumeImport | undefined> {
    const rows = await this.db
      .select()
      .from(workerResumeImports)
      .where(eq(workerResumeImports.workerId, workerId))
      .orderBy(desc(workerResumeImports.createdAt))
      .limit(1);
    return rows[0];
  }

  /**
   * Has this exact object already been registered?
   *
   * The unique index on `storage_key` would refuse a second row anyway; this exists so the
   * confirm route can answer a retry with the ORIGINAL row instead of a 500 from a constraint
   * violation. A client on a weak connection that PUTs, times out reading our response, and
   * retries the confirm is the ordinary case, not the adversarial one.
   */
  async findByStorageKey(storageKey: string): Promise<WorkerResumeImport | undefined> {
    const rows = await this.db
      .select()
      .from(workerResumeImports)
      .where(eq(workerResumeImports.storageKey, storageKey))
      .limit(1);
    return rows[0];
  }

  /**
   * `uploaded` -> `parsing`, and ONLY from `uploaded`.
   *
   * THE WHERE CLAUSE IS THE LOCK. Two deliveries of the same queue job would otherwise both
   * read `uploaded`, both call the AI service, and both bill for reading one document — the
   * cheapest duplicate charge to make and the hardest to notice, because both succeed and the
   * second simply overwrites the first. A conditional UPDATE lets the database decide which
   * delivery wins; the loser gets zero rows back and stops.
   */
  async markParsing(id: string): Promise<boolean> {
    const rows = await this.db
      .update(workerResumeImports)
      .set({ status: "parsing", updatedAt: new Date() })
      .where(and(eq(workerResumeImports.id, id), eq(workerResumeImports.status, "uploaded")))
      .returning({ id: workerResumeImports.id });
    return rows.length > 0;
  }

  /**
   * Run `cb` inside one Drizzle transaction. The parse and route services use it to commit a
   * terminal status write and its event together: an emit that throws rolls the status back, so
   * a row can never say `parsed` or `failed` without the event that counts it, and an event can
   * never count a transition the row does not show.
   */
  withTransaction<T>(cb: (tx: Database) => Promise<T>): Promise<T> {
    return this.db.transaction(cb as (tx: unknown) => Promise<T>);
  }

  /**
   * `parsing` -> `parsed`, WITH the route, the form kind, the staged suggestions and the
   * extraction facts, in ONE guarded UPDATE (ADR-0041 §4, amended 2026-09-15).
   *
   * THIS IS THE ONLY WRITER OF EVERY PARSE-DERIVED COLUMN, AND THAT IS THE FIX. The first cut
   * wrote `status = 'parsed'` in the parse service and `route`/`form_kind`/`suggestions_enc` in
   * a SECOND update from the route service. Between the two, a polling client read `parsed` —
   * which it treats as terminal — beside a null route, which it treats as chat, and a worker the
   * router was about to send to his trade form was sent to the chat instead. Every CHECK on this
   * table was satisfied the whole time; the row was legal and wrong. One statement has no
   * "between".
   *
   * THE WHERE CLAUSE IS THE SECOND LOCK. `markParsing` decided which delivery reads the document;
   * `status = 'parsing'` here decides that exactly one outcome is ever recorded. A redelivery, or
   * a failure that already landed, gets zero rows back — and the caller must then emit nothing,
   * which is why this returns the boolean rather than `void`.
   *
   * `tx` IS REQUIRED, NOT DEFAULTED. The event that counts this transition is written on the same
   * transaction; a default executor would make the un-atomic call the easy one to write.
   *
   * `suggestionsEnc` ARRIVES ALREADY ENCRYPTED. This class takes a token, never a payload — the
   * plaintext carries employer names and role titles lifted from the worker's document, and a
   * repository that accepted the object would be one refactor away from writing it plain. The
   * encryption boundary is the service's, and the type here is what keeps it there.
   */
  async settleParsed(
    id: string,
    facts: ResumeParseFacts,
    routing: ResumeRouting,
    tx: Database,
  ): Promise<boolean> {
    const rows = await settleParsedStatement(tx, id, facts, routing);
    return rows.length > 0;
  }

  /**
   * `parsing` -> `failed`, with the reason the CHECK constraint requires, and ONLY from `parsing`.
   *
   * `wri_failure_reason_chk` is a BICONDITIONAL — a failed row must carry a reason and a
   * non-failed row must not — so these two columns can only ever be written together. That is
   * the constraint doing its job: a failure nobody can explain is not a state this table
   * permits.
   *
   * GUARDED FOR THE SAME REASON AS {@link settleParsed}. Unguarded, a late failure could
   * overwrite a row another path already settled — a `parsed` import the worker was routed on
   * would turn into a `failed` one behind his back. The boolean tells the caller whether it is
   * entitled to emit `profile.resume_parse_failed`; `false` also covers a row erased by account
   * deletion while the parse was in flight.
   *
   * `extractionMethod` IS THE CLOSED SET OR NULL. The contract types it as an open string; the
   * service narrows it before it gets here, so no cast stands between the far side and the
   * column's CHECK.
   */
  async markFailed(
    id: string,
    reason: ResumeImportFailureName,
    extractionMethod: ResumeExtractionMethodName | null,
    tx: Database,
  ): Promise<boolean> {
    const rows = await markFailedStatement(tx, id, reason, extractionMethod);
    return rows.length > 0;
  }
}

/** What only the ai-service can know about a parse: counts and a score, never text. */
export interface ResumeParseFacts {
  extractionMethod: ResumeExtractionMethodName;
  pageCount: number | null;
  ocrConfidence: number | null;
}

/** The routing decision and the staged suggestion token. */
export interface ResumeRouting {
  route: ResumeImportRouteName;
  formKind: string | null;
  suggestionsEnc: string | null;
}

/**
 * The settle statement, BUILT but not awaited.
 *
 * EXPORTED SO THE GUARD CAN BE PINNED WHERE CI RUNS. RUN_DB_TESTS suites never run in CI, so a
 * test that needs Postgres cannot be the only thing standing between this file and a dropped
 * `status = 'parsing'`. `resume-import.repository.query.test.ts` compiles this with
 * `drizzle.mock()` and reads the SQL — no connection, no skip.
 */
export function settleParsedStatement(
  db: Database,
  id: string,
  facts: ResumeParseFacts,
  routing: ResumeRouting,
) {
  return db
    .update(workerResumeImports)
    .set({
      status: "parsed",
      extractionMethod: facts.extractionMethod,
      pageCount: facts.pageCount,
      // `wri_ocr_confidence_chk` ties the score to the method, so a non-OCR parse must carry
      // none. Writing one anyway would be a number nothing computed, which a later reader
      // would average.
      ocrConfidence: facts.extractionMethod === "ocr" ? facts.ocrConfidence : null,
      route: routing.route,
      // NULLED, NOT OMITTED, on the chat route. `wri_form_kind_chk` is an equivalence in both
      // directions, so a form kind riding along on a chat route would fail the whole settle.
      formKind: routing.route === "form" ? routing.formKind : null,
      suggestionsEnc: routing.suggestionsEnc,
      updatedAt: new Date(),
    })
    .where(and(eq(workerResumeImports.id, id), eq(workerResumeImports.status, "parsing")))
    .returning({ id: workerResumeImports.id });
}

/** The failure statement, built but not awaited — exported for the same reason as the settle. */
export function markFailedStatement(
  db: Database,
  id: string,
  reason: ResumeImportFailureName,
  extractionMethod: ResumeExtractionMethodName | null,
) {
  return db
    .update(workerResumeImports)
    .set({
      status: "failed",
      failureReason: reason,
      extractionMethod,
      updatedAt: new Date(),
    })
    .where(and(eq(workerResumeImports.id, id), eq(workerResumeImports.status, "parsing")))
    .returning({ id: workerResumeImports.id });
}
