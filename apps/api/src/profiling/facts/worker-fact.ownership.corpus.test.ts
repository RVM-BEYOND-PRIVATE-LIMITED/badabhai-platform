import { describe, expect, it } from "vitest";

import { packFromCorpus } from "../form/corpus-pack.test-support";
import { chatServableItems, isChatOwnedItem } from "./worker-fact.ownership";

/**
 * `shift_preference` NEVER SERVES THROUGH THE CHAT — walked over the REAL corpus (#1505 F4).
 *
 * WHY A SEPARATE PREDICATE IS NOT NEEDED. `shift_work` (`qp_metal_plant@2`) and `night_work`
 * (`qp_driving_light@2`) are yes/no capability questions about the JOB ("do you work nights?"),
 * declared `prefill_hint` in `worker-fact.registry.ts` — evidence about the `shift` fact, never
 * an answer to it. `isChatOwnedItem`/`chatServableItems` already keep every `prefill_hint` alias
 * servable regardless of which surface owns the fact it hints at, so `shift_preference` (the
 * SETTLING alias, owned by the preferences page per `CHAT_FACT_OWNER`) is excluded by the SAME
 * ownership filter that drops `salary_expected`/`preferred_locations`/`education` — no bespoke
 * shift rule required.
 *
 * THIS WALKS THE SAME FUNCTION `selectableEnginePacks` (`orchestrator.service.ts`) CALLS. That
 * function's ownership step is exactly `{ ...pack, items: chatServableItems(pack.items) }` before
 * either of its own branches run — so exercising `chatServableItems` over these three real packs
 * is exercising the identical filter a live chat session applies, not an approximation of it.
 */
describe("shift_preference is never chat-servable — walked over the real corpus", () => {
  it("qp_metal_plant@2's shift_work (a yes/no hint) survives the ownership filter", () => {
    const pack = packFromCorpus("qp_metal_plant@2");
    const shiftWork = pack.items.find((item) => item.question_key === "shift_work");
    expect(shiftWork).toBeDefined();
    expect(isChatOwnedItem(shiftWork!)).toBe(true);
    expect(chatServableItems(pack.items).map((i) => i.question_key)).toContain("shift_work");
  });

  it("qp_driving_light@2's night_work (a yes/no hint) survives the ownership filter", () => {
    const pack = packFromCorpus("qp_driving_light@2");
    const nightWork = pack.items.find((item) => item.question_key === "night_work");
    expect(nightWork).toBeDefined();
    expect(isChatOwnedItem(nightWork!)).toBe(true);
    expect(chatServableItems(pack.items).map((i) => i.question_key)).toContain("night_work");
  });

  it("qp_universal@2's shift_preference (the SETTLING alias) is dropped — pages-owned", () => {
    const pack = packFromCorpus("qp_universal@2");
    const shiftPreference = pack.items.find((item) => item.question_key === "shift_preference");
    expect(shiftPreference).toBeDefined();
    expect(isChatOwnedItem(shiftPreference!)).toBe(false);
    expect(chatServableItems(pack.items).map((i) => i.question_key)).not.toContain(
      "shift_preference",
    );
  });
});
