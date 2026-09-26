import "reflect-metadata";
import { describe, expect, it, vi } from "vitest";
import { Logger } from "@nestjs/common";

import type { QuestionPack, QuestionPackItem } from "@badabhai/ai-contracts";
import type { NewWorkerPackAnswer, WorkerPackAnswer } from "@badabhai/db";

import { TRADE_RESUME_MAPS } from "../../resume/trade-resume-map";
import { CNC_TURNER } from "../roles/cnc-turner.role";
import { packFromCorpus, rawCorpusPack, UNIVERSAL_PACK_FILE } from "./corpus-pack.test-support";
import { LEGACY_FORM_UNIVERSAL_KEYS } from "./legacy-universal-answer";
import { TradeFormSchemaResponse } from "./trade-form.dto";
import { SEARCHABLE_OPTION_THRESHOLD, TradeFormService } from "./trade-form.service";

/** Marker executor the repository doubles hand to a transaction callback. */
const FAKE_TX = Symbol("fake-tx") as unknown as never;

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
const RESUME = "33333333-3333-4333-8333-333333333333";

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

/**
 * THE REAL UNIVERSAL PACK, served by default (#1503).
 *
 * This double used to return `null`, and that one line is why `f455bb36` appended eight questions
 * to every form without a single test here noticing: there was nothing to append. Serving the real
 * pack means a regression that reads it has something to put on screen.
 */
const UNIVERSAL: QuestionPack = packFromCorpus(UNIVERSAL_PACK_FILE);

