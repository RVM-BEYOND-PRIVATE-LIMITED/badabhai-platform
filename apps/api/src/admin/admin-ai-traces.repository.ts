import { Inject, Injectable } from "@nestjs/common";
import { and, desc, eq, lt, or, sql, type SQL } from "drizzle-orm";
import type { PgColumn } from "drizzle-orm/pg-core";
import { aiCallTraces, type Database } from "@badabhai/db";
import type { AiCostTaskType, AiTraceErrorCode } from "@badabhai/event-schema";

import { DATABASE } from "../database/database.module";
import type { EntityCursor } from "./admin-entities.cursor";
import type { AdminAiTraceListItem } from "./admin-ai-traces.dto";

/**
 * The two ciphertext columns, kept APART from the scalars in the type system.
 *
 * ── WHY {@link AdminAiTracesRepository.byId} RETURNS A PAIR AND NOT ONE FLAT ROW ─────────
 * A flat row would put `promptEnc` beside `taskType` in a single object, and the ordinary way to
 * build a response from such an object — spread it, delete what you do not want — is precisely
 * how a token reaches a client. Splitting them means a caller that wants only metadata takes
 * `.scalars` and CANNOT reach the ciphertext by accident: there is nothing to forget to strip.
 * The one caller that does want the text has to name `.cipher`, which is the moment a reviewer
 * can see the disclosure being asked for.
 *
 * It is the same instinct behind projecting explicit columns rather than `select()`, applied one
 * level up — at the boundary between the repository and the service rather than between the
 * database and the repository.
 */
export interface AdminAiTraceCipher {
  /** AES-256-GCM token, or null when the call had no prompt. NEVER decrypted here. */
  readonly promptEnc: string | null;
  readonly responseEnc: string | null;
}

export interface AdminAiTraceRow {
  /** Everything safe to serve without a decrypt, a capability or an audit row. */
  readonly scalars: AdminAiTraceListItem;
  /** The two encrypted halves. Only the gated detail path may touch these. */
  readonly cipher: AdminAiTraceCipher;
}

/**
 * One list row, plus the value the NEXT page's cursor must be built from.
 *
 * ── WHY THE SORT KEY TRAVELS SEPARATELY INSTEAD OF THE SERVICE USING `created_at` ────────
 * `ai_call_traces.created_at` is `timestamptz`, which Postgres stores to MICROSECOND precision.
 * `created_at` on the DTO is a JS `Date`, which holds MILLISECONDS — and `.toISOString()` on
 * that Date is what the cursor used to carry. So the cursor bound was always ≤ the real value of
 * the row it was minted from, and every remaining row inside that millisecond failed BOTH halves
 * of {@link AdminAiTracesRepository.before}: not `< at`, and not `= at` either, which is what
 * makes the `id` tie-breaker unable to save it (equality is never reached). Those rows were
 * dropped permanently, with no error and a `nextCursor` that looked healthy.
 *
 * WHERE THE DIGITS GO, measured against a live Postgres rather than assumed — the answer is not
 * the layer it looks like. On a drizzle-wrapped client (which is every connection this app has)
 * postgres-js delivers a `timestamptz` as a RAW STRING with all six digits present. It is
 * drizzle's own `timestamp(..., { mode: "date" })` mapper that turns that string into a `Date`
 * and drops them. Nothing on the wire is lossy; the loss is one `new Date(...)` in the mapper.
 *
 * Which is exactly why the sort key has to be rendered by POSTGRES, inside the query: by the time
 * a row reaches JavaScript the microseconds no longer exist to be recovered.
 *
 * MEASURED, not reasoned: six rows seeded inside one millisecond, page size 2 → 2 returned, 4
 * skipped, second page empty. And under an ordinary concurrent load — this is the ONE table on
 * the spine written concurrently by every request path and every queue worker, so sub-millisecond
 * collisions are its normal case, not its edge case.
 *
 * `sortKey` is the same instant rendered by POSTGRES at full precision, so the cursor is finally
 * what {@link import("./admin-entities.cursor").EntityCursor} always claimed it was: lossless.
 */
