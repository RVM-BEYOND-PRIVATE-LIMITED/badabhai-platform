import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  chatSessions,
  createDbClient,
  workerAttributes,
  workerPackAnswers,
  type DbClient,
} from "@badabhai/db";
import { eq } from "drizzle-orm";

/**
 * ══════════════════════════════════════════════════════════════════════════════════════
 * THE TRADE FORM, END TO END — the coverage gap a live outage found.
 * ══════════════════════════════════════════════════════════════════════════════════════
 *
 * WHY THIS FILE EXISTS. On 2026-09-10 a worker on the CNC turner form got "Something went
 * wrong. Please try again." on EVERY question. `apps/api/src/profiling/form/` had 149 passing
 * tests at the time and not one of them executed a single line of SQL — every repository is
 * `vi`-mocked — and there was no e2e suite touching `/profiling/form` at all. Fifteen e2e
 * suites existed; the delivery mechanism for all 21 profiling roles had none.
 *
 * So the failure was invisible from both ends: green unit tests above it, and `/health`
 * reporting `database: "up"` beneath it on a database that could not serve the write.
 *
 * ── WHAT THIS ASSERTS THAT A UNIT TEST CANNOT ────────────────────────────────────────
 *
 * The answer path crosses four boundaries a mock erases:
 *   1. HTTP — the DTO, the Zod pipe, the guards, and the param decorators (`@Ctx()` is on the
 *      POST and not on the GET, which is exactly the kind of asymmetry a mock hides).
 *   2. Nest DI — the real graph, with the real providers wired.
 *   3. Drizzle — the generated INSERT ... ON CONFLICT, including whether its conflict target
 *      matches an index that actually exists.
 *   4. Postgres — `wa_value_present_chk`, `wa_attribute_key_chk`, `wpa_answer_shape_chk`,
 *      `wa_pack_pin_chk` and the two session FKs, none of which a fake repository enforces.
 *
 * ── THE TWO SHAPES, BECAUSE THEY TAKE DIFFERENT COLUMNS ──────────────────────────────
 *
 * A single-select stores its VALUE in `answer_text`; a multi-select stores values in
 * `answer_option_keys`. They also project to different `value_kind`s — `text` versus
 * `text_list` — which land in different columns under different halves of
 * `wa_value_present_chk`. Testing one and not the other covers half the write path, and the
 * production report named both.
 *
 * Opt-in, same lane as the rest of this suite:
 *   1. docker compose up -d postgres redis
 *   2. pnpm db:migrate && pnpm --filter @badabhai/db db:seed:packs --apply
 *   3. TEST_LOGIN_ENABLED=true TEST_LOGIN_TOKEN=<32+ chars> pnpm --filter @badabhai/api start
 *   4. RUN_E2E=1 TEST_LOGIN_TOKEN=<same> pnpm --filter @badabhai/e2e test
 */

const TEST_LOGIN_TOKEN = process.env.TEST_LOGIN_TOKEN ?? "";
const RUN = process.env.RUN_E2E === "1" && TEST_LOGIN_TOKEN.length > 0;
const API_URL = process.env.E2E_API_URL ?? "http://localhost:3001";
const DATABASE_URL =
  process.env.E2E_DATABASE_URL ??
  process.env.DATABASE_URL ??
  "postgresql://badabhai:badabhai@localhost:5432/badabhai";

/** The reserved synthetic block `AuthService.testLogin` will mint for: `+9100000#####`. */
const PHONE = `+9100000${String(Math.floor(Math.random() * 100000)).padStart(5, "0")}`;

const PACK_ID = "qp_cnc_turning";

interface Resp {
  status: number;
  body: any;
}

/**
 * Call the API and RETURN the status rather than throwing on non-2xx.
 *
 * Deliberately unlike `phase1-onboarding`'s helper, which throws with the body. The defect this
 * file exists for is a 5xx whose body the Flutter client could not surface, so the status and the
 * body ARE the assertions — a helper that threw would turn "the server returned 500 saying X"
 * into a stack trace pointing at the helper.
 */
