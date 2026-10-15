import { describe, expect, it } from "vitest";
import {
  COMPANION_HISTORY_MAX,
  CompanionHistoryItemSchema,
  CompanionOpenResponseSchema,
  CompanionTurnSchema,
} from "./chat-companion.dto";
import { V2_CLARIFY } from "./companion-replies";
import { v2CopyTurn } from "./v2/companion-v2-compose";

/**
 * #2297 (ADR-0056) — the additive `history` on `GET /chat/companion`, as #2298 builds against it:
 * optional, oldest first, at most 200 lines, every absent field OMITTED and nothing undeclared.
 */

const ITEM = {
  id: "44444444-4444-4444-8444-444444444444",
  role: "bada_bhai",
  text: "Namaste!",
  tts_text: "नमस्ते!",
  suggested_options: [{ option_key: "k", label_text: "Chip", is_none_of_above: false }],
  suggested_followups: ["Chip"],
  created_at: "2026-10-15T10:00:00.000Z",
} as const;

const open = (history: unknown) => ({ ...v2CopyTurn(V2_CLARIFY), history });

describe("the open response's `history`", () => {
  it("is optional: today's open still validates without it", () => {
    expect(CompanionOpenResponseSchema.safeParse(v2CopyTurn(V2_CLARIFY)).success).toBe(true);
  });

  it("accepts the contract's lines, worker and Bada Bhai alike", () => {
    const worker = { id: ITEM.id, role: "worker", text: "hi", created_at: ITEM.created_at };
    const model = {
      id: ITEM.id,
      role: "bada_bhai",
      text: "Model line",
      read_aloud: false,
      news_links: [{ title: "Story", url: "https://example.com/a", site: "example.com" }],
      created_at: ITEM.created_at,
    };
    expect(CompanionOpenResponseSchema.safeParse(open([worker, ITEM, model])).success).toBe(true);
  });

  it.each([
    ["an empty array (absent means 'draw the recap')", []],
    [
      `more than ${COMPANION_HISTORY_MAX} lines`,
      Array.from({ length: COMPANION_HISTORY_MAX + 1 }, () => ITEM),
    ],
    ["a null field (absent, never null)", [{ ...ITEM, tts_text: null }]],
    ["an undeclared field", [{ ...ITEM, submission_id: ITEM.id }]],
    ["an unknown role", [{ ...ITEM, role: "assistant" }]],
    ["read_aloud: true (only false is ever sent)", [{ ...ITEM, read_aloud: true }]],
    ["empty chips", [{ ...ITEM, suggested_options: [] }]],
  ])("refuses %s", (_why, history) => {
    expect(CompanionOpenResponseSchema.safeParse(open(history)).success).toBe(false);
  });

  it("rides the companion open only: a message turn never carries it, nor does interview mode", () => {
    expect(CompanionTurnSchema.safeParse(open([ITEM])).success).toBe(false);
    expect(
      CompanionOpenResponseSchema.safeParse({ mode: "interview", history: [ITEM] }).success,
    ).toBe(false);
  });

  it("each line is strict on its own", () => {
    expect(CompanionHistoryItemSchema.safeParse(ITEM).success).toBe(true);
    expect(CompanionHistoryItemSchema.safeParse({ ...ITEM, created_at: "yesterday" }).success).toBe(
      false,
    );
  });
});
