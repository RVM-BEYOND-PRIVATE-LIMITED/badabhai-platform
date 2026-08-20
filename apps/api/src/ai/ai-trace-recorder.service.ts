import { Injectable, Logger } from "@nestjs/common";
import type { AICallMetadata } from "@badabhai/ai-contracts";
import {
  AI_TRACE_ERROR_CODES,
  type AiCostTaskType,
  type AiTraceErrorCode,
} from "@badabhai/event-schema";

import { PiiCryptoService } from "../common/pii-crypto.service";
import { AiTracesRepository } from "./ai-traces.repository";

/**
 * WHO THIS CALL BELONGS TO. Structurally identical to `AiCostAttribution`, and identical for the
 * same reason — a session implies a worker, in the type — but it is a SEPARATE type because the
 * two consume it differently and the difference is the whole design of migration 0083:
 *
 *   * a cost row with no worker is legitimate and is still WRITTEN (payer spend counts
 *     platform-wide);
 *   * a trace with no worker is DROPPED, because `ai_call_traces.worker_id` is NOT NULL and that
 *     NOT NULL is the DSAR erasure guarantee.
 *
 * Sharing one type would invite the assumption that the two recorders treat an absent worker the
 * same way. They deliberately do not.
 */
export type AiTraceAttribution =
  | { readonly workerId?: null; readonly sessionId?: null }
  | { readonly workerId: string; readonly sessionId?: string | null };

/**
 * The two strings a trace is FOR — and the ONE place they may come from.
 *
 * ── THEY COME OFF `AICallMetadata`, NEVER OFF THE CALL SITE ─────────────────────────────
 * `meta.prompt_text` / `meta.response_text` are written by
 * `apps/ai-service/app/ai/router.py::_record_trace_text`, which is their only writer and which
 * runs both values through the SAME mask object the Langfuse SDK is handed
 * (`masked_trace_text` → `app/pseudonymize.py`). So what lands in `prompt_enc` is
 * POST-BOUNDARY: the pseudonymization gate ran on it, in the service that owns that gate,
 * before it ever crossed back. That is what makes the claim in `schema/ai-trace.ts`'s header
 * — "those strings pass the pseudonymization boundary before they are minted" — TRUE of what
 * this class actually stores.
 *
 * ── THE ALTERNATIVE THAT WAS BUILT FIRST, AND WHY IT WAS WRONG ──────────────────────────
 * The first cut took the text from a thunk at each call site: `serializeForTrace(request)`,
 * i.e. the REQUEST this app sent. That request is assembled HERE, on the near side of the hop,
 * so on a worker surface it is the worker's own words with nothing taken out of them — a name,
 * a phone number and a street address, measured verbatim in `prompt_enc`. Every containment
 * control still held, but the containment was doing work the producer should have done, and
 * two shipped documents (this table's header and its migration) asserted the opposite. The
 * clean text already existed on the far side; it was being discarded by a `z.object` that had
 * no field for it (`packages/ai-contracts/src/common.ts`). Reading it here is the fix.
 *
 * ── FAIL CLOSED TO *NO TEXT*, NEVER TO *RAW TEXT* ───────────────────────────────────────
 * When the ai-service supplies nothing — `AI_CALL_TRACE_TEXT_ENABLED` off (the default), a
 * surface that does not route through `AIRouter` (embeddings, STT, translate), or an older
 * ai-service that predates the field — both halves are `null` and the trace stores its
 * metadata alone. A trace with no text is a smaller thing than we wanted. A trace with RAW
 * text is a different thing than we said, and there is no posture in which the second is the
 * better failure.
 *
 * Either field may also be null for an ordinary reason: a call that failed before a reply has
 * no response, and a surface whose input is audio has no prompt.
 */
export interface AiTraceText {
  readonly prompt: string | null;
  readonly response: string | null;
}

/** Membership test for the closed error-code set. A Set so the mapper is O(1), not O(n). */
const KNOWN_ERROR_CODES: ReadonlySet<string> = new Set(AI_TRACE_ERROR_CODES);

/**
 * Count CHARACTERS (Unicode code points), not UTF-16 code units.
 *
 * `"".length` is 2 for one emoji and 1 for one Devanagari letter, while Postgres `char_length`
 * — which is what the column's own CHECK is written against and what a reader will compare to —
 * counts code points. The two agree for every BMP character, which is all of Hindi and all of
 * Latin, so the difference only ever shows up on emoji. Worth getting right anyway: the entire
 * privacy argument for this column is that a LENGTH is not the text, and a length that is
 * off-by-a-factor for some inputs is a worse number than one that is simply correct.
 *
 * Iterating rather than `[...s].length` on purpose: the spread allocates an array as large as
 * the string, and a prompt can be tens of kilobytes on the extraction path.
 */
