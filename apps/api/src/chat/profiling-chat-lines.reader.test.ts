import { describe, expect, it } from "vitest";
import { uuidSchema } from "@badabhai/validators";
import { TTS_TEXT_ENTRIES } from "../profiling/question-tts-text";
import {
  opaqueLineId,
  chatsTheWorkerSpokeIn,
  displayText,
  lineOfRow,
  linesOfBuffer,
  PROFILING_CHAT_LINES_MAX,
  ProfilingChatLinesReader,
  type ProfilingChatLine,
  type ProfilingChatRow,
} from "./profiling-chat-lines.reader";

const WORKER = "11111111-1111-4111-8111-111111111111";
const ENDED = "22222222-2222-4222-8222-222222222222";
const LIVE = "33333333-3333-4333-8333-333333333333";
const SINCE = new Date("2026-10-14T00:00:00.000Z");
const at = (iso: string) => new Date(iso);
const TILE = { title: "Story", url: "https://www.thehindu.com/news/a", site: "thehindu.com" };

function row(over: Partial<ProfilingChatRow> = {}): ProfilingChatRow {
  return {
    id: "44444444-4444-4444-8444-444444444444",
    sessionId: ENDED,
    direction: "inbound",
    bodyText: "CNC operator",
    metadata: {},
    createdAt: at("2026-10-20T10:00:00.000Z"),
    ...over,
  };
}

function buffer(workerId: string, messages: unknown[]): string {
  return JSON.stringify({ workerId, turnCount: 1, captured: {}, roleFamily: "x", messages });
}

/**
 * A drizzle stand-in: each `select()` answers the next scripted result (rows, or an Error to
 * reject with) once its chain is awaited at `.limit()`. The reader runs the stored-row read
 * first, then the live-session read.
 */
function fakeDb(answers: Array<readonly unknown[] | Error>) {
  return {
    select: () => {
      const answer = answers.shift() ?? [];
      const chain = {
        from: () => chain,
        innerJoin: () => chain,
        where: () => chain,
        orderBy: () => chain,
        limit: () => (answer instanceof Error ? Promise.reject(answer) : Promise.resolve(answer)),
      };
      return chain;
    },
  };
}

function reader(opts: {
  rows?: readonly ProfilingChatRow[];
  live?: readonly string[];
  dbThrows?: boolean;
  redis?: Record<string, string> | "hangs";
  killSwitch?: boolean;
}) {
  const db = fakeDb(
    opts.dbThrows
      ? [new Error("db down"), []]
      : [[...(opts.rows ?? [])].reverse(), (opts.live ?? []).map((id) => ({ id }))],
  );
  const redis = opts.redis ?? {};
  const queue = {
    client:
      redis === "hangs"
        ? new Promise(() => undefined)
        : Promise.resolve({ mget: async (...keys: string[]) => keys.map((k) => redis[k] ?? null) }),
  };
  return new ProfilingChatLinesReader(
    { CHAT_FREE_CHAT_DISABLED: opts.killSwitch ?? false } as never,
    db as never,
    queue as never,
  );
}

