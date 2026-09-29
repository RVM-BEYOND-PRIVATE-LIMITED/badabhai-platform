import { describe, expect, it } from "vitest";
import { COMPANION_FIXED_KEYS, COMPANION_JOB_KEY_PREFIX } from "./companion-keys";
import {
  COMPANION_TASK_CAREER_KEY,
  COMPANION_TASK_EDIT_RESUME_KEY,
  COMPANION_TASK_KEYS,
  COMPANION_TASK_NEW_RESUME_KEY,
} from "./companion-task-keys";

/**
 * The v2 task chips' keys (ADR-0046 §5.3). Their own file, and their own guard, because
 * `companion-keys.ts` is pinned verbatim by the worker app's parity test — these keys join that
 * contract when the app build that routes them ships (Frontend F5). Until then the server's half
 * must still be collision-free: a task key that a shipped client mistook for a résumé-menu route
 * would send the worker somewhere unrelated.
 */
describe("companion v2 task-chip keys", () => {
  it("every task key uses the companion_task: prefix", () => {
    for (const key of COMPANION_TASK_KEYS) {
      expect(key.startsWith("companion_task:")).toBe(true);
    }
  });

  it("no task key collides with a v1 companion key or the job-key prefix", () => {
    const v1 = [...COMPANION_FIXED_KEYS, COMPANION_JOB_KEY_PREFIX];
    for (const key of COMPANION_TASK_KEYS) {
      expect(v1).not.toContain(key);
    }
  });

  it("the three keys are distinct and name the intents they stand for", () => {
    expect(new Set(COMPANION_TASK_KEYS).size).toBe(3);
    expect(COMPANION_TASK_EDIT_RESUME_KEY).toBe("companion_task:edit_resume");
    expect(COMPANION_TASK_NEW_RESUME_KEY).toBe("companion_task:new_resume");
    expect(COMPANION_TASK_CAREER_KEY).toBe("companion_task:career_talk");
  });

  it("no task key starts with a reserved prefix a shipped client routes on", () => {
    for (const key of COMPANION_TASK_KEYS) {
      for (const reserved of ["resume_", "section_", "update_offer_", "llm_"]) {
        expect(key.startsWith(reserved)).toBe(false);
      }
    }
  });
});
