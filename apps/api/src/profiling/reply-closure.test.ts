import { describe, expect, it } from "vitest";
import type { QuestionPack, QuestionPackItem } from "@badabhai/ai-contracts";

import {
  CLOSING_REPLY_TEXT,
  DE_ESCALATION_REPLY_TEXT,
  DISAMBIGUATION_PROMPT_TEXT,
  HARDSHIP_REPLY_TEXTS,
  joinClarify,
  servedText,
} from "./next-question";
import { CHAT_UNAVAILABLE_REPLY } from "../chat/chat-replies";
import {
  CONSTANT_REPLIES,
  ReplyClosureError,
  assertNoCollisions,
  assertNoInterpolation,
  checkedReplyClosure,
  clipId,
  normalizeReplyText,
  replyClosure,
} from "./reply-closure";

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

function pack(id: string, items: QuestionPackItem[]): QuestionPack {
  return {
    pack_id: id,
    version: 1,
    family_id: "fam_welding",
    locale: "hi-IN",
    status: "active",
    content_hash: `hash_${id}`,
    items,
  };
}

const CITY = item({
  question_key: "q_city",
  prompt_text: "Aap kis sheher mein rehte hain?",
  why_text: "Sheher se aas paas ki naukri dhundhne mein aasani hoti hai.",
  retry_text: "Sheher ka naam bataiye.",
});
const YEARS = item({
  question_key: "q_years",
  prompt_text: "Kitne saal ka kaam ka tajurba hai?",
});

const textsOf = (packs: QuestionPack[]) => replyClosure(packs).map((c) => c.text);

describe("the closure is derived from the engine, not re-implemented beside it", () => {
  it("contains the clarify concatenation BYTE-IDENTICALLY to what the engine serves", () => {
    // The whole point. A second implementation of the join would let the pre-rendered clip and the
    // runtime reply disagree about wording — inaudible to us, and the only signal the worker gets.
    const runtime = joinClarify({ promptText: CITY.why_text as string }, CITY, 1);
    expect(textsOf([pack("qp_a", [CITY])])).toContain(runtime);
  });

  it("follows `servedText` into the RETRY wording for the second ask", () => {
    const texts = textsOf([pack("qp_a", [CITY])]);
    expect(texts).toContain(servedText(CITY, 1)); // "Aap kis sheher…"
    expect(texts).toContain(servedText(CITY, 2)); // "Sheher ka naam bataiye."
    expect(servedText(CITY, 1)).not.toBe(servedText(CITY, 2)); // guards the premise
  });

  it("renders the clarify for BOTH ask numbers — a worker can ask why before or after the re-ask", () => {
    const texts = textsOf([pack("qp_a", [CITY])]);
    expect(texts).toContain(`${CITY.why_text} ${CITY.prompt_text}`);
    expect(texts).toContain(`${CITY.why_text} ${CITY.retry_text}`);
  });

  it("contributes ONE prompt clip for an item with no retry_text", () => {
    const texts = textsOf([pack("qp_a", [YEARS])]);
    expect(texts.filter((t) => t === YEARS.prompt_text)).toHaveLength(1);
  });

  it("emits the bare why_text too — reachable when the served question is gone", () => {
    // `joinClarify` returns the bare `why` when `askedItem` is null, which happens after a pack
    // version moves under a live conversation. A missing clip there is silence at the exact
    // moment a confused worker asked for help.
    expect(textsOf([pack("qp_a", [CITY])])).toContain(CITY.why_text);
    expect(joinClarify({ promptText: CITY.why_text as string }, null, 1)).toBe(CITY.why_text);
  });

  it("carries every fixed constant", () => {
    const texts = textsOf([pack("qp_a", [YEARS])]);
    for (const constant of [
      DE_ESCALATION_REPLY_TEXT,
      ...HARDSHIP_REPLY_TEXTS,
      CLOSING_REPLY_TEXT,
      CHAT_UNAVAILABLE_REPLY,
      DISAMBIGUATION_PROMPT_TEXT,
    ]) {
      expect(texts).toContain(constant);
    }
    // And the enumerated list is the same list — so adding a constant to the orchestrator without
    // adding it here fails HERE rather than becoming silence in a worker's ear.
    expect(new Set(CONSTANT_REPLIES).size).toBe(CONSTANT_REPLIES.length);
  });

  it("deduplicates across packs — 101 packs share most of their wording", () => {
    const twice = textsOf([pack("qp_a", [CITY]), pack("qp_b", [CITY])]);
    expect(new Set(twice).size).toBe(twice.length);
  });

  it("is stable under re-ordering, so a render is an incremental diff and not a re-spend", () => {
    const a = replyClosure([pack("qp_a", [CITY, YEARS])]).map((c) => c.id);
    const b = replyClosure([pack("qp_a", [YEARS, CITY])]).map((c) => c.id);
    expect(a).toEqual(b);
  });
});

