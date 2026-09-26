import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  RESUME_MENU_CHAT_CREATE_KEY,
  RESUME_MENU_CHAT_LABEL,
  RESUME_MENU_EDIT_KEY,
  RESUME_MENU_EDIT_LABEL,
  RESUME_MENU_REDO_KEY,
  RESUME_MENU_REDO_LABEL,
  RESUME_MENU_UPLOAD_KEY,
  RESUME_MENU_UPLOAD_LABEL,
  RESUME_SECTIONS,
  normalizeResumeMenuText,
} from "../chat/resume-menu";
import {
  COMPANION_APPLIED_LABEL,
  COMPANION_FIXED_KEYS,
  COMPANION_JOBS_TAB_LABEL,
  COMPANION_JOB_KEY_PREFIX,
  COMPANION_NEW_JOBS_LABEL,
  COMPANION_RESUME_LABEL,
  companionJobKey,
} from "./companion-keys";

/**
 * A chip key a shipped client already routes on must never be reused: the résumé menu's keys
 * navigate, the ADR-0043 offer's keys answer a question, `llm_*` chips carry a model's options,
 * and `kuch_aur` opens the custom-answer composer.
 */
describe("companion chip keys", () => {
  const claimed = [
    RESUME_MENU_EDIT_KEY,
    RESUME_MENU_REDO_KEY,
    RESUME_MENU_UPLOAD_KEY,
    RESUME_MENU_CHAT_CREATE_KEY,
    ...RESUME_SECTIONS.map((s) => s.key),
    "update_offer_yes",
    "update_offer_no",
    "kuch_aur",
  ];

  it.each([...COMPANION_FIXED_KEYS, COMPANION_JOB_KEY_PREFIX])("%s claims its own prefix and collides with nothing", (key) => {
    expect(key.startsWith("companion_")).toBe(true);
    expect(claimed).not.toContain(key);
    for (const reserved of ["resume_", "section_", "update_offer_", "llm_"]) {
      expect(key.startsWith(reserved)).toBe(false);
    }
  });

  it("a job key is the prefix plus the posting id", () => {
    expect(companionJobKey("abc")).toBe("companion_job:abc");
  });

  it("no companion LABEL can be mistaken for a résumé-menu label (the server matches labels)", () => {
    const menuLabels = [
      RESUME_MENU_EDIT_LABEL,
      RESUME_MENU_REDO_LABEL,
      RESUME_MENU_UPLOAD_LABEL,
      RESUME_MENU_CHAT_LABEL,
      ...RESUME_SECTIONS.map((s) => s.label),
    ].map(normalizeResumeMenuText);
    for (const label of [COMPANION_NEW_JOBS_LABEL, COMPANION_JOBS_TAB_LABEL, COMPANION_APPLIED_LABEL, COMPANION_RESUME_LABEL]) {
      expect(menuLabels).not.toContain(normalizeResumeMenuText(label));
    }
  });

  it("the Dart parity regex sees exactly the four fixed keys (the prefix is asserted separately)", () => {
    // Mirrors apps/worker-app/test/features/chat/chat_companion_keys_test.dart.
    const source = readFileSync(join(__dirname, "companion-keys.ts"), "utf8");
    const seen = [...source.matchAll(/COMPANION_[A-Z_]+_KEY\s*=\s*"([^"]+)"/g)].map((m) => m[1]);
    expect(new Set(seen)).toEqual(new Set(COMPANION_FIXED_KEYS));
    expect(source).toMatch(/COMPANION_JOB_KEY_PREFIX\s*=\s*"companion_job:"/);
  });
});
