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
  resolveResumeMenu,
} from "../chat/resume-menu";
import { isCompanionChipTap } from "./companion-intents";
import { COMPANION_FIXED_KEYS, COMPANION_JOB_KEY_PREFIX } from "./companion-keys";
import { COMPANION_TASK_KEYS } from "./companion-task-keys";
import {
  COMPANION_RESUME_DOWNLOAD_KEY,
  COMPANION_RESUME_DOWNLOAD_LABEL,
  COMPANION_V3_KEYS,
  RESUME_MENU_FORM_CREATE_KEY,
  RESUME_MENU_FORM_CREATE_LABEL,
} from "./companion-v3-keys";

/**
 * ADR-0055 (#2275) — the free-chat brain's two new chip keys. A key a shipped client already routes
 * on must never be reused, and the two files the worker app's parity tests read verbatim must keep
 * EXACTLY their pinned key sets (a backend PR must not redden another team's CI).
 */
describe("the v3 chip keys", () => {
  const claimed = [
    ...COMPANION_FIXED_KEYS,
    ...COMPANION_TASK_KEYS,
    RESUME_MENU_EDIT_KEY,
    RESUME_MENU_REDO_KEY,
    RESUME_MENU_UPLOAD_KEY,
    RESUME_MENU_CHAT_CREATE_KEY,
    ...RESUME_SECTIONS.map((s) => s.key),
    "update_offer_yes",
    "update_offer_no",
    "kuch_aur",
  ];

  it.each(COMPANION_V3_KEYS)("%s is digit-free, distinct and collides with nothing", (key) => {
    expect(key).not.toMatch(/\d/);
    expect(key).toMatch(/^[a-z_]+$/);
    expect(claimed).not.toContain(key);
    for (const reserved of [
      "section_",
      "update_offer_",
      "llm_",
      "kuch_aur",
      COMPANION_JOB_KEY_PREFIX,
      "companion_task:",
    ]) {
      expect(key.startsWith(reserved)).toBe(false);
    }
  });

  it("the two keys are what the owner named", () => {
    expect(COMPANION_RESUME_DOWNLOAD_KEY).toBe("companion_resume_download");
    expect(COMPANION_RESUME_DOWNLOAD_LABEL).toBe("Resume download karein");
    expect(RESUME_MENU_FORM_CREATE_KEY).toBe("resume_form_create");
    expect(RESUME_MENU_FORM_CREATE_LABEL).toBe("Form se resume banayein");
    expect(new Set(COMPANION_V3_KEYS).size).toBe(COMPANION_V3_KEYS.length);
  });

  it("no v3 LABEL can be mistaken for a résumé-menu label or a v1 chip (the server matches labels)", () => {
    const menuLabels = [
      RESUME_MENU_EDIT_LABEL,
      RESUME_MENU_REDO_LABEL,
      RESUME_MENU_UPLOAD_LABEL,
      RESUME_MENU_CHAT_LABEL,
      ...RESUME_SECTIONS.map((s) => s.label),
    ].map(normalizeResumeMenuText);
    for (const label of [COMPANION_RESUME_DOWNLOAD_LABEL, RESUME_MENU_FORM_CREATE_LABEL]) {
      expect(menuLabels).not.toContain(normalizeResumeMenuText(label));
      expect(isCompanionChipTap(label)).toBe(false);
    }
    // The form label is no menu alias either: the shipped menu answers it with its generic root.
    expect(
      resolveResumeMenu(RESUME_MENU_FORM_CREATE_LABEL).options.map((o) => o.option_key),
    ).toEqual([RESUME_MENU_EDIT_KEY, RESUME_MENU_REDO_KEY]);
  });

  it("the worker app's parity regexes still see EXACTLY their pinned key sets", () => {
    // Mirrors chat_companion_keys_test.dart and chat_resume_menu_test.dart.
    const companion = readFileSync(join(__dirname, "companion-keys.ts"), "utf8");
    const companionKeys = [...companion.matchAll(/COMPANION_[A-Z_]+_KEY\s*=\s*"([^"]+)"/g)].map(
      (m) => m[1],
    );
    expect(new Set(companionKeys)).toEqual(new Set(COMPANION_FIXED_KEYS));

    const menu = readFileSync(join(__dirname, "../chat/resume-menu.ts"), "utf8");
    const menuKeys = [...menu.matchAll(/RESUME_MENU_[A-Z_]+_KEY\s*=\s*"([^"]+)"/g)].map(
      (m) => m[1],
    );
    expect(new Set(menuKeys)).toEqual(
      new Set([
        RESUME_MENU_EDIT_KEY,
        RESUME_MENU_REDO_KEY,
        RESUME_MENU_UPLOAD_KEY,
        RESUME_MENU_CHAT_CREATE_KEY,
      ]),
    );
    expect([...menu.matchAll(/key:\s*"([^"]+)"/g)]).toHaveLength(6);
  });
});