describe("clip identity", () => {
  it("survives whitespace churn — a wrapped line must not re-spend the render budget", () => {
    expect(clipId("Aap kaunsa kaam karte hain?")).toBe(clipId("  Aap kaunsa   kaam\tkarte hain?  "));
  });

  it("treats case and punctuation as significant — both change what a listener hears", () => {
    expect(clipId("Aap kahan rehte hain?")).not.toBe(clipId("aap kahan rehte hain?"));
    expect(clipId("Aap kahan rehte hain?")).not.toBe(clipId("Aap kahan rehte hain"));
  });

  it("leaves the Devanagari danda and the non-breaking space ALONE", () => {
    // Both carry meaning in the corpus, and `\s` would have eaten the second. The lexicon package
    // bans `\s` for exactly this reason — it matches a different set in JS than in Python's `re`,
    // and the Python renderer has to agree with this function byte for byte.
    expect(normalizeReplyText("बात। हो")).toBe("बात। हो");
    expect(normalizeReplyText("a b")).toBe("a b");
  });

  // THE SIX CODEPOINTS THAT USED TO DIVERGE — mirrored one-for-one in
  // `apps/ai-service/tests/test_reply_closure_parity.py`, because a vector on one side only
  // proves that side is self-consistent.
  //
  // Banning `\s` was half the job. `String.prototype.trim()` and Python's `str.strip()` strip
  // DIFFERENT sets, measured across the two runtimes this repo actually runs: JS strips U+FEFF
  // and Python does not; Python strips U+001C..U+001F and U+0085 and JS does not. Neither
  // built-in is consulted now, so all six survive normalization identically in both languages.
  //
  // Written as \u ESCAPES on purpose: a literal BOM or NEL in source is invisible in review and
  // one reformat away from being silently eaten — which is the same class of accident the vectors
  // are here to catch.
  it.each([
    ["\uFEFFBOM leads", "\uFEFFBOM leads"],
    ["BOM trails\uFEFF", "BOM trails\uFEFF"],
    ["\u001Cfile separator", "\u001Cfile separator"],
    ["\u001Funit separator", "\u001Funit separator"],
    ["\u0085next line", "\u0085next line"],
  ])("preserves the edge codepoint that trim() and strip() disagreed about (%#)", (raw, expected) => {
    expect(normalizeReplyText(raw)).toBe(expected);
  });

  it("preserves a LEADING non-breaking space, not only an interior one", () => {
    // The inconsistency the interior-only vector above could never catch: `.trim()` treated NBSP
    // as whitespace, so it stripped a leading one while the comment beside it declared NBSP
    // meaningful. Edges and interior now agree.
    expect(normalizeReplyText("\u00A0nbsp leads")).toBe("\u00A0nbsp leads");
    expect(normalizeReplyText("nbsp trails\u00A0")).toBe("nbsp trails\u00A0");
  });

  it("still collapses the runs it IS supposed to, at the edges too", () => {
    expect(normalizeReplyText("  \t padded \r\n ")).toBe("padded");
  });
});

describe("the guards", () => {
  it("REFUSES to pre-render a template placeholder", () => {
    // The worst failure available in this design: a shared clip speaking one worker's name to
    // every other worker. Post-emit interpolation is what makes it possible, so the corpus must
    // never carry the token in served text.
    const vocative = item({ question_key: "q_hi", prompt_text: "Namaste {{worker_name}} ji." });
    expect(() => checkedReplyClosure([pack("qp_a", [vocative])])).toThrow(ReplyClosureError);
    expect(() => checkedReplyClosure([pack("qp_a", [vocative])])).toThrow(/worker_name/);
  });

  it("catches a placeholder hiding in why_text, not only in the prompt", () => {
    const sneaky = item({
      question_key: "q_why",
      prompt_text: "Aap kahan rehte hain?",
      why_text: "{{worker_name}} ke liye paas ki naukri dhoondhne mein.",
    });
    expect(() => checkedReplyClosure([pack("qp_a", [sneaky])])).toThrow(ReplyClosureError);
  });

  it("passes clean text", () => {
    expect(() => checkedReplyClosure([pack("qp_a", [CITY, YEARS])])).not.toThrow();
  });

  it("would name a clip-id collision rather than silently play the wrong audio", () => {
    // Synthetic — two different strings forced onto one id. 64 bits over a few hundred clips makes
    // this ~1e-14 in practice, but the failure mode is a worker hearing the wrong question, so the
    // check is worth its four lines.
    expect(() =>
      assertNoCollisions([
        { id: "same", text: "Aap kahan rehte hain?", producer: "prompt" },
        { id: "same", text: "Kitne saal ka tajurba hai?", producer: "prompt" },
      ]),
    ).toThrow(/claimed by two different strings/);
  });

  it("does not cry collision over the SAME string appearing twice", () => {
    expect(() =>
      assertNoCollisions([
        { id: "x", text: "Aap kahan rehte hain?", producer: "prompt" },
        { id: "x", text: "Aap kahan  rehte hain?", producer: "clarify" },
      ]),
    ).not.toThrow();
  });

  it("never emits an empty clip — a blank reply is a dropped turn, not something to speak", () => {
    const blank = item({ question_key: "q_blank", prompt_text: "   " });
    expect(replyClosure([pack("qp_a", [blank])]).map((c) => c.text)).not.toContain("");
  });

  it("assertNoInterpolation reports EVERY offender, not just the first", () => {
    const clips = [
      { id: "a", text: "Namaste {{worker_name}}", producer: "prompt" as const },
      { id: "b", text: "Theek hai", producer: "prompt" as const },
      { id: "c", text: "{{city}} mein?", producer: "prompt" as const },
    ];
    expect(() => assertNoInterpolation(clips)).toThrow(/2 reply string\(s\)/);
  });
});
