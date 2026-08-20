import { Inject, Injectable } from "@nestjs/common";
import { aiCallTraces, type Database } from "@badabhai/db";
import type { AiCostTaskType, AiTraceErrorCode } from "@badabhai/event-schema";

import { DATABASE } from "../database/database.module";
import { redactQueryParams } from "../common/db-error";

/**
 * One `ai_call_traces` row, as the WRITER hands it over (migration 0083).
 *
 * ⚠ `promptEnc` / `responseEnc` ARE ALREADY CIPHERTEXT. This type is the contract that says so
 * — see {@link AiTracesRepository} for why the encryption cannot live in this layer.
 */
export interface AiTraceInsert {
  /** The `ai_call_id` `ai.cost_recorded` already carries. UNIQUE: the idempotency key. */
  readonly aiCallId: string;
  /** NOT NULL by schema. An unattributable call is DROPPED upstream, never stored faceless. */
  readonly workerId: string;
  readonly sessionId: string | null;
  readonly aiJobId: string | null;
  readonly correlationId: string | null;
  readonly taskType: AiCostTaskType;
  readonly modelName: string | null;
  readonly promptName: string | null;
  readonly promptVersion: string | null;
  /** An `@badabhai/db` AES-256-GCM token. A CHECK constraint refuses anything else with 23514. */
  readonly promptEnc: string | null;
  readonly responseEnc: string | null;
  /** Character counts of the PLAINTEXT, taken before it was encrypted. */
  readonly promptChars: number | null;
  readonly responseChars: number | null;
  readonly realCall: boolean;
  readonly success: boolean;
  /** A CLOSED-SET code (`AI_TRACE_ERROR_CODES`), never a provider message. */
  readonly errorCode: AiTraceErrorCode | null;
}

/**
 * The WRITE side of `ai_call_traces` (migration 0083) — one insert, and nothing else.
 *
 * ── IT DOES NOT ENCRYPT, AND THAT IS THE POINT OF THE `…Enc` SUFFIXES ────────────────────
 * `promptEnc` and `responseEnc` arrive as finished AES-256-GCM tokens. A repository that took
 * plaintext and encrypted it would be a second crypto boundary — `PiiCryptoService` is the
 * first, and it is the one holding the key and the keyring opt-in — and the two would drift the
 * day the keyring behaviour changed. It would also make "was this row encrypted?" a question
 * about a code path rather than about a type: with the tokens supplied, the only way to write
 * plaintext here is to hand this method plaintext, which the database then refuses with 23514.
 * CLAUDE.md §4 says the same thing more generally: repositories do database access, not business
 * logic, and choosing how a worker's words are protected is not database access.
 *
 * ── NO READ METHOD, DELIBERATELY ────────────────────────────────────────────────────────
 * The list and the detail read live on `AdminAiTracesRepository`, under `admin/**`, following
 * the `FeedbackRepository` / `AdminFeedbackRepository` split exactly. Two reasons, and the
 * second is the load-bearing one:
 *   * the reader is SELECT-ONLY and `admin-static-guards.test.ts` asserts that on the file, so
 *     a write added to the admin surface fails CI;
 *   * injecting THIS class into the admin module would put a class that can WRITE trace rows
 *     into the admin injector — the shape the "admin must never import the AI cost-totals
 *     WRITER" guard already exists to prevent, for the same reason: the next person who needs
 *     "just fix up this one row" would find it wired.
 *
 * ── APPEND-ONLY. NO UPDATE, NO DELETE, AND THERE MUST NEVER BE ONE ──────────────────────
 * A trace is the record of one completed call; there is nothing about it that can legitimately
 * change afterwards. Erasure is the `ON DELETE cascade` from `workers` — total by construction
 * because `worker_id` is NOT NULL — so `WorkersRepository.hardDelete` needs no line for this
 * table and a delete method here would only ever be a way around the audit trail.
 */
@Injectable()
export class AiTracesRepository {
  constructor(@Inject(DATABASE) private readonly db: Database) {}

  /**
   * Store one trace. Returns whether a row was actually written.
   *
   * IDEMPOTENT ON `ai_call_id`, VIA `ON CONFLICT DO NOTHING` RATHER THAN A CATCH. A BullMQ job
   * is redelivered at-least-once, so the same call reaches this method more than once as a
   * matter of routine — not as an error. Letting the UNIQUE constraint raise 23505 and catching
   * it would work, and would also abort the surrounding transaction in Postgres if this write
   * were ever moved inside one; `DO NOTHING` is the form that stays correct in both positions.
   *
   * The boolean is returned rather than swallowed because "deduped" and "stored" are different
   * facts and the recorder counts them separately — a retry storm that silently re-inserted
   * nothing would otherwise be indistinguishable from a recorder that had stopped working.
   *
   * NOT ON THE CALLER'S TRANSACTION, AND IT TAKES NO `tx` PARAMETER. A trace is telemetry: it
   * must never be able to fail, roll back or slow down the interview turn it describes. There
   * is deliberately no overload that would let a caller enlist it in their transaction, because
   * the first one to do so would couple a worker's reply to a telemetry insert. See
   * {@link import("./ai-trace-recorder.service").AiTraceRecorder} for the surrounding contract.
   *
   * THE CATCH IS A PRIVACY BOUNDARY, NOT ERROR HANDLING — the same one `FeedbackRepository`
   * documents. Drizzle's query error stringifies the whole bound-parameter array into its own
   * `.message`, and `AllExceptionsFilter` logs `.stack` on any 5xx. What that would put in the
   * log aggregator here is both ciphertext tokens for the row being written. Ciphertext is not
   * plaintext, and it is still the encrypted body of a worker's words landing outside the RLS
   * lock, outside the audited read, and next to the `worker_id` that says whose they are.
   */
  async insert(input: AiTraceInsert): Promise<boolean> {
    try {
      const written = await this.db
        .insert(aiCallTraces)
        .values(input)
        .onConflictDoNothing({ target: aiCallTraces.aiCallId })
        .returning({ id: aiCallTraces.id });
      return written.length === 1;
    } catch (err) {
      throw redactQueryParams(err, "ai call trace insert");
    }
  }
}