describe("ProfilingChatLinesReader.since (#2391)", () => {
  it("stored rows, oldest first, with a live session's buffer in place of its rows", async () => {
    const r = reader({
      rows: [
        row({ id: "44444444-4444-4444-8444-444444444441", direction: "outbound", bodyText: "Aap kaun sa kaam karte hain?", createdAt: at("2026-10-20T09:59:00.000Z") }),
        row(),
        row({ id: "44444444-4444-4444-8444-444444444449", sessionId: LIVE, bodyText: "stale", createdAt: at("2026-10-21T08:00:00.000Z") }),
      ],
      live: [LIVE],
      redis: {
        [`chat:transcript:${LIVE}`]: buffer(WORKER, [
          { role: "assistant", text: "Kitne saal?", at: "2026-10-21T09:00:00.000Z", voiceNoteId: null },
          { role: "worker", text: "5", at: "2026-10-21T09:00:10.000Z", voiceNoteId: null },
        ]),
      },
    });
    const read = await r.since(WORKER, SINCE);
    if (!read.ok) throw new Error("expected ok");
    expect(read.value.map((l) => [l.sessionId, l.role, l.text])).toEqual([
      [ENDED, "bada_bhai", "Aap kaun sa kaam karte hain?"],
      [ENDED, "worker", "CNC operator"],
      [LIVE, "bada_bhai", "Kitne saal?"],
      [LIVE, "worker", "5"],
    ]);
  });

  it("a live line older than the window is left out", async () => {
    const r = reader({
      live: [LIVE],
      redis: {
        [`chat:transcript:${LIVE}`]: buffer(WORKER, [
          { role: "worker", text: "old", at: "2026-10-01T09:00:00.000Z" },
          { role: "worker", text: "new", at: "2026-10-20T09:00:00.000Z" },
        ]),
      },
    });
    const read = await r.since(WORKER, SINCE);
    expect(read.ok && read.value.map((l) => l.text)).toEqual(["new"]);
  });

  it("says when the window held more than it returned (the stored read hit its limit)", async () => {
    const few = await reader({ rows: [row()] }).since(WORKER, SINCE);
    expect(few.ok && few.truncated).toBe(false);
    const full = Array.from({ length: PROFILING_CHAT_LINES_MAX }, (_, i) =>
      row({ id: opaqueLineId(`r${i}`), createdAt: new Date(Date.parse("2026-10-20T00:00:00.000Z") + i * 1_000) }),
    );
    const capped = await reader({ rows: full }).since(WORKER, SINCE);
    expect(capped.ok && capped.truncated).toBe(true);
  });

  it("a database failure is `ok: false` (unknown), never an empty chat", async () => {
    expect(await reader({ dbThrows: true }).since(WORKER, SINCE)).toEqual({ ok: false });
  });

  it("a Redis that never answers costs only the live lines (the deadline), never the open", async () => {
    const r = reader({ rows: [row()], live: [LIVE], redis: "hangs" });
    const read = await r.since(WORKER, SINCE);
    expect(read.ok && read.value.map((l) => l.text)).toEqual(["CNC operator"]);
  });

  it("no live session: Redis is never asked", async () => {
    const r = reader({ rows: [row()], redis: "hangs" });
    const read = await r.since(WORKER, SINCE);
    expect(read.ok && read.value).toHaveLength(1);
  });

  it("news tiles ride a Bada Bhai row, and are dropped under the free chat's kill switch", async () => {
    const reply = row({ direction: "outbound", bodyText: "Yeh rahi khabar", metadata: { news_links: [TILE] } });
    const on = await reader({ rows: [row({ createdAt: at("2026-10-20T09:00:00.000Z") }), reply] }).since(WORKER, SINCE);
    expect(on.ok && on.value[1]?.newsLinks).toEqual([TILE]);
    const off = await reader({ rows: [row({ createdAt: at("2026-10-20T09:00:00.000Z") }), reply], killSwitch: true }).since(WORKER, SINCE);
    expect(off.ok && off.value[1]).not.toHaveProperty("newsLinks");
  });
});

