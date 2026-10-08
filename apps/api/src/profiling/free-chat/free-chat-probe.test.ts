import { describe, expect, it } from "vitest";
import type { PayloadOf } from "@badabhai/event-schema";

import {
  FREE_CHAT_PROBE_SAMPLE_MAX,
  ProbeRefusal,
  SAMPLE_SCAN_FACTOR,
  assertReadOnlyTransaction,
  clarifyLoops,
  drawFreeChatSample,
  isStruggledTurn,
  isWorkerMessage,
  parseFreeChatProbeArgs,
  readProbeEvents,
  repeatedOutcome,
  sessionsFreeWithoutResume,
  type LinkRef,
  type LinkResult,
  type ModeChangedEvent,
  type SampleSources,
  type TurnServedEvent,
} from "./free-chat-probe";

/**
 * ADR-0051 §10 (#2128) — the read-only free-chat probe's decisions. Every line of text below is
 * FABRICATED; no real worker message is, or may ever be, a fixture. The mask has its own suite
 * (`free-chat-probe.mask.test.ts`); the SQL has `free-chat-probe.db.test.ts`.
 */

const UUID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;
const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const T0 = Date.parse("2026-10-07T10:00:00.000Z");
const NOW = new Date("2026-10-08T12:00:00.000Z");

type TurnPayload = PayloadOf<"chat.free_chat_turn_served">;

let nextEvent = 1;
/** A served turn: `at` is seconds after T0; session/worker are small integers. */
function turn(
  at: number,
  over: Partial<TurnPayload> & { session?: number; worker?: number } = {},
): TurnServedEvent {
  const { session = 1, worker = 1, ...payload } = over;
  return {
    id: id(1000 + nextEvent++),
    occurredAt: new Date(T0 + at * 1000),
    payload: {
      worker_id: id(500 + worker),
      session_id: id(700 + session),
      mode: "free",
      category: "casual",
      decided_by: "classifier",
      confidence_bucket: "gte90",
      outcome: "answered",
      refusal_topic: null,
      strike_count: null,
      cooldown_started: false,
      nudge: false,
      submission_id: null,
      ...payload,
    },
  };
}

function refusal(fn: () => unknown): ProbeRefusal {
  try {
    fn();
  } catch (err) {
    expect(err).toBeInstanceOf(ProbeRefusal);
    return err as ProbeRefusal;
  }
  throw new Error("expected a ProbeRefusal");
}

