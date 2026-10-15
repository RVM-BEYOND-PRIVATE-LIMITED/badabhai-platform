import { describe, expect, it } from "vitest";
import {
  RESUME_MENU_CHAT_CREATE_KEY,
  RESUME_MENU_REDO_LABEL,
  RESUME_MENU_UPLOAD_KEY,
  resolveResumeMenu,
} from "../chat/resume-menu";
import { FREE_CHAT_COPY } from "../profiling/free-chat/free-chat.copy";
import { CompanionTurnSchema } from "./chat-companion.dto";
import { CTX, makeCompanionServiceForV2, NOW, SUBMISSION, WORKER } from "./chat-companion.v2.fake";
import {
  RESUME_MENU_FORM_ACK,
  RESUME_MENU_FORM_CREATE_KEY,
  RESUME_MENU_FORM_CREATE_LABEL,
} from "./companion-v3-keys";

/**
 * ADR-0055 (#2275) — the SERVICE's share of the free-chat brain: the distress word list BEFORE the
 * cool-down and the v1 resolver, the form road's chip, and the redo menu that offers it — each
 * gated on the brain, so the kill switch (`CHAT_FREE_CHAT_DISABLED`) is today's flow byte for byte.
 */

const BRAIN = { v2: true, killSwitch: false } as const;
const KILL_SWITCH = { v2: true, killSwitch: true } as const;

const message = async (h: ReturnType<typeof makeCompanionServiceForV2>, text: string) => {
  const result = await h.svc.message(
    WORKER,
    { text, submission_id: SUBMISSION },
    CTX as never,
    NOW,
  );
  if (result.mode !== "companion") throw new Error("expected companion");
  return result.turn;
};

describe("the distress word list runs BEFORE the v1 resolver (and the cool-down)", () => {
  it.each([
    // A strong jobs word v1 would answer with job chips — and a distress phrase.
    "job nahi mili, marna chahta hoon",
    "naukri nahi mili ab suicide kar lunga",
    "resume se kuch nahi hua, jeene ka mann nahi",
  ])("%j → the helpline, never v1's answer", async (text) => {
    const h = makeCompanionServiceForV2(BRAIN);
    const turn = await message(h, text);
    expect(h.v2.handleDistress).toHaveBeenCalledWith(
      WORKER,
      { text, submission_id: SUBMISSION },
      CTX,
      NOW,
    );
    expect(turn.reply).toBe(FREE_CHAT_COPY.DISTRESS.latin);
    expect(turn.suggested_options).toEqual([]);
    // v1 never answered: no v1 event, no jobs read, no classifier route.
    expect(h.events.emit).not.toHaveBeenCalled();
    expect(h.jobs.searchOpenPostings).not.toHaveBeenCalled();
    expect(h.v2.handleMessage).not.toHaveBeenCalled();
  });

  it("a distress message during a faltu cool-down gets the helpline, never the cool-down line", async () => {
    const h = makeCompanionServiceForV2({
      ...BRAIN,
      faltu: true,
      cooling: "2026-09-26T10:30:00.000Z",
    });
    await message(h, "marna chahta hoon");
    expect(h.v2.handleDistress).toHaveBeenCalledTimes(1);
    expect(h.v2.handleCooldown).not.toHaveBeenCalled();
    expect(h.v2.cooldownUntil).not.toHaveBeenCalled();
  });

  it("a distress message never consumes the one-shot pending intent (route precedence)", async () => {
    const h = makeCompanionServiceForV2({
      ...BRAIN,
      precedence: true,
      pendingIntent: "edit_resume",
    });
    await message(h, "marna chahta hoon");
    expect(h.v2.takePendingIntent).not.toHaveBeenCalled();
    expect(h.v2.handleDirectIntent).not.toHaveBeenCalled();
  });

  it("KILL SWITCH ON: no word-list route — the same text is v1's, as today", async () => {
    const h = makeCompanionServiceForV2(KILL_SWITCH);
    await message(h, "job nahi mili, marna chahta hoon");
    expect(h.v2.handleDistress).not.toHaveBeenCalled();
    expect(
      (h.events.emit.mock.calls[0]![0] as { payload: { intent: string } }).payload.intent,
    ).toBe("jobs");
  });

  it("v2 OFF: no word-list route either — v1 is the ADR-0044 tab, untouched", async () => {
    const h = makeCompanionServiceForV2({ v2: false, killSwitch: false });
    await message(h, "marna chahta hoon");
    expect(h.v2.handleDistress).not.toHaveBeenCalled();
  });

  it("an ordinary v1 miss still goes to the orchestrator on the brain", async () => {
    const h = makeCompanionServiceForV2(BRAIN);
    await message(h, "welder ki salary kitni hoti hai");
    expect(h.v2.handleDistress).not.toHaveBeenCalled();
    expect(h.v2.handleMessage).toHaveBeenCalledTimes(1);
  });
});

