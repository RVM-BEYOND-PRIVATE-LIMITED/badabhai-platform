import "reflect-metadata";
import { describe, expect, it, vi } from "vitest";
import { Logger } from "@nestjs/common";

import type { QuestionPack, QuestionPackItem } from "@badabhai/ai-contracts";
import type { NewWorkerPackAnswer, WorkerPackAnswer } from "@badabhai/db";

import { TRADE_RESUME_MAPS } from "../../resume/trade-resume-map";
import { CNC_TURNER } from "../roles/cnc-turner.role";
import { TradeFormSchemaResponse } from "./trade-form.dto";
import { SEARCHABLE_OPTION_THRESHOLD, TradeFormService } from "./trade-form.service";

/**
 * ═══ THE TRADE FORM ═══
 *
 * Three properties carry this file, and each is a defect that would be invisible in production:
 *
 *   1. THE FORM ASKS IN SHEET ORDER. `trade-resume-map.ts` says in terms that its `rank` is NOT
 *      display order — rank decides what is DROPPED when the page overflows, and the array order
 *      is the locked field order the ratified sample fixes. Ordering the form by rank would ask a
 *      worker for their capability in an order their own resume contradicts, and nothing would
 *      ever fail.
 *   2. AN ANSWER IS TYPED BY ITS QUESTION. A client sending chips for a boolean must get a 400
 *      here, not a constraint violation at the database — `wpa_answer_shape_chk` is a
 *      biconditional and would turn a client bug into a 500.
 *   3. NOTHING TICKED IS A DECLINATION, not an empty answer. "I looked and none of these apply"
 *      settles a question; an empty array would violate that same biconditional.
 */

const WORKER = "11111111-1111-4111-8111-111111111111";
const SESSION = "22222222-2222-4222-8222-222222222222";

let order = 0;
function item(partial: Partial<QuestionPackItem> & { question_key: string }): QuestionPackItem {
  return {
    prompt_text: `${partial.question_key}?`,
    display_order: order++,
    target_kind: "none",
    target_field: null,
    target_skill_id: null,
    answer_type: "text",
    is_mandatory: false,
    is_core: false,
    max_asks: 2,
    min_turn: null,
    max_turn: null,
    ask_if: null,
    skip_if: null,
    parent_item_key: null,
    retry_text: null,
    why_text: null,
    options: [],
    ...partial,
  };
}

// `value` is SPELLED DIFFERENTLY FROM `option_key` on purpose. Every shipped pack happens to
// spell them the same, which is exactly what allowed the first version of this service to store
// option KEYS where an interview stores option VALUES and pass its tests anyway. Keeping them
// distinct here is what makes these assertions able to tell the two apart at all.
const options = (n: number) =>
  Array.from({ length: n }, (_, i) => ({
    option_key: `k${i}`,
    label_text: `Label ${i}`,
    value: `v${i}`,
    implies_skill_id: null,
    is_none_of_above: false,
  }));

/** The real map's first three capability rows, so the order assertion is against shipped data. */
const TURNER_MAP = TRADE_RESUME_MAPS.find((m) => m.pack_id === "qp_cnc_turning");

const PACK: QuestionPack = {
  pack_id: "qp_cnc_turning",
  version: 1,
  family_id: "fam_cnc_turning",
  locale: "hi-IN",
  status: "active",
  content_hash: "hash",
  items: [
    // DELIBERATELY SHUFFLED relative to the map, and `display_order` deliberately disagrees too:
    // if the service fell back to either the pack's own order or to `rank`, the order assertion
    // below would catch it.
    item({ question_key: "tolerance_band", answer_type: "single_select", options: options(5) }),
    item({ question_key: "material_worked", answer_type: "multi_select", options: options(23) }),
    item({ question_key: "controller_brand", answer_type: "multi_select", options: options(6) }),
    item({ question_key: "turning_machine", answer_type: "multi_select", options: options(6) }),
    item({ question_key: "iti_project_work", answer_type: "text" }),
    item({ question_key: "trade_test_status", answer_type: "boolean" }),
  ],
};