describe("the redraw rules", () => {
  it("strips the persona's vocative and any other template token; the worker's words stay as typed", () => {
    expect(displayText("{{worker_name}} ji, Namaste")).toBe("Namaste");
    expect(displayText("{{ worker_name }}, kaam?")).toBe("kaam?");
    expect(displayText("Haan {{other}} bilkul")).toBe("Haan  bilkul");
    expect(lineOfRow(row({ bodyText: "  mera naam {{worker_name}}  " }), true)?.text).toBe(
      "mera naam {{worker_name}}",
    );
  });

  it("a row with nothing to show is no line: null body, blank, or a name-only vocative", () => {
    expect(lineOfRow(row({ bodyText: null }), true)).toBeNull();
    expect(lineOfRow(row({ bodyText: "   " }), true)).toBeNull();
    expect(lineOfRow(row({ direction: "outbound", bodyText: "{{worker_name}} ji, " }), true)).toBeNull();
  });

  it("a reviewed Bada Bhai line carries its Devanagari twin; a worker line never does", () => {
    const [roman, devanagari] = TTS_TEXT_ENTRIES[0]!;
    expect(lineOfRow(row({ direction: "outbound", bodyText: roman }), true)?.ttsText).toBe(
      displayText(devanagari),
    );
    expect(lineOfRow(row({ bodyText: roman }), true)).not.toHaveProperty("ttsText");
  });

  it("a buffer that is absent, unreadable or another worker's gives no lines; a bad line is dropped alone", () => {
    expect(linesOfBuffer(null, WORKER, LIVE, true)).toEqual([]);
    expect(linesOfBuffer("{not json", WORKER, LIVE, true)).toEqual([]);
    expect(linesOfBuffer(buffer("someone-else", [{ role: "worker", text: "x", at: "2026-10-20T00:00:00Z" }]), WORKER, LIVE, true)).toEqual([]);
    const lines = linesOfBuffer(
      buffer(WORKER, [
        { role: "worker", text: "ok", at: "2026-10-20T00:00:00.000Z" },
        { role: "system", text: "?", at: "2026-10-20T00:00:01.000Z" },
        { role: "worker", text: "bad time", at: "yesterday" },
        { role: "assistant", text: "Khabar", at: "2026-10-20T00:00:02.000Z", newsLinks: [TILE] },
      ]),
      WORKER,
      LIVE,
      true,
    );
    expect(lines.map((l) => [l.role, l.text])).toEqual([
      ["worker", "ok"],
      ["bada_bhai", "Khabar"],
    ]);
    expect(lines[1]?.newsLinks).toEqual([TILE]);
  });

  it("a line's id is an opaque, stable uuid — never the row id it came from", () => {
    const id = opaqueLineId("chat-message:a");
    expect(uuidSchema.safeParse(id).success).toBe(true);
    expect(opaqueLineId("chat-message:a")).toBe(id);
    expect(opaqueLineId("chat-message:b")).not.toBe(id);
    const ROW = "44444444-4444-4444-8444-444444444444";
    const line = lineOfRow(row({ id: ROW }), true);
    expect(line?.id).not.toBe(ROW);
    expect(line?.id).toBe(opaqueLineId(`chat-message:${ROW}`));
    const buffered = linesOfBuffer(
      buffer(WORKER, [{ role: "worker", text: "ok", at: "2026-10-20T00:00:00.000Z" }]),
      WORKER,
      LIVE,
      true,
    );
    expect(buffered[0]?.id).toBe(opaqueLineId(`chat-transcript-line:${LIVE}:0`));
  });

  it("the vocative's `ji` is a whole word — a word that merely starts with it is kept", () => {
    expect(displayText("{{worker_name}} jitne saal?")).toBe("jitne saal?");
    expect(displayText("{{worker_name}} ji batao")).toBe("batao");
  });

  it("a chat the worker never spoke in is left out; one they did keeps every line", () => {
    const line = (sessionId: string, role: ProfilingChatLine["role"]): ProfilingChatLine => ({
      id: opaqueLineId(`${sessionId}:${role}`),
      sessionId,
      role,
      text: role,
      createdAt: SINCE,
    });
    expect(
      chatsTheWorkerSpokeIn([line(ENDED, "bada_bhai"), line(LIVE, "bada_bhai"), line(LIVE, "worker")]).map(
        (l) => [l.sessionId, l.role],
      ),
    ).toEqual([
      [LIVE, "bada_bhai"],
      [LIVE, "worker"],
    ]);
  });
});
