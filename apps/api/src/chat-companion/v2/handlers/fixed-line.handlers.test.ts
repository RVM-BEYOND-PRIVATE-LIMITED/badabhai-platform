import "reflect-metadata";
import { describe, expect, it, vi } from "vitest";
import { CompanionTurnSchema } from "../../chat-companion.dto";
import {
  RESUME_MENU_CHAT_CREATE_KEY,
  RESUME_MENU_UPLOAD_KEY,
  RESUME_SECTIONS,
} from "../../../chat/resume-menu";
import { EditSectionMenuHandler } from "./fixed-line.handlers";
import type { HandlerInput } from "./handler";

const WORKER = "11111111-1111-4111-8111-111111111111";
const NOW = new Date("2026-10-19T10:00:00.000Z");

const input = (profileSource: string | null): HandlerInput => ({
  workerId: WORKER,
  profile: { source: profileSource } as never,
  text: "resume badle",
  recentTurns: [],
  ctx: { correlationId: "c-1", requestId: "r-1" } as never,
  now: NOW,
  submissionId: null,
});

const resumes = (source: string | null) => ({
  history: vi.fn(async () => ({ items: [{ source }], pending_update: null })),
});

describe("EditSectionMenuHandler — the brain's edit answer per road", () => {
  it("form-road serves the six sections", async () => {
    const { turn, outcome } = await new EditSectionMenuHandler(
      resumes("form") as never,
    ).handle(input("form"));
    expect(outcome).toBe("served");
    expect(turn.suggested_options.map((o) => o.option_key)).toEqual(
      RESUME_SECTIONS.map((s) => s.key),
    );
    expect(CompanionTurnSchema.safeParse(turn).success).toBe(true);
  });

  it("chat-road profile serves the redo pair, without reading the résumé", async () => {
    const history = resumes("form");
    const { turn } = await new EditSectionMenuHandler(history as never).handle(input("chat"));
    expect(turn.suggested_options.map((o) => o.option_key)).toEqual([
      RESUME_MENU_UPLOAD_KEY,
      RESUME_MENU_CHAT_CREATE_KEY,
    ]);
    expect(history.history).not.toHaveBeenCalled();
  });

  it("chat-road résumé serves the redo pair even for a form-road profile", async () => {
    const { turn } = await new EditSectionMenuHandler(resumes("chat") as never).handle(
      input("form"),
    );
    expect(turn.suggested_options.map((o) => o.option_key)).toEqual([
      RESUME_MENU_UPLOAD_KEY,
      RESUME_MENU_CHAT_CREATE_KEY,
    ]);
  });

  it("without a résumé read (hand-built), only the profile road is checked", async () => {
    const chat = await new EditSectionMenuHandler().handle(input("chat"));
    expect(chat.turn.suggested_options.map((o) => o.option_key)).toEqual([
      RESUME_MENU_UPLOAD_KEY,
      RESUME_MENU_CHAT_CREATE_KEY,
    ]);
    const form = await new EditSectionMenuHandler().handle(input("form"));
    expect(form.turn.suggested_options.map((o) => o.option_key)).toEqual(
      RESUME_SECTIONS.map((s) => s.key),
    );
  });

  it("an unreadable résumé read fails open to the six sections", async () => {
    const broken = {
      history: vi.fn(async () => {
        throw new Error("db down");
      }),
    };
    const { turn } = await new EditSectionMenuHandler(broken as never).handle(input("form"));
    expect(turn.suggested_options.map((o) => o.option_key)).toEqual(
      RESUME_SECTIONS.map((s) => s.key),
    );
  });
});
