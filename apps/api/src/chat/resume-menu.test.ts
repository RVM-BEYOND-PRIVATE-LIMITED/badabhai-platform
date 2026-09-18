import { describe, it, expect } from "vitest";
import {
  RESUME_MENU_EDIT_LABEL,
  RESUME_MENU_REDO_LABEL,
  RESUME_MENU_UPLOAD_LABEL,
  RESUME_MENU_CHAT_LABEL,
  RESUME_MENU_ROOT_REPLY,
  RESUME_MENU_REDO_REPLY,
  RESUME_MENU_EDIT_REPLY,
  RESUME_SECTIONS,
  resolveResumeMenu,
} from "./resume-menu";

describe("resolveResumeMenu — post-completion menu, deterministic", () => {
  it("any free text falls back to the root pair", () => {
    const menu = resolveResumeMenu("namaste bhai, aur kaam kaisa hai");
    expect(menu.reply).toBe(RESUME_MENU_ROOT_REPLY);
    expect(menu.followups).toEqual([RESUME_MENU_EDIT_LABEL, RESUME_MENU_REDO_LABEL]);
    expect(menu.options.map((o) => o.option_key)).toEqual(["resume_edit", "resume_redo"]);
  });

  it("empty text is the root pair, never an error", () => {
    expect(resolveResumeMenu("").followups).toHaveLength(2);
    expect(resolveResumeMenu("   ").followups).toHaveLength(2);
  });

  it("edit label opens the 6 resume sections", () => {
    const menu = resolveResumeMenu(RESUME_MENU_EDIT_LABEL);
    expect(menu.reply).toBe(RESUME_MENU_EDIT_REPLY);
    expect(menu.followups).toEqual(RESUME_SECTIONS.map((s) => s.label));
    expect(menu.followups).toHaveLength(6);
  });

  it("redo label opens the upload-vs-chat pair", () => {
    const menu = resolveResumeMenu(RESUME_MENU_REDO_LABEL);
    expect(menu.reply).toBe(RESUME_MENU_REDO_REPLY);
    expect(menu.followups).toEqual([RESUME_MENU_UPLOAD_LABEL, RESUME_MENU_CHAT_LABEL]);
  });

  it("dobara/firse free text routes to redo, not root", () => {
    expect(resolveResumeMenu("dobara banayein").reply).toBe(RESUME_MENU_REDO_REPLY);
    expect(resolveResumeMenu("firse banana hai").reply).toBe(RESUME_MENU_REDO_REPLY);
  });

  it("upload acks with no chips (the client navigates to resume-import)", () => {
    const menu = resolveResumeMenu(RESUME_MENU_UPLOAD_LABEL);
    expect(menu.followups).toEqual([]);
    expect(menu.options).toEqual([]);
    expect(menu.reply).toContain("upload");
  });

  it("chat-create acks with no chips (the client starts a fresh session)", () => {
    const menu = resolveResumeMenu(RESUME_MENU_CHAT_LABEL);
    expect(menu.followups).toEqual([]);
    expect(menu.reply).toContain("Nayi chat");
  });

  it("a section label acks and keeps the 6 options for correction", () => {
    for (const s of RESUME_SECTIONS) {
      const menu = resolveResumeMenu(s.label);
      expect(menu.reply).toContain(s.label);
      expect(menu.followups).toHaveLength(6);
    }
  });

  it("matching is case/space/punctuation-insensitive", () => {
    expect(resolveResumeMenu("  APNA RESUME EDIT KAREIN. ").reply).toBe(RESUME_MENU_EDIT_REPLY);
    expect(resolveResumeMenu("dobara!!").reply).toBe(RESUME_MENU_REDO_REPLY);
  });
});