function makeService(
  opts: { formKind?: unknown; saved?: WorkerPackAnswer[]; pack?: QuestionPack | null } = {},
) {
  const written: NewWorkerPackAnswer[] = [];
  const chat = {
    findLatestSessionByWorker: vi.fn(async () => ({
      id: SESSION,
      conversationState:
        opts.formKind === undefined ? { form_kind: "cnc_turner" } : { form_kind: opts.formKind },
    })),
  };
  const packs = { loadForFamily: vi.fn(async () => (opts.pack === undefined ? PACK : opts.pack)) };
  const answers = {
    listAnswers: vi.fn(async () => opts.saved ?? []),
    upsertAnswer: vi.fn(async (row: NewWorkerPackAnswer) => {
      written.push(row);
    }),
  };
  // THE SHEET'S OWN SOURCE. Captured so the tests can assert that a form answer reaches
  // `worker_attributes` and not only `worker_pack_answer` — the capability zone reads the former,
  // and the handover switches off the extraction job that used to be its only writer.
  const upsertMany = vi.fn(async (_rows: unknown[]) => 0);
  // The completion half of the form funnel. Captured rather than stubbed to a no-op so the tests
  // can assert BOTH directions: that finishing the form emits exactly once, and that answering a
  // question mid-form emits nothing.
  const emitted: { event_name: string; payload: Record<string, unknown> }[] = [];
  const emit = vi.fn(async (params: { event_name: string; payload: Record<string, unknown> }) => {
    emitted.push(params);
    return {};
  });
  const rebuildQuietly = vi.fn(async () => undefined);
  const service = new TradeFormService(
    chat as never,
    packs as never,
    answers as never,
    { upsertMany } as never,
    { emit } as never,
    // M1 — the match rebuild the completion now enqueues. A spy, not a stub of the real
    // service: what these tests assert is the FORM's behaviour, and the only thing they need
    // from the matching layer is that it is called with the worker id. `rebuildQuietly` is
    // contractually never-throwing, which is why the form can await it without a try/catch.
    { rebuildQuietly } as never,
  );
  return { service, written, packs, chat, upsertMany, emitted, emit };
}

const answered = (over: Partial<WorkerPackAnswer>): WorkerPackAnswer =>
  ({
    questionKey: "turning_machine",
    status: "answered",
    answerOptionKeys: ["k1"],
    answerText: null,
    answerNumber: null,
    answerBool: null,
    ...over,
  }) as WorkerPackAnswer;

