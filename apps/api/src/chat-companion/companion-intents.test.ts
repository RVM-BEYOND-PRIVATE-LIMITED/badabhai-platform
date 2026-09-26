import { describe, expect, it } from "vitest";
import {
  RESUME_MENU_CHAT_LABEL,
  RESUME_MENU_EDIT_LABEL,
  RESUME_MENU_REDO_LABEL,
  RESUME_MENU_UPLOAD_LABEL,
  RESUME_SECTIONS,
  resolveResumeMenu,
} from "../chat/resume-menu";
import {
  COMPANION_APPLIED_LABEL,
  COMPANION_JOBS_TAB_LABEL,
  COMPANION_NEW_JOBS_LABEL,
  COMPANION_RESUME_KEY,
  COMPANION_RESUME_LABEL,
  companionJobKey,
} from "./companion-keys";
import { resolveCompanionText } from "./companion-intents";

/**
 * The compatibility contract of ADR-0044: everything the shipped résumé menu understands is
 * answered BY that menu, byte for byte — the companion only adds meaning where the menu would
 * have fallen back to its generic root.
 */
describe("resolveCompanionText — the résumé menu keeps first refusal", () => {
  const menuInputs = [
    RESUME_MENU_EDIT_LABEL,
    RESUME_MENU_REDO_LABEL,
    RESUME_MENU_UPLOAD_LABEL,
    RESUME_MENU_CHAT_LABEL,
    ...RESUME_SECTIONS.map((s) => s.label),
    ...RESUME_SECTIONS.map((s) => s.key),
    // The menu's own Hinglish aliases (resume-menu.ts), typed free-text.
    "mujhe upload karna hai",
    "resume dobara banana hai",
    "firse banao",
    "phir se chahiye",
    "naya resume",
    "dubara",
    "edit karna hai",
    "theek karna hai",
    "sudhar do",
    "badalna hai",
    "correction",
    "update karna hai",
    "chat se",
  ];

  it.each(menuInputs)("%j is served by resolveResumeMenu, verbatim", (text) => {
    const resolved = resolveCompanionText(text);
    expect(resolved.kind).toBe("resume_menu");
    if (resolved.kind === "resume_menu") expect(resolved.menu).toEqual(resolveResumeMenu(text));
  });

  it("'Resume badlein' opens the menu's ROOT (edit / redo), exactly as the ended session serves it", () => {
    for (const text of [COMPANION_RESUME_LABEL, COMPANION_RESUME_KEY, "resume badlein."]) {
      const resolved = resolveCompanionText(text);
      expect(resolved.kind).toBe("resume_menu");
      if (resolved.kind === "resume_menu") expect(resolved.menu).toEqual(resolveResumeMenu(""));
    }
  });
});

describe("resolveCompanionText — the companion's own intents", () => {
  const cases: ReadonlyArray<readonly [string, string]> = [
    ["", "digest"],
    ["   ", "digest"],
    ["Namaste", "digest"],
    ["hi", "digest"],
    ["ab tak kya hua", "digest"],
    ["mera resume kaisa hai", "digest"],
    ["meri profile", "digest"],
    [COMPANION_NEW_JOBS_LABEL, "jobs"],
    [COMPANION_JOBS_TAB_LABEL, "jobs"],
    [companionJobKey("11111111-1111-4111-8111-111111111111"), "jobs"],
    ["naye jobs dikhao", "jobs"],
    ["koi naukri hai", "jobs"],
    ["kaam chahiye", "jobs"],
    [COMPANION_APPLIED_LABEL, "applied"],
    ["maine kitne jobs par apply kiya", "applied"],
    ["meri applications", "applied"],
    ["job milegi?", "guarantee"],
    ["naukri milegi kya", "guarantee"],
    ["pakka job hai", "guarantee"],
    ["mausam kaisa hai", "fallback"],
    ["asdfgh", "fallback"],
  ];

  it.each(cases)("%j → %s", (text, intent) => {
    expect(resolveCompanionText(text)).toEqual({ kind: "intent", intent });
  });

  it("'job milegi' is the honest refusal, NOT a jobs listing — the guarantee words win", () => {
    expect(resolveCompanionText("koi job milegi")).toEqual({ kind: "intent", intent: "guarantee" });
  });

  it("an applications question that also says 'jobs' is about applications", () => {
    expect(resolveCompanionText("kitne jobs")).toEqual({ kind: "intent", intent: "applied" });
  });

  it("never throws on hostile input", () => {
    for (const text of ["x".repeat(4000), "🙂🙂🙂", "नमस्ते क्या हुआ", "{{worker_name}}", "\n\t"]) {
      expect(() => resolveCompanionText(text)).not.toThrow();
    }
  });
});
