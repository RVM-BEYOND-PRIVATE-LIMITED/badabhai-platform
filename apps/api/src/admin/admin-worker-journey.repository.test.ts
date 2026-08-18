import { describe, it, expect } from "vitest";
import { chatMessages, voiceNotes } from "@badabhai/db";
import { AdminWorkerJourneyRepository } from "./admin-worker-journey.repository";
import { captureQueries, expectColumnsAbsent } from "./testing/query-capture";
import { encodeCursor } from "./admin-events.cursor";

/**
 * SQL-SHAPE tests for the worker-journey reads.
 *
 * These assert on the statement that actually reaches Postgres, not on fixture rows. The
 * properties here are about the QUERY — "this read cannot return a transcript, for ANY data",
 * "this predicate matches the index it was written for" — and a fixture only ever proves
 * something for the rows someone thought to insert.
 */

const WORKER = "11111111-1111-4111-8111-111111111111";
const SESSION = "22222222-2222-4222-8222-222222222222";

/**
 * The columns that must NEVER be projected by this surface. The first two are the reason the
 * whole PR carries a PII paragraph: they hold the worker's own words, UNMASKED — pseudonymization
 * happens transiently at the LLM-call boundary and never on the way into these rows.
 */
const RAW_TEXT_COLUMNS = [
  "body_text",
  "transcript_text",
  "transcript_english",
  "answer_text",
  "answer_number",
  "answer_bool",
  "answer_option_keys",
  "value_raw",
  "value_normalized",
  "prompt_text",
  "why_text",
  "retry_text",
  "phone_e164",
  "phone_hash",
  "full_name",
];

/**
 * Columns that MAY be referenced inside a reducing predicate and must never be PROJECTED.
 * Referencing `voice_note_id` in an `IS NOT NULL` is the point; returning its value hands the
 * caller a handle to the row that holds `transcript_text`.
 */
const REDUCED_ONLY: Array<[string, RegExp]> = [
  ["photo_storage_key", /"photo_storage_key"(?!\s+IS\s+NOT\s+NULL)/i],
  ["voice_note_id", /"voice_note_id"(?!\s+IS\s+NOT\s+NULL)/i],
  ["error_message", /"error_message"(?!\s+IS\s+NOT\s+NULL)/i],
];

function expectNoRawText(captured: ReturnType<typeof captureQueries>): void {
  expectColumnsAbsent(captured, RAW_TEXT_COLUMNS);
  for (const [name, bare] of REDUCED_ONLY) {
    expect(bare.test(captured.sql()), `${name} may only appear inside a reducing predicate`).toBe(
      false,
    );
  }
}

const repo = (c: ReturnType<typeof captureQueries>) => new AdminWorkerJourneyRepository(c.db);

// ---------------------------------------------------------------------------
// The guard's own guard.
// ---------------------------------------------------------------------------

describe("the capture helper is CAPABLE of failing (so every absence below means something)", () => {
  it("records a projected transcript column, so the assertions are not vacuous", () => {
    const c = captureQueries();
    c.db.select({ leak: chatMessages.bodyText } as never);
    expect(c.sql()).toContain("body_text");
    expect(() => expectColumnsAbsent(c, ["body_text"])).toThrow(/must never be selected/);
  });

  it("...and a projected voice transcript too", () => {
    const c = captureQueries();
    c.db.select({ leak: voiceNotes.transcriptText } as never);
    expect(() => expectColumnsAbsent(c, ["transcript_text"])).toThrow(/must never be selected/);
  });
});

// ---------------------------------------------------------------------------
// THE HARD LINE: no raw transcript text, on any read.
// ---------------------------------------------------------------------------