export interface AdminAiTraceListRow {
  readonly item: AdminAiTraceListItem;
  /** Full-microsecond ISO-8601, e.g. `2026-08-01T10:00:00.000600Z`. Cursor use ONLY. */
  readonly sortKey: string;
}

/**
 * SELECT-ONLY data access for the admin AI-trace read (migration 0083).
 *
 * ── WHY IT IS NOT A METHOD ON `AiTracesRepository` ──────────────────────────────────────
 * That class can INSERT. Injecting it here would put a writer for `ai_call_traces` into the
 * admin injector, which is the shape `admin-static-guards.test.ts` already forbids for the AI
 * cost-totals writer, and for the same reason: the next person who wants "just fix up this one
 * row" would find the capability already wired next to a console. The `FeedbackRepository` /
 * `AdminFeedbackRepository` split is the precedent, verbatim.
 *
 * ── NO WRITES, EVER; NO JOINS; NO SEARCH ───────────────────────────────────────────────
 * There is no insert/update/delete here and there must never be one — a trace is the record of a
 * completed call and nothing about it can legitimately change. There is no join to `workers`,
 * because that is how an opaque `worker_id` becomes a name. And there is no `ilike`, no
 * `to_tsquery` and no hash lookup over `prompt_enc` / `response_enc`: a search over this table
 * would be a search over everything every worker has ever said to the platform, and the fact
 * that it is one predicate away is why it is refused here in writing rather than left to be
 * noticed later. (It is also impossible today — the columns are non-deterministic AES ciphertext
 * — which is exactly why a plaintext or hashed sibling must never be added.)
 *
 * ── THE INDEXES THESE QUERIES ARE WRITTEN FOR ──────────────────────────────────────────
 * `ai_call_traces_admin_keyset_idx` on `(created_at DESC NULLS FIRST, id DESC NULLS FIRST)`
 * serves the unfiltered page, and `ai_call_traces_worker_keyset_idx` leads on `worker_id` for
 * the per-worker drill-down. Both were built NULLS FIRST deliberately, because drizzle's bare
 * `desc()` emits no NULLS clause and Postgres reads that as DESC NULLS FIRST — an index built
 * NULLS LAST would serve the filter and leave the Sort in place, which is the entire cost those
 * indexes exist to remove. The `orderBy` below must therefore stay a bare `desc()` pair.
 *
 * `task_type` and `success` have NO leading index and deliberately do not get one: both are
 * low-cardinality (nine task types; two booleans), so a filtered page still walks the keyset
 * index and discards, which is the right plan at any size a filter this coarse produces.
 */
@Injectable()
export class AdminAiTracesRepository {
  constructor(@Inject(DATABASE) private readonly db: Database) {}

  /**
   * "Strictly older than the cursor" under DESC `(created_at, id)`: `created_at < c` OR
   * (`created_at = c` AND `id < cid`). The `id` tie-breaker is what makes the ordering TOTAL, and
   * it is load-bearing here more than anywhere: one extraction fans out several calls inside a
   * single `defaultNow()` tick, so a page boundary landing mid-tick would skip or repeat rows.
   *
   * ── THE BOUND IS A STRING, CAST THROUGH `::text` FIRST ──────────────────────────────────
   * NOT `new Date(cursor.createdAt)`. A JS `Date` carries milliseconds and this column carries
   * microseconds, so a Date-valued bound sits strictly BELOW the row it was minted from and
   * silently skips every row sharing that millisecond — see {@link AdminAiTraceListRow} for the
   * measurement and for where the digits are really lost.
   *
   * `::text::timestamptz` rather than a bare `::timestamptz`, and the honest reason is narrower
   * than it first looks — stated precisely, because the first version of this comment got it
   * wrong in the direction that reads as more rigorous:
   *
   *   * On a BARE postgres-js client `$1::timestamptz` genuinely does truncate. Postgres
   *     resolves the parameter's type as 1184 and postgres-js applies its own `date` serializer,
   *     `(x instanceof Date ? x : new Date(x)).toISOString()`, round-tripping the string through
   *     a `Date` before Postgres sees it. Measured: `.000000` vs `.000600`.
   *   * But `drizzle(sql)` MUTATES the client it is handed, and `createDbClient` wraps
   *     immediately — so on every connection this app actually has, that serializer is gone and
   *     BOTH forms keep all six digits. Measured on a wrapped client: both `.000600`.
   *
   * So this is belt to the `SORT_KEY` brace, not the fix: it is correct whether or not the
   * client has been wrapped, and a repository should not silently depend on a mutation another
   * library performs on a shared connection. It also still satisfies BP-1, whose subject was
   * handing postgres-js a raw `Date` — a bound STRING is exactly what that post-mortem asked
   * for. See `admin-keyset-params.test.ts` and `packages/db/src/ai-trace-schema.test.ts`.
   */
  private static before(createdAtCol: PgColumn, idCol: PgColumn, cursor: EntityCursor): SQL {
    const at = sql`${cursor.createdAt}::text::timestamptz`;
    return or(lt(createdAtCol, at), and(eq(createdAtCol, at), lt(idCol, cursor.id)))!;
  }

