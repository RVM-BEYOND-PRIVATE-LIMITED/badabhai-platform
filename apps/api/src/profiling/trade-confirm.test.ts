import { describe, expect, it } from "vitest";

import {
  draftTradeLabel,
  readTradeConfirmReply,
  TRADE_CONFIRM_OPTIONS,
  TRADE_DESIRED_PROMPT,
  tradeConfirmPrompt,
} from "./trade-confirm";

describe("trade-confirm gate copy", () => {
  it("asks '<trade> — kya aap yahi kaam karna chahte hain?'", () => {
    expect(tradeConfirmPrompt("CNC Turner")).toBe("CNC Turner — kya aap yahi kaam karna chahte hain?");
  });

  it("strips a question mark inside the trade so the bubble keeps one", () => {
    expect(tradeConfirmPrompt("CNC? Turner")).toBe("CNC Turner — kya aap yahi kaam karna chahte hain?");
  });

  it("the re-ask names the wanted trade", () => {
    expect(TRADE_DESIRED_PROMPT).toBe("Aap kis trade mein kaam karna chahte hain?");
  });

  it("chips are Haan/Nahi on collision-free keys", () => {
    expect(TRADE_CONFIRM_OPTIONS.map((o) => o.label_text)).toEqual(["Haan", "Nahi"]);
    expect(TRADE_CONFIRM_OPTIONS.map((o) => o.option_key)).toEqual([
      "trade_confirm_yes",
      "trade_confirm_no",
    ]);
  });
});

describe("readTradeConfirmReply", () => {
  it.each(["Haan", "haan", "HAAN", "haan ji"])("reads %j as yes", (text) => {
    expect(readTradeConfirmReply(text)).toBe("yes");
  });

  it.each(["Nahi", "nahi", "NAHI", "nahi ji", "no"])("reads %j as no", (text) => {
    expect(readTradeConfirmReply(text)).toBe("no");
  });

  it("reads chip keys exactly", () => {
    expect(readTradeConfirmReply("trade_confirm_yes")).toBe("yes");
    expect(readTradeConfirmReply("trade_confirm_no")).toBe("no");
  });

  it("reads a negated yes as no (the lexicon veto)", () => {
    expect(readTradeConfirmReply("haan nahi karna")).toBe("no");
  });

  it("reads the Kuch aur escape as no", () => {
    expect(readTradeConfirmReply("Kuch aur")).toBe("no");
    expect(readTradeConfirmReply("kuch_aur")).toBe("no");
  });

  it("reads a desired-trade statement as other, not yes", () => {
    expect(readTradeConfirmReply("CAM programmer banna hai")).toBe("other");
    expect(readTradeConfirmReply("CAM programmer")).toBe("other");
    expect(readTradeConfirmReply("")).toBe("other");
  });
});

describe("draftTradeLabel", () => {
  it("prefers role_label over domain_label", () => {
    expect(
      draftTradeLabel({ role_label: "CAM programmer", domain_label: "CNC Machining" }),
    ).toBe("CAM programmer");
  });

  it("falls back to domain_label", () => {
    expect(draftTradeLabel({ role_label: null, domain_label: "CNC Machining" })).toBe(
      "CNC Machining",
    );
  });

  it("is null when nothing is named", () => {
    expect(draftTradeLabel({ role_label: null, domain_label: null })).toBeNull();
    expect(draftTradeLabel({ role_label: "  ", domain_label: null })).toBeNull();
  });
});