function charCount(text: string): number {
  let count = 0;
  for (const _ of text) count += 1;
  return count;
}

/**
 * THE WRITER OF `ai_call_traces` (migration 0083) — the prompt and the completion, for the one
 * question `ai.cost_recorded` cannot answer.
 *
 * Wired at the SAME six call sites as {@link import("./ai-cost-recorder.service").AiCostRecorder}
 * and deliberately kept a separate class: the cost record is an EVENT on the append-only spine
 * that must commit, and the trace is a best-effort telemetry row that must never be able to fail
 * anything. Folding them together would mean one of those two contracts quietly becoming the
 * other's.
 *
 * ── THE FOUR RULES, IN THE ORDER THEY FIRE ──────────────────────────────────────────────
 *
 * 1. NO METADATA, NO TRACE. `meta` is null only when the ai-service was UNREACHABLE or its
 *    reply failed the contract (`AiService` returns `ai_metadata: null` on those paths) —
 *    there was no call to describe, and `ai_call_id` (the UNIQUE key) comes from the metadata,
 *    so there would be nothing to key the row on. Same no-op the cost recorder makes, so no
 *    call site has to branch.
 *
 *    ⚠ IT DOES **NOT** FIRE ON THE MOCK POSTURE, which an earlier version of this comment
 *    claimed. `apps/ai-service/app/ai/router.py` builds `AICallMetadata` on its TERMINAL path
 *    unconditionally (`real_call=False, success=True`), so a mocked call — every developer
 *    machine, and staging per TD81 — returns metadata and IS traced. Measured, not reasoned:
 *    `POST /profile/extract` in the default posture answers 200 with `ai_metadata` present.
 *    That is the intended posture and not a leak: the text comes from `meta.prompt_text`,
 *    which the router masks on the mock path exactly as on the real one (its `mock_response`
 *    for `/profile/extract` is derived from raw worker text, which is precisely why the mask
 *    is applied on the response leg too).
 *
 * 2. NO WORKER, NO TRACE — AND THAT IS A DELETION, NOT A DEGRADATION. `worker_id` is NOT NULL
 *    with `ON DELETE cascade`, and that single choice IS the DSAR design: `WorkersRepository
 *    .hardDelete` enumerates no child tables, so the cascade is the erasure coverage and a
 *    nullable column would have created a class of prompt text that survives a deletion request
 *    forever. The cost of that strictness is paid HERE, once, explicitly: the payer-side calls
 *    (`skill_embedding` on a posting write, `job_posting_chat_turn`) have no worker and are
 *    DROPPED. Losing an unattributable trace is a telemetry gap; keeping one is an un-erasable
 *    record of somebody's words. The drops are COUNTED — see {@link droppedCount} — so the gap
 *    is a number somebody can read rather than a silence.
 *
 * 3. LENGTHS FROM THE PLAINTEXT, BEFORE THE ENCRYPT. `prompt_chars` / `response_chars` describe
 *    the text, not its ciphertext, and they are what the ungated list serves so "how big was
 *    this call" is answerable without anyone decrypting anything. Measuring after encryption
 *    would silently measure base64 overhead instead.
 *
 * 4. BEST EFFORT, ALWAYS, IN EVERY DIRECTION. One try/catch around everything; the method
 *    resolves rather than rejecting on any failure. It opens no transaction and joins none, so
 *    an insert failure cannot roll back the caller's work, and a slow insert cannot hold a lock
 *    the caller's transaction is waiting on. A trace failing must never cost a worker their
 *    interview turn or a payer their posting.
 *
 * ── WHY IT IS `await`ED AT THE CALL SITES DESPITE BEING BEST-EFFORT ─────────────────────
 * "Best effort" is about the FAILURE, not about the ordering. A floating promise would produce
 * unhandled-rejection noise the moment this class's own catch was ever narrowed, would make the
 * log line arrive after the response it describes, and would make every test of it racy. The
 * cost of awaiting is one insert on a path that has just waited on an LLM.
 */
@Injectable()
export class AiTraceRecorder {
  private readonly logger = new Logger(AiTraceRecorder.name);

  /** Traces refused for want of a worker id. Expected on the payer surfaces — see rule 2. */
  private dropped = 0;
  /** Traces the database refused or the encrypt failed on. NOT expected; see {@link noteFailure}. */
  private failed = 0;

  constructor(
    private readonly repo: AiTracesRepository,
    // THE SAME BOUNDARY THE REST OF apps/api USES, never a second key. `PiiCryptoService` owns
    // the AES key and the TD22-1 keyring opt-in, so a trace written today is readable by the
    // same `decrypt` — and rotatable by the same backfill — as every other ciphertext column.
    private readonly pii: PiiCryptoService,
  ) {}

