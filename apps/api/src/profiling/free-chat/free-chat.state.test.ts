import { describe, expect, it } from "vitest";

import {
  canEnter,
  carriesFreeChatLock,
  coolingDown,
  enterMode,
  FREE_CHAT_COOLDOWN_MS,
  greetingState,
  narrowFreeChat,
  readFreeChatLock,
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
    });
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
