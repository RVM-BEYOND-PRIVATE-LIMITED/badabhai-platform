import { describe, expect, it, vi } from "vitest";

import { FreeChatReplyInputSchema, FreeChatSummarizeInputSchema } from "@badabhai/ai-contracts";

import {
  FREE_CHAT_SUMMARY_KEY,
  FREE_CHAT_SUMMARY_MAX,
  copiedFreeChatSummary,
  foldWatermarkOf,
  readFreeChatSummary,
  readFreeChatSummaryValue,
  screenFreeChatSummary,
  storedFreeChatSummary,
} from "./free-chat-summary";

// The G1 scanner, spied so a scanner ERROR can be forced; every other test runs the real one.
const gates = vi.hoisted(() => ({ forced: null as null | "scanner_error" | "throw" }));
vi.mock("../resume-import/resume-parse-gates", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../resume-import/resume-parse-gates")>();
  return {
    ...actual,
    containsHardIdentifier: (raw: string) => {
      if (gates.forced === "throw") throw new Error("regex blew up");
      if (gates.forced === "scanner_error") return "scanner_error";
      return actual.containsHardIdentifier(raw);
    },
  };
});

/**
 * ADR-0051 §8 (Release 2) — the rolling summary's PURE half: the durable shape and its readers,
 * the carry every replacing writer spreads, and the gate a model-written summary must pass.
 */

const SESSION = "22222222-2222-4222-8222-222222222222";
const OTHER = "44444444-4444-4444-8444-444444444444";
const STORED = {
  v: 1 as const,
  text: "Worker enjoys cricket; asked about welding pay.",
  updated_at: "2026-10-07T10:00:00.000Z",
  session_id: SESSION,
  folded_lines: 8,
};

describe("the stored shape — strict, versioned, fails soft", () => {
  it("reads a well-formed summary off the state, and the raw value alone", () => {
    expect(readFreeChatSummary({ turn_count: 3, [FREE_CHAT_SUMMARY_KEY]: STORED })).toEqual(STORED);
    expect(readFreeChatSummaryValue(STORED)).toEqual(STORED);
  });

  it.each([
    ["a later version", { ...STORED, v: 2 }],
    ["an extra key", { ...STORED, raw_turns: ["x"] }],
    ["an empty text", { ...STORED, text: "" }],
    ["a text over the cap", { ...STORED, text: "x".repeat(FREE_CHAT_SUMMARY_MAX + 1) }],
    ["a negative count", { ...STORED, folded_lines: -1 }],
    ["a non-uuid session", { ...STORED, session_id: "s1" }],
    ["a bad timestamp", { ...STORED, updated_at: "yesterday" }],
  ])("reads %s as NO summary", (_label, value) => {
    expect(readFreeChatSummary({ [FREE_CHAT_SUMMARY_KEY]: value })).toBeNull();
  });

  it("reads no state, a null state and a state without the key as none", () => {
    expect(readFreeChatSummary(null)).toBeNull();
    expect(readFreeChatSummary("x")).toBeNull();
    expect(readFreeChatSummary({ free_chat_lock: { v: 1 } })).toBeNull();
  });

  it("the cap is the contract's: 1200 rides the reply and the fold, 1201 does not", () => {
    const at = "x".repeat(FREE_CHAT_SUMMARY_MAX);
    const over = `${at}x`;
    const reply = (summary: string) =>
      FreeChatReplyInputSchema.safeParse({
        category: "casual",
        text: "hi",
        recent_turns: [],
        summary,
      }).success;
    const fold = (previous_summary: string) =>
      FreeChatSummarizeInputSchema.safeParse({
        previous_summary,
        turns: [{ role: "worker", text: "hi" }],
      }).success;
    expect([reply(at), fold(at)]).toEqual([true, true]);
    expect([reply(over), fold(over)]).toEqual([false, false]);
  });
});

describe("storedFreeChatSummary — the carry every replacing writer spreads", () => {
  it("keeps the row's raw value whatever its shape — a later build's summary is not erased", () => {
    expect(storedFreeChatSummary({ [FREE_CHAT_SUMMARY_KEY]: STORED })).toEqual({
      free_chat_summary: STORED,
    });
    expect(storedFreeChatSummary({ [FREE_CHAT_SUMMARY_KEY]: { v: 9 } })).toEqual({
      free_chat_summary: { v: 9 },
    });
  });

  it("is {} — the key ABSENT — without one, so a pre-Release-2 row persists byte-identically", () => {
    expect(storedFreeChatSummary({ turn_count: 3 })).toEqual({});
    expect(storedFreeChatSummary({ [FREE_CHAT_SUMMARY_KEY]: null })).toEqual({});
    expect(storedFreeChatSummary(null)).toEqual({});
  });
});