describe("the argument contract", () => {
  it("requires --since, reads a bare date as UTC midnight, and defaults --until to now", () => {
    expect(refusal(() => parseFreeChatProbeArgs([], NOW)).message).toMatch(/--since/);
    expect(parseFreeChatProbeArgs(["--since=2026-10-07"], NOW)).toEqual({
      since: new Date("2026-10-07T00:00:00.000Z"),
      until: NOW,
      sample: null,
    });
  });

  it("accepts an instant only with an explicit offset — a bare local time differs by machine", () => {
    expect(
      parseFreeChatProbeArgs(["--since=2026-10-07T10:00+05:30"], NOW).since.toISOString(),
    ).toBe("2026-10-07T04:30:00.000Z");
    expect(
      parseFreeChatProbeArgs(["--since=2026-10-07T10:00:00.5Z"], NOW).since.toISOString(),
    ).toBe("2026-10-07T10:00:00.500Z");
    refusal(() => parseFreeChatProbeArgs(["--since=2026-10-07T10:00"], NOW));
    refusal(() => parseFreeChatProbeArgs(["--since=07/10/2026"], NOW));
    refusal(() => parseFreeChatProbeArgs(["--since=yesterday"], NOW));
  });

  it("refuses a date that does not exist rather than rolling it forward", () => {
    refusal(() => parseFreeChatProbeArgs(["--since=2026-02-31"], NOW));
    refusal(() => parseFreeChatProbeArgs(["--since=2026-13-01"], NOW));
  });

  it("refuses an empty or inverted window", () => {
    refusal(() => parseFreeChatProbeArgs(["--since=2026-10-08", "--until=2026-10-08"], NOW));
    refusal(() => parseFreeChatProbeArgs(["--since=2026-10-09", "--until=2026-10-08"], NOW));
    refusal(() => parseFreeChatProbeArgs(["--since=2026-10-09"], NOW)); // after `now`
    expect(
      parseFreeChatProbeArgs(["--since=2026-10-07", "--until=2026-10-08"], NOW).until.toISOString(),
    ).toBe("2026-10-08T00:00:00.000Z");
  });

  it(`bounds --sample to 1..${FREE_CHAT_PROBE_SAMPLE_MAX} integers`, () => {
    const sample = (v: string) =>
      parseFreeChatProbeArgs(["--since=2026-10-07", `--sample=${v}`], NOW);
    expect(sample("1").sample).toBe(1);
    expect(sample(String(FREE_CHAT_PROBE_SAMPLE_MAX)).sample).toBe(FREE_CHAT_PROBE_SAMPLE_MAX);
    for (const bad of [
      "0",
      String(FREE_CHAT_PROBE_SAMPLE_MAX + 1),
      "-1",
      "1.5",
      "abc",
      "",
      "1e1",
    ]) {
      expect(refusal(() => sample(bad)).message).toMatch(/--sample/);
    }
  });

  it("refuses an unknown flag and a positional (e.g. a write flag this probe does not have)", () => {
    refusal(() => parseFreeChatProbeArgs(["--since=2026-10-07", "--apply"], NOW));
    refusal(() => parseFreeChatProbeArgs(["--since=2026-10-07", "stray"], NOW));
    refusal(() =>
      parseFreeChatProbeArgs(
        ["--since=2026-10-07", "--i-am-authorised-to-write-to-production"],
        NOW,
      ),
    );
  });
});

describe("the read-only assertion", () => {
  it("passes only on the server's literal `on`", () => {
    expect(() => assertReadOnlyTransaction("on")).not.toThrow();
    for (const value of ["off", "ON", "", undefined, null, true, 1]) {
      expect(refusal(() => assertReadOnlyTransaction(value)).message).toMatch(/not read-only/);
    }
  });
});

describe("the struggled-turn predicate (R29, as revised by review)", () => {
  const facts = (over: Partial<TurnPayload>) => ({
    outcome: "answered" as TurnPayload["outcome"],
    decided_by: "classifier" as TurnPayload["decided_by"],
    confidence_bucket: "gte90" as TurnPayload["confidence_bucket"],
    category: "casual" as TurnPayload["category"],
    ...over,
  });

  it("is a clarify, a fallback line or a deflection, whatever decided it", () => {
    for (const outcome of ["clarify", "fallback", "deflected"] as const) {
      expect(isStruggledTurn(facts({ outcome, decided_by: "chip", confidence_bucket: null }))).toBe(
        true,
      );
    }
  });

  it("is an unavailable classifier, even on a fixed line", () => {
    expect(
      isStruggledTurn(
        facts({
          outcome: "fixed_line",
          decided_by: "fallback",
          confidence_bucket: null,
          category: null,
        }),
      ),
    ).toBe(true);
  });

  it("is a classifier verdict in 50_70 that was ACTED ON — not lt50, 70_90 or gte90", () => {
    const answered = (bucket: TurnPayload["confidence_bucket"]) =>
      isStruggledTurn(facts({ confidence_bucket: bucket }));
    expect(answered("50_70")).toBe(true);
    expect(
      isStruggledTurn(
        facts({ confidence_bucket: "50_70", outcome: "fixed_line", category: "jobs" }),
      ),
    ).toBe(true);
    // lt50 is always served as a clarify (caught by outcome) — an acted-on lt50 is distress only.
    expect(answered("lt50")).toBe(false);
    expect(answered("70_90")).toBe(false);
    expect(answered("gte90")).toBe(false);
  });

  it("is NEVER a distress turn, whatever its other fields", () => {
    for (const over of [
      {
        category: "distress" as const,
        outcome: "fixed_line" as const,
        confidence_bucket: "50_70" as const,
      },
      { category: "distress" as const, outcome: "clarify" as const },
      { category: "distress" as const, decided_by: "fallback" as const, confidence_bucket: null },
      {
        category: "distress" as const,
        decided_by: "lexicon" as const,
        confidence_bucket: null,
        outcome: "deflected" as const,
      },
    ]) {
      expect(isStruggledTurn(facts(over))).toBe(false);
    }
  });

  it("is not an ordinary answered, refused, opener or greeting turn", () => {
    for (const outcome of [
      "answered",
      "refused",
      "opener",
      "greeting",
      "strike",
      "fixed_line",
    ] as const) {
      expect(
        isStruggledTurn(facts({ outcome, decided_by: "lexicon", confidence_bucket: null })),
      ).toBe(false);
    }
  });
});