function makeService(
  opts: {
    formKind?: unknown;
    saved?: WorkerPackAnswer[];
    pack?: QuestionPack | null;
    /** What every universal-loading door returns. Defaults to the real `qp_universal@2`. */
    universal?: QuestionPack | null;
    /** ADR-0041 RI-4 — what a résumé staged for this worker, keyed by question key. */
    suggestions?: ReadonlyMap<string, unknown>;
    /** An already-generated resume row id: set when the test is about a post-completion edit. */
    resumeId?: string;
    /**
     * #1459 — what the chat's `experience_years` row says: a number (answered), `"declined"`
     * (settled, no value), or absent (never asked).
     */
    chatExperienceYears?: number | "declined";
  } = {},
) {
  const written: NewWorkerPackAnswer[] = [];
  const chat = {
    findLatestSessionByWorker: vi.fn(async () => ({
      id: SESSION,
      conversationState:
        opts.formKind === undefined ? { form_kind: "cnc_turner" } : { form_kind: opts.formKind },
    })),
  };
  const universal = opts.universal === undefined ? UNIVERSAL : opts.universal;
  const packs = {
    loadForFamily: vi.fn(async () => (opts.pack === undefined ? PACK : opts.pack)),
    loadUniversal: vi.fn(async () => universal),
    resolveForOccupation: vi.fn(async () => universal),
  };
  const answers = {
    listAnswers: vi.fn(async () => opts.saved ?? []),
    // #1459 — the cross-pack tier read. The double mirrors the repository's contract: the row
    // exists only when the chat actually asked the question, and a declined row carries no value.
    findLatestAnswerByQuestionKey: vi.fn(async () => {
      if (opts.chatExperienceYears === undefined) return undefined;
      return {
        status: opts.chatExperienceYears === "declined" ? "declined" : "answered",
        answerNumber: typeof opts.chatExperienceYears === "number" ? opts.chatExperienceYears : null,
      } as unknown as WorkerPackAnswer;
    }),
    // ONE ANSWER IS TWO ROWS, so the service wraps both writes in one transaction. The double
    // runs `cb` directly with a marker executor: there is no database here, so "atomic" is not a
    // property this fake can hold — what it CAN hold is that both writes are attempted inside
    // the callback, which the assertions on `written` and `upsertMany` already check.
    withTransaction: vi.fn(async <T,>(cb: (tx: unknown) => Promise<T>) => cb(FAKE_TX)),
    // `_tx` is captured, not used: the enrolment assertion below reads it off `mock.calls`.
    upsertAnswer: vi.fn(async (row: NewWorkerPackAnswer, _tx?: unknown) => {
      written.push(row);
    }),
  };
  // THE SHEET'S OWN SOURCE. Captured so the tests can assert that a form answer reaches
  // `worker_attributes` and not only `worker_pack_answer` — the capability zone reads the former,
  // and the handover switches off the extraction job that used to be its only writer.
  const upsertMany = vi.fn(async (_rows: unknown[], _tx?: unknown) => 0);
  // The completion half of the form funnel. Captured rather than stubbed to a no-op so the tests
  // can assert BOTH directions: that finishing the form emits exactly once, and that answering a
  // question mid-form emits nothing.
  const emitted: { event_name: string; payload: Record<string, unknown> }[] = [];
  const emit = vi.fn(async (params: { event_name: string; payload: Record<string, unknown> }) => {
    emitted.push(params);
    return {};
  });
  const rebuildQuietly = vi.fn(async () => undefined);
  // "TYPED CUSTOM ANSWER, EVERYWHERE" — the review-or-omit call `answer()` fires,
  // fire-and-forget, whenever `recordFor` marks a value as an "other" answer. A spy, not the
  // real service: these tests assert that the TRIGGER fires with the right arguments, not the
  // AI/fail-closed contract itself, which `other-answer-polish.service.test.ts` already covers.
  const review = vi.fn(async () => "reviewed" as string | null);
  const otherAnswerPolish = { review };
  const config = { WORK_HISTORY_POLISH_ENABLED: true };
  // The safety-net resume refresh: no resume row by default (first-timer), so the
  // re-render never fires unless a test opts in via `resumeId`. The queue double
  // captures `add` calls so the enqueue tests can assert them.
  const latestResume = vi.fn(async (_workerId: string) =>
    opts.resumeId === undefined ? undefined : { id: opts.resumeId },
  );
  const renderQueueAdd = vi.fn(async (_name: string, _data: unknown, _opts: unknown) => ({}));
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
    // ADR-0041 RI-4. THE DEFAULT IS AN EMPTY MAP, and that is the point: a worker who uploaded
    // nothing is the case every other test in this file is about, and the form they assert on
    // must be byte-for-byte the form he sees today.
    { forWorker: async () => opts.suggestions ?? new Map() } as never,
    // ADR-0041 RI-4 — `contextFor`'s résumé-import fallback. No import, so every test here
    // reaches the form through the interview handover. NEITHER THIS SUITE NOR THE ROLE-DRIVE SUITE
    // EXERCISES THAT FALLBACK — both stub it exactly like this — so its branch is unit-untested.
    { findLatestForWorker: async () => undefined } as never,
    otherAnswerPolish as never,
    config as never,
    { latestResume } as never,
    { add: renderQueueAdd } as never,
  );
  return {
    service,
    written,
    packs,
    chat,
    upsertMany,
    emitted,
    emit,
    answers,
    rebuildQuietly,
    review,
    latestResume,
    renderQueueAdd,
  };
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
    // THE MIC ON THE WORK-HISTORY PAGE DEPENDS ON THIS FIELD. `POST /voice/upload` takes a
    // `session_id` and `voice_notes.session_id` is NOT NULL, so a form that does not serve one
    // cannot record a spoken work description at all. Pinned so it is not dropped as unused.
    it("serves the interview's session id, so the work-history mic has one to file a clip under", async () => {
      const { service } = await makeService();
      const schema = await service.schema(WORKER);
      expect(schema.session_id).toBe(SESSION);
    });

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

    // HONEST STATE, PROVED RATHER THAN ASSERTED IN A COMMENT: even once a rewrite exists,
    // `other_text` on the resumed-form edit surface stays the worker's RAW typed words. The
    // `SavedAnswerSchema.other_text` docblock says this is deliberate — the worker editing his
    // own answer must see what he actually typed, not a rewrite he has not yet had the chance to
    // see or refuse — and this test is what would go red the moment someone points this field at
    // `answerOtherTextPolished` without that product decision being made.
    it("still replays the RAW typed 'other' text on the edit surface, even once a reviewed rewrite exists", async () => {
      const { service } = await makeService({
        saved: [
          answered({
            questionKey: "turning_machine",
            answerOptionKeys: null,
            answerOtherText: "ek purana Batliboi lathe",
            answerOtherTextPolished: "Batliboi lathe",
          } as Partial<WorkerPackAnswer>),
        ],
      });
      const schema = await service.schema(WORKER);
      const screens = schema.sections.flatMap((s) => s.screens);
      const machine = screens.find(
        (s) => s.type === "question" && s.question.question_key === "turning_machine",
      );
      expect(machine).toMatchObject({
        answer: { status: "answered", other_text: "ek purana Batliboi lathe" },
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

    it("refreshes an already-generated resume after a capability answer — the Bada Bhai edit loop", async () => {
      // THE SAFETY NET THIS EXISTS FOR. A section-walk edit writes fresh attributes, but the
      // building-screen regenerate only runs when the worker finishes inside the app. An
      // abandoned walk (or a failed generate) would otherwise leave the new attributes in the
      // database with the OLD document + READY pill on screen, forever. The forced re-render
      // rebuilds the sheet from the live attributes at run time: LLM-free, no version bump,
      // no daily-cap spend.
      const { service, renderQueueAdd, latestResume } = await makeService({ resumeId: RESUME });
      await service.answer(WORKER, {
        question_key: "turning_machine",
        answer: { kind: "chips", option_keys: ["k1", "k2"] },
      });
      expect(latestResume).toHaveBeenCalledWith(WORKER);
      expect(renderQueueAdd).toHaveBeenCalledTimes(1);
      expect(renderQueueAdd).toHaveBeenCalledWith(
        "render",
        expect.objectContaining({ resumeId: RESUME, workerId: WORKER, force: true }),
        expect.objectContaining({
          jobId: `trade-form-rerender-${WORKER}`,
          delay: 60_000,
          removeOnComplete: true,
        }),
      );
      // THE LIBRARY RULE, not the mock's silence: BullMQ refuses a custom id containing ":"
      // unless it splits into exactly three parts. The old `trade-form-rerender:<id>` threw on
      // every enqueue in production, and this test, against a mocked queue, pinned it anyway.
      const { jobId } = renderQueueAdd.mock.calls[0]![2] as { jobId: string };
      expect(!jobId.includes(":") || jobId.split(":").length === 3).toBe(true);
    });

    it("does NOT refresh when there is no resume yet — the first generate owns version 1", async () => {
      // First run through the form: nothing to re-render, and the building screen's generate
      // (with its overlay) is what mints the row. An eager enqueue here would render a row
      // that does not exist yet — or worse, race the generate.
      const { service, renderQueueAdd } = await makeService();
      await service.answer(WORKER, {
        question_key: "turning_machine",
        answer: { kind: "chips", option_keys: ["k1", "k2"] },
      });
      expect(renderQueueAdd).not.toHaveBeenCalled();
    });

    it("does NOT refresh on the legacy-universal shim — it writes no attributes", async () => {
      // The shim returns before the capability write, so the hook is never reached even with
      // a resume on file. Same discipline as the preferences page owning shift (#1503).
      const { service, renderQueueAdd, upsertMany } = await makeService({ resumeId: RESUME });
      await service.answer(WORKER, {
        question_key: "shift_preference",
        answer: { kind: "chips", option_keys: ["night"] },
      });
      expect(upsertMany).not.toHaveBeenCalled();
      expect(renderQueueAdd).not.toHaveBeenCalled();
    });

    it("still saves the answer when the refresh enqueue fails — fail open, always", async () => {
      // The answer above already committed; a Redis blip must not fail it, and the worker
      // must never be asked to re-tap a saved answer.
      const { service, renderQueueAdd, written } = await makeService({ resumeId: RESUME });
      renderQueueAdd.mockRejectedValueOnce(new Error("redis down"));
      const result = await service.answer(WORKER, {
        question_key: "turning_machine",
        answer: { kind: "chips", option_keys: ["k1"] },
      });
      expect(result.status).toBe("answered");
      expect(written[0]).toMatchObject({ questionKey: "turning_machine", status: "answered" });
      expect(renderQueueAdd).toHaveBeenCalledTimes(1);
    });

    it("still saves the answer when the resume lookup fails — fail open, always", async () => {
      const { service, renderQueueAdd, latestResume, written } = await makeService({
        resumeId: RESUME,
      });
      latestResume.mockRejectedValueOnce(new Error("db down"));
      const result = await service.answer(WORKER, {
        question_key: "turning_machine",
        answer: { kind: "chips", option_keys: ["k1"] },
      });
      expect(result.status).toBe("answered");
      expect(written[0]).toMatchObject({ questionKey: "turning_machine", status: "answered" });
      expect(renderQueueAdd).not.toHaveBeenCalled();
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

    // "Typed custom answer, everywhere" (owner ruling, round 4): a worker who types free text
    // against a closed-option question is not turned away. This REPLACES the old assertion that
    // this 400'd (`/does not take free text/`) — the old behaviour was exactly the silent-drop-
    // by-rejection the ruling forbids: the worker typed a real answer and the form refused it.
    it("captures free text on a select question as an 'other' answer, never a 400 and never a typed column", async () => {
      const { service, written } = await makeService();
      const response = await service.answer(WORKER, {
        question_key: "turning_machine",
        answer: { kind: "text", text: "CNC lathe" },
      });
      expect(response.status).toBe("answered");
      expect(written[0]).toMatchObject({ status: "answered" });
      // NEVER a typed column — an "other" answer must not be readable as settled vocabulary by
      // a tier gate or a `worker_attributes` projection. See `pack-answer-row.ts`.
      expect(written[0]?.answerText).toBeUndefined();
      expect(written[0]?.answerOptionKeys).toBeUndefined();
      expect(written[0]?.answerOtherText).toBe("CNC lathe");
    });

    // INTEGRATION-SHAPED: exercises the real `answer()` flow end to end (through `recordFor`,
    // `packAnswerRowFor`, the transaction, and the trigger below it) and asserts the review-or-
    // omit path was actually invoked with the answer just saved — not a unit test of
    // `OtherAnswerPolishService` in isolation, which `other-answer-polish.service.test.ts`
    // already covers. This is the test that would have caught the dead-code finding: it fails
    // red the moment `triggerOtherAnswerPolish`'s call site is removed or never wired.
    it("hands a typed 'other' answer to the review-or-omit path, fire-and-forget", async () => {
      const { service, review } = await makeService();
      const response = await service.answer(WORKER, {
        question_key: "turning_machine",
        answer: { kind: "text", text: "CNC lathe" },
      });
      expect(response.status).toBe("answered");
      // CALLED SYNCHRONOUSLY WITHIN `answer()`, even though never awaited — a mocked async
      // function records its call the instant it is invoked, before its own promise settles, so
      // this assertion needs no `await`/flush to see the call `answer()`'s return already implies.
      expect(review).toHaveBeenCalledTimes(1);
      expect(review).toHaveBeenCalledWith(
        WORKER,
        "qp_cnc_turning",
        "turning_machine",
        "CNC lathe",
        // The question's own prompt text — this pack's `item()` helper defaults it to
        // `${question_key}?`.
        "turning_machine?",
        expect.objectContaining({ correlationId: undefined, requestId: undefined }),
        expect.objectContaining({ WORK_HISTORY_POLISH_ENABLED: true }),
        // A FRESH TRIGGER, ALWAYS — `upsertAnswer` clears any prior polish/decline on every
        // write, so this is the only state `triggerOtherAnswerPolish` can honestly pass.
        { polished: null, declined: false },
      );
    });

    it("never triggers the review-or-omit path for a settled (non-'other') answer", async () => {
      const { service, review } = await makeService();
      await service.answer(WORKER, {
        question_key: "trade_test_status",
        answer: { kind: "boolean", value: true },
      });
      expect(review).not.toHaveBeenCalled();
    });

    it("never triggers the review-or-omit path when the typed 'other' text is empty (declined, not stored)", async () => {
      const { service, review } = await makeService();
      const response = await service.answer(WORKER, {
        question_key: "turning_machine",
        answer: { kind: "text", text: "   " },
      });
      expect(response.status).toBe("declined");
      expect(review).not.toHaveBeenCalled();
    });

    it("declines (rather than 400s or silently drops) empty typed text on a select question", async () => {
      const { service, written } = await makeService();
      const response = await service.answer(WORKER, {
        question_key: "turning_machine",
        answer: { kind: "text", text: "   " },
      });
      expect(response.status).toBe("declined");
      expect(written[0]).toMatchObject({ status: "declined" });
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
/**
   * ═══ ONE ANSWER IS TWO ROWS, AND THEY COMMIT TOGETHER ═══
   *
   * These two writes were separate autocommits, and the failure was silent AND unrecoverable:
   * when the attribute write failed, the `worker_pack_answer` row still committed — so
   * `answeredCount` counted the question, the rail advanced, the worker was told it saved, and
   * `worker_attributes` (what the printed sheet and the matcher read) had nothing. Retrying could
   * not repair it either, because `upsertAnswer` is idempotent and succeeds again every time.
   *
   * WHAT A MOCK CAN AND CANNOT PROVE. Atomicity is a database property and there is no database
   * here — the real proof is `tests/e2e/trade-form.e2e.test.ts`, which runs this against Postgres.
   * What IS provable here is enrolment: both writes receive the SAME executor the transaction
   * handed out, rather than each opening its own. That is the thing the code change actually
   * makes true, and it is what would regress if someone dropped a `tx` argument.
   */
  describe("the two writes are one unit of work", () => {
    it("enrols BOTH writes in the same transaction", async () => {
      const { service, answers, upsertMany } = await makeService();

      await service.answer(WORKER, {
        question_key: "turning_machine",
        answer: { kind: "chips", option_keys: ["k1"] },
      });

      expect(answers.withTransaction).toHaveBeenCalledTimes(1);
      // The executor the transaction handed out, and the one each write actually used.
      const answerTx = answers.upsertAnswer.mock.calls[0]![1];
      const attributeTx = upsertMany.mock.calls[0]![1];
      expect(answerTx, "upsertAnswer ran outside the transaction").toBe(FAKE_TX);
      expect(attributeTx, "upsertMany ran outside the transaction").toBe(FAKE_TX);
      expect(answerTx).toBe(attributeTx);
    });

    it("does not open a transaction per write", async () => {
      const { service, answers } = await makeService();

      await service.answer(WORKER, {
        question_key: "turning_machine",
        answer: { kind: "chips", option_keys: ["k1"] },
      });
      await service.answer(WORKER, {
        question_key: "controller_brand",
        answer: { kind: "chips", option_keys: ["k2"] },
      });

      // One per ANSWER, not one per row written.
      expect(answers.withTransaction).toHaveBeenCalledTimes(2);
    });
  });
/**
 * ═══ MUTUALLY EXCLUSIVE QUESTIONS NEVER REACH A WORKER TOGETHER (#1413 §3) ═══
 *
 * `qp_cad_drafting` asks a draughtsman with experience which sectors he has DRAWN for, and a
 * fresher which he STUDIED. The two are complements on one gate — `drafting_experience >= 2`
 * against `<= 1` — so exactly one is ever his question.
 *
 * #1413 reported that both are visible on the first fetch, and that is TRUE OF THE PAYLOAD:
 * `form-eligibility`'s rule is that an UNRESOLVED gate shows the question, deliberately, so the
 * form is never shorter than the truth. What stops the worker seeing both is a chain of three
 * separate changes that no test held together:
 *
 *   1. #1377/#1378 — `orderBySheet` hoists every mandatory item and the tenure gate to the FRONT,
 *      so `drafting_experience` is asked before the pair it gates.
 *   2. `schema_stale` — answering a key that appears in any `ask_if`/`skip_if` tells the client
 *      the screen list it holds is now stale (`gateKeysOf`).
 *   3. #1382 — the client re-fetches on that flag rather than walking its stale list.
 *
 * Break any one and the worker is asked both, or asked the wrong one. These assert the two links
 * this service owns; the third is the Flutter cubit's `_resyncAfterStaleSchema`.
 */
describe("#1413 §3 — the drafting-sector pair", () => {
  const DRAFTING: QuestionPack = {
    ...PACK,
    pack_id: "qp_cad_drafting",
    family_id: "fam_cad_drafting",
    items: [
      // Deliberately LAST in the pack's own order, so a service that did not hoist it would
      // serve it after the two questions it governs — the exact defect #1377 fixed.
      item({
        question_key: "cad_software",
        answer_type: "multi_select",
        options: options(4),
      }),
      item({
        question_key: "sector_drawn",
        answer_type: "multi_select",
        options: options(4),
        ask_if: { op: "gte", left: { field: "drafting_experience" }, right: { const: 2 } },
      }),
      item({
        question_key: "sector_studied",
        answer_type: "multi_select",
        options: options(4),
        ask_if: { op: "lte", left: { field: "drafting_experience" }, right: { const: 1 } },
      }),
      item({
        question_key: "drafting_experience",
        answer_type: "single_select",
        is_mandatory: true,
        options: [
          { option_key: "k0", label_text: "Fresher", value: 0, implies_skill_id: null, is_none_of_above: false },
          { option_key: "k5", label_text: "5 saal", value: 5, implies_skill_id: null, is_none_of_above: false },
        ],
      }),
    ] as QuestionPackItem[],
  };

  const keysOf = (schema: { sections: { screens: unknown[] }[] }) =>
    schema.sections
      .flatMap((s) => s.screens)
      .filter((s): s is { question: { question_key: string } } =>
        typeof s === "object" && s !== null && "question" in s)
      .map((s) => s.question.question_key);

  it("asks the GATE before either question it gates", async () => {
    const { service } = await makeService({ pack: DRAFTING });
    const keys = keysOf(await service.schema(WORKER));
    // The pack lists it last; the form must not.
    expect(keys.indexOf("drafting_experience")).toBeLessThan(keys.indexOf("sector_drawn"));
    expect(keys.indexOf("drafting_experience")).toBeLessThan(keys.indexOf("sector_studied"));
    expect(keys[0]).toBe("drafting_experience");
  });

  it("EXACTLY ONE of the pair survives once the gate is answered", async () => {
    for (const [rung, expected, gone] of [
      [5, "sector_drawn", "sector_studied"],
      [0, "sector_studied", "sector_drawn"],
    ] as const) {
      const { service } = await makeService({
        pack: DRAFTING,
        saved: [
          answered({
            questionKey: "drafting_experience",
            answerOptionKeys: null,
            answerNumber: rung,
          }),
        ],
      });
      const keys = keysOf(await service.schema(WORKER));
      expect(keys, `rung ${rung} must keep ${expected}`).toContain(expected);
      expect(keys, `rung ${rung} must drop ${gone}`).not.toContain(gone);
    }
  });

  it("shows BOTH while the gate is unanswered — the deliberate fail-open", async () => {
    // NOT A BUG, and pinned so it is not "fixed" into a silent drop. An unresolved gate shows the
    // question so the form is never SHORTER than the truth; the ordering and staleness rules
    // above are what stop a worker reaching them. Removing this would hide a fresher's own
    // question from him whenever the gate write failed.
    const { service } = await makeService({ pack: DRAFTING });
    const keys = keysOf(await service.schema(WORKER));
    expect(keys).toContain("sector_drawn");
    expect(keys).toContain("sector_studied");
  });
});
});

/**
 * ═══ #1503 — THE UNIVERSAL APPEND IS GONE, AND AN APP HOLDING IT IS NOT STRANDED ═══
 *
 * `f455bb36` served all eight `qp_universal@2` questions on every trade form. The owner ruling of
 * 2026-09-15 puts those facts on the pages that own them, so the form serves its trade pack and
 * nothing else — and an app still holding the old schema must be able to POST the screen it is
 * showing without a 400 stranding the worker there.
 */
describe("#1503 — the trade form without the universal append", () => {
  const LEGACY = new Set(rawCorpusPack(UNIVERSAL_PACK_FILE).items.map((entry) => entry.question_key));

  /** Every question in PACK settled, so a completion WOULD fire on any answer that evaluated it. */
  const everythingSettled = () =>
    PACK.items.map((entry) =>
      answered({
        questionKey: entry.question_key,
        answerOptionKeys: null,
        answerText: "v0",
      }),
    );

  const logSpy = () => vi.spyOn(Logger.prototype, "log").mockImplementation(() => undefined);

  it("VACUITY — the universal pack the double serves really has eight questions to append", () => {
    expect(UNIVERSAL.items).toHaveLength(8);
    expect(LEGACY.size).toBe(8);
  });

  it("serves no universal question, although the universal pack loads", async () => {
    const { service } = makeService();
    const served = (await service.schema(WORKER)).sections
      .flatMap((section) => section.screens)
      .flatMap((screen) => (screen.type === "question" ? [screen.question.question_key] : []));
    expect(served.filter((key) => LEGACY.has(key))).toEqual([]);
    expect([...served].sort()).toEqual(PACK.items.map((entry) => entry.question_key).sort());
  });

  it("the frozen legacy list is EXACTLY the eight keys that deploy served, as a literal", () => {
    expect(Object.isFrozen(LEGACY_FORM_UNIVERSAL_KEYS)).toBe(true);
    expect([...LEGACY_FORM_UNIVERSAL_KEYS].sort()).toEqual([...LEGACY].sort());
  });

  describe("the legacy-key shim", () => {
    it("answers 200 with schema_stale, and stores the row where that deploy stored it", async () => {
      const { service, written } = makeService();
      const result = await service.answer(WORKER, {
        question_key: "availability",
        answer: { kind: "chips", option_keys: ["immediate"] },
      });

      expect(result).toEqual({
        question_key: "availability",
        status: "answered",
        answered: 0,
        total: PACK.items.length,
        schema_stale: true,
      });
      expect(written).toHaveLength(1);
      // UNDER THE TRADE PACK, not an invented `qp_universal` location nothing reads.
      expect(written[0]).toMatchObject({
        workerId: WORKER,
        packId: "qp_cnc_turning",
        packVersion: 1,
        questionKey: "availability",
        answerText: "immediate",
        status: "answered",
        source: "form",
        chatSessionId: SESSION,
      });
    });

    it("writes NO worker_attributes row — the preferences page owns shift", async () => {
      // `shift_preference` is the one universal item with `target_kind: attribute`, so the normal
      // path WOULD write it; that write racing the page's is the overwrite #1503 reported.
      const { service, upsertMany, written, answers } = makeService();
      await service.answer(WORKER, {
        question_key: "shift_preference",
        answer: { kind: "chips", option_keys: ["night"] },
      });
      expect(written[0]).toMatchObject({ questionKey: "shift_preference", answerText: "night" });
      expect(upsertMany).not.toHaveBeenCalled();
      expect(answers.withTransaction).not.toHaveBeenCalled();
    });

    it("runs NO completion evaluation, even on a form every question of which is settled", async () => {
      // THE DISCRIMINATING HALF FIRST: the same settled rows DO complete the form on a real answer,
      // so an empty `emitted` below is the shim skipping the check, not the fixture being unable to
      // satisfy it.
      const control = makeService({ saved: everythingSettled() });
      await control.service.answer(WORKER, {
        question_key: "turning_machine",
        answer: { kind: "chips", option_keys: ["k1"] },
      });
      expect(control.emitted.map((event) => event.event_name)).toEqual(["profile.form_completed"]);

      const { service, emitted, rebuildQuietly } = makeService({ saved: everythingSettled() });
      const result = await service.answer(WORKER, {
        question_key: "current_city",
        answer: { kind: "text", text: "Pune" },
      });
      expect(emitted).toEqual([]);
      expect(rebuildQuietly).not.toHaveBeenCalled();
      // Counted over what the form asks — the shim's own row is in neither number.
      expect(result).toMatchObject({ answered: PACK.items.length, total: PACK.items.length });
    });

    it("logs the key slug and counts, never the value", async () => {
      const log = logSpy();
      const { service } = makeService();
      await service.answer(WORKER, {
        question_key: "current_city",
        answer: { kind: "text", text: "Pimpri Chinchwad" },
      });
      const lines = log.mock.calls.map((call) => String(call[0]));
      const line = lines.find((entry) => entry.includes("legacy universal form key accepted"));
      log.mockRestore();

      expect(line).toBeDefined();
      expect(line).toContain("key=current_city");
      expect(line).toContain("pack=qp_cnc_turning");
      expect(lines.join("\n")).not.toContain("Pimpri");
    });

    it("400s a universal key that deploy NEVER served, even when the live pack defines it", async () => {
      // A ninth question the universal pack gains later reached no trade form, so no client holds
      // it. A shim that derived its list from `loadUniversal()` would accept this.
      const ninth = item({ question_key: "notice_period", answer_type: "text" });
      const { service, written } = makeService({
        universal: { ...UNIVERSAL, items: [...UNIVERSAL.items, ninth] },
      });
      await expect(
        service.answer(WORKER, {
          question_key: "notice_period",
          answer: { kind: "text", text: "15 din" },
        }),
      ).rejects.toMatchObject({ status: 400 });
      expect(written).toEqual([]);
    });

    it("400s, logged, when the universal pack does not load — there is no type to validate against", async () => {
      const warn = vi.spyOn(Logger.prototype, "warn").mockImplementation(() => undefined);
      const { service, written } = makeService({ universal: null });
      await expect(
        service.answer(WORKER, {
          question_key: "experience_years",
          answer: { kind: "text", text: "6" },
        }),
      ).rejects.toMatchObject({ status: 400 });
      expect(written).toEqual([]);
      expect(warn.mock.calls.map((call) => String(call[0])).join("\n")).toContain(
        "experience_years",
      );
      warn.mockRestore();
    });

    it("400s when the universal pack no longer defines the key", async () => {
      const { service, written } = makeService({
        universal: {
          ...UNIVERSAL,
          items: UNIVERSAL.items.filter((entry) => entry.question_key !== "education"),
        },
      });
      await expect(
        service.answer(WORKER, {
          question_key: "education",
          answer: { kind: "chips", option_keys: ["tenth"] },
        }),
      ).rejects.toMatchObject({ status: 400 });
      expect(written).toEqual([]);
    });
  });

  describe("numbers", () => {
    /** PACK with one number-typed trade question. No enabled pack has one today; this is a guard. */
    const NUMBERED: QuestionPack = {
      ...PACK,
      items: [...PACK.items, item({ question_key: "parts_per_shift", answer_type: "number" })],
    };

    it.each([
      ["6", 6],
      ["15,000", 15000],
      ["₹25,000", 25000],
      ["1,00,000", 100000],
    ])("a trade number question stores %j as %d", async (text, expected) => {
      const { service, written } = makeService({ pack: NUMBERED });
      await service.answer(WORKER, { question_key: "parts_per_shift", answer: { kind: "text", text } });
      expect(written[0]).toMatchObject({ answerNumber: expected, status: "answered" });
    });

    it.each(["pata nahi", "5 se 7 saal", "2 saal 6 mahine", "15k", "6 saal nahi"])(
      "a trade number question 400s %j rather than storing a false number",
      async (text) => {
        const { service, written } = makeService({ pack: NUMBERED });
        await expect(
          service.answer(WORKER, { question_key: "parts_per_shift", answer: { kind: "text", text } }),
        ).rejects.toThrow(/parts_per_shift takes a number/);
        expect(written).toEqual([]);
      },
    );

    it.each([
      ["experience_years", "6", 6],
      ["salary_expected", "15,000", 15000],
      ["salary_expected", "₹25,000", 25000],
      ["salary_expected", "1,00,000", 100000],
    ])("the shim stores %s %j as %d", async (key, text, expected) => {
      const { service, written } = makeService();
      await service.answer(WORKER, { question_key: key, answer: { kind: "text", text } });
      expect(written[0]).toMatchObject({ answerNumber: expected, status: "answered" });
    });

    it.each(["pata nahi", "5 se 7 saal", "2 saal 6 mahine", "15k", "6 saal nahi"])(
      "the shim DECLINES %j — never 0, 57, 26, 15 or 6",
      async (text) => {
        const { service, written } = makeService();
        const result = await service.answer(WORKER, {
          question_key: "experience_years",
          answer: { kind: "text", text },
        });
        expect(result).toMatchObject({ status: "declined", schema_stale: true });
        expect(written[0]).toMatchObject({ questionKey: "experience_years", status: "declined" });
        expect(written[0]!.answerNumber ?? null).toBeNull();
      },
    );
  });
});

describe("ADR-0041 RI-4 — what the worker's résumé suggested, beside the question it is about", () => {
  const suggestion = (text: string) => ({
    values: { option_keys: [], text, number: null, bool: null },
    source: "resume" as const,
    confidence: 0.88,
  });

  it("a worker who uploaded NOTHING sees every question with `suggestion: null`", async () => {
    // THE INVARIANT THE WHOLE FEATURE SHIPS UNDER. The no-résumé path is the one that ships
    // today, and it must stay byte for byte what it was — an additive field that is always
    // present and always null is exactly that.
    const { service } = makeService();
    const schema = await service.schema(WORKER);
    const questions = schema.sections
      .flatMap((section) => section.screens)
      .filter((screen) => screen.type === "question");

    expect(questions.length).toBeGreaterThan(0); // vacuity: there ARE questions to check
    for (const screen of questions) {
      expect(screen).toHaveProperty("suggestion", null);
    }
  });

  it("a staged suggestion reaches the question it targets, and only that one", async () => {
    const { service } = makeService({
      suggestions: new Map([["turning_machine", suggestion("CNC Lathe")]]),
    });
    const schema = await service.schema(WORKER);
    const questions = schema.sections
      .flatMap((section) => section.screens)
      .filter((screen) => screen.type === "question");

    const targeted = questions.find((screen) => screen.question.question_key === "turning_machine");
    expect(targeted?.suggestion?.values.text).toBe("CNC Lathe");
    // Every OTHER question is untouched — a suggestion is not a form-wide banner.
    for (const screen of questions) {
      if (screen.question.question_key !== "turning_machine") {
        expect(screen.suggestion).toBeNull();
      }
    }
  });

  it("a STORED ANSWER is served BYTE FOR BYTE what it would be with no résumé (ruling D7)", async () => {
    // D7 says a stored answer always wins, and the way that is expressed here is that nothing
    // overwrites anything. Asserting a hard-coded option list would pin the FIXTURE; asserting
    // the answer is identical with and without a suggestion pins the RULE — if a suggestion
    // ever altered a served answer by any byte, this fails and nothing else would.
    const saved = [answered({ questionKey: "turning_machine", answerOptionKeys: ["k1"] })];
    const withoutResume = await makeService({ saved }).service.schema(WORKER);
    const withResume = await makeService({
      saved,
      suggestions: new Map([["turning_machine", suggestion("CNC Lathe")]]),
    }).service.schema(WORKER);

    type Screen = Awaited<ReturnType<TradeFormService["schema"]>>["sections"][number]["screens"][number];
    type QuestionScreen = Extract<Screen, { type: "question" }>;
    const answerFor = (schema: Awaited<ReturnType<TradeFormService["schema"]>>) =>
      schema.sections
        .flatMap((section) => section.screens)
        .find(
          (candidate): candidate is QuestionScreen =>
            candidate.type === "question" && candidate.question.question_key === "turning_machine",
        );

    const plain = answerFor(withoutResume);
    const suggested = answerFor(withResume);

    expect(plain?.answer).not.toBeNull(); // vacuity: there IS a stored answer to preserve
    expect(suggested?.answer).toEqual(plain?.answer);
    // And the suggestion sits BESIDE it rather than instead of it — the worker sees both and
    // settles the disagreement himself, which is the only place it can honestly be settled.
    expect(suggested?.suggestion?.values.text).toBe("CNC Lathe");
    expect(plain?.suggestion).toBeNull();
  });

  it("a suggestion carries NO status — it is not an answer and cannot be read as one", async () => {
    // Ruling D2. A capability chip arrives highlighted and UNTICKED; a suggestion that arrived
    // shaped like a SavedAnswer is one client bug away from being rendered as settled.
    const { service } = makeService({
      suggestions: new Map([["turning_machine", suggestion("CNC Lathe")]]),
    });
    const schema = await service.schema(WORKER);
    const screen = schema.sections
      .flatMap((section) => section.screens)
      .find(
        (candidate): candidate is Extract<typeof candidate, { type: "question" }> =>
          candidate.type === "question" && candidate.question.question_key === "turning_machine",
      );

    expect(screen?.suggestion).not.toBeNull();
    expect(screen?.suggestion).not.toHaveProperty("status");
    expect(Object.keys(screen!.suggestion!).sort()).toEqual(["confidence", "source", "values"]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// #1459 — THE PER-TRADE TIER IS PRE-SETTLED FROM THE CHAT'S experience_years
//
// The defect: the form's FIRST question is the pack's `*_experience` tier gate and the chat
// already asked `experience_years`. Deleting it re-opens #1378; re-pointing the gates cannot
// work (pack-scoped answer map). The owner ruling of 2026-09-21: derive the tier, do not ask.
// ─────────────────────────────────────────────────────────────────────────────

/** The tenure question's options carry value_number ONLY — the shape every gate expects. */
const TENURE_OPTIONS = [
  { option_key: "k0", label_text: "Fresher", value: 0, implies_skill_id: null, is_none_of_above: false },
  { option_key: "k2", label_text: "1-3 years", value: 2, implies_skill_id: null, is_none_of_above: false },
  { option_key: "k5", label_text: "3-7 years", value: 5, implies_skill_id: null, is_none_of_above: false },
  { option_key: "k10", label_text: "7+ years", value: 10, implies_skill_id: null, is_none_of_above: false },
];

/** The real tenure key for `cnc_turner` (`cnc-turner.role.ts`), plus one gate per direction. */
const TENURE_PACK: QuestionPack = {
  pack_id: "qp_cnc_turning",
  version: 1,
  family_id: "fam_cnc_turning",
  locale: "hi-IN",
  status: "active",
  content_hash: "hash",
  items: [
    item({ question_key: "turning_experience", answer_type: "single_select", options: TENURE_OPTIONS }),
    item({
      question_key: "turning_test_advanced",
      answer_type: "boolean",
      ask_if: { op: "gte", left: { field: "turning_experience" }, right: { const: 5 } },
    }),
    item({
      question_key: "iti_project_work",
      answer_type: "text",
      ask_if: { op: "lte", left: { field: "turning_experience" }, right: { const: 0 } },
    }),
  ],
};

/** Every question key the served schema puts on a screen. */
function servedKeys(schema: TradeFormSchemaResponse): string[] {
  return schema.sections.flatMap((section) =>
    section.screens.flatMap((screen) =>
      screen.type === "question" ? [screen.question.question_key] : [],
    ),
  );
}

describe("#1459 — the per-trade tier is pre-settled from the chat's experience_years", () => {
  it("still asks the tier when the chat never asked experience_years — nothing is derived", async () => {
    const { service } = await makeService({ pack: TENURE_PACK });
    const keys = servedKeys(await service.schema(WORKER));
    expect(keys).toContain("turning_experience");
    // An UNRESOLVED gate shows its question (form-eligibility's documented fail direction).
    expect(keys).toContain("turning_test_advanced");
    expect(keys).toContain("iti_project_work");
  });

  it("stops asking it once the chat knows: 7 years resolves the senior gate and hides the fresher one", async () => {
    const { service } = await makeService({ pack: TENURE_PACK, chatExperienceYears: 7 });
    const keys = servedKeys(await service.schema(WORKER));
    expect(keys).not.toContain("turning_experience");
    expect(keys).toContain("turning_test_advanced");
    expect(keys).not.toContain("iti_project_work");
  });

  it("0 years resolves the fresher gate and hides the senior one", async () => {
    const { service } = await makeService({ pack: TENURE_PACK, chatExperienceYears: 0 });
    const keys = servedKeys(await service.schema(WORKER));
    expect(keys).not.toContain("turning_experience");
    expect(keys).toContain("iti_project_work");
    expect(keys).not.toContain("turning_test_advanced");
  });

  it("FIRST-WRITE-WINS: a stored tenure answer keeps the question visible, derived or not", async () => {
    const { service } = await makeService({
      pack: TENURE_PACK,
      chatExperienceYears: 7,
      saved: [answered({ questionKey: "turning_experience", answerNumber: 2 })],
    });
    const keys = servedKeys(await service.schema(WORKER));
    expect(keys).toContain("turning_experience");
    // The worker's OWN tap gates the form, not the derived 7 — the senior question stays hidden
    // because 2 is below 5, which is the value his stored answer carries.
    expect(keys).not.toContain("turning_test_advanced");
  });

  it("a DECLINED experience_years derives nothing — the question stays and its gates stay unresolved", async () => {
    const { service } = await makeService({ pack: TENURE_PACK, chatExperienceYears: "declined" });
    const keys = servedKeys(await service.schema(WORKER));
    expect(keys).toContain("turning_experience");
    expect(keys).toContain("turning_test_advanced");
    expect(keys).toContain("iti_project_work");
  });
});
