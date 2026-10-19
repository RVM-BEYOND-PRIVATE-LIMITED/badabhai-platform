import { describe, expect, it, vi } from "vitest";
import { Logger } from "@nestjs/common";
import {
  RESUME_MENU_CHAT_CREATE_KEY,
  RESUME_MENU_EDIT_LABEL,
  RESUME_MENU_REDO_LABEL,
  RESUME_MENU_UPLOAD_KEY,
  RESUME_MENU_UPLOAD_LABEL,
  resolveResumeMenu,
} from "../chat/resume-menu";
import {
  currentResumeFacts,
  resumeDownloadOf,
  type CompanionResumeFacts,
  type CompanionResumeState,
} from "./companion-facts";
import {
  downloadOption,
  formCreateAck,
  isFormCreateChoice,
  withDownloadOption,
  withFormCreateOption,
} from "./companion-resume-menu";
import { CompanionResumeStatus } from "./companion-resume-status";
import {
  COMPANION_RESUME_DOWNLOAD_KEY,
  RESUME_MENU_FORM_ACK,
  RESUME_MENU_FORM_CREATE_KEY,
  RESUME_MENU_FORM_CREATE_LABEL,
} from "./companion-v3-keys";

/** ADR-0055 (#2275) — the résumé menu's two decorations and the download rule, all deterministic. */

describe("withFormCreateOption — the form road in the redo submenu", () => {
  it("inserts the form road right after upload, labels and keys in step", () => {
    const menu = withFormCreateOption(resolveResumeMenu(RESUME_MENU_REDO_LABEL));
    expect(menu.reply).toBe(resolveResumeMenu(RESUME_MENU_REDO_LABEL).reply);
    expect(menu.options.map((o) => o.option_key)).toEqual([
      RESUME_MENU_UPLOAD_KEY,
      RESUME_MENU_FORM_CREATE_KEY,
      RESUME_MENU_CHAT_CREATE_KEY,
    ]);
    expect(menu.followups).toEqual(menu.options.map((o) => o.label_text));
    expect(menu.followups[1]).toBe(RESUME_MENU_FORM_CREATE_LABEL);
  });

  it("leaves every other menu exactly as the shipped menu builds it, and never adds the road twice", () => {
    for (const text of ["", RESUME_MENU_EDIT_LABEL, RESUME_MENU_UPLOAD_LABEL, "General Info"]) {
      expect(withFormCreateOption(resolveResumeMenu(text))).toEqual(resolveResumeMenu(text));
    }
    const once = withFormCreateOption(resolveResumeMenu(RESUME_MENU_REDO_LABEL));
    expect(withFormCreateOption(once)).toEqual(once);
  });

  it("does not touch the shipped menu (the ended-interview path shares it)", () => {
    expect(resolveResumeMenu(RESUME_MENU_REDO_LABEL).options).toHaveLength(2);
  });

  it("hides the form road for chat-road profiles — either source is enough", () => {
    const redo = resolveResumeMenu(RESUME_MENU_REDO_LABEL);
    // Chat profile, form résumé (or unreadable): still two options.
    expect(
      withFormCreateOption(redo, { profileSource: "chat", resumeSource: "form" }).options.map(
        (o) => o.option_key,
      ),
    ).toEqual([RESUME_MENU_UPLOAD_KEY, RESUME_MENU_CHAT_CREATE_KEY]);
    // Form profile, chat résumé: still two options.
    expect(
      withFormCreateOption(redo, { profileSource: "form", resumeSource: "chat" }).options.map(
        (o) => o.option_key,
      ),
    ).toEqual([RESUME_MENU_UPLOAD_KEY, RESUME_MENU_CHAT_CREATE_KEY]);
    // Form profile, form résumé (or unknown): all three.
    expect(
      withFormCreateOption(redo, { profileSource: "form", resumeSource: "form" }).options.map(
        (o) => o.option_key,
      ),
    ).toEqual([RESUME_MENU_UPLOAD_KEY, RESUME_MENU_FORM_CREATE_KEY, RESUME_MENU_CHAT_CREATE_KEY]);
    expect(
      withFormCreateOption(redo, { profileSource: null, resumeSource: null }).options.map(
        (o) => o.option_key,
      ),
    ).toEqual([RESUME_MENU_UPLOAD_KEY, RESUME_MENU_FORM_CREATE_KEY, RESUME_MENU_CHAT_CREATE_KEY]);
  });
});

