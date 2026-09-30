import { describe, expect, it } from "vitest";
import { resolveCompanionTaskChip } from "./companion-task-chips";

/**
 * ADR-0046 P2 — the task-chip recognition step that runs BEFORE the cool-down gate and before
 * v1. Two properties matter: every chip's label and key are recognised (a tap must never miss),
 * and nothing else is (a typed sentence is free text and must go through the normal flow).
 */
describe("resolveCompanionTaskChip", () => {
  it("matches each chip's label and key, case- and punctuation-tolerant like v1's chip checks", () => {
    expect(resolveCompanionTaskChip("Resume badlo")).toBe("edit_resume");
    expect(resolveCompanionTaskChip("  resume badlo. ")).toBe("edit_resume");
    expect(resolveCompanionTaskChip("companion_task:edit_resume")).toBe("edit_resume");

    expect(resolveCompanionTaskChip("Naya resume")).toBe("new_resume");
    expect(resolveCompanionTaskChip("naya resume?")).toBe("new_resume");
    expect(resolveCompanionTaskChip("companion_task:new_resume")).toBe("new_resume");

    expect(resolveCompanionTaskChip("Career ki baat")).toBe("career_talk");
    expect(resolveCompanionTaskChip("companion_task:career_talk")).toBe("career_talk");
  });

  it("is EXACT, never substring — a typed sentence stays free text", () => {
    expect(resolveCompanionTaskChip("resume badalna hai")).toBeNull();
    expect(resolveCompanionTaskChip("mujhe naya resume chahiye")).toBeNull();
    expect(resolveCompanionTaskChip("career ke baare mein batao")).toBeNull();
    expect(resolveCompanionTaskChip("resume")).toBeNull();
    expect(resolveCompanionTaskChip("")).toBeNull();
  });
});
