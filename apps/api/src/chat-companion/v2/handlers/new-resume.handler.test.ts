import "reflect-metadata";
import { describe, expect, it, vi } from "vitest";
import type { ServerConfig } from "@badabhai/config";
import { RESUME_MENU_REDO_LABEL, resolveResumeMenu } from "../../../chat/resume-menu";
import { FALLBACK } from "../../companion-replies";
import { CompanionTurnSchema } from "../../chat-companion.dto";
import { NewResumeHandler } from "./new-resume.handler";
import type { HandlerInput } from "./handler";

const WORKER = "11111111-1111-4111-8111-111111111111";

const INPUT: HandlerInput = {
  workerId: WORKER,
  profile: {} as never,
  text: "naya resume chahiye",
  ctx: { correlationId: "c-1", requestId: "r-1" } as never,
  now: new Date("2026-09-29T10:00:00.000Z"),
};

function setup(latest?: () => Promise<unknown>) {
  const consents = {
    findLatestByWorker: vi.fn(latest ?? (async () => ({ revokedAt: null, purposes: ["resume_generation"] }))),
  };
  const config = {
    CHAT_COMPANION_V2_EDIT_ENABLED: true,
    CHAT_COMPANION_V2_NEW_RESUME_ENABLED: true,
  } as unknown as ServerConfig;
  return { handler: new NewResumeHandler(config, consents as never), consents };
}

describe("NewResumeHandler (ADR-0046 P2) — the redo flow, or the fallback line", () => {
  it("serves the résumé menu's redo turn VERBATIM — the same fields the menu itself serves", async () => {
    const h = setup();
    const { turn, outcome } = await h.handler.handle(INPUT);

    // The single source of the copy: the same call `resolveResumeMenu` makes for the menu's own
    // redo chip. If the menu's copy or options change, this test follows it rather than pinning
    // a stale duplicate.
    const menu = resolveResumeMenu(RESUME_MENU_REDO_LABEL);
    expect(outcome).toBe("served");
    expect(turn.reply).toBe(menu.reply);
    expect(turn.suggested_followups).toEqual([...menu.followups]);
    expect(turn.suggested_options).toEqual(menu.options.map((o) => ({ ...o })));
    expect(turn.question_kind).toBe("disambiguate");
    // No Devanagari twin is authored for the menu's redo line, so `ttsField` (the same helper
    // v1's `menuTurn` spreads) yields no field — verbatim includes the ABSENCE.
    expect(turn.tts_text).toBeUndefined();

    // The options are the EXISTING doors (form / chat-create / upload) — no new client work.
    expect(turn.suggested_options.map((o) => o.option_key)).toEqual(["resume_upload", "resume_chat_create"]);

    // And the whole turn is what the wire accepts.
    expect(CompanionTurnSchema.safeParse(turn).success).toBe(true);
  });

  it("consent missing the purpose, revoked, absent or unreadable — the v1 fallback line, fail closed", async () => {
    const cases: Array<() => Promise<unknown>> = [
      async () => ({ revokedAt: null, purposes: ["profiling"] }),
      async () => ({ revokedAt: new Date(), purposes: ["resume_generation"] }),
      async () => null,
      async () => {
        throw new Error("consent read boom");
      },
    ];
    for (const latest of cases) {
      const h = setup(latest);
      const { turn, outcome } = await h.handler.handle(INPUT);
      expect(outcome).toBe("fallback");
      expect(turn.reply).toBe(FALLBACK.latin);
      // Never a dead end: the fallback still offers the open task chips.
      expect(turn.suggested_options.map((o) => o.option_key)).toEqual([
        "companion_task:edit_resume",
        "companion_task:new_resume",
        "companion_new_jobs",
      ]);
      expect(CompanionTurnSchema.safeParse(turn).success).toBe(true);
    }
  });
});