  /**
   * The keyset sort key, rendered by POSTGRES at full microsecond precision.
   *
   * `to_char(...)` and not `::text`, because the cursor's contract is an ISO-8601 string that
   * `decodeEntityCursor` can `Date.parse` — and `::text` on a `timestamptz` emits Postgres's own
   * `2026-08-01 10:00:00.0006+00` form, which is not that. This emits
   * `2026-08-01T10:00:00.000600Z`: parseable by `Date.parse` (V8 accepts more than three
   * fractional digits and truncates them for the *validity* check only, which is all the decoder
   * uses it for), and parseable back by Postgres at full precision, which is what matters.
   *
   * SELECTED, NOT COMPUTED IN JS, because the microseconds do not survive the driver — by the
   * time a row reaches JS the value is already a millisecond-precision `Date`. The only place
   * this string can be made is inside the query.
   */
  private static readonly SORT_KEY = sql<string>`to_char(${aiCallTraces.createdAt} at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`;

  /**
   * The PII-free column list, named once.
   *
   * `prompt_enc` and `response_enc` ARE NOT IN IT, and that absence is the list read's whole
   * guarantee — not a mapper that strips them afterwards, which would leave the tokens in a
   * variable one `return row` away from a response. A future column added to the table is
   * likewise absent until someone adds it here on purpose.
   */
  private static readonly SCALARS = {
    id: aiCallTraces.id,
    aiCallId: aiCallTraces.aiCallId,
    workerId: aiCallTraces.workerId,
    sessionId: aiCallTraces.sessionId,
    aiJobId: aiCallTraces.aiJobId,
    correlationId: aiCallTraces.correlationId,
    taskType: aiCallTraces.taskType,
    modelName: aiCallTraces.modelName,
    promptName: aiCallTraces.promptName,
    promptVersion: aiCallTraces.promptVersion,
    promptChars: aiCallTraces.promptChars,
    responseChars: aiCallTraces.responseChars,
    realCall: aiCallTraces.realCall,
    success: aiCallTraces.success,
    errorCode: aiCallTraces.errorCode,
    createdAt: aiCallTraces.createdAt,
  } as const;