describe("worker messages — the struggle-rate denominator", () => {
  it("excludes the greeting, which answers no message", () => {
    expect(isWorkerMessage({ outcome: "greeting" })).toBe(false);
    for (const outcome of ["opener", "answered", "clarify", "deflected", "fixed_line"] as const) {
      expect(isWorkerMessage({ outcome })).toBe(true);
    }
  });
});

describe("clarify loops — greeting/free mode only, where every message is recorded", () => {
  it("counts two or more clarify lines back to back in free mode, in time order", () => {
    const turns = [
      turn(20, { session: 1, outcome: "clarify" }), // inserted out of order on purpose
      turn(10, { session: 1, outcome: "clarify" }),
      turn(10, { session: 3, outcome: "clarify" }),
      turn(20, { session: 3, outcome: "clarify" }),
      turn(30, { session: 3, outcome: "clarify" }),
    ];
    expect(clarifyLoops(turns)).toEqual({ sessions: 2, longest: 3 });
  });

  it("does NOT count résumé-mode clarifies: an unseen interview answer may sit between them", () => {
    // clarify → (the worker's next answer passes to the interview: no event) → clarify
    const turns = [
      turn(10, { session: 5, mode: "resume", outcome: "clarify" }),
      turn(40, { session: 5, mode: "resume", outcome: "clarify" }),
    ];
    expect(clarifyLoops(turns)).toEqual({ sessions: 0, longest: 0 });
  });

  it("breaks a run on any other served turn and on a mode change", () => {
    const turns = [
      turn(10, { session: 2, outcome: "clarify" }),
      turn(20, { session: 2, outcome: "answered" }),
      turn(30, { session: 2, outcome: "clarify" }),
      turn(10, { session: 6, mode: "greeting", outcome: "clarify" }),
      turn(20, { session: 6, mode: "free", outcome: "clarify" }),
      turn(30, { session: 6, mode: "resume", outcome: "clarify" }),
    ];
    expect(clarifyLoops(turns)).toEqual({ sessions: 0, longest: 0 });
  });

  it("orders a session by time, not by arrival, so a late row cannot fake or break a run", () => {
    const turns = [
      turn(30, { session: 4, outcome: "clarify" }),
      turn(10, { session: 4, outcome: "clarify" }),
      turn(20, { session: 4, outcome: "answered" }),
    ];
    expect(clarifyLoops(turns).sessions).toBe(0);
  });
});

describe("repeated deflections — counted, adjacency unknown", () => {
  it("counts sessions with two or more deflections, wherever they fall", () => {
    const turns = [
      turn(10, { session: 1, mode: "resume", outcome: "deflected" }),
      turn(50, { session: 1, mode: "resume", outcome: "deflected" }),
      turn(90, { session: 1, mode: "resume", outcome: "deflected" }),
      turn(10, { session: 2, mode: "resume", outcome: "deflected" }),
    ];
    expect(repeatedOutcome(turns, "deflected")).toEqual({ sessions: 1, most: 3 });
  });
});

