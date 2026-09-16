import { describe, expect, it } from "vitest";
import type { QuestionPackItem } from "@badabhai/ai-contracts";

import {
  CHAT_FACT_OWNER,
  chatServableItems,
  crossFillItems,
  isChatOwnedItem,
  PER_JOB_FACTS,
} from "./worker-fact.ownership";
import { WORKER_FACT_IDS } from "./worker-fact.registry";

function item(questionKey: string, targetField: string | null): Pick<QuestionPackItem, "question_key" | "target_field"> {
  return { question_key: questionKey, target_field: targetField };
}

describe("CHAT_FACT_OWNER", () => {
  it("is exhaustive over WORKER_FACT_IDS — the Record type already enforces this at compile time", () => {
    expect(Object.keys(CHAT_FACT_OWNER).sort()).toEqual([...WORKER_FACT_IDS].sort());
  });

  it("owns exactly trade/experience/current_city/availability", () => {
    const chatOwned = WORKER_FACT_IDS.filter((id) => CHAT_FACT_OWNER[id] === "chat");
    expect(chatOwned.sort()).toEqual(["availability", "current_city", "experience", "trade"].sort());
  });

  it("defaults every other fact — including the pages the design names explicitly — to 'pages'", () => {
    expect(CHAT_FACT_OWNER.preferred_locations).toBe("pages");
    expect(CHAT_FACT_OWNER.shift).toBe("pages");
    expect(CHAT_FACT_OWNER.salary_expected).toBe("pages");
    expect(CHAT_FACT_OWNER.education).toBe("pages");
    // Not named by the design, and still pages — the DEFAULT, not a special case.
    expect(CHAT_FACT_OWNER.certifications).toBe("pages");
    expect(CHAT_FACT_OWNER.relocation).toBe("pages");
  });
});

describe("PER_JOB_FACTS", () => {
  it("is exactly {experience}", () => {
    expect([...PER_JOB_FACTS]).toEqual(["experience"]);
  });
});

describe("isChatOwnedItem / chatServableItems", () => {
  it("an item naming no registered fact is servable", () => {
    const skills = item("welding_process", "skills");
    expect(isChatOwnedItem(skills)).toBe(true);
  });

  it("a prefill_hint alias is servable even though the fact it hints at is pages-owned", () => {
    const shiftWork = item("shift_work", "shift_work");
    expect(isChatOwnedItem(shiftWork)).toBe(true);
  });

  it("a settling alias of a CHAT-owned fact is servable", () => {
    expect(isChatOwnedItem(item("primary_trade", "trade"))).toBe(true);
    expect(isChatOwnedItem(item("current_city", "current_city"))).toBe(true);
    expect(isChatOwnedItem(item("availability", "availability"))).toBe(true);
    expect(isChatOwnedItem(item("experience_years", "experience_years"))).toBe(true);
  });

  it("a settling alias of a PAGES-owned fact is NOT servable", () => {
    expect(isChatOwnedItem(item("salary_expected", "salary_expected"))).toBe(false);
    expect(isChatOwnedItem(item("preferred_locations", "preferred_locations"))).toBe(false);
    expect(isChatOwnedItem(item("education", "education"))).toBe(false);
    expect(isChatOwnedItem(item("shift_preference", "shift_preference"))).toBe(false);
  });

  it("chatServableItems drops only the pages-owned settling aliases, order preserved", () => {
    const items = [
      item("primary_trade", "trade"),
      item("salary_expected", "salary_expected"),
      item("current_city", "current_city"),
      item("shift_work", "shift_work"),
      item("shift_preference", "shift_preference"),
    ];
    expect(chatServableItems(items).map((i) => i.question_key)).toEqual([
      "primary_trade",
      "current_city",
      "shift_work",
    ]);
  });
});

describe("crossFillItems", () => {
  const trade = item("primary_trade", "trade");
  const city = item("current_city", "current_city");
  const experience = item("experience_years", "experience_years");
  const salary = item("salary_expected", "salary_expected");
  const shiftWork = item("shift_work", "shift_work");
  const ALL = [trade, city, experience, salary, shiftWork];

  it("drops pages-owned facts UNCONDITIONALLY — phaseALeads true or false", () => {
    for (const phaseALeads of [true, false]) {
      const keys = crossFillItems(ALL, phaseALeads).map((i) => i.question_key);
      expect(keys, `phaseALeads=${phaseALeads}`).not.toContain("salary_expected");
    }
  });

  it("keeps a prefill_hint regardless of phaseALeads", () => {
    for (const phaseALeads of [true, false]) {
      const keys = crossFillItems(ALL, phaseALeads).map((i) => i.question_key);
      expect(keys, `phaseALeads=${phaseALeads}`).toContain("shift_work");
    }
  });

  it("drops experience_years ONLY when phaseALeads is true (a per-job model question is on screen)", () => {
    expect(crossFillItems(ALL, true).map((i) => i.question_key)).not.toContain("experience_years");
    expect(crossFillItems(ALL, false).map((i) => i.question_key)).toContain("experience_years");
  });

  it("never drops current_city even when phaseALeads is true — it is chat-owned and not per-job", () => {
    expect(crossFillItems(ALL, true).map((i) => i.question_key)).toContain("current_city");
  });
});
