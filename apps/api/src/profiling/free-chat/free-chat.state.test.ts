import { describe, expect, it } from "vitest";

import {
  canEnter,
  carriesFreeChatLock,
  coolingDown,
  enterMode,
  FREE_CHAT_COOLDOWN_MS,
  FREE_CHAT_LANGUAGE_KEY,
  freeChatLanguageRecord,
  greetingState,
  keptLanguageOf,
  lapsedOf,
  narrowFreeChat,
  pendingKeyOf,
  readFreeChatLanguage,
  readFreeChatLanguageValue,
  readFreeChatLock,
  storedFreeChatLock,
  registerStrike,
  toFreeChatStatePatch,
  type FreeChatState,
} from "./free-chat.state";

/**
 * The free chat's state, pure (ADR-0051 §3.1). The mode machine is the lock (R5): nothing leaves
 * résumé mode. The strikes are R13's three-a-day. The narrower fails toward "no mode yet" — today's
 * interview — and the lock patch is the one durable fact, absent everywhere else.
 */

const T0 = new Date("2026-10-06T10:00:00.000Z");

describe("the mode machine — the lock has no way out", () => {
  it.each([
    [null, "greeting", true],
    [null, "resume", true],
    [null, "free", false],
    ["greeting", "free", true],
    ["greeting", "resume", true],
    ["free", "resume", true],
    ["free", "greeting", false],
    ["resume", "free", false],
    ["resume", "greeting", false],
    ["resume", "resume", false],
  ] as const)("%s → %s allowed: %s", (from, to, allowed) => {
    expect(canEnter(from, to)).toBe(allowed);
  });

  it("entering résumé mode stamps the lock time ONCE and clears the held turn", () => {
    const free = enterMode(greetingState(), "free", "chip", T0);
    const later = new Date(T0.getTime() + 60_000);
    const locked = enterMode({ ...free, held: null }, "resume", "classifier", later);
    expect(locked).toMatchObject({
      mode: "resume",
      trigger: "classifier",
      lockedAt: later.toISOString(),
    });
    // A transition the machine refuses returns the state unchanged — never a throw on the turn.
    expect(enterMode(locked, "free", "chip", T0)).toBe(locked);
  });

  it("carries the counters across a transition — a strike in free mode is still a strike", () => {
    const struck = registerStrike(enterMode(greetingState(), "free", "chip", T0), T0).state;
    expect(enterMode(struck, "resume", "chip", T0).strikes).toEqual({
      day: "2026-10-06",
      count: 1,
    });
  });
});

describe("trash strikes and the cool-down (R13)", () => {
  const free = enterMode(greetingState(), "free", "chip", T0);

  it("the third strike of a UTC day starts a 30-minute cool-down", () => {
    let state: FreeChatState = free;
    const outcomes = [1, 2, 3].map(() => {
      const out = registerStrike(state, T0);
      state = out.state;
      return [out.count, out.cooldownStarted];
    });
    expect(outcomes).toEqual([
      [1, false],
      [2, false],
      [3, true],
    ]);
    expect(state.cooldownUntil).toBe(new Date(T0.getTime() + FREE_CHAT_COOLDOWN_MS).toISOString());
    expect(coolingDown(state, new Date(T0.getTime() + FREE_CHAT_COOLDOWN_MS - 1))).toBe(true);
    expect(coolingDown(state, new Date(T0.getTime() + FREE_CHAT_COOLDOWN_MS))).toBe(false);
  });

  it("a new UTC day starts the tally again", () => {
    const yesterday = registerStrike(registerStrike(free, T0).state, T0).state;
    const tomorrow = new Date("2026-10-07T00:00:01.000Z");
    expect(registerStrike(yesterday, tomorrow)).toMatchObject({ count: 1, cooldownStarted: false });
  });
});