describe("TradeFormService", () => {
  vi.spyOn(Logger.prototype, "error").mockImplementation(() => undefined);

  describe("the schema", () => {
    it("asks the capability rows in the SHEET's array order, not the pack's and not by rank", async () => {
      const { service } = await makeService();
      const schema = await service.schema(WORKER);
      const capability = schema.sections.find((s) => s.id === "capability");
      const asked = capability?.screens.map((s) =>
        s.type === "question" ? s.question.question_key : s.type,
      );

      // The expected order is READ OFF THE SHIPPED MAP rather than restated, so this test tracks
      // the sheet if the sheet is redlined — which its own doc says the shop floor may do.
      const expected = (TURNER_MAP?.capability ?? [])
        .map((row) => row.from)
        .filter((key) => PACK.items.some((i) => i.question_key === key));
      expect(asked).toEqual(expected);
      expect(expected.length).toBeGreaterThan(1);
    });

    it("puts questions the sheet has no row for last, but still asks them", async () => {
      const { service } = await makeService();
      const schema = await service.schema(WORKER);
      const quals = schema.sections.find((s) => s.id === "qualifications");
      const keys = quals?.screens.flatMap((s) =>
        s.type === "question" ? [s.question.question_key] : [],
      );
      // They feed matching even when they do not print, so dropping them would lose real signal.
      expect(keys).toContain("iti_project_work");
      expect(keys).toContain("trade_test_status");
    });

    it("marks a long option list searchable and a short one not", async () => {
      const { service } = await makeService();
      const schema = await service.schema(WORKER);
      const screens = schema.sections.flatMap((s) => s.screens);
      const byKey = new Map(
        screens.flatMap((s) => (s.type === "question" ? [[s.question.question_key, s]] : [])),
      );
      // 23 materials need a search box; 5 tolerance bands do not.
      expect(byKey.get("material_worked")).toMatchObject({ ui: { searchable: true } });
      expect(byKey.get("tolerance_band")).toMatchObject({ ui: { searchable: false } });
      expect(SEARCHABLE_OPTION_THRESHOLD).toBeGreaterThan(5);
    });

    it("replays what the worker already said, so a half-finished form comes back filled in", async () => {
      const { service } = await makeService({
        saved: [answered({ questionKey: "turning_machine", answerOptionKeys: ["v2", "v3"] })],
      });
      const schema = await service.schema(WORKER);
      const screens = schema.sections.flatMap((s) => s.screens);
      const machine = screens.find(
        (s) => s.type === "question" && s.question.question_key === "turning_machine",
      );
      expect(machine).toMatchObject({
        answer: { status: "answered", option_keys: ["k2", "k3"] },
      });
    });

    it("carries the pack pin, so an answer is never replayed into a different version", async () => {
      const { service } = await makeService();
      const schema = await service.schema(WORKER);
      expect(schema).toMatchObject({ pack_id: "qp_cnc_turning", pack_version: 1 });
    });

    it("places terms and work history as markers on the endpoints that already own them", async () => {
      const { service } = await makeService();
      const schema = await service.schema(WORKER);
      expect(schema.sections.map((s) => s.id)).toEqual([
        "capability",
        "terms",
        "work_history",
        "qualifications",
      ]);
      expect(schema.sections[1]?.screens[0]).toEqual({
        type: "preferences",
        endpoint: "PUT /workers/me/work-preferences",
      });
      expect(schema.sections[2]?.screens[0]).toEqual({
        type: "employment",
        endpoint: "PUT /workers/me/employment",
      });
    });

    it("ends the qualifications section with the credentials marker, carrying this TRADE's suggestions", async () => {
      const { service } = await makeService();
      const quals = (await service.schema(WORKER)).sections.find((s) => s.id === "qualifications");
      // LAST, after the leftover questions rather than before them. Every one of those can vanish
      // for a senior — the tier gate below hides all three fresher items — and this marker is
      // what stops the section from being a heading with nothing under it while the Certificates
      // row on that same worker sheet still has no source at all.
      expect(quals?.screens.at(-1)).toEqual({
        type: "qualifications",
        endpoint: "PUT /workers/me/qualifications",
        suggested_certificates: [...CNC_TURNER.suggestedCertificates],
      });
      // READ OFF THE ROLE, never restated here: these strings are ratified résumé content, and a
      // second copy in this file would go on passing after the role list was redlined. Non-empty
      // is the load-bearing half — an empty array is exactly what a role declaring no
      // certificates serves, so a lookup that silently missed the descriptor would look identical.
      expect(CNC_TURNER.suggestedCertificates.length).toBeGreaterThan(0);
    });

    it("still validates against the wire schema, marker and all", async () => {
      // NOTHING PARSES THIS SCHEMA IN PRODUCTION — the controller returns the object as the
      // service built it — so this test is the only thing that ever RUNS the contract. That
      // matters for a FOURTH variant in particular: `z.discriminatedUnion` fails closed on a
      // `type` it does not carry, and the Flutter parser is written from this declaration, so a
      // screen the union does not name is a screen no reader can read. Constructing one and
      // returning it is not evidence that the contract admits it.
      const { service } = await makeService();
      const parsed = TradeFormSchemaResponse.safeParse(await service.schema(WORKER));
      // The issues rather than the boolean, so a failure names the offending field instead of
      // asserting that `false` should have been `true`.
      expect(parsed.success ? [] : parsed.error.issues).toEqual([]);
    });

    it("404s a worker who was never handed a form, rather than serving an empty one", async () => {
      const { service } = await makeService({ formKind: null });
      await expect(service.schema(WORKER)).rejects.toThrow(/not been handed/);
    });

    it("does NOT 404 when the pack is missing — that is a server fault, not an empty form", async () => {
      // THE DISTINCTION THIS TEST EXISTS FOR, and it cost a real worker a dead end before it did.
      //
      // The client maps 404 on this route to "aapke liye koi form taiyaar nahi kiya gaya hai",
      // which is the correct reading of 404 here and completely false when the worker HAS been
      // handed a form and the pack is simply absent from the database. Seeding is manual, so a
      // new pack can ship, pass every test, deploy green and still not be there.
      //
      // 503, so the app offers a retry instead of telling the worker they are not entitled to
      // the form they were just invited to fill.
      const { service } = await makeService({ pack: null });
      await expect(service.schema(WORKER)).rejects.toMatchObject({
        status: 503,
      });
    });

    it("still 404s the worker who was never handed a form — the two are not the same failure", async () => {
      // The discriminating half. Without it the assertion above would pass against a route that
      // had stopped distinguishing the cases at all, in the other direction.
      const { service } = await makeService({ formKind: null });
      await expect(service.schema(WORKER)).rejects.toMatchObject({ status: 404 });
    });
  });

  describe("saving an answer", () => {
    it("stores the option VALUES an interview would have stored, not the keys", async () => {
      const { service, written } = await makeService();
      await service.answer(WORKER, {
        question_key: "turning_machine",
        answer: { kind: "chips", option_keys: ["k1", "k2"] },
      });
      expect(written[0]).toMatchObject({
        workerId: WORKER,
        packId: "qp_cnc_turning",
        packVersion: 1,
        questionKey: "turning_machine",
        // `answer-capture.matchOptions` stores `option.value ?? option.label_text`, and the
        // resume map is keyed by that value — keys here leave every chip unrenderable.
        answerOptionKeys: ["v1", "v2"],
        status: "answered",
        source: "form",
        // The interview that handed the worker to this form — honest provenance, not null.
        chatSessionId: SESSION,
      });
    });

    it("puts a SINGLE-select in answer_text, where the interview puts it", async () => {
      // One question type, one column, one meaning.
      const { service, written } = await makeService();
      await service.answer(WORKER, {
        question_key: "tolerance_band",
        answer: { kind: "chips", option_keys: ["k3"] },
      });
      expect(written[0]).toMatchObject({ answerText: "v3", status: "answered" });
      expect(written[0]!.answerOptionKeys ?? null).toBeNull();
    });

    it("writes worker_attributes too — the table the SHEET actually reads", async () => {
      // THE REGRESSION THIS EXISTS FOR. The capability zone reads `worker_attributes`, and the
      // handover switches off the extraction job that used to be its only writer. Without this
      // write a worker answers every question and their sheet prints an empty section.
      const { service, upsertMany } = await makeService();
      await service.answer(WORKER, {
        question_key: "turning_machine",
        answer: { kind: "chips", option_keys: ["k1", "k2"] },
      });
      expect(upsertMany).toHaveBeenCalledTimes(1);
      const rows = upsertMany.mock.calls[0]![0] as Array<Record<string, unknown>>;
      expect(rows[0]).toMatchObject({
        workerId: WORKER,
        attributeKey: "turning_machine",
        valueKind: "text_list",
        valueTextList: ["v1", "v2"],
        packId: "qp_cnc_turning",
        sessionId: SESSION,
      });
    });

    it("de-duplicates repeated option keys", async () => {
      const { service, written } = await makeService();
      await service.answer(WORKER, {
        question_key: "turning_machine",
        answer: { kind: "chips", option_keys: ["k1", "k1", "k2"] },
      });
      expect(written[0]?.answerOptionKeys).toEqual(["v1", "v2"]);
    });

    it("treats nothing ticked as a DECLINATION, not an empty answer", async () => {
      const { service, written } = await makeService();
      const result = await service.answer(WORKER, {
        question_key: "turning_machine",
        answer: { kind: "chips", option_keys: [] },
      });
      // An empty array would violate the table's answered-implies-a-value biconditional, and
      // "none of these apply" is a real answer that must not be re-asked as a blank.
      expect(result.status).toBe("declined");
      expect(written[0]).toMatchObject({ status: "declined" });
      expect(written[0]!.answerOptionKeys ?? null).toBeNull();
    });

    it("records an explicit skip as declined", async () => {
      const { service, written } = await makeService();
      await service.answer(WORKER, {
        question_key: "turning_machine",
        answer: { kind: "declined" },
      });
      expect(written[0]?.status).toBe("declined");
    });

    it("rejects an option key the pack does not define", async () => {
      const { service } = await makeService();
      await expect(
        service.answer(WORKER, {
          question_key: "turning_machine",
          answer: { kind: "chips", option_keys: ["k1", "not_a_key"] },
        }),
      ).rejects.toThrow(/unknown option keys: not_a_key/);
    });

    it("rejects a second option on a single-select", async () => {
      const { service } = await makeService();
      await expect(
        service.answer(WORKER, {
          question_key: "tolerance_band",
          answer: { kind: "chips", option_keys: ["k1", "k2"] },
        }),
      ).rejects.toThrow(/takes one option/);
    });

    it("rejects chips for a boolean question", async () => {
      const { service } = await makeService();
      await expect(
        service.answer(WORKER, {
          question_key: "trade_test_status",
          answer: { kind: "chips", option_keys: ["k1"] },
        }),
      ).rejects.toThrow(/does not take option keys/);
    });

    it("rejects a boolean for a select question", async () => {
      const { service } = await makeService();
      await expect(
        service.answer(WORKER, {
          question_key: "turning_machine",
          answer: { kind: "boolean", value: true },
        }),
      ).rejects.toThrow(/not a yes\/no question/);
    });

    it("rejects free text for a select question", async () => {
      const { service } = await makeService();
      await expect(
        service.answer(WORKER, {
          question_key: "turning_machine",
          answer: { kind: "text", text: "CNC lathe" },
        }),
      ).rejects.toThrow(/does not take free text/);
    });

    it("rejects a question key this pack does not define, rather than dropping it", async () => {
      const { service } = await makeService();
      await expect(
        service.answer(WORKER, {
          question_key: "welding_process",
          answer: { kind: "text", text: "MIG" },
        }),
      ).rejects.toThrow(/is not in qp_cnc_turning/);
    });

    it("saves a boolean and free text on the questions that take them", async () => {
      const { service, written } = await makeService();
      await service.answer(WORKER, {
        question_key: "trade_test_status",
        answer: { kind: "boolean", value: true },
      });
      await service.answer(WORKER, {
        question_key: "iti_project_work",
        answer: { kind: "text", text: "Shaft turning project" },
      });
      expect(written[0]).toMatchObject({ answerBool: true, status: "answered" });
      expect(written[1]).toMatchObject({ answerText: "Shaft turning project", status: "answered" });
    });

    it("reports progress over the pack, for the client's rail", async () => {
      const { service } = await makeService({
        saved: [
          answered({ questionKey: "turning_machine" }),
          answered({ questionKey: "controller_brand" }),
        ],
      });
      const result = await service.answer(WORKER, {
        question_key: "turning_machine",
        answer: { kind: "chips", option_keys: ["k1"] },
      });
      expect(result).toMatchObject({ answered: 2, total: PACK.items.length });
    });
  });

  /**
   * ═══ THE TIER GATE (#1377, #1378) ═══
   *
   * The form served every pack item regardless of `ask_if`, so a turner with eight years of
   * employment was asked the three FRESHER questions — and then had all three silently dropped by
   * the renderer, which only builds a fresher block for a worker with no employments. Three
   * questions asked, three answers stored, nothing printed, nothing failed.
   *
   * The gate itself was asked LAST, because it has no capability row and `orderBySheet` files
   * anything the sheet does not print after everything it does. The pack's own `_depth` note says
   * the opposite in as many words: "THE TIER GATE IS turning_experience, and it is asked FIRST."
   */
  describe("the tier gate", () => {
    /** A pack shaped like the real one: a numeric gate, plus items gated both ways off it. */
    const GATED: QuestionPack = {
      ...PACK,
      items: [
        item({ question_key: "turning_machine", answer_type: "multi_select", options: options(6) }),
        item({
          question_key: "turning_experience",
          answer_type: "single_select",
          is_core: true,
          options: [
            {
              option_key: "under_one",
              label_text: "1 saal se kam",
              value: 0,
              implies_skill_id: null,
              is_none_of_above: false,
            },
            {
              option_key: "over_seven",
              label_text: "7 saal se zyada",
              value: 10,
              implies_skill_id: null,
              is_none_of_above: false,
            },
          ] as never,
        }),
        // Senior-only depth.
        item({
          question_key: "tolerance_band",
          answer_type: "single_select",
          options: options(5),
          ask_if: {
            op: "gte",
            left: { field: "turning_experience" },
            right: { const: 2 },
          } as never,
        }),
        // Fresher-only, the three that were being dropped.
        item({
          question_key: "iti_project_work",
          answer_type: "text",
          ask_if: {
            op: "lte",
            left: { field: "turning_experience" },
            right: { const: 0 },
          } as never,
        }),
      ],
    };

    const gate = (over: Partial<WorkerPackAnswer> = {}) =>
      answered({
        questionKey: "turning_experience",
        answerOptionKeys: null,
        answerNumber: 10,
        ...over,
      });

    const keysOf = async (saved: WorkerPackAnswer[]) => {
      const { service } = await makeService({ pack: GATED, saved });
      const schema = await service.schema(WORKER);
      return schema.sections
        .flatMap((s) => s.screens)
        .flatMap((s) => (s.type === "question" ? [s.question.question_key] : []));
    };

    it("asks the gate FIRST, ahead of the capability rows it gates", async () => {
      const { service } = await makeService({ pack: GATED });
      const capability = (await service.schema(WORKER)).sections.find((s) => s.id === "capability");
      const asked = capability?.screens.map((s) =>
        s.type === "question" ? s.question.question_key : s.type,
      );
      expect(asked?.[0]).toBe("turning_experience");
    });

    it("shows every gated question while the gate is UNANSWERED — a form is one round trip", async () => {
      // The interview's fail direction (unevaluatable → skip) would serve a first-time worker only
      // the ungated questions, hiding the tiered depth from exactly the seniors the pack is for.
      expect(await keysOf([])).toEqual([
        "turning_experience",
        "turning_machine",
        "tolerance_band",
        "iti_project_work",
      ]);
    });

    it("drops the fresher questions once the worker states real tenure", async () => {
      const keys = await keysOf([gate()]);
      expect(keys).toContain("tolerance_band");
      expect(keys).not.toContain("iti_project_work");
    });

    it("drops the senior depth for a fresher, and keeps the fresher block", async () => {
      const keys = await keysOf([gate({ answerNumber: 0 })]);
      expect(keys).toContain("iti_project_work");
      expect(keys).not.toContain("tolerance_band");
    });

    it("keeps a question the worker ALREADY answered, even once it is no longer eligible", async () => {
      // Otherwise the answer sits in `worker_attributes` where the worker can no longer reach it
      // to correct or withdraw it — worse than an extra screen.
      const keys = await keysOf([
        gate(),
        answered({
          questionKey: "iti_project_work",
          answerOptionKeys: null,
          answerText: "Bush banaya",
        }),
      ]);
      expect(keys).toContain("iti_project_work");
    });

    it("shows the tiered depth when a MIS-AUTHORED gate cannot be ordered, instead of hiding it", async () => {
      // THE #776 SHAPE. A gate option carrying `value_text` next to its `value_number` stores the
      // answer as the STRING "10"; `compare()` refuses to order a string against a number and
      // returns null, so every `gte` in the pack is false forever and every tiered question is
      // silently never asked. That defect sat in `qp_welding` for the life of the pack.
      //
      // A type mismatch is an UNANSWERABLE comparison, not a false one, so the form shows the
      // question. The authoring slip then costs one extra screen rather than all of the depth.
      //
      // NOT VACUOUS, unlike the `??`-ordering assertion this replaced: `wpa_answer_shape_chk` is a
      // biconditional, so exactly one answer column is ever non-null and the read order cannot
      // matter. Which COLUMN the value lands in is the thing that can go wrong, and this is it.
      const keys = await keysOf([gate({ answerNumber: null, answerText: "10" })]);
      expect(keys).toContain("tolerance_band");
      expect(keys).toContain("iti_project_work");
    });

    it("counts progress over what is still ASKED, not over the whole pack", async () => {
      const { service } = await makeService({ pack: GATED, saved: [gate()] });
      const result = await service.answer(WORKER, {
        question_key: "turning_machine",
        answer: { kind: "chips", option_keys: ["k1"] },
      });
      // Four items in the pack, but a senior is never asked `iti_project_work` — a denominator of
      // 4 is one this worker can never reach.
      expect(result.total).toBe(3);
    });

    it("tells the client its schema is stale when a GATE is answered, and only then", async () => {
      const { service } = await makeService({ pack: GATED });
      const onGate = await service.answer(WORKER, {
        question_key: "turning_experience",
        answer: { kind: "chips", option_keys: ["over_seven"] },
      });
      const onOrdinary = await service.answer(WORKER, {
        question_key: "turning_machine",
        answer: { kind: "chips", option_keys: ["k1"] },
      });
      expect(onGate.schema_stale).toBe(true);
      expect(onOrdinary.schema_stale).toBe(false);
    });
  });

  /**
   * ═══ profile.form_completed (#0.6) ═══
   *
   * The funnel had a first step and no last one. `profile.form_mode_entered` records that a worker
   * was SENT to a form; nothing recorded whether anyone ever came out of one, so abandonment at
   * question fourteen of a badly ordered pack and completion in one sitting produced identical
   * telemetry — on a surface about to carry twenty-one packs whose ordering is exactly what this
   * number would judge.
   */
  describe("finishing the form", () => {
    /**
     * A tiered pack in miniature: the gate, one capability question, and one fresher question the
     * gate hides. THREE items, TWO of them ever asked — the arithmetic the whole event turns on.
     */
    const TIERED: QuestionPack = {
      ...PACK,
      items: [
        item({ question_key: "turning_experience", answer_type: "number" }),
        item({ question_key: "turning_machine", answer_type: "multi_select", options: options(6) }),
        item({
          question_key: "iti_project_work",
          answer_type: "text",
          ask_if: {
            op: "lte",
            left: { field: "turning_experience" },
            right: { const: 0 },
          } as never,
        }),
      ],
    };

    /** Ten years on the lathe — so the fresher question is gated away for this worker. */
    const senior = () =>
      answered({ questionKey: "turning_experience", answerOptionKeys: null, answerNumber: 10 });

    it("stays silent while a visible question is still unanswered", async () => {
      // The discriminating half of the pair. Without it, a service that emitted on every answer
      // would satisfy the test below and still report a finished form for a worker who has
      // settled one question of two.
      const { service, emitted } = await makeService({ pack: TIERED, saved: [senior()] });
      await service.answer(WORKER, {
        question_key: "turning_machine",
        answer: { kind: "chips", option_keys: ["k1"] },
      });
      expect(emitted).toEqual([]);
    });

    it("announces completion at the VISIBLE denominator, the only one this worker can reach", async () => {
      const { service, emitted, emit } = await makeService({
        pack: TIERED,
        saved: [senior(), answered({ questionKey: "turning_machine" })],
      });
      const result = await service.answer(WORKER, {
        question_key: "turning_machine",
        answer: { kind: "chips", option_keys: ["k1"] },
      });

      expect(emitted).toHaveLength(1);
      expect(emitted[0]?.event_name).toBe("profile.form_completed");
      // `toEqual`, NOT `toMatchObject`. Counts and slugs only is the discipline
      // `profile.form_mode_entered` keeps and for the same reason — the answers are what one
      // specific worker said about themselves — and a subset match would pass a payload that had
      // quietly grown a label or a value.
      expect(emitted[0]?.payload).toEqual({
        worker_id: WORKER,
        form_kind: "cnc_turner",
        pack_id: "qp_cnc_turning",
        pack_version: 1,
        answered: 2,
        total: 2,
      });
      // THE POINT OF THE EVENT, in one assertion. The pack holds three items and this worker is
      // asked two; counted against the pack an experienced turner could never satisfy the
      // condition at all, and the funnel would report that only freshers ever finish.
      expect(TIERED.items).toHaveLength(3);
      // The rail the worker watches and the number the funnel reports have to be the same total,
      // or the two disagree about what finishing this form means.
      expect(result.total).toBe(2);

      const call = emit.mock.calls[0]![0] as {
        event_name: string;
        payload: Record<string, unknown>;
        idempotencyKey: string;
      };
      // ONCE PER (WORKER, PACK), and deliberately not per VERSION. The completion condition stays
      // true for every subsequent answer, so a worker who finishes and then corrects one chip
      // satisfies it again — without the key the funnel numerator climbs past its denominator.
      expect(call.idempotencyKey).toBe(`profile.form_completed:${WORKER}:qp_cnc_turning`);
    });

    it("ignores a retired answer entirely rather than counting it past the denominator", async () => {
      // THE STALE-ROW CASE, AND WHY IT COUNTS IN NEITHER NUMBER. Answers are listed by PACK ID and
      // never by version, so a question dropped in v2 leaves its v1 row behind forever — this
      // worker has three settled answers and is asked two. Counting the retired row in the
      // numerator alone (which is what shipped, and what reached the progress rail) makes the rail
      // read 3/2: a worker told they are 150% finished, and a funnel whose numerator can climb
      // past its own denominator.
      //
      // The worker DID answer it. It is simply not a question this form asks any more, so it
      // belongs to neither side of "how far through are you" — and excluding it is also what makes
      // the completion condition an equality the worker can actually reach, rather than one they
      // satisfy through a row they can neither see nor remove.
      //
      // A GATED-AWAY ANSWER WILL NOT PRODUCE THIS STATE, which is why the fixture is shaped this
      // way and not the obvious way: `isFormQuestionVisible` returns true for anything already
      // settled, precisely so a worker can still change it, so a question the tier gate hides is
      // counted in BOTH numbers. A retired key is the only shape that lands in one and not the
      // other.
      const { service, emitted } = await makeService({
        pack: TIERED,
        saved: [
          senior(),
          answered({ questionKey: "turning_machine" }),
          answered({ questionKey: "coolant_type", answerOptionKeys: null, answerText: "soluble" }),
        ],
      });
      // The premise, asserted rather than assumed: if a later edit ever adds `coolant_type` to
      // TIERED, this test would go on passing while testing nothing at all.
      expect(TIERED.items.map((entry) => entry.question_key)).not.toContain("coolant_type");

      const result = await service.answer(WORKER, {
        question_key: "turning_machine",
        answer: { kind: "chips", option_keys: ["k1"] },
      });

      // THE EVENT STILL FIRES — the retired row must not cost this worker their completion.
      expect(emitted).toHaveLength(1);
      // BOTH NUMBERS RANGE OVER THE SAME SET, which is the property this test exists for. Three
      // rows are stored and two are asked; the numerator reports two, NOT three. `answered: 3`
      // here would be the shipped defect, and it is what this assertion is watching for. The rest
      // of the payload is the sibling test's to own — these two numbers are this one's.
      expect(emitted[0]?.payload).toMatchObject({ answered: 2, total: 2 });
      // The progress rail agrees with the funnel, and can never exceed 100%.
      expect(result.answered).toBe(2);
      expect(result.total).toBe(2);
    });

    it("keeps the answer when the emit throws", async () => {
      // BEST-EFFORT BY DESIGN, and this assertion is what holds that design in place. The answer
      // is durably written before the emitter runs, so throwing here would fail a request whose
      // work succeeded and send the client back to retry an answer it had already saved — a
      // stored answer traded for a telemetry row. The log line is the fallback record.
      const { service, written, emit } = await makeService({
        pack: TIERED,
        saved: [senior(), answered({ questionKey: "turning_machine" })],
      });
      emit.mockImplementationOnce(async () => {
        throw new Error("event store unreachable");
      });

      await expect(
        service.answer(WORKER, {
          question_key: "turning_machine",
          answer: { kind: "chips", option_keys: ["k1"] },
        }),
      ).resolves.toMatchObject({
        question_key: "turning_machine",
        status: "answered",
        answered: 2,
        total: 2,
      });
      expect(written).toHaveLength(1);
    });
  });
});
