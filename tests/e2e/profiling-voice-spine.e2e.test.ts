import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDbClient, workers, chatSessions, type DbClient } from "@badabhai/db";

/**
 * Migration 0071 — the voice profiling form's data spine, proved against real Postgres.
 *
 * WHY AT THE DATABASE AND NOT IN A UNIT TEST. Every guarantee here is a constraint, and a
 * constraint that is never exercised is a comment with a semicolon. Each case below asserts the
 * SPECIFIC constraint that fired, not merely that "something was rejected" — a row rejected by the
 * wrong constraint means the intended one is dead and nobody would know.
 *
 * The two invariants worth the most:
 *   1. `pva_session_question_live_uq` — at most ONE live answer per question per session. This is
 *      what makes "Phir se bolein" a supersession rather than a race, and it is the only thing
 *      standing between a re-record and two rows the review screen cannot choose between.
 *   2. `wa_value_present_chk` — `value_kind` names the populated column, and exactly one is
 *      populated. Without the "and the right one" half, a row could claim `number` while carrying
 *      only text, and every reader that trusted `value_kind` would silently read NULL.
 *
 * Opt-in, same lane as the rest of this suite:
 *   1. docker compose up -d postgres
 *   2. pnpm db:migrate            # applies 0071
 *   3. RUN_E2E=1 pnpm --filter @badabhai/e2e test
 */

const RUN = process.env.RUN_E2E === "1";
const DATABASE_URL =
  process.env.E2E_DATABASE_URL ??
  process.env.DATABASE_URL ??
  "postgresql://badabhai:badabhai@localhost:5432/badabhai";

