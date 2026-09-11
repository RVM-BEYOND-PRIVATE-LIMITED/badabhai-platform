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
   * The extraction facts, which can only come from the ai-service — apps/api never sees the
   * document, so there is nowhere else for `extraction_method`, `page_count` or
   * `ocr_confidence` to be learned.
   *
   * NO SUGGESTIONS WRITTEN HERE. `wri_suggestions_chk` permits a `parsed` row with none, and
   * that is the correct RI-3 state: a parse has happened and nothing has been offered to the
   * worker yet. Ruling D2 — a suggestion becomes a claim only when he confirms it — is what
   * makes the intermediate state safe to persist.
   */
  async markParsed(
    id: string,
    facts: {
      extractionMethod: string | null;
      pageCount: number | null;
      ocrConfidence: number | null;
    },
  ): Promise<void> {
    await this.db
      .update(workerResumeImports)
      .set({
        status: "parsed",
        extractionMethod: facts.extractionMethod as ResumeExtractionMethodName | null,
        pageCount: facts.pageCount,
        // `wri_ocr_confidence_chk` ties the score to the method, so a non-OCR parse must
        // carry none. Writing one anyway would be a number nothing computed, which a later
        // reader would average.
        ocrConfidence: facts.extractionMethod === "ocr" ? facts.ocrConfidence : null,
        updatedAt: new Date(),
      })
      .where(eq(workerResumeImports.id, id));
  }

  /**
   * `failed`, with the reason the CHECK constraint requires.
   *
   * `wri_failure_reason_chk` is a BICONDITIONAL — a failed row must carry a reason and a
   * non-failed row must not — so these two columns can only ever be written together. That is
   * the constraint doing its job: a failure nobody can explain is not a state this table
   * permits.
   */
  async markFailed(
    id: string,
    reason: ResumeImportFailureName,
    extractionMethod: string | null,
  ): Promise<void> {
    await this.db
      .update(workerResumeImports)
      .set({
        status: "failed",
        failureReason: reason,
        extractionMethod: extractionMethod as ResumeExtractionMethodName | null,
        updatedAt: new Date(),
      })
      .where(eq(workerResumeImports.id, id));
  }

  /**
   * The routing decision and the staged suggestions, written together (ADR-0041 RI-4).
   *
   * ONE WRITE, BECAUSE THE CONSTRAINTS ARE BICONDITIONAL. `wri_form_kind_chk` requires
   * `form_kind` to be present exactly when `route = 'form'`, and `wri_suggestions_chk` requires
   * `status = 'parsed'` before `suggestions_enc` may hold anything. Splitting this into two
   * updates would mean a moment where the row is legal but wrong, and a failure between them
   * would leave a routed import with nothing to offer.
   *
   * `suggestionsEnc` ARRIVES ALREADY ENCRYPTED. This class takes a token, never a payload — the
   * plaintext carries employer names and role titles lifted from the worker's document, and a
   * repository that accepted the object would be one refactor away from writing it plain. The
   * encryption boundary is the service's, and the type here is what keeps it there.
   */
  async markRouted(
    id: string,
    routing: {
      route: ResumeImportRouteName;
      formKind: string | null;
      suggestionsEnc: string | null;
    },
  ): Promise<void> {
    await this.db
      .update(workerResumeImports)
      .set({
        route: routing.route,
        // NULLED, NOT OMITTED, on the chat route. The CHECK is an equivalence in both
        // directions, so leaving a stale `form_kind` behind on a re-route would fail the write.
        formKind: routing.route === "form" ? routing.formKind : null,
        suggestionsEnc: routing.suggestionsEnc,
        updatedAt: new Date(),
      })
      .where(eq(workerResumeImports.id, id));
  }
}