describe("sessions that reached free mode and never entered résumé mode", () => {
  const change = (session: number, to: "free" | "resume"): ModeChangedEvent => ({
    id: id(9000 + session * 10 + (to === "free" ? 1 : 2)),
    occurredAt: new Date(T0),
    payload: {
      worker_id: id(501),
      session_id: id(700 + session),
      from: to === "free" ? "greeting" : "free",
      to,
      trigger: "chip",
    },
  });

  it("reads both events, so a lost mode-change event does not hide a session", () => {
    const changes = [change(1, "free"), change(2, "free"), change(2, "resume")];
    const turns = [
      turn(0, { session: 3, mode: "free" }), // reached free; its mode change was never recorded
      turn(0, { session: 1, mode: "free" }),
      turn(0, { session: 4, mode: "free" }),
      turn(5, { session: 4, mode: "resume", outcome: "deflected" }), // entered résumé mode
    ];
    expect(sessionsFreeWithoutResume(changes, turns)).toBe(2); // sessions 1 and 3
  });
});

describe("readProbeEvents — narrowed through the registry", () => {
  it("keeps valid v1 payloads, sets aside other versions, and counts unreadable ones", () => {
    const good = turn(0);
    const read = readProbeEvents("chat.free_chat_turn_served", [
      { id: good.id, occurredAt: good.occurredAt, version: 1, payload: good.payload },
      { id: id(2), occurredAt: good.occurredAt, version: 2, payload: good.payload },
      {
        id: id(3),
        occurredAt: good.occurredAt,
        version: 1,
        payload: { ...good.payload, outcome: "x" },
      },
      {
        id: id(4),
        occurredAt: good.occurredAt,
        version: 1,
        payload: { ...good.payload, text: "hi" },
      },
    ]);
    expect(read.events).toEqual([good]);
    expect(read.otherVersions).toBe(1);
    expect(read.unreadable).toBe(2);
  });
});

