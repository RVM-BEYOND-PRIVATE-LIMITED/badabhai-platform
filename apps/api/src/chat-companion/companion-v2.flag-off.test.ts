import { describe, expect, it } from "vitest";
import { EVENT_REGISTRY } from "@badabhai/event-schema";
import { RESUME_MENU_REDO_LABEL, resolveResumeMenu } from "../chat/resume-menu";
import { FALLBACK, V2_PHASE_OFF } from "./companion-replies";
import { resolveCompanionText } from "./companion-intents";
import { COMPANION_NEW_JOBS_LABEL, COMPANION_RESUME_LABEL } from "./companion-keys";
import {
  COMPANION_TASK_CAREER_KEY,
  COMPANION_TASK_CAREER_LABEL,
  COMPANION_TASK_EDIT_RESUME_KEY,
  COMPANION_TASK_EDIT_RESUME_LABEL,
  COMPANION_TASK_NEW_RESUME_KEY,
  COMPANION_TASK_NEW_RESUME_LABEL,
} from "./companion-task-keys";
import { CTX, makeCompanionServiceForV2, NOW, SUBMISSION, WORKER } from "./chat-companion.v2.fake";

/**
 * ADR-0046 §3 — FLAG OFF ⇒ v1 BYTE-FOR-BYTE. With `CHAT_COMPANION_V2_ENABLED` off the v2 layer
 * must be unreachable: no orchestrator call, no classify, no v2 event, and every turn is the one
 * v1 composed. This is the guarantee that lets v2 ship dark.
 */
describe("v2 off: the v1 paths are untouched", () => {
  const TEXTS = [
    "ab tak kya hua",
    COMPANION_NEW_JOBS_LABEL,
    COMPANION_RESUME_LABEL,
    "fir se banao",
    "job milegi?",
    // A MISS for the v1 resolver: with v2 off this is v1's own fallback line.
    "Tata ki jagah Mahindra likho",
    "mausam kaisa hai",
  ];

  it.each(TEXTS)("%j: the v2 layer is never reached, and the event is v1", async (text) => {
    const h = makeCompanionServiceForV2({ v2: false });
    const result = await h.svc.message(WORKER, { text, submission_id: SUBMISSION }, CTX as never, NOW);

    expect(result.mode).toBe("companion");
    expect(h.v2.handleMessage).not.toHaveBeenCalled();
    expect(h.edits.propose).not.toHaveBeenCalled();

    const event = h.events.emit.mock.calls[0]![0] as { event_name: string; payload: unknown };
    expect(event.event_name).toBe("chat.companion_turn_served");
    expect(
      EVENT_REGISTRY["chat.companion_turn_served"].payload.safeParse(event.payload).success,
    ).toBe(true);
    // NEVER the v2 event name, whatever the text was.
    for (const call of h.events.emit.mock.calls) {
      expect((call[0] as { event_name: string }).event_name).not.toBe("chat.companion_turn_served_v2");
    }
  });

  it("a v1 miss is v1's own fallback line, byte-for-byte", async () => {
    const h = makeCompanionServiceForV2({ v2: false });
    const result = await h.svc.message(WORKER, { text: "Tata ki jagah Mahindra likho" }, CTX as never, NOW);
    if (result.mode !== "companion") throw new Error("expected companion");
    expect(result.turn.reply).toBe(FALLBACK.latin);
    expect(result.turn.tts_text).toBe(FALLBACK.dev);
  });

  it("the v2 edit routes are closed too — they answer not_found with the flags off", async () => {
    const h = makeCompanionServiceForV2({ v2: false });
    expect(await h.svc.confirmEdit(WORKER, SUBMISSION, { row_ids: [SUBMISSION] }, CTX as never)).toEqual({
      mode: "not_found",
    });
    expect(await h.svc.cancelEdit(WORKER, SUBMISSION, CTX as never)).toEqual({ mode: "not_found" });
    expect(h.edits.confirm).not.toHaveBeenCalled();
  });
});

/**
 * README rule 6, PER PHASE FLAG — with the master ON and one phase OFF, that phase's task chip
 * is not shown, so its label arriving as text is a worker TYPING it: it must get exactly the
 * turn it got before the chip existed. For a v1 hit that is v1's own turn, byte for byte (the
 * same text through a v2-off service is the baseline); for a v1 miss it is the Phase 1 router
 * (`handleMessage`), exactly like any other free text. It is never the chip route, whose answer
 * for a closed phase would be the "abhi aana baaki hai" line.
 */
