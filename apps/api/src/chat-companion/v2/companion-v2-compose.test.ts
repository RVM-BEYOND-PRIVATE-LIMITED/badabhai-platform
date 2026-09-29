import { describe, expect, it } from "vitest";
import type { ServerConfig } from "@badabhai/config";
import { V2_FALTU_COOLDOWN } from "../companion-replies";
import { taskChips, v2CooldownTurn } from "./companion-v2-compose";

const config = (over: Record<string, boolean> = {}): ServerConfig =>
  ({
    CHAT_COMPANION_V2_EDIT_ENABLED: false,
    CHAT_COMPANION_V2_NEW_RESUME_ENABLED: false,
    ...over,
  }) as unknown as ServerConfig;

/**
 * ADR-0046 P2 — the chip row and the cool-down turn. A chip exists only while its phase flag is
 * on (contracts §5.3), so a worker is never offered a door that opens onto "abhi aana baaki hai".
 */
describe("taskChips (P2 gating)", () => {
  it("the new-résumé chip appears only while its flag is on; jobs is always there", () => {
    const off = taskChips(config()).map((c) => c.option_key);
    expect(off).toEqual(["companion_new_jobs"]);

    const on = taskChips(config({ CHAT_COMPANION_V2_NEW_RESUME_ENABLED: true })).map(
      (c) => c.option_key,
    );
    expect(on).toEqual(["companion_task:new_resume", "companion_new_jobs"]);

    const all = taskChips(
      config({ CHAT_COMPANION_V2_EDIT_ENABLED: true, CHAT_COMPANION_V2_NEW_RESUME_ENABLED: true }),
    ).map((c) => c.option_key);
    expect(all).toEqual([
      "companion_task:edit_resume",
      "companion_task:new_resume",
      "companion_new_jobs",
    ]);
  });

  it("the career chip appears only while ITS flag is on (P3)", () => {
    const career = taskChips(config({ CHAT_COMPANION_V2_CAREER_ENABLED: true })).map(
      (c) => c.option_key,
    );
    expect(career).toEqual(["companion_task:career_talk", "companion_new_jobs"]);
  });
});

describe("v2CooldownTurn (P2)", () => {
  it("the cool-down line, the open chips and the instant the composer may reopen", () => {
    const turn = v2CooldownTurn("2026-09-29T10:30:00.000Z", taskChips(config()));
    expect(turn.reply).toBe(V2_FALTU_COOLDOWN.latin);
    expect(turn.tts_text).toBe(V2_FALTU_COOLDOWN.dev);
    expect(turn.cooldown_until).toBe("2026-09-29T10:30:00.000Z");
    expect(turn.suggested_options.length).toBeGreaterThan(0);
  });
});
