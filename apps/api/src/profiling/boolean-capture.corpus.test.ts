import { describe, expect, it } from "vitest";

import type { QuestionPackItem } from "@badabhai/ai-contracts";
import { loadQuestionPackCorpus, type PackRecord } from "@badabhai/db";

import { captureAnswer } from "./answer-capture";
import { toCorpusItem } from "./corpus-packs.fixture";

/**
 * #2468 — THE YES/NO QUESTIONS OF THE SHIPPED CORPUS, every one of them.
 *
 * A bare "nahi" now answers a yes/no question only from the reply's opening words. A hand-built
 * item cannot show that no authored question reads its answer some other way first (a field
 * normalizer, a chip label), so this walks the latest version of every pack: each boolean item,
 * and each select whose options are a yes and a no.
 */
function latestPacks(): PackRecord[] {
  const latest = new Map<string, PackRecord>();
  for (const pack of loadQuestionPackCorpus().packs) {
    const seen = latest.get(pack.pack_id);
    if (seen === undefined || pack.version > seen.version) latest.set(pack.pack_id, pack);
  }
  return [...latest.values()];
}

function yesNoItems(): QuestionPackItem[] {
  return latestPacks().flatMap((pack) =>
    (pack.items as unknown as Array<Record<string, unknown>>)
      .map(toCorpusItem)
      .filter(
        (item) =>
          item.answer_type === "boolean" ||
          (item.answer_type === "single_select" &&
            item.options.some((option) => option.value === true) &&
            item.options.some((option) => option.value === false)),
      ),
  );
}

const SIDE_REMARK =
  "pahle Mujhe yah batao Mera notice period ek mahine ka Nahin Hai Mera 3 mahine ka hai lekin " +
  "vahan per Koi option nahin tha to usko change karke 3 Mahina kar do";

const SHORT_NO = ["Nahi", "nahi ji", "ji nahi", "nahi ja sakta", "मैं नहीं कर सकता"];
const SHORT_YES = ["Haan", "haan ji", "haan ja sakta hoon"];

const ITEMS = yesNoItems();
const label = (item: QuestionPackItem): string => `${item.question_key} (${item.answer_type})`;
const read = (text: string, item: QuestionPackItem): unknown[] =>
  captureAnswer(text, item).values.map((value) => value.valueNormalized);

describe("every yes/no question in the corpus (#2468)", () => {
  it("covers the authored yes/no questions", () => {
    // 198 boolean items across the latest pack versions on 2026-10-28 (236 across all versions).
    expect(ITEMS.filter((item) => item.answer_type === "boolean").length).toBeGreaterThan(150);
  });

  it("captures nothing from a long side remark carrying a stray 'nahin'", () => {
    const answered = ITEMS.filter((item) => read(SIDE_REMARK, item).length > 0).map(label);
    expect(answered).toEqual([]);
  });

  it("still captures a short no as FALSE", () => {
    const missed = ITEMS.flatMap((item) =>
      SHORT_NO.filter((text) => read(text, item)[0] !== false).map(
        (text) => `${label(item)}: ${text}`,
      ),
    );
    expect(missed).toEqual([]);
  });

  it("still captures a short yes as TRUE", () => {
    const missed = ITEMS.flatMap((item) =>
      SHORT_YES.filter((text) => read(text, item)[0] !== true).map(
        (text) => `${label(item)}: ${text}`,
      ),
    );
    expect(missed).toEqual([]);
  });
});
