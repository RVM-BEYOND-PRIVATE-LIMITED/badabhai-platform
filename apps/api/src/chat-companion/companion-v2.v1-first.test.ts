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

/**
 * WP6 (TD146) — ROUTE PRECEDENCE, behind its own default-off flag. Flag OFF is the suite above
 * byte-for-byte; flag ON changes exactly three shapes, and every NAMED v1 intent keeps its
 * zero-model answer.
 */
describe("route precedence on (TD146): pending intent and the edit pre-check bypass v1 and the classifier", () => {
  it.each([
    ["edit my resume", "edit_resume"],
    ["location Mumbai kar do", "edit_resume"],
    ["salary 25000 kar do", "edit_resume"],
    ["meri bhasha badal do", "edit_resume"],
    ["mera naam badal do", "edit_resume"],
  ])("%j → the edit handler directly, with no classifier call", async (text, intent) => {
    const h = makeCompanionServiceForV2({ v2: true, precedence: true, edit: true });
    const result = await h.svc.message(WORKER, { text }, CTX as never, NOW);

    expect(result.mode).toBe("companion");
    expect(h.v2.handleDirectIntent).toHaveBeenCalledTimes(1);
    expect(h.v2.handleDirectIntent.mock.calls[0]![3]).toBe(intent);
    expect(h.v2.handleMessage).not.toHaveBeenCalled();
    expect(h.edits.propose).not.toHaveBeenCalled(); // the service never pre-parses: the handler does
  });

  it("a pending edit intent after a chip tap routes the next message directly (no v1, no classify)", async () => {
    const h = makeCompanionServiceForV2({ v2: true, precedence: true, pendingIntent: "edit_resume" });
    await h.svc.message(WORKER, { text: "night shift kar do" }, CTX as never, NOW);
    expect(h.v2.takePendingIntent).toHaveBeenCalledWith(WORKER);
    expect(h.v2.handleDirectIntent).toHaveBeenCalledTimes(1);
    expect(h.v2.handleDirectIntent.mock.calls[0]![3]).toBe("edit_resume");
    expect(h.v2.handleMessage).not.toHaveBeenCalled();
  });

  it("a pending career intent routes to the career handler directly", async () => {
    const h = makeCompanionServiceForV2({ v2: true, precedence: true, pendingIntent: "career_talk" });
    await h.svc.message(WORKER, { text: "aage kya karun" }, CTX as never, NOW);
    expect(h.v2.handleDirectIntent).toHaveBeenCalledTimes(1);
    expect(h.v2.handleDirectIntent.mock.calls[0]![3]).toBe("career_talk");
    expect(h.v2.handleMessage).not.toHaveBeenCalled();
  });

  it("'welding ka kaam seekhna hai, kya karun' reaches the CLASSIFIER, not the v1 jobs digest", async () => {
    const h = makeCompanionServiceForV2({ v2: true, precedence: true, career: true });
    await h.svc.message(WORKER, { text: "welding ka kaam seekhna hai, kya karun" }, CTX as never, NOW);
    expect(h.v2.handleMessage).toHaveBeenCalledTimes(1);
    expect(h.v2.handleDirectIntent).not.toHaveBeenCalled();
  });

  it("another chip clears a stale pending intent", async () => {
    const h = makeCompanionServiceForV2({ v2: true, precedence: true });
    await h.svc.message(WORKER, { text: COMPANION_NEW_JOBS_LABEL }, CTX as never, NOW);
    expect(h.v2.clearPendingIntent).toHaveBeenCalledWith(WORKER);
    expect(h.v2.handleMessage).not.toHaveBeenCalled();
  });

  it.each([
    ["ab tak kya hua", "digest"],
    ["koi update hai", "digest"],
    [COMPANION_NEW_JOBS_LABEL, "jobs"],
    ["meri applications", "applied"],
    ["job milegi?", "guarantee"],
    [COMPANION_RESUME_LABEL, "resume_menu"],
    ["Apna resume edit karein", "resume_menu"],
  ])("%j (a NAMED v1 intent) still gets its zero-model v1 answer with precedence on", async (text, expected) => {
    const h = makeCompanionServiceForV2({ v2: true, precedence: true });
    await h.svc.message(WORKER, { text }, CTX as never, NOW);
    expect(h.v2.handleMessage).not.toHaveBeenCalled();
    expect(h.v2.handleDirectIntent).not.toHaveBeenCalled();
    const event = h.events.emit.mock.calls[0]![0] as { event_name: string; payload: { intent: string } };
    expect(event.event_name).toBe("chat.companion_turn_served");
    expect(event.payload.intent).toBe(expected);
  });
});

describe("route precedence OFF (the default): the three TD146 phrasings behave exactly as today", () => {
  it.each([
    ["edit my resume", "resume_menu"],
    ["location Mumbai kar do", "resume_menu"],
    ["welding ka kaam seekhna hai, kya karun", "jobs"],
  ])("%j → the v1 answer, with no v2 route and no model", async (text, expected) => {
    const h = makeCompanionServiceForV2({ v2: true });
    await h.svc.message(WORKER, { text }, CTX as never, NOW);
    expect(h.v2.takePendingIntent).not.toHaveBeenCalled();
    expect(h.v2.handleDirectIntent).not.toHaveBeenCalled();
    expect(h.v2.handleMessage).not.toHaveBeenCalled();
    const event = h.events.emit.mock.calls[0]![0] as { event_name: string; payload: { intent: string } };
    expect(event.event_name).toBe("chat.companion_turn_served");
    expect(event.payload.intent).toBe(expected);
  });
});