describe.skipIf(!RUN)("Voice profiling data spine (migration 0071)", () => {
  let client!: DbClient;
  let workerId = "";
  let sessionId = "";

  /**
   * Run a statement that MUST be rejected and return the constraint Postgres blamed.
   *
   * Returning the name rather than a boolean is the whole point: it is what turns "the insert
   * failed" into "the insert failed FOR THE STATED REASON".
   */
  async function rejectedBy(statement: string): Promise<string> {
    try {
      await client.sql.unsafe(statement);
    } catch (error) {
      const e = error as { constraint_name?: string; code?: string };
      return e.constraint_name ?? e.code ?? "unknown";
    }
    return "ACCEPTED";
  }

  beforeAll(async () => {
    client = createDbClient(DATABASE_URL);
    const [w] = await client.db
      .insert(workers)
      .values({ phoneE164: "v1.0071-spine", phoneHash: randomUUID(), status: "active" })
      .returning({ id: workers.id });
    workerId = w!.id;
    const [s] = await client.db
      .insert(chatSessions)
      .values({ workerId })
      .returning({ id: chatSessions.id });
    sessionId = s!.id;
  });

  afterAll(async () => {
    // The workers cascade takes both new tables with it; the explicit delete is belt-and-braces
    // for a partially-failed run, and its success is itself asserted below.
    if (workerId) await client.sql`delete from workers where id = ${workerId}`;
    await client.sql.end({ timeout: 5 });
  });

  // -------------------------------------------------------------------------
  // chat_sessions — the pack pin
  // -------------------------------------------------------------------------

  it("rejects half a pack pin, and accepts a complete one", async () => {
    // Half a pin names an interview nobody can reproduce: the pack without its version cannot say
    // which questions were asked, and the version alone says nothing at all.
    expect(
      await rejectedBy(`UPDATE chat_sessions SET pack_id = 'qp_universal' WHERE id = '${sessionId}'`),
    ).toBe("chat_sessions_pack_pin_chk");
    expect(
      await rejectedBy(`UPDATE chat_sessions SET pack_version = 2 WHERE id = '${sessionId}'`),
    ).toBe("chat_sessions_pack_pin_chk");

    await client.sql`
      update chat_sessions set pack_id = 'qp_universal', pack_version = 1 where id = ${sessionId}`;
    const [row] = await client.sql`select pack_id, pack_version from chat_sessions where id = ${sessionId}`;
    expect(row).toMatchObject({ pack_id: "qp_universal", pack_version: 1 });
  });

  // -------------------------------------------------------------------------
  // worker_attributes — the 77% of the corpus that had no destination
  // -------------------------------------------------------------------------

  describe("worker_attributes", () => {
    it("stores one live value per (worker, attribute_key) and rejects a second", async () => {
      await client.sql`
        insert into worker_attributes (worker_id, attribute_key, value_kind, value_bool)
        values (${workerId}, 'forklift', 'boolean', true)`;

      expect(
        await rejectedBy(`
          INSERT INTO worker_attributes (worker_id, attribute_key, value_kind, value_bool)
          VALUES ('${workerId}', 'forklift', 'boolean', false)`),
      ).toBe("wa_worker_key_uq");

      // A re-interview UPDATEs. That is the entire reason the uniqueness is on the pair.
      await client.sql`
        update worker_attributes set value_bool = false, updated_at = now()
        where worker_id = ${workerId} and attribute_key = 'forklift'`;
      const [row] = await client.sql`
        select value_bool from worker_attributes where worker_id = ${workerId} and attribute_key = 'forklift'`;
      expect(row!.value_bool).toBe(false);
    });

    it("forces value_kind to name the populated column — and only that one", async () => {
      // Claims `number`, carries text. Reading `value_number` on this row would return NULL and
      // the caller would conclude the worker never answered.
      expect(
        await rejectedBy(`
          INSERT INTO worker_attributes (worker_id, attribute_key, value_kind, value_text)
          VALUES ('${workerId}', 'shift_work', 'number', 'three')`),
      ).toBe("wa_value_present_chk");

      // Two populated columns: which one is the answer?
      expect(
        await rejectedBy(`
          INSERT INTO worker_attributes (worker_id, attribute_key, value_kind, value_bool, value_text)
          VALUES ('${workerId}', 'shift_work', 'boolean', true, 'yes')`),
      ).toBe("wa_value_present_chk");

      // No value at all is a captured answer with nothing captured.
      expect(
        await rejectedBy(`
          INSERT INTO worker_attributes (worker_id, attribute_key, value_kind)
          VALUES ('${workerId}', 'shift_work', 'boolean')`),
      ).toBe("wa_value_present_chk");
    });

    it("rejects an attribute_key that would break an event payload", async () => {
      // The SAME slug filter `question_pack_item.question_key` carries, because this key reaches
      // event payloads — and a bad id there does not fail loudly, it makes the flush discard a
      // completed interview.
      expect(
        await rejectedBy(`
          INSERT INTO worker_attributes (worker_id, attribute_key, value_kind, value_bool)
          VALUES ('${workerId}', 'Shift-Work!', 'boolean', true)`),
      ).toBe("wa_attribute_key_chk");
    });

    it("stores multi_select answers as a JSON ARRAY, empty included, and rejects an object", async () => {
      expect(
        await rejectedBy(`
          INSERT INTO worker_attributes (worker_id, attribute_key, value_kind, value_text_list)
          VALUES ('${workerId}', 'pipe_material', 'text_list', '{"a":1}'::jsonb)`),
      ).toBe("wa_value_text_list_shape_chk");

      await client.sql`
        insert into worker_attributes (worker_id, attribute_key, value_kind, value_text_list)
        values (${workerId}, 'pipe_material', 'text_list', '["pvc","gi"]'::jsonb)`;
      // An EMPTY list is a real answer — "none of these" is not the same as "unanswered", and
      // collapsing the two would re-ask a question the worker has already closed.
      await client.sql`
        insert into worker_attributes (worker_id, attribute_key, value_kind, value_text_list)
        values (${workerId}, 'measuring_tools', 'text_list', '[]'::jsonb)`;

      const rows = await client.sql`
        select attribute_key, value_text_list from worker_attributes
        where worker_id = ${workerId} and value_kind = 'text_list' order by attribute_key`;
      expect(rows.map((r) => r.attribute_key)).toEqual(["measuring_tools", "pipe_material"]);
      expect(rows[0]!.value_text_list).toEqual([]);
      expect(rows[1]!.value_text_list).toEqual(["pvc", "gi"]);
    });

    it("rejects half a pack pin on the provenance columns", async () => {
      expect(
        await rejectedBy(`
          INSERT INTO worker_attributes (worker_id, attribute_key, value_kind, value_bool, pack_id)
          VALUES ('${workerId}', 'night_work', 'boolean', true, 'qp_universal')`),
      ).toBe("wa_pack_pin_chk");
    });
  });

  // -------------------------------------------------------------------------
  // profiling_voice_answer — the evidence, and supersession
  // -------------------------------------------------------------------------

  describe("profiling_voice_answer", () => {
    let firstAttemptId = "";

    it("admits the first attempt and refuses a SECOND LIVE answer to the same question", async () => {
      const [first] = await client.sql`
        insert into profiling_voice_answer (worker_id, session_id, pack_id, pack_version, question_key, ordinal)
        values (${workerId}, ${sessionId}, 'qp_universal', 1, 'current_city', 0)
        returning id`;
      firstAttemptId = first!.id as string;

      // THE CORE INVARIANT. Two live answers for one question is a review screen with no rule for
      // which one is the answer.
      expect(
        await rejectedBy(`
          INSERT INTO profiling_voice_answer (worker_id, session_id, pack_id, pack_version, question_key, ordinal, attempt_no)
          VALUES ('${workerId}', '${sessionId}', 'qp_universal', 1, 'current_city', 0, 2)`),
      ).toBe("pva_session_question_live_uq");
    });

    it("models a re-record as SUPERSESSION, never as a delete", async () => {
      // A stamp with no successor is unresolvable; a row that supersedes itself is a cycle.
      expect(
        await rejectedBy(`
          UPDATE profiling_voice_answer SET superseded_at = now() WHERE id = '${firstAttemptId}'`),
      ).toBe("pva_superseded_pair_chk");
      expect(
        await rejectedBy(`
          UPDATE profiling_voice_answer SET superseded_at = now(), superseded_by_id = id
          WHERE id = '${firstAttemptId}'`),
      ).toBe("pva_superseded_by_self_chk");

      const [second] = await client.sql`
        insert into profiling_voice_answer (worker_id, session_id, pack_id, pack_version, question_key, ordinal, attempt_no)
        values (${workerId}, ${sessionId}, 'qp_universal', 1, 'experience_years', 1, 1)
        returning id`;
      await client.sql`
        update profiling_voice_answer set superseded_at = now(), superseded_by_id = ${second!.id}
        where id = ${firstAttemptId}`;

      // Only NOW does the retake fit — and the superseded row is still there.
      await client.sql`
        insert into profiling_voice_answer (worker_id, session_id, pack_id, pack_version, question_key, ordinal, attempt_no)
        values (${workerId}, ${sessionId}, 'qp_universal', 1, 'current_city', 0, 2)`;

      const attempts = await client.sql`
        select attempt_no, superseded_at from profiling_voice_answer
        where session_id = ${sessionId} and question_key = 'current_city' order by attempt_no`;
      expect(attempts).toHaveLength(2);
      expect(attempts[0]!.superseded_at).not.toBeNull();
      expect(attempts[1]!.superseded_at).toBeNull();
    });

    it("refuses an error code without a failure, and accepts one with", async () => {
      // The defect this closes: a budget-blocked call recorded as a successful transcription of
      // silence. A code that can exist alongside `succeeded` re-opens exactly that.
      const [row] = await client.sql`
        insert into profiling_voice_answer (worker_id, session_id, pack_id, pack_version, question_key, ordinal)
        values (${workerId}, ${sessionId}, 'qp_universal', 1, 'salary_expected', 2)
        returning id`;
      expect(
        await rejectedBy(`
          UPDATE profiling_voice_answer SET transcript_error_code = 'stt_budget_blocked'
          WHERE id = '${row!.id}'`),
      ).toBe("pva_error_code_chk");

      await client.sql`
        update profiling_voice_answer
        set transcript_status = 'failed', transcript_error_code = 'stt_budget_blocked'
        where id = ${row!.id}`;
      const [after] = await client.sql`
        select transcript_status, transcript_error_code from profiling_voice_answer where id = ${row!.id}`;
      expect(after).toMatchObject({
        transcript_status: "failed",
        transcript_error_code: "stt_budget_blocked",
      });
    });

    it("bounds duration by the 120s CONTRACT limit, not by the form's own cap", async () => {
      // The form caps an answer at 30s, but that is a product decision that may move. The schema's
      // business is the contract limit, so the two can change independently.
      expect(
        await rejectedBy(`
          INSERT INTO profiling_voice_answer (worker_id, session_id, pack_id, pack_version, question_key, ordinal, duration_seconds)
          VALUES ('${workerId}', '${sessionId}', 'qp_universal', 1, 'primary_trade', 3, 121)`),
      ).toBe("pva_duration_chk");
    });

    it("enforces the PURGE ORDER: the clip goes first, the stamp second", async () => {
      const [note] = await client.sql`
        insert into voice_notes (worker_id, session_id, storage_path, duration_seconds)
        values (${workerId}, ${sessionId}, ${`voice-notes/${workerId}/${randomUUID()}.m4a`}, 12)
        returning id`;
      const [answer] = await client.sql`
        insert into profiling_voice_answer (worker_id, session_id, voice_note_id, pack_id, pack_version, question_key, ordinal)
        values (${workerId}, ${sessionId}, ${note!.id}, 'qp_universal', 1, 'work_type', 4)
        returning id`;

      // A row stamped purged while still pointing at a live clip is how a retention report comes to
      // disagree with the bucket.
      expect(
        await rejectedBy(`UPDATE profiling_voice_answer SET purged_at = now() WHERE id = '${answer!.id}'`),
      ).toBe("pva_purged_ref_chk");

      await client.sql`delete from voice_notes where id = ${note!.id}`;
      const [orphaned] = await client.sql`
        select voice_note_id, question_key from profiling_voice_answer where id = ${answer!.id}`;
      // THE CAPTURE FACT OUTLIVES THE CLIP. That is the whole reason the FK is SET NULL and
      // `worker_id` is denormalized.
      expect(orphaned!.voice_note_id).toBeNull();
      expect(orphaned!.question_key).toBe("work_type");

      await client.sql`update profiling_voice_answer set purged_at = now() where id = ${answer!.id}`;
    });
  });

  // -------------------------------------------------------------------------
  // DSAR
  // -------------------------------------------------------------------------

  it("erases both new tables when the worker is deleted", async () => {
    await client.sql`delete from workers where id = ${workerId}`;
    const [left] = await client.sql`
      select (select count(*) from worker_attributes where worker_id = ${workerId})
           + (select count(*) from profiling_voice_answer where worker_id = ${workerId}) as n`;
    expect(Number(left!.n)).toBe(0);
    workerId = ""; // already gone; keep afterAll from re-deleting
  });
});
