import { describe, expect, it } from "vitest";
import type { TranscriptLine } from "@badabhai/ai-contracts";

import { classifyLlmReply } from "./llm-reply-guard";

function line(role: TranscriptLine["role"], text: string, i: number): TranscriptLine {
  return { i, role, text };
}

describe("classifyLlmReply — gate_shaped", () => {
  it("flags the model writing the engine's own gate in its own words", () => {
    expect(classifyLlmReply("Koi aur kaam bhi kiya hai?", [])).toBe("gate_shaped");
    expect(classifyLlmReply("Aur koi naukri thi aapki?", [])).toBe("gate_shaped");
    expect(classifyLlmReply("Koi doosri company mein kaam kiya?", [])).toBe("gate_shaped");
  });

  it("flags the Devanagari equivalents", () => {
    expect(classifyLlmReply("क्या कोई और नौकरी की है?", [])).toBe("gate_shaped");
  });

  it("does not flag an ADD marker with no job noun nearby", () => {
    expect(classifyLlmReply("Koi aur cheez batana chahenge?", [])).toBe("ok");
  });

  it("does not flag a leading information-question WH-token", () => {
    // "kaunsa" leads — an ordinary role question, not the yes/no gate shape.
    expect(classifyLlmReply("Kaunsa aur kaam karte the?", [])).toBe("ok");
  });

  it("does NOT exempt a leading 'kya' — the gate's own yes/no shape starts with it", () => {
    expect(classifyLlmReply("Kya aapke paas koi aur kaam hai?", [])).toBe("gate_shaped");
  });
});

describe("classifyLlmReply — repeat", () => {
  it("flags an exact repeat of an earlier model line", () => {
    const history: TranscriptLine[] = [
      line("assistant", "Aap kaunsi cuisine banate hain?", 0),
      line("worker", "North Indian", 1),
    ];
    expect(classifyLlmReply("Aap kaunsi cuisine banate hain?", history)).toBe("repeat");
  });

  it("flags a near-duplicate (token-Jaccard >= 0.8, both sides >= 4 tokens)", () => {
    const history: TranscriptLine[] = [
      line("assistant", "Aap kaunsi machine yahan chalate hain apni factory mein?", 0),
    ];
    // 8 shared tokens, 1 differing each side: intersection 8 / union 10 = 0.8, at the floor.
    expect(
      classifyLlmReply("Aap kaunsi machine yahan chalate hain us factory mein?", history),
    ).toBe("repeat");
  });

  it("does not flag two short lines that merely share a couple of words", () => {
    const history: TranscriptLine[] = [line("assistant", "Aur kuch?", 0)];
    expect(classifyLlmReply("Aur kya seekha?", history)).toBe("ok");
  });

  it("ignores worker lines when scanning for a repeat", () => {
    const history: TranscriptLine[] = [
      line("worker", "Aap kaunsi cuisine banate hain?", 0),
    ];
    expect(classifyLlmReply("Aap kaunsi cuisine banate hain?", history)).toBe("ok");
  });

  /**
   * CRITIQUE-5's demanded fixture: the model re-asks a PRE-gate skills question after job 1's
   * gate. A boundary-scoped comparator (only against lines AFTER the last gate prompt) would
   * miss this — the repeat sits BEFORE the boundary — which is exactly the false negative the
   * "move on, no retry" ruling requires catching for ANY repeated question, not only the gate.
   */
  it("flags a pre-gate question repeated AFTER the gate — the full-history comparison", () => {
    const history: TranscriptLine[] = [
      line("assistant", "Aap kaunsi skills jaante hain is kaam mein?", 0),
      line("worker", "Welding aur fitting", 1),
      line("assistant", "Is naukri mein aapko kitne saal ho gaye?", 2),
      line("worker", "3 saal", 3),
      line("assistant", "Aur koi experience jodna hai?", 4),
      line("worker", "Haan", 5),
    ];
    // The model, instead of asking about the SECOND job, re-asks the FIRST job's skills question.
    expect(classifyLlmReply("Aap kaunsi skills jaante hain is kaam mein?", history)).toBe("repeat");
  });

  it("does NOT flag two genuinely per-job 'kitne saal' questions asked once per job", () => {
    const history: TranscriptLine[] = [
      line("assistant", "Is naukri mein aapko kitne saal ho gaye?", 0),
      line("worker", "3 saal", 1),
      line("assistant", "Aur koi experience jodna hai?", 2),
      line("worker", "Haan", 3),
    ];
    // Same per-job SHAPE, about a DIFFERENT job — expected to recur once per job.
    expect(classifyLlmReply("Is naukri mein aapko kitne saal ho gaye?", history)).toBe("ok");
  });
});

describe("classifyLlmReply — ok", () => {
  it("classifies an ordinary, non-repeating, non-gate-shaped ask as ok", () => {
    expect(classifyLlmReply("Aap kis sheher mein rehte hain?", [])).toBe("ok");
  });
});
