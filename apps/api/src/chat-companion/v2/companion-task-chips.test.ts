import { describe, expect, it } from "vitest";
import type { ServerConfig } from "@badabhai/config";
import {
  COMPANION_TASK_CHIPS,
  resolveCompanionTaskChip,
  type CompanionTaskChipFlags,
} from "./companion-task-chips";
import { taskChips } from "./companion-v2-compose";

const ALL_OPEN: CompanionTaskChipFlags = {
  CHAT_COMPANION_V2_EDIT_ENABLED: true,
  CHAT_COMPANION_V2_NEW_RESUME_ENABLED: true,
  CHAT_COMPANION_V2_CAREER_ENABLED: true,
};

/**
 * ADR-0046 P2 — the task-chip recognition step that runs BEFORE the cool-down gate and before
 * v1. Three properties matter: every OPEN chip's label and key are recognised (a tap must never
 * miss), nothing else is (a typed sentence is free text and must go through the normal flow), and
 * a chip whose phase is off is not recognised at all (its label is then typed text, v1's first).
 */
describe("resolveCompanionTaskChip", () => {
  it("matches each chip's label and key, case- and punctuation-tolerant like v1's chip checks", () => {
    expect(resolveCompanionTaskChip("Resume badlo", ALL_OPEN)).toBe("edit_resume");
    expect(resolveCompanionTaskChip("  resume badlo. ", ALL_OPEN)).toBe("edit_resume");
    expect(resolveCompanionTaskChip("companion_task:edit_resume", ALL_OPEN)).toBe("edit_resume");

    expect(resolveCompanionTaskChip("Naya resume", ALL_OPEN)).toBe("new_resume");
    expect(resolveCompanionTaskChip("naya resume?", ALL_OPEN)).toBe("new_resume");
    expect(resolveCompanionTaskChip("companion_task:new_resume", ALL_OPEN)).toBe("new_resume");

    expect(resolveCompanionTaskChip("Career ki baat", ALL_OPEN)).toBe("career_talk");
    expect(resolveCompanionTaskChip("companion_task:career_talk", ALL_OPEN)).toBe("career_talk");
  });

  it("is EXACT, never substring — a typed sentence stays free text", () => {
    expect(resolveCompanionTaskChip("resume badalna hai", ALL_OPEN)).toBeNull();
    expect(resolveCompanionTaskChip("mujhe naya resume chahiye", ALL_OPEN)).toBeNull();
    expect(resolveCompanionTaskChip("career ke baare mein batao", ALL_OPEN)).toBeNull();
    expect(resolveCompanionTaskChip("resume", ALL_OPEN)).toBeNull();
    expect(resolveCompanionTaskChip("", ALL_OPEN)).toBeNull();
  });

  it.each(COMPANION_TASK_CHIPS.map((chip) => [chip.intent, chip] as const))(
    "%s: its phase flag OFF ⇒ neither its label nor its key is a chip tap",
    (_intent, chip) => {
      const flags = { ...ALL_OPEN, [chip.flag]: false };
      expect(resolveCompanionTaskChip(chip.label, flags)).toBeNull();
      expect(resolveCompanionTaskChip(chip.key, flags)).toBeNull();
      // ...while the OTHER chips are untouched by its flag.
      for (const other of COMPANION_TASK_CHIPS.filter((c) => c !== chip)) {
        expect(resolveCompanionTaskChip(other.label, flags)).toBe(other.intent);
      }
    },
  );

  it("SHOWN ⇔ ROUTED: for every flag combination, a chip is recognised exactly when a turn offers it", () => {
    for (const edit of [false, true]) {
      for (const newResume of [false, true]) {
        for (const career of [false, true]) {
          const flags: CompanionTaskChipFlags = {
            CHAT_COMPANION_V2_EDIT_ENABLED: edit,
            CHAT_COMPANION_V2_NEW_RESUME_ENABLED: newResume,
            CHAT_COMPANION_V2_CAREER_ENABLED: career,
          };
          const shown = new Set(taskChips(flags as ServerConfig).map((o) => o.option_key));
          for (const chip of COMPANION_TASK_CHIPS) {
            const routed = resolveCompanionTaskChip(chip.label, flags) !== null;
            expect(routed, `${chip.key} ${JSON.stringify(flags)}`).toBe(shown.has(chip.key));
          }
        }
      }
    }
  });
});