describe("narrowFreeChat — read back field by field, failing toward 'no mode yet'", () => {
  it("round-trips a full state through JSON", () => {
    const state: FreeChatState = {
      mode: "resume",
      trigger: "chip",
      lockedAt: T0.toISOString(),
      strikes: { day: "2026-10-06", count: 2 },
      cooldownUntil: T0.toISOString(),
      casualReplies: 3,
      asides: 9,
      held: {
        reply: "Aap kaunsa kaam karte hain?",
        kind: "ask",
        questionKey: "primary_trade",
        options: [],
        answerType: "text",
        whyText: null,
        inputMode: "text",
      },
      clarifiedFor: "key:primary_trade",
      deflected: { key: "key:primary_trade", count: 1 },
      deescalated: { key: "key:primary_trade", count: 2 },
      chipNoOps: { key: "key:primary_trade", count: 1 },
    };
    expect(narrowFreeChat(JSON.parse(JSON.stringify(state)))).toEqual(state);
  });

  it.each([null, undefined, 7, "resume", {}, { mode: "chatting" }])(
    "an unreadable value %j is null — the session is stamped résumé mode on its next turn",
    (value) => {
      expect(narrowFreeChat(value)).toBeNull();
    },
  );

  it("clamps counters, drops a malformed day, and keeps a held turn only in résumé mode", () => {
    const narrowed = narrowFreeChat({
      mode: "free",
      trigger: "nonsense",
      strikes: { day: "yesterday", count: -4 },
      casualReplies: -1,
      asides: 2.7,
      lockedAt: "not a date",
      held: {
        reply: "x",
        kind: "ask",
        questionKey: null,
        options: [],
        answerType: null,
        whyText: null,
        inputMode: "text",
      },
    });
    expect(narrowed).toEqual({
      mode: "free",
      trigger: null,
      lockedAt: null,
      strikes: { day: null, count: 0 },
      cooldownUntil: null,
      casualReplies: 0,
      asides: 2,
      held: null,
      clarifiedFor: null,
      deflected: null,
      deescalated: null,
      chipNoOps: null,
    });
  });
});

describe("the deflect count — narrowed, keyed, and back-compatible", () => {
  const resume = enterMode(null, "resume", "chip", T0);

  it("reads ABSENT (an envelope written before the field) as null", () => {
    const { deflected: _gone, ...older } = resume;
    expect(narrowFreeChat(JSON.parse(JSON.stringify(older)))?.deflected).toBeNull();
  });

  it("drops a count with no key, clamps a negative count, and keeps it only in résumé mode", () => {
    expect(narrowFreeChat({ ...resume, deflected: { count: 2 } })?.deflected).toBeNull();
    expect(
      narrowFreeChat({ ...resume, deflected: { key: "key:q", count: -3 } })?.deflected,
    ).toEqual({
      key: "key:q",
      count: 0,
    });
    expect(
      narrowFreeChat({ ...greetingState(), deflected: { key: "key:q", count: 1 } })?.deflected,
    ).toBeNull();
  });

  it("keys a pending question by its pack key, else by its exact text", () => {
    expect(
      pendingKeyOf({ questionKey: "primary_trade", reply: "Aap kaunsa kaam karte hain?" }),
    ).toBe("key:primary_trade");
    expect(pendingKeyOf({ questionKey: null, reply: "Theek hai." })).toBe("text:Theek hai.");
  });
});

describe("storedFreeChatLock — the row's own lock, kept whatever its shape", () => {
  it("spreads the raw stored value, and nothing when the row has none", () => {
    expect(storedFreeChatLock({ free_chat_lock: { v: 1, locked_at: T0.toISOString() } })).toEqual({
      free_chat_lock: { v: 1, locked_at: T0.toISOString() },
    });
    expect(storedFreeChatLock({ free_chat_lock: { v: 9 } })).toEqual({ free_chat_lock: { v: 9 } });
    expect(storedFreeChatLock({ turn_count: 3 })).toEqual({});
    expect(storedFreeChatLock(null)).toEqual({});
  });
});

