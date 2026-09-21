import { describe, expect, it, vi } from "vitest";

import { PiiCryptoService } from "../../common/pii-crypto.service";
import { ResumeAutofillService } from "../form/resume-autofill.service";
import { selectedKeys } from "../form/trade-form.service";
import { ResumeSuggestionReader } from "./resume-suggestion-reader";

/**
 * THE WHOLE RI-AUTOFILL CHAIN, over the REAL components — staging, seal/unseal, apply, read-back.
 *
 * WHY THIS FILE EXISTS. The autofill's parts are each unit-tested, and every one of those
 * unit tests passes while the FEATURE can still not work, because the failure modes live
 * BETWEEN the parts: a writer spelling `question_key` while the reader expects `questionKey`
 * (that one happened and was caught only by the reader's own test), an `option_map` key that
 * does not survive the seal, an applied answer whose normalised VALUE does not map back
 * through the pack's option table to the KEY the client pre-selects. A unit test cannot see
 * any of those, and the symptom — "I uploaded a résumé and no chip was ticked" — looks
 * exactly like a config problem, which is where a search for it goes first.
 *
 * THE ONE THING IT PROVES: for a document whose mapping ticks `cylindrical`, the client
 * receives `answer.option_keys: ["cylindrical"]` for that question — which is precisely what
 * `trade_form_question_body.dart` seeds `_selected` from.
 *
 * `selectedKeys` IS THE REAL FUNCTION, exported for this test. The alternative — a second
 * copy of the option-table round trip here — would be a copy free to disagree with the one
 * the form actually serves, which is the entire class of bug this file exists to catch.
 */

const WORKER = "11111111-1111-4111-8111-111111111111";
const IMPORT = "22222222-2222-4222-8222-222222222222";

/** A pack shaped like the real ones: option_key ≠ option.value, which is the trap. */
const PACK = {
  pack_id: "qp_cnc_grinding",
  version: 3,
  items: [
    {
      question_key: "grinding_machine",
      prompt_text: "Kaun si grinding machine chalate hain?",
      display_order: 0,
      target_kind: "attribute" as const,
      target_field: "grinding_machine",
      target_skill_id: null,
      answer_type: "multi_select" as const,
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
      options: [
        {
          option_key: "cylindrical",
          label_text: "CNC cylindrical grinder",
          // THE DELIBERATE TRAP: the value differs from the key, exactly as the comment in
          // `questionScreen` warns. A round trip that stored the key would look right here
          // and fail in the client; one that stores the value and reads back through the
          // option table is the only one that works.
          value: "mach_cylindrical_v1",
          implies_skill_id: null,
          is_none_of_above: false,
        },
        {
          option_key: "surface",
          label_text: "Surface grinder",
          value: "mach_surface_v1",
          implies_skill_id: null,
          is_none_of_above: false,
        },
      ],
    },
  ],
};

describe("RI-autofill end to end — a staged mapping reaches the client as a ticked chip", () => {
  it("staged key -> sealed envelope -> applied answer -> selectedKeys returns the key", async () => {
    const crypto = new PiiCryptoService({
      PII_ENCRYPTION_KEY: Buffer.alloc(32, 7).toString("base64"),
    } as never);

    // (1) STAGE, exactly as `ResumeRouteService.decide` writes it — through the real cipher.
    const sealed = crypto.encrypt(
      JSON.stringify({
        answers: {},
        employments: [],
        option_map: [{ question_key: "grinding_machine", option_keys: ["cylindrical"] }],
      }),
    );
    const imports = {
      findForWorker: vi.fn(async () => ({
        id: IMPORT,
        route: "form",
        formKind: "cnc_grinding",
        suggestionsEnc: sealed,
      })),
    };
    const reader = new ResumeSuggestionReader(imports as never, crypto);

    // (2) The real rows the autofill would write into `worker_pack_answer`.
    const written: Record<string, unknown>[] = [];
    const answers = {
      listAnswers: vi.fn(async () => []),
      withTransaction: vi.fn(async (cb: (tx: unknown) => Promise<unknown>) => cb("tx")),
      upsertAnswer: vi.fn(async (row: Record<string, unknown>) => {
        written.push(row);
      }),
    };
    const svc = new ResumeAutofillService(
      reader,
      {
        loadForFamily: vi.fn(async () => PACK),
      } as never,
      answers as never,
      { upsertMany: vi.fn(async () => 1) } as never,
      { emit: vi.fn(async () => undefined) } as never,
      { RESUME_AUTOFILL_ENABLED: true } as never,
    );

    // (3) APPLY — the full service, the real second wall, the real builders.
    const result = await svc.applyOnHaan(WORKER, IMPORT, {
      correlationId: "c",
      requestId: "r",
    });
    expect(result).toEqual({ mapped: 1, applied: 1, skippedAnswered: 0 });
    expect(written).toHaveLength(1);
    // THE STORED VALUE IS THE NORMALISED ONE, never the key.
    expect(written[0]).toMatchObject({
      questionKey: "grinding_machine",
      status: "answered",
      source: "resume",
      answerOptionKeys: ["mach_cylindrical_v1"],
    });

    // (4) READ BACK over the REAL read-back — what `GET /profiling/form` serves and what
    // `trade_form_question_body.dart` seeds `_selected` from. If this ever stops returning
    // the key, the client renders the question unanswered and this file is the alarm.
    const selected = selectedKeys(PACK.items[0]!, written[0] as never);
    expect(selected).toEqual(["cylindrical"]);
  });
});