  /**
   * Store the trace for ONE completed AI call. Never throws.
   *
   * NAMED `capture`, NOT `record`. `ai-cost-coverage.test.ts` derives the set of ledgered task
   * types by scanning apps/api source for `this.<anything>.record(` and pulling the quoted
   * lowercase literals out of the argument window. A second recorder called `record` would feed
   * that scan its own arguments — making a load-bearing coverage guard depend on a class that
   * has nothing to do with the cost ledger. Different verb, different concern, no coupling.
   *
   * NO TEXT PARAMETER, AND THAT ABSENCE IS A CONTROL. There is deliberately no way for a call
   * site to hand this method a string: the only text it will store is the text the ai-service
   * already masked, read off `meta` below. A `text` argument existed here once and is what put
   * a worker's raw name, phone and address into `prompt_enc` — see {@link AiTraceText}.
   *
   * @param meta   the provider call's metadata, or null when the service was unreachable or
   *               answered off-contract (rule 1). Carries the masked text.
   * @param attribution whose call it was. Absent worker ⇒ the trace is dropped (rule 2). It is
   *               passed IN rather than looked up here for the same reason the cost recorder
   *               takes it: only the caller knows, and a recorder that guessed would be a
   *               recorder that filed one worker's words under another's name.
   */
  async capture(
    meta: AICallMetadata | null,
    taskType: AiCostTaskType,
    aiJobId: string | null,
    correlationId: string,
    attribution: AiTraceAttribution = {},
  ): Promise<void> {
    // --- Rule 1. No call to describe, and no id to key the row on.
    if (!meta) return;

    // --- Rule 2. Unattributable ⇒ dropped, counted, and never stored faceless.
    const workerId = attribution.workerId ?? null;
    if (workerId === null) {
      this.noteDrop(taskType);
      return;
    }

    try {
      // THE TEXT, FROM THE ONE PLACE IT MAY COME FROM. `?? null` normalises an older
      // ai-service's absent field to the same "no text" the flag-off case produces — see
      // {@link AiTraceText} for why the fallback is *no text* and never the caller's request.
      const prompt = meta.prompt_text ?? null;
      const response = meta.response_text ?? null;

      // --- Rule 3. Lengths from the PLAINTEXT, before anything is encrypted.
      const promptChars = prompt === null ? null : charCount(prompt);
      const responseChars = response === null ? null : charCount(response);

      await this.repo.insert({
        aiCallId: meta.ai_call_id,
        workerId,
        sessionId: attribution.sessionId ?? null,
        aiJobId,
        // Bounded at the schema (128 chars) and PII-free by construction — it is the
        // request-scoped id the API log already carries, which is what makes a trace joinable
        // back to the request that produced it.
        //
        // `|| null` FOR THE SAME REASON `model_name` HAS IT, THREE LINES DOWN, and it is not
        // theoretical: `ProfileExtractionProcessor` passes `job.correlationId ?? ""` at both of
        // its queue-driven call sites, and the column's CHECK is `BETWEEN 1 AND 128`, which `""`
        // fails with 23514. Because the insert is ONE statement, that 23514 does not lose the
        // correlation id — it loses the WHOLE ROW, i.e. the `profile_parse` and Phase-C
        // `profile_extraction` traces, the two the processor's own comments call the most
        // valuable in the system. Measured against a live Postgres: `correlation_id = ''`
        // is refused with SQLSTATE 23514 and `failedCount` goes up by one.
        correlationId: correlationId.slice(0, 128) || null,
        taskType,
        // `|| null`, not `?? null`: the metadata's model/provider fields are `z.string()` with
        // no `.min(1)`, so an unlabelled call arrives as `""` — and the column's CHECK is
        // `BETWEEN 1 AND 128`, which an empty string fails with 23514. `?? null` would have
        // turned "we do not know the model" into a dropped trace.
        modelName: meta.model_name || null,
        // NULL, AND KNOWINGLY SO. The prompt TEMPLATE and its version are the ai-service's —
        // `main.py` stamps a `prompt_version` on its own trace — and no response contract
        // returns either to this app. The columns exist because the QUESTION ("which template
        // wrote this?") is the right one for the table to be able to answer; filling them with
        // something this app invented would answer it wrongly, which is worse than null.
        //
        // STILL OPEN, and now the ONLY thing left of that shape: the sibling gap — the text
        // itself — closed by adding `prompt_text`/`response_text` to `AICallMetadata`, and
        // `AIRouter` already resolves a `ResolvedPrompt` carrying `name`/`version`. Two more
        // fields on the same model closes this one the same way. Not done here because it is a
        // cross-package widening with no finding behind it, and `apps/admin-web` renders the
        // null with copy that says exactly why it is null.
        promptName: null,
        promptVersion: null,
        promptEnc: prompt === null ? null : this.pii.encrypt(prompt),
        responseEnc: response === null ? null : this.pii.encrypt(response),
        promptChars,
        responseChars,
        realCall: meta.real_call,
        success: meta.success,
        errorCode: meta.success ? null : AiTraceRecorder.toErrorCode(meta.error_code),
      });
    } catch (err) {
      // --- Rule 4. Everything above is telemetry. Nothing here may reach the caller.
      this.noteFailure(taskType, err);
    }
  }