describe("drawing the sample", () => {
  const NAMES: Record<string, string | null> = { [id(501)]: "Suresh Kumar", [id(502)]: null };

  /** Fake sources: a link result per session id; workers in `ineligible` fail R36; every call recorded. */
  function sources(links: Record<string, LinkResult>, ineligible: readonly string[] = []) {
    const calls = {
      eligible: [] as string[],
      linked: [] as LinkRef[][],
      counted: [] as LinkRef[][],
      names: [] as string[],
    };
    const src: SampleSources = {
      eligible: async (workerId) => {
        calls.eligible.push(workerId);
        return !ineligible.includes(workerId);
      },
      linkedLines: async (refs) => {
        calls.linked.push([...refs]);
        return refs.map((r) => links[r.sessionId] ?? { kind: "none" });
      },
      linkCounts: async (refs) => {
        calls.counted.push([...refs]);
        const kinds = refs.map((r) => links[r.sessionId]?.kind ?? "none");
        return {
          none: kinds.filter((k) => k === "none").length,
          ambiguous: kinds.filter((k) => k === "ambiguous").length,
        };
      },
      knownName: async (workerId) => {
        calls.names.push(workerId);
        return NAMES[workerId] ?? null;
      },
    };
    return { src, calls };
  }
  let nextRow = 1;
  /** A proven link to a fresh row (pass `row` to make two links claim the same one). */
  const linked = (
    workerText: string,
    botText: string | null = "Aap kya kaam karte ho?",
    row = nextRow++,
  ): LinkResult => ({
    kind: "linked",
    messageId: id(3000 + row),
    workerText,
    botText,
  });

  it("shows struggled turns only, newest first, with ordinals and no id anywhere", async () => {
    const turns = [
      turn(10, { session: 1, outcome: "clarify", category: "unclear", confidence_bucket: "lt50" }),
      turn(20, { session: 2, outcome: "answered" }), // not struggled: never read
      turn(30, { session: 3, outcome: "deflected", mode: "resume", category: "career" }),
    ];
    const { src, calls } = sources({
      [id(701)]: linked("kya matlab"),
      [id(702)]: linked("never read"),
      [id(703)]: linked("suresh hoon, abhi nahi", "{{worker_name}} ji, kitne saal kaam kiya?"),
    });
    const sample = await drawFreeChatSample(turns, 5, src);
    expect(sample.entries.map((e) => e.ordinal)).toEqual([1, 2]);
    expect(sample.entries[0]).toEqual({
      ordinal: 1,
      turn: {
        mode: "resume",
        category: "career",
        decided_by: "classifier",
        confidence_bucket: "gte90",
        outcome: "deflected",
      },
      bot: { kind: "shown", text: "[NAME] ji, kitne saal kaam kiya?" },
      worker: "[NAME] hoon, abhi nahi",
    });
    expect(sample.entries[1]?.worker).toBe("kya matlab");
    expect(JSON.stringify(sample)).not.toMatch(UUID_RE);
    expect(calls.linked.flat().map((r) => r.sessionId)).not.toContain(id(702));
    expect(sample).toMatchObject({ struggled: 2, noLinkedText: 0, ambiguous: 0, examined: 2 });
  });

  it("never reads a distress turn, even one that is otherwise struggled", async () => {
    const { src, calls } = sources({ [id(709)]: linked("fabricated distress line") });
    const sample = await drawFreeChatSample(
      [
        turn(10, {
          session: 9,
          category: "distress",
          outcome: "fixed_line",
          confidence_bucket: "50_70",
        }),
      ],
      5,
      src,
    );
    expect(sample).toMatchObject({ struggled: 0, examined: 0, entries: [] });
    expect(calls).toEqual({ eligible: [], linked: [], counted: [], names: [] });
  });

  it("R36 — an ineligible worker's turn is never counted, linked, read or decrypted", async () => {
    const turns = [
      turn(10, { session: 1, outcome: "clarify", worker: 3 }), // ineligible
      turn(20, { session: 2, outcome: "clarify", worker: 3 }), // ineligible (asked once)
      turn(30, { session: 3, outcome: "clarify" }),
    ];
    const { src, calls } = sources(
      {
        [id(701)]: { kind: "ambiguous" },
        [id(702)]: linked("never read"),
        [id(703)]: linked("kaam"),
      },
      [id(503)],
    );
    const sample = await drawFreeChatSample(turns, 5, src);
    expect(sample.workerDrops.not_eligible).toBe(2);
    expect(sample.entries.map((e) => e.worker)).toEqual(["kaam"]);
    expect(calls.eligible.filter((w) => w === id(503))).toHaveLength(1);
    expect(calls.linked.flat().map((r) => r.sessionId)).toEqual([id(703)]);
    expect(calls.names).not.toContain(id(503));
    // The link COUNTS cover the eligible turn only — session 1's ambiguity is not in them.
    expect(calls.counted.flat().map((r) => r.sessionId)).toEqual([id(703)]);
    expect(sample).toMatchObject({ struggled: 3, eligible: 1, ambiguous: 0, noLinkedText: 0 });
  });

  it("never prints one row twice: a second claim on it is an ambiguous link", async () => {
    const turns = [
      turn(10, { session: 1, outcome: "clarify" }),
      turn(20, { session: 2, outcome: "clarify" }),
    ];
    const { src } = sources({
      [id(701)]: linked("kya matlab", null, 900),
      [id(702)]: linked("kya matlab", null, 900),
    });
    const sample = await drawFreeChatSample(turns, 5, src);
    expect(sample.entries).toHaveLength(1);
    expect(sample.workerDrops.ambiguous_link).toBe(1);
  });

  it("applies the ONE blank rule in JavaScript: a blank worker line is no text; a blank bot line is none", async () => {
    const turns = [
      turn(10, { session: 1, outcome: "clarify" }),
      turn(20, { session: 2, outcome: "clarify" }),
    ];
    const { src } = sources({
      // NBSP and an ideographic space: JavaScript whitespace that SQL `btrim` would keep.
      [id(701)]: linked(" 　​"),
      [id(702)]: linked("kaam", " \t"),
    });
    const sample = await drawFreeChatSample(turns, 5, src);
    expect(sample.workerDrops.no_linked_text).toBe(1);
    expect(sample.entries).toEqual([expect.objectContaining({ worker: "kaam", bot: null })]);
  });

  it("tallies every drop — ambiguous, no text, masked out — and withholds a bad bot line", async () => {
    const turns = [
      turn(10, { session: 1, outcome: "clarify" }),
      turn(20, { session: 2, outcome: "clarify" }),
      turn(30, { session: 3, outcome: "clarify", worker: 2 }), // name unreadable
      turn(40, { session: 4, outcome: "clarify" }), // no text linked
      turn(50, { session: 5, outcome: "clarify" }), // ambiguous
      turn(60, {
        session: 6,
        outcome: "fallback",
        decided_by: "fallback",
        confidence_bucket: null,
      }),
    ];
    const { src, calls } = sources({
      [id(701)]: linked("mera number 9876543210"),
      [id(702)]: linked("mera naam Ramesh"),
      [id(703)]: linked("kaam chahiye"),
      [id(705)]: { kind: "ambiguous" },
      [id(706)]: linked("phir se bolo", "Aapka naam kya hai?"),
    });
    const sample = await drawFreeChatSample(turns, 10, src);
    expect(sample.entries).toHaveLength(1);
    expect(sample.entries[0]?.bot).toEqual({ kind: "dropped", reason: "name_cue" });
    expect(sample.workerDrops).toEqual({
      not_eligible: 0,
      identifier: 1,
      name_cue: 1,
      name_unreadable: 1,
      name_tokens_found: 0,
      ambiguous_link: 1,
      no_linked_text: 1,
    });
    expect(sample.botWithheld.name_cue).toBe(1);
    expect(sample).toMatchObject({ noLinkedText: 1, ambiguous: 1 });
    expect(calls.counted).toHaveLength(1);
    expect(calls.counted[0]).toHaveLength(6);
    // One decrypt per worker, however many of their turns are examined; none for an ambiguous turn.
    expect(calls.names.filter((w) => w === id(501))).toHaveLength(1);
  });

  it(`stops at N shown, and reads at most N × ${SAMPLE_SCAN_FACTOR} turns when lines keep dropping`, async () => {
    const many = Array.from({ length: 40 }, (_, i) =>
      turn(i * 200, { session: 100 + i, outcome: "clarify", worker: 2 }),
    );
    const links = Object.fromEntries(
      many.map((t) => [t.payload.session_id, linked("kaam chahiye")]),
    );
    const unreadable = await drawFreeChatSample(many, 3, sources(links).src);
    expect(unreadable.entries).toHaveLength(0);
    expect(unreadable.examined).toBe(3 * SAMPLE_SCAN_FACTOR);

    const readable = many.map((t) => ({ ...t, payload: { ...t.payload, worker_id: id(501) } }));
    const { src, calls } = sources(links);
    const shown = await drawFreeChatSample(readable, 3, src);
    expect(shown.entries).toHaveLength(3);
    expect(shown.examined).toBe(3);
    expect(calls.linked).toHaveLength(1);
    expect(calls.linked[0]).toHaveLength(3);
  });

  it("reads nothing when no turn struggled", async () => {
    const { src, calls } = sources({});
    const sample = await drawFreeChatSample([turn(0)], 5, src);
    expect(sample).toMatchObject({
      struggled: 0,
      noLinkedText: 0,
      ambiguous: 0,
      examined: 0,
      entries: [],
    });
    expect(calls).toEqual({ eligible: [], linked: [], counted: [], names: [] });
  });
});
