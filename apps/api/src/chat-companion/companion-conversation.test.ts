import { describe, expect, it } from "vitest";
import type { ProfilingChatLine } from "../chat/profiling-chat-lines.reader";
import {
  COMPANION_CONVERSATION_MAX,
  CompanionConversationSchema,
  type CompanionHistoryItem,
} from "./chat-companion.dto";
import {
  composeConversation,
  withoutStoredRecap,
  type ConversationSources,
} from "./companion-conversation";

const FIRST = "11111111-1111-4111-8111-111111111111";
const REDO = "22222222-2222-4222-8222-222222222222";
const T0 = Date.parse("2026-10-15T10:00:00.000Z");
const MIN = 60_000;

const RECAP = {
  suggested_options: [{ option_key: "companion_jobs", label_text: "Naye jobs", is_none_of_above: false }],
  suggested_followups: ["Naye jobs"],
};
const MENU = [{ option_key: "resume_menu", label_text: "Resume badlein", is_none_of_above: false }];
const TILE = { title: "Story", url: "https://www.thehindu.com/news/a", site: "thehindu.com" };

let seq = 0;
const uuid = () => `00000000-0000-4000-8000-${String(++seq).padStart(12, "0")}`;

function compose(over: Partial<ConversationSources>) {
  return composeConversation({
    profiling: [],
    profilingTruncated: false,
    chat: [],
    chatTruncated: false,
    recap: RECAP,
    ...over,
  });
}

function said(
  session: string,
  role: ProfilingChatLine["role"],
  text: string,
  minutes: number,
): ProfilingChatLine {
  return { id: uuid(), sessionId: session, role, text, createdAt: new Date(T0 + minutes * MIN) };
}

/** A stored Bada Bhai chat turn: the worker's line, and the reply 1 ms later (`keepTurn`). */
function turn(
  ask: string,
  reply: string,
  minutes: number,
  over: Partial<CompanionHistoryItem> = {},
): CompanionHistoryItem[] {
  const at = T0 + minutes * MIN;
  return [
    { id: uuid(), role: "worker", text: ask, created_at: new Date(at).toISOString() },
    { id: uuid(), role: "bada_bhai", text: reply, created_at: new Date(at + 1).toISOString(), ...over },
  ];
}

/** The recap an open stored as a line of its own before #2391 — always the window's oldest line. */
function storedRecap(minutes: number): CompanionHistoryItem {
  return {
    id: uuid(),
    role: "bada_bhai",
    text: "Aapka resume chat se bana hai.",
    suggested_options: RECAP.suggested_options,
    created_at: new Date(T0 + minutes * MIN).toISOString(),
  };
}