describe("NO read on this surface projects raw worker text", () => {
  it("every session-detail read is transcript-free", async () => {
    for (const run of [
      (c: ReturnType<typeof captureQueries>) => repo(c).findSession(SESSION),
      (c: ReturnType<typeof captureQueries>) => repo(c).listSessionAnswers(SESSION),
      (c: ReturnType<typeof captureQueries>) => repo(c).listSessionVoiceAnswers(SESSION),
      (c: ReturnType<typeof captureQueries>) => repo(c).listSessionAiJobs(SESSION),
      (c: ReturnType<typeof captureQueries>) => repo(c).sessionAiCost(SESSION),
      (c: ReturnType<typeof captureQueries>) => repo(c).listSettledKeys(SESSION),
    ]) {
      const c = captureQueries();
      await run(c);
      expectNoRawText(c);
    }
  });

  it("every funnel read is transcript-free and PII-free", async () => {
    for (const run of [
      (c: ReturnType<typeof captureQueries>) => repo(c).findWorkerCore(WORKER),
      (c: ReturnType<typeof captureQueries>) =>
        repo(c).countWorkerSubjectEvents(WORKER, ["worker.otp_verified"]),
      (c: ReturnType<typeof captureQueries>) => repo(c).countInterviewKitDownloads(WORKER),
      (c: ReturnType<typeof captureQueries>) => repo(c).packAnswerStatusCounts(WORKER),
      (c: ReturnType<typeof captureQueries>) => repo(c).answeredPackVersions(WORKER),
      (c: ReturnType<typeof captureQueries>) => repo(c).resumeStats(WORKER),
      (c: ReturnType<typeof captureQueries>) => repo(c).currentProfile(WORKER),
      (c: ReturnType<typeof captureQueries>) => repo(c).applicationActionCounts(WORKER),
      (c: ReturnType<typeof captureQueries>) => repo(c).listSessions(WORKER, {}, null, 10),
    ]) {
      const c = captureQueries();
      await run(c);
      expectNoRawText(c);
    }
  });

  it("the message count is a COUNT — `chat_messages` is never selected from", async () => {
    const c = captureQueries();
    await repo(c).countMessagesBySession([SESSION]);
    expect(c.sql()).toContain("session_id");
    expect(c.sql()).not.toContain("body_text");
  });

  it("`conversation_state` is reduced IN SQL — the column itself is never projected", async () => {
    // It is ONE jsonb blob holding both `ask_counts` (integers — the point) and `answer_map`
    // (records carrying `value_raw`, the worker's verbatim words). Selecting the column to
    // read two scalars off it would pull those words into this process.
    const c = captureQueries();
    await repo(c).findSession(SESSION);
    const sql = c.sql();
    expect(sql).toContain("ask_counts");
    expect(sql).toContain("answer_map");
    // ...and it only ever appears followed by a `->` extraction or an IS NOT NULL test.
    const bare = /"conversation_state"(?!\s*(->|IS\s+NOT\s+NULL))/i;
    expect(bare.test(sql), "conversation_state must never be projected whole").toBe(false);
    // The lateral projects exactly two scalars per answer record — never a value field.
    expect(sql).toContain("'question_key'");
    expect(sql).toContain("'status'");
    expect(sql).not.toContain("'value_raw'");
  });

  it("the voice-answer read reduces `voice_note_id` to a boolean and keeps the error CODE only", async () => {
    const c = captureQueries();
    await repo(c).listSessionVoiceAnswers(SESSION);
    const sql = c.sql();
    expect(sql).toMatch(/"voice_note_id"\s+IS\s+NOT\s+NULL/i);
    // The closed-set failure code IS projected — it is a code, never a provider message.
    expect(sql).toContain("transcript_error_code");
    // The supersession chain is projected in full: it is the evidence a worker had to repeat
    // themselves, which is the whole reason this table is on the page.
    expect(sql).toContain("superseded_at");
    expect(sql).toContain("superseded_by_id");
  });

  it("the ai_jobs read reduces `error_message` to a boolean", async () => {
    const c = captureQueries();
    await repo(c).listSessionAiJobs(SESSION);
    expect(c.sql()).toMatch(/"error_message"\s+IS\s+NOT\s+NULL/i);
  });

  it("`has_photo` is an IS NOT NULL test — the storage key value is never fetched", async () => {
    const c = captureQueries();
    await repo(c).findWorkerCore(WORKER);
    expect(c.sql()).toMatch(/"photo_storage_key"\s+IS\s+NOT\s+NULL/i);
  });
});

