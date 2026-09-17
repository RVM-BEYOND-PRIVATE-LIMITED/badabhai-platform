import { describe, expect, it } from "vitest";
import type { QuestionPackItem } from "@badabhai/ai-contracts";

import { LANGUAGES, WORK_TYPES } from "../../profiles/worker-preferences.vocabulary";
import { captureAnswer } from "../answer-capture";
import { universalPack } from "../corpus-packs.fixture";
import { factForPackItem } from "./worker-fact.registry";

/**
 * FILL-GAP PHASE 1, END TO END THROUGH THE REAL CORPUS — `qp_universal@3`'s two new questions.
 *
 * `languages` and `work_types` are `attribute` `multi_select`s over CLOSED chip vocabularies, and
 * every one of those three words is load-bearing:
 *
 *  - `multi_select` because a worker speaks more than one language and will take more than one
 *    kind of work, and the single-choice forms of both used to force a half-truth;
 *  - `attribute` because the destination is `worker_attributes` (a `text_list` of slugs), the
 *    SAME store the finishing form's own multis write — so the Languages row on the sheet has one
 *    source, not two that disagree;
 *  - CLOSED because `worker_attributes.value_text` is matched by equality: a chip the worker did
 *    not tap must be dropped rather than guessed, or the value is unmatchable.
 *
 * VERBATIM FROM THE SHIPPED CORPUS, not a hand-built fixture — the defect class this file exists
 * for is a disagreement between what was AUTHORED and what the capture path can read, and a
 * fixture that restates either half would test my reading of the corpus instead of the corpus.
 */
const pack = universalPack(3);

function corpusItem(questionKey: string): QuestionPackItem {
  const item = pack.items.find((candidate) => candidate.question_key === questionKey);
  if (!item) throw new Error(`qp_universal@3 has no item ${questionKey}`);
  return item;
}

const only = (capture: ReturnType<typeof captureAnswer>) => {
  expect(capture.values).toHaveLength(1);
  return capture.values[0]!;
};

describe("qp_universal@3 — the two new questions are wired to their facts", () => {
  it("resolves to the chat-owned facts by the same lookup the ownership filter uses", () => {
    expect(factForPackItem(corpusItem("languages"))?.fact).toBe("languages");
    expect(factForPackItem(corpusItem("work_types"))?.fact).toBe("work_types");
  });

  it("carries the whole LANGUAGES dictionary — every chip's slug and label, no drift", () => {
    const chips = corpusItem("languages").options;
    expect(Object.fromEntries(chips.map((c) => [c.value, c.label_text]))).toEqual({ ...LANGUAGES });
  });

  it("carries the whole WORK_TYPES dictionary — the same slugs the finishing form writes", () => {
    const chips = corpusItem("work_types").options;
    expect(Object.fromEntries(chips.map((c) => [c.value, c.label_text]))).toEqual({
      ...WORK_TYPES,
    });
  });
});

describe("qp_universal@3 — what a spoken answer captures", () => {
  it("captures EVERY language the worker names, in the order they said them, as slugs", () => {
    const value = only(
      captureAnswer("Hindi aur English dono bolta hoon", corpusItem("languages")),
    ).valueNormalized;
    expect(value).toEqual(["hindi", "english"]);
  });

  it("captures a regional language named on its own", () => {
    expect(only(captureAnswer("sirf Haryanvi", corpusItem("languages"))).valueNormalized).toEqual([
      "haryanvi",
    ]);
  });

  it("drops a language the worker REFUSED rather than recording it", () => {
    expect(
      only(captureAnswer("Hindi bolta hoon, Tamil nahi", corpusItem("languages"))).valueNormalized,
    ).toEqual(["hindi"]);
  });

  it("captures NOTHING rather than guessing when the answer is a hedge", () => {
    // Closed vocabulary on an attribute: a sentence stored here is not a worse value, it is an
    // unmatchable one. The question stays askable instead.
    expect(captureAnswer("thodi thodi sab aati hai", corpusItem("languages")).values).toHaveLength(
      0,
    );
  });

  it("captures both work types when the worker says both are acceptable", () => {
    expect(
      only(captureAnswer("permanent aur daily wage dono chalega", corpusItem("work_types")))
        .valueNormalized,
    ).toEqual(["permanent", "daily_wage"]);
  });

  it("captures a single work type from a sentence", () => {
    expect(
      only(captureAnswer("sirf contract kaam karna hai", corpusItem("work_types"))).valueNormalized,
    ).toEqual(["contract"]);
  });
});