describe("composeConversation (#2391, ADR-0059)", () => {
  it("nothing in the window: no conversation — the app draws the recap", () => {
    expect(compose({})).toBeUndefined();
  });

  it("the profiling chat first, its divider on its last line; the recap's chips while profiling is newest", () => {
    const out = compose({
      profiling: [said(FIRST, "bada_bhai", "Aap kaun sa kaam karte hain?", 0), said(FIRST, "worker", "CNC operator", 1)],
    });
    expect(CompanionConversationSchema.safeParse(out).success).toBe(true);
    expect(out?.messages.map((m) => [m.source, m.role, m.text, m.ends_profiling_chat ?? false])).toEqual([
      ["profiling", "bada_bhai", "Aap kaun sa kaam karte hain?", false],
      ["profiling", "worker", "CNC operator", true],
    ]);
    expect(out?.suggested_options).toEqual(RECAP.suggested_options);
    expect(out?.suggested_followups).toEqual(RECAP.suggested_followups);
  });

  it("a redo sits where it happened: every profiling chat in time order, each with its own divider", () => {
    const out = compose({
      profiling: [
        said(FIRST, "worker", "welder", 0),
        said(FIRST, "bada_bhai", "Shukriya", 1),
        said(REDO, "worker", "fitter", 30),
      ],
      chat: turn("naye jobs", "Yeh rahe jobs", 10, { suggested_options: MENU }),
    });
    expect(out?.messages.map((m) => [m.source, m.text, m.ends_profiling_chat ?? false])).toEqual([
      ["profiling", "welder", false],
      ["profiling", "Shukriya", true],
      ["bada_bhai_chat", "naye jobs", false],
      ["bada_bhai_chat", "Yeh rahe jobs", false],
      ["profiling", "fitter", true],
    ]);
    // A profiling chat is newer than every reply: the recap's chips, not the old reply's.
    expect(out?.suggested_options).toEqual(RECAP.suggested_options);
  });

  it("the Bada Bhai chat is newest: its newest reply's chips, exactly as the history drew them", () => {
    const out = compose({
      profiling: [said(FIRST, "worker", "welder", 0)],
      chat: [
        ...turn("naye jobs", "Yeh rahe jobs", 10, { suggested_options: MENU, suggested_followups: ["Aur"] }),
        // The worker's newest line whose reply is not stored: the newest REPLY's chips still.
        { id: uuid(), role: "worker", text: "aur?", created_at: new Date(T0 + 20 * MIN).toISOString() },
      ],
    });
    expect(out?.suggested_options).toEqual(MENU);
    expect(out?.suggested_followups).toEqual(["Aur"]);
  });

  it("a profiling chat newer than the newest reply wins the chips even when a worker chat line is newest", () => {
    const out = compose({
      profiling: [said(REDO, "worker", "fitter", 15)],
      chat: [
        ...turn("naye jobs", "Yeh rahe jobs", 10, { suggested_options: MENU }),
        { id: uuid(), role: "worker", text: "aur?", created_at: new Date(T0 + 20 * MIN).toISOString() },
      ],
    });
    expect(out?.suggested_options).toEqual(RECAP.suggested_options);
  });

  it("a newest reply without chips shows none — never the recap's", () => {
    const out = compose({
      profiling: [said(FIRST, "worker", "welder", 0)],
      chat: turn("kaise ho", "Main theek hoon.", 10, { read_aloud: false }),
    });
    expect(out?.suggested_options).toEqual([]);
    expect(out?.messages.at(-1)).toMatchObject({ source: "bada_bhai_chat", read_aloud: false });
  });

  it("the recap is never a line: one stored before #2391 heads its window and is left out", () => {
    const chat = [storedRecap(5), ...turn("naye jobs", "Yeh rahe jobs", 10)];
    expect(withoutStoredRecap(chat).map((l) => l.text)).toEqual(["naye jobs", "Yeh rahe jobs"]);
    expect(compose({ chat: [storedRecap(5)] })).toBeUndefined();
    // A turn's reply is never at the head: its worker line comes first, and both are kept.
    expect(withoutStoredRecap(turn("a", "b", 0)).map((l) => l.text)).toEqual(["a", "b"]);
  });

  it("NO GAP: when the chat read was capped, nothing older than its oldest line shows from either source", () => {
    const out = compose({
      profiling: [said(FIRST, "worker", "day-1 chat", 0), said(REDO, "worker", "later chat", 40)],
      chat: [...turn("q1", "a1", 30), ...turn("q2", "a2", 50)],
      chatTruncated: true,
    });
    expect(out?.messages.map((m) => m.text)).toEqual(["q1", "a1", "later chat", "q2", "a2"]);
  });

  it("NO GAP: when the profiling read was capped, older Bada Bhai chat lines are left out too", () => {
    const out = compose({
      profiling: [said(REDO, "worker", "kept", 30)],
      profilingTruncated: true,
      chat: [...turn("old", "older reply", 10), ...turn("new", "newer reply", 40)],
    });
    expect(out?.messages.map((m) => m.text)).toEqual(["kept", "new", "newer reply"]);
  });

  it("an exact tie keeps the profiling line first", () => {
    const [ask] = turn("hi", "hello", 0);
    const out = compose({ profiling: [said(FIRST, "worker", "welder", 0)], chat: [ask!] });
    expect(out?.messages.map((m) => m.source)).toEqual(["profiling", "bada_bhai_chat"]);
  });

  it("a line off the contract is dropped alone, and the divider moves to the last line that shows", () => {
    const good = said(FIRST, "worker", "welder", 0);
    const bad = { ...said(FIRST, "bada_bhai", "x", 1), id: "not-a-uuid" };
    const out = compose({ profiling: [good, bad] });
    expect(out?.messages).toHaveLength(1);
    expect(out?.messages[0]).toMatchObject({ text: "welder", ends_profiling_chat: true });
  });

  it("tiles and the read-aloud twin are carried; a chip never rides a line", () => {
    const line: ProfilingChatLine = { ...said(FIRST, "bada_bhai", "Khabar", 0), ttsText: "खबर", newsLinks: [TILE] };
    const out = compose({
      profiling: [said(FIRST, "worker", "news?", -1), line],
      chat: turn("jobs", "Yeh rahe", 5, { suggested_options: MENU }),
    });
    expect(out?.messages[1]).toMatchObject({ tts_text: "खबर", news_links: [TILE] });
    for (const m of out?.messages ?? []) expect(m).not.toHaveProperty("suggested_options");
  });

  it(`keeps at most ${COMPANION_CONVERSATION_MAX} lines, the newest`, () => {
    const many = Array.from({ length: COMPANION_CONVERSATION_MAX + 5 }, (_, i) =>
      said(FIRST, "worker", `n${i}`, i),
    );
    const out = compose({ profiling: many });
    expect(out?.messages).toHaveLength(COMPANION_CONVERSATION_MAX);
    expect(out?.messages[0]?.text).toBe("n5");
    expect(out?.messages.at(-1)).toMatchObject({
      text: `n${COMPANION_CONVERSATION_MAX + 4}`,
      ends_profiling_chat: true,
    });
    expect(CompanionConversationSchema.safeParse(out).success).toBe(true);
  });
});
