import { Inject, Injectable } from "@nestjs/common";
import { and, asc, desc, eq, inArray, lt } from "drizzle-orm";
import {
  type Database,
  workerResumeImports,
  type WorkerResumeImport,
  type NewWorkerResumeImport,
} from "@badabhai/db";
import type {
  ResumeDegradedPostureName,
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
 *
 * ONE EXCEPTION, AND IT IS NARROWED BY PROJECTION RATHER THAN BY PROMISE (#1665).
 * {@link ResumeImportRepository.findStaleParsing} and
 * {@link ResumeImportRepository.countStaleUploaded} are the ADR-0041 §7 sweep's work list, and
 * a sweep by definition has no worker to scope to — the defining property of a stranded import
 * is that nobody is asking for it. So they are the two reads in this class that cross workers,
 * and neither can ever hand back a document: they select an explicit COLUMN LIST of opaque ids
 * and a timestamp, never `select()`, so `storage_key`, `suggestions_enc` and the identity
 * strings are unreachable through them by construction. A controller that got hold of one would
 * learn nothing it could show anybody.
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
   * Imports stuck in `parsing` since before `staleBefore` — the ADR-0041 §7 sweep's work list
   * (#1665).
   *
   * `updated_at` IS THE CLOCK, NOT `created_at`. The row enters `parsing` in `markParsing`,
   * which stamps `updated_at`; measuring from `created_at` would start the clock at CONFIRM and
   * count the time a job spent waiting in a Redis backlog against a document nobody had begun
   * reading yet. The only other writer that touches a `parsing` row is `saveIdentitySummary`,
   * which re-stamps it mid-job — that pushes the deadline LATER, which is the safe direction:
   * a job observably still working is not swept.
   *
   * THREE COLUMNS, AND THAT IS THE WHOLE POINT. This is the one cross-worker read in the class
   * (see the class docblock). An explicit projection of two opaque uuids and a timestamp is
   * what makes it safe: a `select()` here would put every worker's `storage_key` and sealed
   * suggestion token behind a method that takes no owner.
   *
   * BOUNDED, and the caller re-ticks. A first deploy may find a backlog of rows stranded before
   * the sweep existed; a backlog drains across ticks rather than holding one transaction open
   * over thousands of rows. ORDERED OLDEST-FIRST so it drains FIFO and no row starves behind
   * newer arrivals.
   *
   * ⚠ NO SUPPORTING INDEX, deliberately and for a smaller reason than it looks. The predicate
   * wants a partial index on `(updated_at) WHERE status = 'parsing'` — tiny, since `parsing` is
   * a transient state holding a handful of rows at a time. It is not here because the owner
   * ruling for #1665 was explicitly "no migration", and because the cost of not having it is a
   * sequential scan of `worker_resume_import` every RESUME_IMPORT_SWEEP_INTERVAL_MINUTES, off
   * every request path, with output capped at `RESUME_IMPORT_SWEEP_BATCH_LIMIT`. That is
   * affordable at this table's size (one row per résumé ever uploaded) and stops being
   * affordable at some larger one. Unlike `findIdleActiveSessions`' identical note, nothing
   * BLOCKS the index any more — #865 was fixed in 26cab7bf and `db:generate` is clean — so this
   * is a one-line follow-up whenever the scan shows up in a plan.
   */
  async findStaleParsing(staleBefore: Date, limit: number): Promise<StaleImport[]> {
    return staleParsingStatement(this.db, staleBefore, limit);
  }

  /**
   * How many imports are stuck at `uploaded` past `staleBefore` — OBSERVABILITY ONLY (#1665).
   *
   * THE SWEEP DOES NOT SETTLE THESE, and `ResumeImportSweepProcessor` carries the
   * argument for why. This exists so the decision is AUDITABLE rather than invisible: an
   * operator can see the number without the sweep writing a status for it.
   *
   * BOUNDED BY `limit`, so the answer is "at least n" rather than a `count(*)` over a table
   * that grows forever. Same projection discipline as {@link findStaleParsing} — one opaque
   * column, never `select()`.
   */
  async countStaleUploaded(staleBefore: Date, limit: number): Promise<number> {
    const rows = await staleUploadedStatement(this.db, staleBefore, limit);
    return rows.length;
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

  /**
   * Stage the RI-identity Hinglish line beside the row, and ONLY the line.
   *
   * GUARDED TO `parsing` OR `parsed`, and that disjunction is the whole design: the
   * processor stages pre-settle (`parsing`), and a redelivery that finds the row already
   * settled (`parsed`) may still backfill a line whose first write was lost to a throw.
   * Anything else — `failed`, `discarded`, or a row erased mid-flight — gets zero rows
   * back and the caller stages nothing. Never touches `status`, `route` or any CHECK-bound
   * sibling, so this write cannot disturb the settle's atomicity from either side.
   *
   * UNCHANGED BY THE D9 AMENDMENT (#1654), deliberately. Staging a line for an import that
   * is about to FAIL does not need `failed` added here: the processor runs the summary
   * BEFORE `settleFailure`, so the row is still `parsing` at the write, exactly as on the
   * parsed path. `failed` stays out because this guard is what stops a line landing on a
   * row that has left the flow, and a terminal row is precisely such a row — the one case
   * it would newly admit is a redelivery backfill we do not perform (a redelivery gets
   * `already_settled` and never reaches the summary at all).
   *
   * PLAIN STRINGS AT THIS BOUNDARY (like `formKind`): the service narrowed the kind and
   * the far side certified the Hinglish; the CHECK enforces the rest.
   */
  async saveIdentitySummary(id: string, identity: ResumeIdentity): Promise<boolean> {
    const rows = await saveIdentitySummaryStatement(this.db, id, identity);
    return rows.length > 0;
  }
}

/**
 * One stranded import, as the ADR-0041 §7 sweep sees it (#1665).
 *
 * TWO OPAQUE IDS AND A TIMESTAMP, and nothing else is reachable through the read that
 * produces it — see `findStaleParsing`. The sweep needs the import id to settle, the worker id
 * for the event's actor/subject (the ONE thing a sweep cannot get from a session), and
 * `updatedAt` only to say in a log how long the row waited.
 */
export interface StaleImport {
  id: string;
  workerId: string;
  updatedAt: Date;
}

/** The RI-identity Hinglish line, staged for the "is this you?" turn. */
export interface ResumeIdentity {
  roleKind: string | null;
  experienceText: string | null;
  summaryText: string | null;
}

/** What only the ai-service can know about a parse: counts and a score, never text. */
export interface ResumeParseFacts {
  extractionMethod: ResumeExtractionMethodName;
  pageCount: number | null;
  ocrConfidence: number | null;
  /**
   * #1660 - how many target fields the parse actually produced.
   *
   * THE SAME NUMBER `profile.resume_parsed` CARRIES, from the same expression, so the row
   * and the event can never disagree about one import. It is a PARSE FACT and lives here
   * rather than on {@link ResumeRouting}, because it describes what the document gave us,
   * not where we sent the worker.
   */
  fieldsExtracted: number;
  /**
   * #1656 — why no real model call stood behind this parse, or null when one did.
   *
   * A PARSE FACT like the two above it, and the one that makes `fieldsExtracted: 0`
   * readable: without it, zero means BOTH "the document said nothing" and "a spend cap, a
   * cooldown, a cost ceiling or the kill switch meant we never asked". Those need opposite
   * responses, and only one of them is a parser problem.
   *
   * THE CLOSED SET OR NULL, narrowed by the parse service — the same posture
   * `extractionMethod` keeps, and for the same reason: no cast stands between the far side's
   * open `notes` array and `wri_degraded_posture_chk`.
   */
  degradedPosture: ResumeDegradedPostureName | null;
}

/** The routing decision and the staged suggestion token. */
export interface ResumeRouting {
  route: ResumeImportRouteName;
  formKind: string | null;
  /**
   * Task 1 B2 — the model's closed-list judgment (`association_kind` column).
   * Recorded beside the route; never read by the router. Plain `string | null`
   * at this boundary (like `formKind`): the service narrowed it, the CHECK
   * enforces it.
   */
  associationKind: string | null;
  suggestionsEnc: string | null;
}

/**
 * The settle statement, BUILT but not awaited.
 *
 * EXPORTED SO THE GUARD CAN BE PINNED WHERE CI RUNS. CI runs DB-backed suites from a HAND-LISTED
 * set (`.github/workflows/ci.yml`, step "DB-backed gates", `RUN_DB_TESTS=1`), and
 * `resume-import.repository.db.test.ts` is not on that list yet — wiring it in is a follow-up.
 * Until then a test that needs Postgres cannot be the only thing standing between this file and
 * a dropped `status = 'parsing'`. `resume-import.repository.query.test.ts` compiles this with
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
      // #1660 - the count the event has always carried, now on the row too. An event is
      // not a read: the import status endpoint had no field that could tell a productive
      // chat-routed import from one that yielded nothing.
      fieldsExtracted: facts.fieldsExtracted,
      // #1656 - WHY it yielded nothing, when the document was not at fault. In the SAME
      // statement as the count and the route, so no reader can ever see a `parsed` row whose
      // zero count has lost the reason behind it. NULL is written EXPLICITLY on a healthy
      // parse: this is the only writer, so "not degraded" is asserted rather than inferred
      // from a column nobody got round to setting.
      degradedPosture: facts.degradedPosture,
      route: routing.route,
      // NULLED, NOT OMITTED, on the chat route. `wri_form_kind_chk` is an equivalence in both
      // directions, so a form kind riding along on a chat route would fail the whole settle.
      formKind: routing.route === "form" ? routing.formKind : null,
      // Task 1 B2 — recorded on EVERY route, including chat: "judged none" is the
      // signal the recall path will read, and it lives on chat rows.
      associationKind: routing.associationKind,
      suggestionsEnc: routing.suggestionsEnc,
      updatedAt: new Date(),
    })
    .where(and(eq(workerResumeImports.id, id), eq(workerResumeImports.status, "parsing")))
    .returning({ id: workerResumeImports.id });
}

/** The identity-stage statement, built but not awaited — exported for the same reason as the settle. */
export function saveIdentitySummaryStatement(db: Database, id: string, identity: ResumeIdentity) {
  return db
    .update(workerResumeImports)
    .set({
      identityRoleKind: identity.roleKind,
      identityExperienceText: identity.experienceText,
      identitySummaryText: identity.summaryText,
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(workerResumeImports.id, id),
        inArray(workerResumeImports.status, ["parsing", "parsed"]),
      ),
    )
    .returning({ id: workerResumeImports.id });
}

/**
 * The stale-`parsing` work-list statement, BUILT but not awaited — exported for the same reason
 * as the settle, and for one of its own.
 *
 * THE PREDICATE IS THE VACUITY GUARD. Losing `status = 'parsing'` would hand the sweep every
 * aged row in the table, and losing `updated_at < $n` would hand it every in-flight parse. The
 * guarded UPDATE downstream is what stops either mutation from actually corrupting a row — it
 * refuses anything not `parsing` — but it would not stop the sweep from settling a job that is
 * legitimately still working, which is the one outcome the threshold exists to prevent. Pinned
 * here against `drizzle.mock()` so the predicate itself is under test with no database.
 */
export function staleParsingStatement(db: Database, staleBefore: Date, limit: number) {
  return db
    .select({
      id: workerResumeImports.id,
      workerId: workerResumeImports.workerId,
      updatedAt: workerResumeImports.updatedAt,
    })
    .from(workerResumeImports)
    .where(
      and(
        eq(workerResumeImports.status, "parsing"),
        lt(workerResumeImports.updatedAt, staleBefore),
      ),
    )
    .orderBy(asc(workerResumeImports.updatedAt))
    .limit(limit);
}

/** The stale-`uploaded` COUNT statement (observability only), built but not awaited. */
export function staleUploadedStatement(db: Database, staleBefore: Date, limit: number) {
  return db
    .select({ id: workerResumeImports.id })
    .from(workerResumeImports)
    .where(
      and(
        eq(workerResumeImports.status, "uploaded"),
        lt(workerResumeImports.updatedAt, staleBefore),
      ),
    )
    .limit(limit);
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
