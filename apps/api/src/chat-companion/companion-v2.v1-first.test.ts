import { describe, expect, it } from "vitest";
import { resolveCompanionText } from "./companion-intents";
import {
  COMPANION_APPLIED_LABEL,
  COMPANION_JOBS_TAB_LABEL,
  COMPANION_NEW_JOBS_LABEL,
  COMPANION_RESUME_LABEL,
} from "./companion-keys";
import { RESUME_MENU_EDIT_KEY } from "../chat/resume-menu";
import { CTX, makeCompanionServiceForV2, NOW, WORKER } from "./chat-companion.v2.fake";

/**
 * ADR-0046 §2.1 step 4 — THE V1 RESOLVER STILL RUNS FIRST, and a hit is served by v1 with ZERO
 * model calls even while the v2 flag is on. This is the test that keeps v2 from quietly becoming
 * a second, model-priced path for everything a shipped chip already understands.
 */
describe("v2 on: every v1 chip / alias / intent is still served by v1, with no model call", () => {
  /**
   * Texts that `resolveCompanionText` resolves to a MENU or a NAMED intent. v1's own `fallback`
   * intent is deliberately absent: that IS the miss, and under v2 it belongs to the classifier.
   */
  const v1Hits: readonly [string, string][] = [
    ["ab tak kya hua", "digest"],
    [COMPANION_NEW_JOBS_LABEL, "jobs"],
    [COMPANION_JOBS_TAB_LABEL, "jobs"],
    [COMPANION_APPLIED_LABEL, "applied"],
    ["meri applications", "applied"],
    ["job milegi?", "guarantee"],
    [COMPANION_RESUME_LABEL, "resume_menu"],
    ["firse banao", "resume_menu"],
    ["update karna hai", "resume_menu"],
  ];

  it("the fixture is real — every text is a v1 hit (a menu, a named intent, or v1's own fallback)", () => {
    for (const [text, expected] of v1Hits) {
      const resolved = resolveCompanionText(text);
      if (expected === "resume_menu") expect(resolved.kind, text).toBe("resume_menu");
      else expect(resolved, text).toEqual({ kind: "intent", intent: expected });
    }
  });

  it.each(v1Hits)("%j → %s: v1 answers and the v2 layer is NEVER reached", async (text, expected) => {
    const h = makeCompanionServiceForV2({ v2: true });
    const result = await h.svc.message(WORKER, { text }, CTX as never, NOW);

    expect(result.mode).toBe("companion");
    expect(h.v2.handleMessage).not.toHaveBeenCalled();
    // The only model-reaching collaborators this service holds stay untouched.
    expect(h.edits.propose).not.toHaveBeenCalled();
    expect(h.edits.confirm).not.toHaveBeenCalled();

    const event = h.events.emit.mock.calls[0]![0] as { event_name: string; payload: { intent: string } };
    expect(event.event_name).toBe("chat.companion_turn_served");
    expect(event.payload.intent).toBe(expected);
  });

  it("the menu hits are served by resolveResumeMenu VERBATIM, as the ended session serves them", async () => {
    const h = makeCompanionServiceForV2({ v2: true });
    const result = await h.svc.message(WORKER, { text: COMPANION_RESUME_LABEL }, CTX as never, NOW);
    if (result.mode !== "companion") throw new Error("expected companion");
    expect(result.turn.suggested_options.map((o) => o.option_key)).toContain(RESUME_MENU_EDIT_KEY);
    expect(h.v2.handleMessage).not.toHaveBeenCalled();
  });
});