describe("a bare greeting (#2287) — after the chips, distress and the cool-down", () => {
  it("is answered by the greeting route on the brain", async () => {
    const h = makeCompanionServiceForV2(BRAIN);
    await message(h, "Namaste ji");
    expect(h.v2.handleGreeting).toHaveBeenCalledWith(
      WORKER,
      { text: "Namaste ji", submission_id: SUBMISSION },
      CTX,
      NOW,
    );
    expect(h.v2.handleMessage).not.toHaveBeenCalled();
    expect(h.events.emit).not.toHaveBeenCalled();
  });

  it("during a faltu cool-down it gets the cool-down line, not the greeting", async () => {
    const h = makeCompanionServiceForV2({
      ...BRAIN,
      faltu: true,
      cooling: "2026-09-26T10:30:00.000Z",
    });
    await message(h, "hello");
    expect(h.v2.handleCooldown).toHaveBeenCalledTimes(1);
    expect(h.v2.handleGreeting).not.toHaveBeenCalled();
  });

  it("KILL SWITCH ON: never the greeting route", async () => {
    const h = makeCompanionServiceForV2(KILL_SWITCH);
    await message(h, "hello");
    expect(h.v2.handleGreeting).not.toHaveBeenCalled();
  });
});

describe("the redo menu offers the form road on the brain", () => {
  it("'Apna resume dobara banayein' → upload · form · chat", async () => {
    const h = makeCompanionServiceForV2(BRAIN);
    const turn = await message(h, RESUME_MENU_REDO_LABEL);
    expect(turn.suggested_options.map((o) => o.option_key)).toEqual([
      RESUME_MENU_UPLOAD_KEY,
      RESUME_MENU_FORM_CREATE_KEY,
      RESUME_MENU_CHAT_CREATE_KEY,
    ]);
    expect(turn.suggested_followups).toEqual([
      "Resume upload karein",
      RESUME_MENU_FORM_CREATE_LABEL,
      "Chat se resume banayein",
    ]);
    expect(CompanionTurnSchema.safeParse(turn).success).toBe(true);
  });

  it("KILL SWITCH ON: the shipped redo menu, byte for byte", async () => {
    const turn = await message(makeCompanionServiceForV2(KILL_SWITCH), RESUME_MENU_REDO_LABEL);
    const shipped = resolveResumeMenu(RESUME_MENU_REDO_LABEL);
    expect(turn.suggested_followups).toEqual(shipped.followups);
    expect(turn.suggested_options).toEqual(shipped.options);
  });
});

describe("'Form se resume banayein' posted back as text", () => {
  it.each([
    RESUME_MENU_FORM_CREATE_LABEL,
    RESUME_MENU_FORM_CREATE_KEY,
    "  form se RESUME banayein. ",
  ])("%j → the form ack, no chips, recorded as the résumé menu", async (text) => {
    const h = makeCompanionServiceForV2(BRAIN);
    const turn = await message(h, text);
    expect(turn.reply).toBe(RESUME_MENU_FORM_ACK);
    expect(turn.suggested_options).toEqual([]);
    expect(turn.question_kind).toBe("close");
    expect(
      (h.events.emit.mock.calls[0]![0] as { payload: { intent: string } }).payload.intent,
    ).toBe("resume_menu");
    expect(h.v2.handleMessage).not.toHaveBeenCalled();
  });

  it("is a CHIP: a faltu cool-down never gates it", async () => {
    const h = makeCompanionServiceForV2({
      ...BRAIN,
      faltu: true,
      cooling: "2026-09-26T10:30:00.000Z",
    });
    const turn = await message(h, RESUME_MENU_FORM_CREATE_LABEL);
    expect(turn.reply).toBe(RESUME_MENU_FORM_ACK);
    expect(h.v2.cooldownUntil).not.toHaveBeenCalled();
  });

  it("KILL SWITCH ON: the label is typed text, answered by v1 as before the chip existed", async () => {
    const h = makeCompanionServiceForV2(KILL_SWITCH);
    const turn = await message(h, RESUME_MENU_FORM_CREATE_LABEL);
    expect(turn.reply).not.toBe(RESUME_MENU_FORM_ACK);
    const baseline = await message(
      makeCompanionServiceForV2({ v2: false }),
      RESUME_MENU_FORM_CREATE_LABEL,
    );
    expect(turn).toEqual(baseline);
  });
});

describe("the companion turn DTO carries `news_links` (ADR-0054 tiles on the companion)", () => {
  const base = {
    mode: "companion",
    reply: "Pune mein ek nayi factory khul rahi hai.",
    read_aloud: false,
    blocked: false,
    is_mock: false,
    suggested_followups: [],
    suggested_options: [],
    question_kind: "close",
  };
  const LINK = {
    title: "New factory in Pune",
    url: "https://www.thehindu.com/x",
    site: "thehindu.com",
  };

  it("accepts 1-3 tiles, and a turn with none (absent)", () => {
    expect(CompanionTurnSchema.safeParse({ ...base, news_links: [LINK] }).success).toBe(true);
    expect(CompanionTurnSchema.safeParse({ ...base, news_links: [LINK, LINK, LINK] }).success).toBe(
      true,
    );
    expect(CompanionTurnSchema.safeParse(base).success).toBe(true);
  });

  it("refuses an empty list, a fourth tile and a non-URL", () => {
    expect(CompanionTurnSchema.safeParse({ ...base, news_links: [] }).success).toBe(false);
    expect(
      CompanionTurnSchema.safeParse({ ...base, news_links: [LINK, LINK, LINK, LINK] }).success,
    ).toBe(false);
    expect(
      CompanionTurnSchema.safeParse({ ...base, news_links: [{ ...LINK, url: "not a url" }] })
        .success,
    ).toBe(false);
  });
});