describe("the durable lock — chat_sessions.conversation_state.free_chat_lock", () => {
  it("is patched ONLY in résumé mode, and ABSENT (never null) everywhere else", () => {
    expect(toFreeChatStatePatch({ freeChat: null })).toEqual({});
    expect(toFreeChatStatePatch({})).toEqual({});
    expect(toFreeChatStatePatch({ freeChat: greetingState() })).toEqual({});
    const locked = enterMode(greetingState(), "resume", "chip", T0);
    expect(toFreeChatStatePatch({ freeChat: locked })).toEqual({
      free_chat_lock: { v: 1, locked_at: T0.toISOString() },
    });
  });

  it("reads back strictly, and tells presence from parse", () => {
    const state = { free_chat_lock: { v: 1, locked_at: T0.toISOString() } };
    expect(readFreeChatLock(state)).toEqual({ v: 1, locked_at: T0.toISOString() });
    expect(readFreeChatLock({ free_chat_lock: { v: 2 } })).toBeNull();
    expect(readFreeChatLock(null)).toBeNull();
    // A lock a later build shaped differently still COUNTS — the safe side.
    expect(carriesFreeChatLock({ free_chat_lock: { v: 2 } })).toBe(true);
    expect(carriesFreeChatLock({ turn_count: 3 })).toBe(false);
    expect(carriesFreeChatLock(null)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// ADR-0051 §11 — the reply language in the envelope, and its durable record
// ---------------------------------------------------------------------------

describe("the reply language in the envelope (ADR-0051 §11)", () => {
  const free = enterMode(greetingState(), "free", "chip", T0);

  it("round-trips the kept language, a pending offer and the previous reply's category", () => {
    const state: FreeChatState = {
      ...free,
      language: { kept: "tamil", offer: "marathi" },
      lastReplyCategory: "career",
    };
    expect(narrowFreeChat(JSON.parse(JSON.stringify(state)))).toEqual(state);
  });

  it("an envelope written BEFORE §11 parses as no kept language and no offer — no new key at all", () => {
    const older = JSON.parse(JSON.stringify(free)) as Record<string, unknown>;
    expect("language" in older).toBe(false);
    const narrowed = narrowFreeChat(older)!;
    expect("language" in narrowed).toBe(false);
    expect("lastReplyCategory" in narrowed).toBe(false);
    expect(keptLanguageOf(narrowed)).toBeNull();
    expect(keptLanguageOf(null)).toBeNull();
  });

  it("fails soft: an unreadable kept language is none; an offer and a category only in free mode", () => {
    expect(narrowFreeChat({ ...free, language: { kept: "klingon" } })?.language).toBeUndefined();
    expect(narrowFreeChat({ ...free, language: "marathi" })?.language).toBeUndefined();
    expect(narrowFreeChat({ ...free, language: { kept: null, offer: "x" } })?.language).toEqual({
      kept: null,
    });
    expect(
      narrowFreeChat({ ...free, lastReplyCategory: "jobs" })?.lastReplyCategory,
    ).toBeUndefined();
    const greeting = { ...greetingState(), language: { kept: "tamil", offer: "marathi" } };
    expect(narrowFreeChat(greeting)?.language).toEqual({ kept: "tamil" });
    const resume = {
      ...enterMode(null, "resume", "chip", T0),
      language: { kept: "tamil", offer: "marathi" },
      lastReplyCategory: "casual",
    };
    expect(narrowFreeChat(resume)?.language).toEqual({ kept: "tamil" });
    expect(narrowFreeChat(resume)?.lastReplyCategory).toBeUndefined();
  });

  it("the greeting holds the language the worker last kept — and is byte-identical without one", () => {
    expect(greetingState("marathi").language).toEqual({ kept: "marathi" });
    expect(keptLanguageOf(greetingState("marathi"))).toBe("marathi");
    expect("language" in greetingState()).toBe(false);
    expect(greetingState(null)).toEqual(greetingState());
  });

  it("lapsedOf drops the offer and the previous category — the kept language stays", () => {
    const pending: FreeChatState = {
      ...free,
      language: { kept: "tamil", offer: "marathi" },
      lastReplyCategory: "casual",
    };
    const lapsed = lapsedOf(pending);
    expect(lapsed.language).toEqual({ kept: "tamil" });
    expect("lastReplyCategory" in lapsed).toBe(false);
    expect("language" in lapsedOf(free)).toBe(false);
  });

  it("a mode change lets a pending offer lapse and keeps the kept language", () => {
    const pending: FreeChatState = { ...free, language: { kept: "tamil", offer: "marathi" } };
    expect(enterMode(pending, "resume", "chip", T0).language).toEqual({ kept: "tamil" });
  });

  it("what the previous turn served round-trips in greeting and free mode, and lasts one message", () => {
    for (const lastServed of ["answered", "distress", "other"] as const) {
      const state: FreeChatState = { ...free, lastServed };
      expect(narrowFreeChat(JSON.parse(JSON.stringify(state)))).toEqual(state);
    }
    // The distress line at the greeting is read there too.
    expect(narrowFreeChat({ ...greetingState(), lastServed: "distress" })?.lastServed).toBe(
      "distress",
    );
    // Unreadable, older, or in résumé mode: absent ("other").
    expect("lastServed" in narrowFreeChat({ ...free, lastServed: "panic" })!).toBe(false);
    expect("lastServed" in narrowFreeChat(JSON.parse(JSON.stringify(free)))!).toBe(false);
    const resume = { ...enterMode(null, "resume", "chip", T0), lastServed: "distress" };
    expect(narrowFreeChat(resume)?.lastServed).toBeUndefined();
    expect("lastServed" in lapsedOf({ ...free, lastServed: "distress" })).toBe(false);
  });
});

describe("the kept language's durable record — conversation_state.free_chat_language", () => {
  const SESSION = "33333333-3333-4333-8333-333333333333";

  it("is built set now, on this session — a decline is a null language, a SET value", () => {
    expect(freeChatLanguageRecord("marathi", T0, SESSION)).toEqual({
      v: 1,
      language: "marathi",
      set_at: T0.toISOString(),
      session_id: SESSION,
    });
    expect(freeChatLanguageRecord(null, T0, SESSION).language).toBeNull();
  });

  it("reads back strictly, failing soft to null", () => {
    const record = freeChatLanguageRecord("tamil", T0, SESSION);
    expect(readFreeChatLanguage({ turn_count: 2, [FREE_CHAT_LANGUAGE_KEY]: record })).toEqual(
      record,
    );
    expect(readFreeChatLanguageValue(freeChatLanguageRecord(null, T0, SESSION))).toEqual({
      v: 1,
      language: null,
      set_at: T0.toISOString(),
      session_id: SESSION,
    });
    expect(readFreeChatLanguageValue({ ...record, v: 2 })).toBeNull();
    expect(readFreeChatLanguageValue({ ...record, language: "klingon" })).toBeNull();
    expect(readFreeChatLanguageValue({ ...record, extra: true })).toBeNull();
    expect(readFreeChatLanguageValue({ ...record, set_at: "yesterday" })).toBeNull();
    expect(readFreeChatLanguage({ turn_count: 2 })).toBeNull();
    expect(readFreeChatLanguage(null)).toBeNull();
  });

  it("is never part of the envelope's lock patch — only the merge writes it", () => {
    const pending: FreeChatState = {
      ...enterMode(greetingState(), "resume", "chip", T0),
      language: { kept: "tamil" },
    };
    expect(Object.keys(toFreeChatStatePatch({ freeChat: pending }))).toEqual(["free_chat_lock"]);
  });
});