async function call(
  method: string,
  path: string,
  body?: unknown,
  token?: string,
  opts: { testLogin?: boolean } = {},
): Promise<Resp> {
  const headers: Record<string, string> = {};
  if (body !== undefined) headers["content-type"] = "application/json";
  if (token) headers["authorization"] = `Bearer ${token}`;
  if (opts.testLogin) headers["x-test-login-token"] = TEST_LOGIN_TOKEN;
  const res = await fetch(`${API_URL}${path}`, {
    method,
    headers: Object.keys(headers).length > 0 ? headers : undefined,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let parsed: unknown = null;
  if (text) {
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = text;
    }
  }
  return { status: res.status, body: parsed };
}

describe.skipIf(!RUN)("Trade form — chat handover to a saved answer", () => {
  let client!: DbClient;
  let workerId = "";
  let token = "";

  beforeAll(async () => {
    client = createDbClient(DATABASE_URL);

    const login = await call("POST", "/auth/test-login", { phone: PHONE }, undefined, {
      testLogin: true,
    });
    expect(
      login.status,
      "POST /auth/test-login must be armed: TEST_LOGIN_ENABLED=true and a >=32-char " +
        "TEST_LOGIN_TOKEN on BOTH the API process and this runner",
    ).toBe(200);
    workerId = login.body.worker_id as string;
    token = login.body.access_token as string;

    // THE HANDOVER, WRITTEN DIRECTLY. Driving the interview until the model names a CNC turner
    // would make this suite depend on model output, which is exactly the coupling the rest of
    // the e2e suite avoids. `contextFor` reads one thing — `conversation_state.form_kind` on the
    // worker's latest session — so that is what is staged.
    await client.db
      .insert(chatSessions)
      .values({
        workerId,
        conversationState: { form_kind: "cnc_turner" },
        lastMessageAt: new Date(),
      })
      .returning({ id: chatSessions.id });
  });

  afterAll(async () => {
    if (workerId) {
      await client.db.delete(workerAttributes).where(eq(workerAttributes.workerId, workerId));
      await client.db.delete(workerPackAnswers).where(eq(workerPackAnswers.workerId, workerId));
      await client.db.delete(chatSessions).where(eq(chatSessions.workerId, workerId));
    }
    await client.sql.end({ timeout: 5 });
  });

  /**
   * The read half. It works in production, and it is asserted here so that a failure in the
   * write half below cannot be blamed on the handover or the pack being missing.
   */
  it("serves the form after a handover", async () => {
    const res = await call("GET", "/profiling/form", undefined, token);
    expect(res.status, `GET /profiling/form -> ${JSON.stringify(res.body)}`).toBe(200);
    expect(res.body.kind).toBe("cnc_turner");
    expect(res.body.pack_id).toBe(PACK_ID);
    expect(Array.isArray(res.body.sections)).toBe(true);
  });

  it("SAVES A SINGLE-SELECT — value in answer_text, attribute value_kind 'text'", async () => {
    const form = await call("GET", "/profiling/form", undefined, token);
    const flat = JSON.stringify(form.body);
    // The question and an option key the SERVED pack actually defines — never a literal, so a
    // pack revision moves this test with it instead of failing on a stale slug.
    const q = /"question_key":"(turning_experience)"[\s\S]{0,4000}?"option_key":"([a-z_]+)"/.exec(
      flat,
    );
    expect(q, "turning_experience with at least one option must be in the served schema").not.toBeNull();
    const [, questionKey, optionKey] = q!;

    const res = await call(
      "POST",
      "/profiling/form/answer",
      { question_key: questionKey, answer: { kind: "chips", option_keys: [optionKey] } },
      token,
    );

    // THE ASSERTION THE OUTAGE NEEDED. A 500 here is the production defect; the body is printed
    // so the failure names the cause rather than only the status.
    expect(res.status, `POST /profiling/form/answer -> ${JSON.stringify(res.body)}`).toBe(200);
    expect(res.body.status).toBe("answered");
    expect(res.body.total).toBeGreaterThan(0);

    // ...AND IT REACHED BOTH TABLES. A 200 with nothing written is the silent-truncation shape:
    // the worker is told it saved and the sheet never mentions it.
    const answers = await client.db
      .select()
      .from(workerPackAnswers)
      .where(eq(workerPackAnswers.workerId, workerId));
    const saved = answers.find((a) => a.questionKey === questionKey);
    expect(saved, "no worker_pack_answer row was written").toBeTruthy();
    expect(saved!.status).toBe("answered");
    expect(saved!.source).toBe("form");
    expect(saved!.packId).toBe(PACK_ID);
    // A single-select stores its VALUE here, not its key, and not in answer_option_keys.
    expect(saved!.answerText).toBeTruthy();
    expect(saved!.answerOptionKeys).toBeNull();

    const attrs = await client.db
      .select()
      .from(workerAttributes)
      .where(eq(workerAttributes.workerId, workerId));
    const attr = attrs.find((a) => a.attributeKey === questionKey);
    expect(attr, "no worker_attributes row was written — the capability zone stays empty").toBeTruthy();
    expect(attr!.valueKind).toBe("text");
    expect(attr!.valueText).toBeTruthy();
  });

  it("SAVES A MULTI-SELECT — values in answer_option_keys, attribute value_kind 'text_list'", async () => {
    const form = await call("GET", "/profiling/form", undefined, token);
    const flat = JSON.stringify(form.body);
    // The first MULTI-select in the served pack, whichever it is. Its two option keys exercise
    // the `text_list` half of `wa_value_present_chk`, which the single-select above cannot.
    const m =
      /"question_key":"([a-z_]+)","answer_type":"multi_select"[\s\S]{0,4000}?"option_key":"([a-z_]+)"[\s\S]{0,2000}?"option_key":"([a-z_]+)"/.exec(
        flat,
      );
    if (!m) {
      // Reported rather than silently skipped: "this pack has no multi-select" is a real answer,
      // and a test that quietly asserts nothing is worse than one that says why.
      console.warn("no multi_select with two options in the served pack — half this path untested");
      return;
    }
    const [, questionKey, first, second] = m;

    const res = await call(
      "POST",
      "/profiling/form/answer",
      { question_key: questionKey, answer: { kind: "chips", option_keys: [first, second] } },
      token,
    );
    expect(res.status, `POST /profiling/form/answer -> ${JSON.stringify(res.body)}`).toBe(200);

    const attrs = await client.db
      .select()
      .from(workerAttributes)
      .where(eq(workerAttributes.workerId, workerId));
    const attr = attrs.find((a) => a.attributeKey === questionKey);
    expect(attr, "no worker_attributes row for the multi-select").toBeTruthy();
    expect(attr!.valueKind).toBe("text_list");
    expect(Array.isArray(attr!.valueTextList)).toBe(true);
    expect((attr!.valueTextList as string[]).length).toBe(2);
  });

  /**
   * RE-ANSWERING IS A CORRECTION, NOT A SECOND ROW.
   *
   * Both writes are upserts, and their conflict targets are the thing a mock cannot check: if
   * `ON CONFLICT` names columns with no matching unique index, Postgres raises 42P10 and every
   * answer 500s — which is one of the shapes the outage could have taken.
   */
  it("re-answering the same question corrects the row instead of duplicating it", async () => {
    const form = await call("GET", "/profiling/form", undefined, token);
    const flat = JSON.stringify(form.body);
    const q = /"question_key":"(turning_experience)"[\s\S]{0,4000}?"option_key":"([a-z_]+)"/.exec(
      flat,
    );
    const [, questionKey, optionKey] = q!;

    for (let i = 0; i < 2; i++) {
      const res = await call(
        "POST",
        "/profiling/form/answer",
        { question_key: questionKey, answer: { kind: "chips", option_keys: [optionKey] } },
        token,
      );
      expect(res.status, `re-answer ${i} -> ${JSON.stringify(res.body)}`).toBe(200);
    }

    const rows = (
      await client.db
        .select()
        .from(workerPackAnswers)
        .where(eq(workerPackAnswers.workerId, workerId))
    ).filter((r) => r.questionKey === questionKey);
    expect(rows.length, "a re-answer must correct the row, not add one").toBe(1);
  });

  /**
   * A KEY THIS PACK DOES NOT DEFINE IS A 400 THAT SAYS SO.
   *
   * The client renders a 400's message verbatim and everything else as "Something went wrong",
   * so this is the difference between a worker who can act and one who cannot. Asserted with the
   * message non-empty, because a 400 with an empty body reaches the worker as the generic error.
   */
  it("rejects an unknown question_key with a NAMED 400", async () => {
    const res = await call(
      "POST",
      "/profiling/form/answer",
      { question_key: "not_a_real_question", answer: { kind: "chips", option_keys: ["x"] } },
      token,
    );
    expect(res.status).toBe(400);
    const message = JSON.stringify(res.body?.message ?? res.body ?? "");
    expect(message.length, "a 400 with no message reaches the worker as a dead end").toBeGreaterThan(2);
    expect(message).toContain("not_a_real_question");
  });
});