describe("the form road's chip and ack", () => {
  it("recognises the label and the key exactly — never a substring", () => {
    expect(isFormCreateChoice(RESUME_MENU_FORM_CREATE_LABEL)).toBe(true);
    expect(isFormCreateChoice(RESUME_MENU_FORM_CREATE_KEY)).toBe(true);
    expect(isFormCreateChoice(" FORM SE RESUME BANAYEIN. ")).toBe(true);
    expect(isFormCreateChoice("form se resume banana hai kya")).toBe(false);
    expect(isFormCreateChoice("")).toBe(false);
  });

  it("acks like the menu's upload and chat acks: the line, no chips", () => {
    expect(formCreateAck()).toEqual({ reply: RESUME_MENU_FORM_ACK, followups: [], options: [] });
  });
});

describe("the download chip on a menu", () => {
  it("rides last, labels and keys in step", () => {
    const menu = withDownloadOption(resolveResumeMenu(""));
    expect(menu.options.map((o) => o.option_key).at(-1)).toBe(COMPANION_RESUME_DOWNLOAD_KEY);
    expect(menu.followups).toEqual(menu.options.map((o) => o.label_text));
    expect(downloadOption().option_key).toBe(COMPANION_RESUME_DOWNLOAD_KEY);
  });
});

describe("resumeDownloadOf — what a download request may honestly be told", () => {
  const resume = (renderStatus: string): CompanionResumeFacts => ({
    resumeId: "r1",
    source: "form",
    renderStatus,
    generatedAt: null,
    tradeLabel: null,
    experienceYears: null,
    machines: [],
    city: null,
  });
  it.each([
    ["ready", "rendered", "ready"],
    // `ready` for the recap past the grace, but no PDF is drawn: the download route answers 409.
    ["ready", "pending", "unavailable"],
    ["building", "pending", "building"],
    ["failed", "failed", "unavailable"],
    ["none", null, "unavailable"],
    ["unknown", null, "unavailable"],
  ] as const)("state %s, render %s → %s", (state, render, expected) => {
    expect(
      resumeDownloadOf(state as CompanionResumeState, render === null ? null : resume(render)),
    ).toBe(expected);
  });
});

describe("CompanionResumeStatus — the recap's own rule, read-only, fail safe", () => {
  const NOW = new Date("2026-10-14T10:00:00.000Z");
  const PROFILE = { confirmedAt: new Date("2026-10-14T09:59:00.000Z") } as never;
  const config = { RESUME_UPDATE_PENDING_TIMEOUT_SECONDS: 1_200 } as never;
  const item = (render_status: string, generated_at: string) => ({
    resume_id: "r1",
    profile_id: "p1",
    source: "form",
    trigger: null,
    generated_at,
    render_status,
    rendered_at: null,
    is_current: true,
    display_ref: "ABC123",
    trade_label: null,
    experience_years: null,
    machines: null,
    axes: null,
    city: null,
    page_count: null,
  });
  const status = (history: () => Promise<unknown>) =>
    new CompanionResumeStatus(config, { history: vi.fn(history) } as never);

  it("rendered → ready; a fresh pending → building; no row just after confirming → building", async () => {
    const rendered = status(async () => ({
      items: [item("rendered", "2026-10-13T10:00:00.000Z")],
      pending_update: null,
    }));
    expect(await rendered.downloadOf("w", PROFILE, NOW)).toBe("ready");
    const fresh = status(async () => ({
      items: [item("pending", "2026-10-14T09:59:30.000Z")],
      pending_update: null,
    }));
    expect(await fresh.downloadOf("w", PROFILE, NOW)).toBe("building");
    const none = status(async () => ({ items: [], pending_update: null }));
    expect(await none.downloadOf("w", PROFILE, NOW)).toBe("building");
  });

  it("a history read that throws is `unavailable` — no chip, no promise — and a PII-free warn", async () => {
    const warn = vi.spyOn(Logger.prototype, "warn").mockImplementation(() => undefined);
    const broken = status(async () => {
      throw new Error("db down");
    });
    expect(await broken.downloadOf("w", PROFILE, NOW)).toBe("unavailable");
    expect(String(warn.mock.calls[0]?.[0])).toContain("worker w");
    warn.mockRestore();
  });

  it("maps the current item exactly as the recap does", () => {
    expect(currentResumeFacts(undefined)).toBeNull();
    expect(currentResumeFacts(item("rendered", "2026-10-13T10:00:00.000Z") as never)).toMatchObject(
      {
        resumeId: "r1",
        renderStatus: "rendered",
        generatedAt: new Date("2026-10-13T10:00:00.000Z"),
        machines: [],
      },
    );
  });
});