describe("a phase flag off: its task chip's label is typed text, served as before the chip existed", () => {
  type Flag = "edit" | "newResume" | "career";
  const ALL_ON = { edit: true, newResume: true, career: true } as const;
  const CASES: readonly [label: string, flag: Flag, v1: "resume_menu" | "digest" | "fallback"][] = [
    // v1's résumé-menu alias "naya resume" → the redo menu (resume-menu.ts), not the digest.
    [COMPANION_TASK_NEW_RESUME_LABEL, "newResume", "resume_menu"],
    [COMPANION_TASK_NEW_RESUME_KEY, "newResume", "digest"],
    // v1's weak "resume" signal → the recap; the key carries the menu alias "edit" → the menu.
    [COMPANION_TASK_EDIT_RESUME_LABEL, "edit", "digest"],
    [COMPANION_TASK_EDIT_RESUME_KEY, "edit", "resume_menu"],
    // No v1 signal at all → v1's miss, which Phase 1 hands to the router.
    [COMPANION_TASK_CAREER_LABEL, "career", "fallback"],
    [COMPANION_TASK_CAREER_KEY, "career", "fallback"],
  ];

  it("the fixture is real — each label resolves in v1 as stated", () => {
    for (const [text, , v1] of CASES) {
      const resolved = resolveCompanionText(text);
      expect(resolved.kind === "resume_menu" ? "resume_menu" : resolved.intent, text).toBe(v1);
    }
  });

  it.each(CASES)("%j with its phase (%s) OFF: never the chip route; v1's turn or the router", async (text, flag, v1) => {
    const h = makeCompanionServiceForV2({ v2: true, ...ALL_ON, [flag]: false });
    const result = await h.svc.message(WORKER, { text, submission_id: SUBMISSION }, CTX as never, NOW);
    if (result.mode !== "companion") throw new Error("expected companion");

    expect(h.v2.handleTaskChip).not.toHaveBeenCalled();
    if (v1 === "fallback") {
      // The Phase 1 path for a v1 miss: the router, called exactly as for any free text.
      expect(h.v2.handleMessage).toHaveBeenCalledWith(
        WORKER,
        expect.anything(),
        { text, submission_id: SUBMISSION },
        CTX,
        NOW,
      );
      return;
    }
    expect(h.v2.handleMessage).not.toHaveBeenCalled();
    // v1 answered, BYTE FOR BYTE what a v2-off service serves for the same text...
    const baseline = makeCompanionServiceForV2({ v2: false });
    const expected = await baseline.svc.message(WORKER, { text, submission_id: SUBMISSION }, CTX as never, NOW);
    expect(result).toEqual(expected);
    // ...and recorded on v1's own event, never the v2 one.
    expect(h.events.emit.mock.calls.map((c) => (c[0] as { event_name: string }).event_name)).toEqual([
      "chat.companion_turn_served",
    ]);
  });

  it("'naya resume' typed with NEW_RESUME off is v1's redo menu — the regression this pins", async () => {
    const h = makeCompanionServiceForV2({ v2: true, edit: true, newResume: false });
    const result = await h.svc.message(WORKER, { text: "naya resume" }, CTX as never, NOW);
    if (result.mode !== "companion") throw new Error("expected companion");
    expect(result.turn.reply).toBe(resolveResumeMenu(RESUME_MENU_REDO_LABEL).reply);
    expect(result.turn.reply).not.toBe(V2_PHASE_OFF.latin);
  });

  it.each(CASES)("%j with its phase (%s) ON is routed as a chip tap", async (text, flag) => {
    const h = makeCompanionServiceForV2({ v2: true, ...ALL_ON });
    await h.svc.message(WORKER, { text }, CTX as never, NOW);
    const intent = { edit: "edit_resume", newResume: "new_resume", career: "career_talk" }[flag];
    expect(h.v2.handleTaskChip).toHaveBeenCalledWith(WORKER, expect.anything(), { text }, intent, CTX, NOW);
  });

  it("the edit routes answer not_found with the master ON and only EDIT off", async () => {
    const h = makeCompanionServiceForV2({ v2: true, edit: false });
    expect(await h.svc.confirmEdit(WORKER, SUBMISSION, { row_ids: [SUBMISSION] }, CTX as never)).toEqual({
      mode: "not_found",
    });
    expect(await h.svc.cancelEdit(WORKER, SUBMISSION, CTX as never)).toEqual({ mode: "not_found" });
    expect(h.edits.confirm).not.toHaveBeenCalled();
    expect(h.edits.cancel).not.toHaveBeenCalled();
  });
});