  /** How many traces have been dropped for want of a worker id this process. Read by tests. */
  get droppedCount(): number {
    return this.dropped;
  }

  /** How many traces have failed to store this process. Read by tests. */
  get failedCount(): number {
    return this.failed;
  }

  /**
   * Narrow an arbitrary provider `error_code` to a member of the CLOSED set, or to one of two
   * constants of our own.
   *
   * AN ALLOW-LIST RETURNING A CONSTANT — never a shape test, never a truncation of the input.
   * `error_code` is produced outside this codebase; the contract says it is "a closed-set
   * transport reason code or a bare exception type name", which is a claim about today's
   * `router.py` rather than a property anything here enforces, and provider SDKs routinely put
   * the request back inside an exception message. A regex saying "this looks code-shaped" cannot
   * say "this is not a fragment of what the worker typed"; membership can. So an unrecognised
   * string is DISCARDED and replaced by `provider_error`, which keeps the only signal a triage
   * query actually needs — it failed on the far side — and carries none of the input.
   *
   * The absent case is `unknown_error` rather than null: `success === false` with no code is a
   * real and distinguishable state ("it failed and told us nothing"), and null on this column
   * means "did not fail".
   */
  private static toErrorCode(raw: string | null | undefined): AiTraceErrorCode {
    if (raw === null || raw === undefined || raw === "") return "unknown_error";
    return KNOWN_ERROR_CODES.has(raw) ? (raw as AiTraceErrorCode) : "provider_error";
  }

  /**
   * Count one dropped trace, and say so on a LOGARITHMIC schedule (the 1st, 10th, 100th …).
   *
   * NOT PER CALL, and the payer surfaces are why: `skill_embedding` fans out one call per skill
   * phrase on every posting write and every one of them is unattributable BY DESIGN, so a line
   * per drop would be a permanent, high-volume log of the system working correctly — which is
   * how a real signal ends up filtered out. Once-only would be the other failure: an operator
   * reading a single line from three days ago cannot tell an ongoing gap from a settled one.
   * Powers of ten grow with the problem and stay bounded.
   *
   * PII-FREE, and it has to be: a task-type label and two integers. No prompt, no response, no
   * worker id, no session id — a drop is by definition a call with no worker to name.
   */
  private noteDrop(taskType: string): void {
    this.dropped += 1;
    if (!AiTraceRecorder.isLogPoint(this.dropped)) return;
    this.logger.log(
      `ai trace DROPPED (no worker to attribute it to) task=${taskType}; ` +
        `${this.dropped} dropped this process. Expected on the payer surfaces — ` +
        `ai_call_traces.worker_id is NOT NULL because that cascade IS the DSAR erasure.`,
    );
  }

  /**
   * Count one failed trace write, on the same logarithmic schedule and at WARN.
   *
   * Louder than a drop because it means something is wrong rather than something is by design —
   * an unmigrated database (0083 not applied), a 23514 from the ciphertext CHECK, an encrypt
   * failure. Still not per-call: an unmigrated deploy fails EVERY trace on EVERY AI call, and
   * that is precisely the case where per-call logging would bury the first line under the
   * millionth.
   *
   * `String(err)` is safe here and is chosen over `err.message` on purpose in the other
   * direction to the usual rule: `AiTracesRepository.insert` has already replaced any
   * parameter-bearing drizzle error with a `RedactedQueryError`, whose message carries the SQL
   * text and the SQLSTATE and no bound values. An unredacted error reaching this line would be
   * a bug there, not here.
   */
  private noteFailure(taskType: string, err: unknown): void {
    this.failed += 1;
    if (!AiTraceRecorder.isLogPoint(this.failed)) return;
    this.logger.warn(
      `ai trace write FAILED task=${taskType} (non-fatal — the call it describes succeeded); ` +
        `${this.failed} failed this process: ${String(err)}`,
    );
  }

  /** True at 1, 10, 100, 1000 … — the logarithmic schedule both counters log on. */
  private static isLogPoint(count: number): boolean {
    if (count < 1) return false;
    let step = 1;
    while (step < count) step *= 10;
    return step === count;
  }
}