  /** camelCase row → the snake_case DTO the admin surface serves. */
  private static toItem(r: {
    id: string;
    aiCallId: string;
    workerId: string;
    sessionId: string | null;
    aiJobId: string | null;
    correlationId: string | null;
    taskType: string;
    modelName: string | null;
    promptName: string | null;
    promptVersion: string | null;
    promptChars: number | null;
    responseChars: number | null;
    realCall: boolean;
    success: boolean;
    errorCode: string | null;
    createdAt: Date;
  }): AdminAiTraceListItem {
    return {
      id: r.id,
      ai_call_id: r.aiCallId,
      worker_id: r.workerId,
      session_id: r.sessionId,
      ai_job_id: r.aiJobId,
      correlation_id: r.correlationId,
      // ── THE TWO UNCHECKED CASTS ON THIS PATH, AND WHY THEY STAY UNCHECKED ────────────────
      // Both columns are `text` whose only CHECK is a length bound, so the database can hold a
      // value this build's enum does not know — and for `task_type` that is BY DESIGN (the 0081
      // reasoning: the ai-service gaining a task type must not require a migration ahead of the
      // deploy). Narrowing at runtime would mean DROPPING or blanking exactly the new surface an
      // operator is looking for, so both are asserted and the display layer is written to cope:
      // `apps/admin-web`'s `taskTypeLabel` and `aiTraceErrorLabel` both de-snake an unrecognised
      // value rather than rendering an empty cell.
      //
      // WHAT THE CAST DOES COST, stated so it is a known trade: the declared response type is a
      // promise about values, and old rows do not keep it if either vocabulary is ever NARROWED.
      // `AI_TRACE_ERROR_CODES` spreads `AI_SPEND_CAP_REASONS`, which is owned elsewhere, so that
      // narrowing could happen in a package that has never heard of this table. It is safe today
      // because both sets have only ever grown; a removal from either needs a data question
      // ("what is already stored?") answered before the type is believed again.
      task_type: r.taskType as AiCostTaskType,
      model_name: r.modelName,
      prompt_name: r.promptName,
      prompt_version: r.promptVersion,
      prompt_chars: r.promptChars,
      response_chars: r.responseChars,
      real_call: r.realCall,
      success: r.success,
      error_code: r.errorCode as AiTraceErrorCode | null,
      created_at: r.createdAt,
    };
  }

  /**
   * One keyset page, newest first. `limit` is the caller's page size PLUS ONE — the service
   * over-fetches by one to tell "there is more" from "that was the last page".
   */
  async list(
    filter: { taskType?: AiCostTaskType; success?: boolean; workerId?: string },
    cursor: EntityCursor | null,
    limit: number,
  ): Promise<AdminAiTraceListRow[]> {
    const clauses: SQL[] = [];
    if (filter.taskType) clauses.push(eq(aiCallTraces.taskType, filter.taskType));
    // `!== undefined`, not a truthiness test: `?success=false` is THE triage query on this
    // surface, and `if (filter.success)` would silently serve an unfiltered page for it.
    if (filter.success !== undefined) clauses.push(eq(aiCallTraces.success, filter.success));
    if (filter.workerId) clauses.push(eq(aiCallTraces.workerId, filter.workerId));
    if (cursor)
      clauses.push(AdminAiTracesRepository.before(aiCallTraces.createdAt, aiCallTraces.id, cursor));

    const rows = await this.db
      .select({ ...AdminAiTracesRepository.SCALARS, sortKey: AdminAiTracesRepository.SORT_KEY })
      .from(aiCallTraces)
      .where(clauses.length > 0 ? and(...clauses) : undefined)
      .orderBy(desc(aiCallTraces.createdAt), desc(aiCallTraces.id))
      .limit(limit);

    return rows.map((r) => ({ item: AdminAiTracesRepository.toItem(r), sortKey: r.sortKey }));
  }

  /**
   * One trace by id, with the ciphertext returned SEPARATELY from the scalars.
   *
   * `undefined` for an unknown id — the service turns that into the same neutral 404 as a denied
   * read, so this surface is not an existence oracle for trace ids.
   *
   * The two selects are one query: the scalars and the two encrypted columns come back together
   * and are split in memory. Splitting them in the TYPE rather than in a second round trip is
   * what buys the safety — see {@link AdminAiTraceRow}.
   */
  async byId(id: string): Promise<AdminAiTraceRow | undefined> {
    const [row] = await this.db
      .select({
        ...AdminAiTracesRepository.SCALARS,
        promptEnc: aiCallTraces.promptEnc,
        responseEnc: aiCallTraces.responseEnc,
      })
      .from(aiCallTraces)
      .where(eq(aiCallTraces.id, id))
      .limit(1);
    if (!row) return undefined;
    const { promptEnc, responseEnc, ...scalars } = row;
    return {
      scalars: AdminAiTracesRepository.toItem(scalars),
      cipher: { promptEnc, responseEnc },
    };
  }
}
