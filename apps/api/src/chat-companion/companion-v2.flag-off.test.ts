import { describe, expect, it } from "vitest";
import { EVENT_REGISTRY } from "@badabhai/event-schema";
import { FALLBACK } from "./companion-replies";
import { COMPANION_NEW_JOBS_LABEL, COMPANION_RESUME_LABEL } from "./companion-keys";
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