describe("folded_lines counts only the CURRENT session's lines", () => {
  it("a copy onto a new session is re-stamped and starts at 0", () => {
    expect(copiedFreeChatSummary(STORED, OTHER)).toEqual({
      ...STORED,
      session_id: OTHER,
      folded_lines: 0,
    });
  });

  it("the watermark is the stored count only when it was folded in THIS session", () => {
    expect(foldWatermarkOf(STORED, SESSION)).toBe(8);
    expect(foldWatermarkOf(STORED, OTHER)).toBe(0);
    expect(foldWatermarkOf(null, SESSION)).toBe(0);
    expect(foldWatermarkOf(copiedFreeChatSummary(STORED, OTHER), OTHER)).toBe(0);
  });
});

describe("screenFreeChatSummary — the model's summary is untrusted (ADR-0051 §8)", () => {
  it("accepts compact notes, trimmed", () => {
    expect(screenFreeChatSummary("  Likes cricket; worried about rent.  ", null)).toEqual({
      kind: "accept",
      text: "Likes cricket; worried about rent.",
    });
  });

  it.each([
    ["a phone number", "Shared number 98765 43210 for calls."],
    ["an email", "Mail is ramesh.k@example.com."],
    ["a PAN", "PAN ABCDE1234F mentioned."],
    ["an Aadhaar", "Aadhaar 2345 6789 0123 was typed."],
    ["a long digit run", "Account 123456789012345678."],
  ])("refuses %s (G1)", (_label, raw) => {
    expect(screenFreeChatSummary(raw, null)).toEqual({ kind: "reject", reason: "identifier" });
  });

  it("refuses when the scanner errors or throws — fail closed", () => {
    try {
      gates.forced = "scanner_error";
      expect(screenFreeChatSummary("Likes cricket.", null)).toEqual({
        kind: "reject",
        reason: "identifier",
      });
      gates.forced = "throw";
      expect(screenFreeChatSummary("Likes cricket.", null)).toEqual({
        kind: "reject",
        reason: "identifier",
      });
    } finally {
      gates.forced = null;
    }
  });

  it.each([["{{worker_name}} likes cricket."], ["Likes }} cricket."], ["{{ x"]])(
    "refuses a template token: %s",
    (raw) => {
      expect(screenFreeChatSummary(raw, null)).toEqual({
        kind: "reject",
        reason: "template_token",
      });
    },
  );

  it("redacts the worker's OWN name (G2), whole and token-wise, case-insensitively", () => {
    expect(
      screenFreeChatSummary("ramesh Kumar likes cricket; Ramesh is from Patna.", "Ramesh Kumar"),
    ).toEqual({
      kind: "accept",
      text: "[NAME] likes cricket; [NAME] is from Patna.",
    });
  });

  it("refuses an empty or whitespace summary", () => {
    expect(screenFreeChatSummary("", null)).toEqual({ kind: "reject", reason: "empty" });
    expect(screenFreeChatSummary(" \n\t ", null)).toEqual({ kind: "reject", reason: "empty" });
  });

  it("refuses one over 1200 characters — measured AFTER the redaction, so it always fits back", () => {
    expect(screenFreeChatSummary("x".repeat(FREE_CHAT_SUMMARY_MAX), null).kind).toBe("accept");
    expect(screenFreeChatSummary("x".repeat(FREE_CHAT_SUMMARY_MAX + 1), null)).toEqual({
      kind: "reject",
      reason: "too_long",
    });
    // 1199 characters as typed fits; redacting "Ram" to "[NAME]" makes it 1202.
    const near = `${"x".repeat(FREE_CHAT_SUMMARY_MAX - 5)} Ram`;
    expect(near.length).toBeLessThanOrEqual(FREE_CHAT_SUMMARY_MAX);
    expect(screenFreeChatSummary(near, "Ram")).toEqual({ kind: "reject", reason: "too_long" });
  });
});