// ---------------------------------------------------------------------------
// Index-matchability: the predicates are written to hit the indexes that exist.
// ---------------------------------------------------------------------------

describe("predicates match the indexes they were written for", () => {
  it("the kit read carries BOTH halves of `events_interview_kit_worker_idx` (0078)", async () => {
    // PARTIAL on the event name and built on `payload->>'worker_id'`. Both must appear
    // verbatim or the planner cannot prove the partial covers the query, and this becomes a
    // sequential scan of the largest table in the system.
    const c = captureQueries();
    await repo(c).countInterviewKitDownloads(WORKER);
    const sql = c.sql();
    expect(sql).toContain("event_name");
    expect(sql).toMatch(/"payload"\s*->>\s*'worker_id'/i);
    expect(c.params).toContain("interview_kit.downloaded");
    expect(c.params).toContain(WORKER);
  });

  it("the ai_jobs read carries the partial index's `job_type` predicate", async () => {
    // `ai_jobs_extraction_session_idx` is PARTIAL on job_type='profile_extraction' and leads
    // on `input_ref->>'session_id'`. It is also the ONLY job type that records a session id,
    // so the filter costs no completeness.
    const c = captureQueries();
    await repo(c).listSessionAiJobs(SESSION);
    expect(c.sql()).toContain("job_type");
    expect(c.params).toContain("profile_extraction");
    expect(c.sql()).toMatch(/"input_ref"\s*->>\s*'session_id'/i);
  });

  it("the ai_jobs sort spells out DESC NULLS LAST, matching the index's own ordering", async () => {
    // Postgres defaults DESC to NULLS FIRST and pathkeys compare `nulls_first` STRICTLY, so a
    // bare `desc()` does not match the index and the planner adds a Sort.
    const c = captureQueries();
    await repo(c).listSessionAiJobs(SESSION);
    expect(c.sql()).toMatch(/created_at"?\s+desc\s+nulls\s+last/i);
  });

  it("the worker-subject event read filters on (subject_type, subject_id) — the indexed pair", async () => {
    const c = captureQueries();
    await repo(c).countWorkerSubjectEvents(WORKER, ["worker.otp_verified", "worker.test_login"]);
    const sql = c.sql();
    expect(sql).toContain("subject_type");
    expect(sql).toContain("subject_id");
    expect(c.params).toContain("worker");
    expect(c.params).toContain(WORKER);
  });
});

// ---------------------------------------------------------------------------
// Keyset correctness on the session list.
// ---------------------------------------------------------------------------

describe("session list — keyset, scoped, bounded", () => {
  it("is always scoped to ONE worker and ordered (started_at, id) DESC", async () => {
    const c = captureQueries();
    await repo(c).listSessions(WORKER, {}, null, 10);
    const sql = c.sql();
    expect(sql).toContain("worker_id");
    expect(sql).toContain("started_at");
    expect(c.params).toContain(WORKER);
  });

  it("a cursor binds BOTH the timestamp and the id tie-breaker", async () => {
    // Without the id term the predicate is `started_at < t`, which drops every row sharing the
    // boundary timestamp — and a worker's sessions can share one, because a client retry can
    // open two inside a millisecond.
    const c = captureQueries();
    const cursor = encodeCursor({ occurredAt: "2026-08-04T12:00:00.000Z", id: "abc" });
    await repo(c).listSessions(WORKER, {}, { occurredAt: "2026-08-04T12:00:00.000Z", id: "abc" }, 10);
    expect(cursor).toBeTruthy();
    const sql = c.sql();
    expect(sql).toMatch(/started_at"?\s*<\s*\$/i);
    expect(sql).toMatch(/"id"\s*<\s*\$/i);
  });

  it("the cursor timestamp is bound as an ISO STRING — mapped, not handed to the driver raw", async () => {
    // `lt(column, value)` runs the column's `mapToDriverValue`, which turns a Date into the ISO
    // string postgres-js requires. An interpolated `sql` template renders IDENTICAL SQL and
    // passes the Date object through unmapped — which 500s every page past the first. The
    // parameter list is the only place short of a real database where the two differ.
    const c = captureQueries();
    await repo(c).listSessions(WORKER, {}, { occurredAt: "2026-08-04T12:00:00.000Z", id: "abc" }, 10);
    expect(c.params).toContain("2026-08-04T12:00:00.000Z");
    expect(c.params.some((p) => p instanceof Date)).toBe(false);
  });

  it("a status filter is applied server-side, never by the caller", async () => {
    const c = captureQueries();
    await repo(c).listSessions(WORKER, { status: "abandoned" }, null, 10);
    expect(c.params).toContain("abandoned");
  });
});

// ---------------------------------------------------------------------------
// The pack denominator, at the SQL layer.
// ---------------------------------------------------------------------------

describe("pack-version derivation — the denominator's SQL", () => {
  it("groups the worker's OWN answers by (pack_id, pack_version)", async () => {
    const c = captureQueries();
    await repo(c).answeredPackVersions(WORKER);
    const sql = c.sql();
    expect(sql).toContain("pack_id");
    expect(sql).toContain("pack_version");
    expect(sql).toContain("worker_id");
    expect(c.params).toContain(WORKER);
  });

  it("counts items for EXACTLY the pairs it was given — both halves of every pair are bound", async () => {
    const c = captureQueries();
    await repo(c).countPackItems([
      { packId: "qp_welding", packVersion: 1 },
      { packId: "qp_universal", packVersion: 3 },
    ]);
    // Version-qualified, not pack-qualified: `pack_id = 'qp_welding'` alone would sum EVERY
    // version of that pack, which is the same wrong answer as reading the active one.
    expect(c.params).toEqual(expect.arrayContaining(["qp_welding", 1, "qp_universal", 3]));
  });

  it("no pairs ⇒ no query at all (an unfiltered count would be the whole corpus)", async () => {
    const c = captureQueries();
    const out = await repo(c).countPackItems([]);
    expect(out).toEqual([]);
    expect(c.statements).toEqual([]);
  });

  it("listPackItems asks only for the ranking inputs — no interview copy", async () => {
    const c = captureQueries();
    await repo(c).listPackItems([{ packId: "qp_welding", packVersion: 1 }]);
    const sql = c.sql();
    expect(sql).toContain("max_asks");
    expect(sql).toContain("display_order");
    expect(sql).toContain("question_key");
    expect(sql).not.toContain("prompt_text");
  });
});

// ---------------------------------------------------------------------------
// Settled keys mean exactly what the engine means.
// ---------------------------------------------------------------------------

describe("settled keys", () => {
  it("filters to answered|declined and EXCLUDES unanswered (the engine's `isSettled`)", async () => {
    const c = captureQueries();
    await repo(c).listSettledKeys(SESSION);
    expect(c.params).toContain("answered");
    expect(c.params).toContain("declined");
    // `unanswered` means the engine asked and gave up — the opposite of settled. Including it
    // would make every skipped question look like a completion.
    expect(c.params).not.toContain("unanswered");
  });
});

// ---------------------------------------------------------------------------
// Read-only.
// ---------------------------------------------------------------------------

describe("the journey repository is SELECT-only", () => {
  it("exposes no method whose name suggests a write", () => {
    const methods = Object.getOwnPropertyNames(AdminWorkerJourneyRepository.prototype);
    for (const m of methods) {
      expect(m).not.toMatch(/^(insert|update|delete|upsert|create|save|write)/i);
    }
  });
});
