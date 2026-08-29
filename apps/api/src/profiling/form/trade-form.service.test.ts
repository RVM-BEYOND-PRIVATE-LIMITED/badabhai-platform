import "reflect-metadata";
import { describe, expect, it, vi } from "vitest";
import { Logger } from "@nestjs/common";

import type { QuestionPack, QuestionPackItem } from "@badabhai/ai-contracts";
import type { NewWorkerPackAnswer, WorkerPackAnswer } from "@badabhai/db";

import { TRADE_RESUME_MAPS } from "../../resume/trade-resume-map";
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

const options = (n: number) =>
  Array.from({ length: n }, (_, i) => ({
    option_key: `k${i}`,
    label_text: `Label ${i}`,
    value: null,
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
  const service = new TradeFormService(chat as never, packs as never, answers as never);
  return { service, written, packs, chat };
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
        saved: [answered({ questionKey: "turning_machine", answerOptionKeys: ["k2", "k3"] })],
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

    it("404s a worker who was never handed a form, rather than serving an empty one", async () => {
      const { service } = await makeService({ formKind: null });
      await expect(service.schema(WORKER)).rejects.toThrow(/not been handed/);
    });

    it("404s loudly when the form kind has no active pack", async () => {
      const { service } = await makeService({ pack: null });
      await expect(service.schema(WORKER)).rejects.toThrow(/no active question pack/);
    });
  });

  describe("saving an answer", () => {
    it("writes option keys with source=form and no session", async () => {
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
        answerOptionKeys: ["k1", "k2"],
        status: "answered",
        source: "form",
        // Provenance, not ownership: a form answer has no interview behind it.
        chatSessionId: null,
      });
    });

    it("de-duplicates repeated option keys", async () => {
      const { service, written } = await makeService();
      await service.answer(WORKER, {
        question_key: "turning_machine",
        answer: { kind: "chips", option_keys: ["k1", "k1", "k2"] },
      });
      expect(written[0]?.answerOptionKeys).toEqual(["k1", "k2"]);
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
      expect(written[0]).toMatchObject({ status: "declined", answerOptionKeys: null });
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
});
