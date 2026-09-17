import { describe, expect, it } from "vitest";

import {
  CHAT_FILL_FIELDS,
  FACT_FILL_FIELDS,
  LAYER_A_FILL_FIELDS,
  aggregateFill,
  formatReport,
  parseCorpusLines,
  type ChatFillField,
  type FillObservation,
} from "./chat-fill-coverage";

/** Every field empty; `filled` names the ones that are settled. */
function obs(
  road: FillObservation["road"],
  filled: readonly ChatFillField[] = [],
): FillObservation {
  const record = {} as Record<ChatFillField, boolean>;
  for (const field of CHAT_FILL_FIELDS) record[field] = filled.includes(field);
  return { road, filled: record };
}

describe("the field universe", () => {
  it("is the 19 facts plus the six Layer A storages, all unique", () => {
    expect(FACT_FILL_FIELDS).toHaveLength(19);
    expect(LAYER_A_FILL_FIELDS).toEqual([
      "whatsapp",
      "training",
      "licence",
      "portfolio",
      "secondary_occupations",
      "verification",
    ]);
    expect(CHAT_FILL_FIELDS).toHaveLength(25);
    expect(new Set(CHAT_FILL_FIELDS).size).toBe(CHAT_FILL_FIELDS.length);
  });
});

describe("aggregateFill — vacuity: the fixtures exercise every branch", () => {
  it("contains a filled and an unfilled observation on each living road, plus null source", () => {
    // Written first, per the repo's detector-fixture convention: a corpus that never contained a
    // filled chat field, an unfilled form field or a null-source row would let a broken
    // denominator or a dropped bucket pass silently.
    const observations = [
      obs("chat", ["trade"]),
      obs("chat"),
      obs("form", ["trade", "education"]),
      obs("form"),
      obs("unknown", ["trade"]),
    ];
    const aggregate = aggregateFill(observations);
    expect(aggregate.workersPerRoad).toEqual({ form: 2, chat: 2, unknown: 1 });
    expect(aggregate.unknownRoadWorkers).toBe(1);
    expect(aggregate.rows.some((r) => r.road === "chat" && r.filled === 1 && r.workers === 2)).toBe(
      true,
    );
    expect(aggregate.rows.some((r) => r.road === "form" && r.filled === 0)).toBe(true);
    expect(aggregate.rows.some((r) => r.road === "unknown" && r.filled === 1)).toBe(true);
  });

  it("computes fillRate per (road, field), never NaN", () => {
    const observations = [
      obs("chat", ["trade"]),
      obs("chat", ["trade", "experience"]),
      obs("chat", ["experience"]),
      obs("chat"),
    ];
    const aggregate = aggregateFill(observations);
    const trade = aggregate.rows.find((r) => r.road === "chat" && r.field === "trade");
    const experience = aggregate.rows.find((r) => r.road === "chat" && r.field === "experience");
    expect(trade).toMatchObject({ workers: 4, filled: 2, fillRate: 0.5 });
    expect(experience).toMatchObject({ workers: 4, filled: 2, fillRate: 0.5 });
    // A field nobody settled still has a row at 0% — "never filled" is a finding, not absence.
    const training = aggregate.rows.find((r) => r.road === "chat" && r.field === "training");
    expect(training).toMatchObject({ workers: 4, filled: 0, fillRate: 0 });
  });

  it("emits a row for every field on every road that has workers, and none for an empty road", () => {
    const aggregate = aggregateFill([obs("chat", ["trade"]), obs("unknown")]);
    expect(aggregate.rows.filter((r) => r.road === "chat")).toHaveLength(CHAT_FILL_FIELDS.length);
    expect(aggregate.rows.filter((r) => r.road === "unknown")).toHaveLength(
      CHAT_FILL_FIELDS.length,
    );
    expect(aggregate.rows.filter((r) => r.road === "form")).toHaveLength(0);
    expect(aggregate.rows.every((r) => r.workers > 0)).toBe(true);
  });

  it("handles an empty corpus without dividing by zero", () => {
    const aggregate = aggregateFill([]);
    expect(aggregate.totalWorkers).toBe(0);
    expect(aggregate.unknownRoadWorkers).toBe(0);
    expect(aggregate.rows).toEqual([]);
  });
});

describe("parseCorpusLines — the strict corpus format", () => {
  it("skips comments and blanks, expands sparse filled lists, and maps null road to unknown", () => {
    const parsed = parseCorpusLines(
      [
        "# header",
        "",
        '{"road": "chat", "filled": ["trade", "experience"]}',
        '{"road": null}',
      ].join("\n"),
    );
    expect(parsed).toHaveLength(2);
    expect(parsed[0]).toMatchObject({ road: "chat" });
    expect(Object.values(parsed[0]!.filled).filter(Boolean)).toHaveLength(2);
    expect(parsed[1]!.road).toBe("unknown");
    expect(Object.values(parsed[1]!.filled).every((v) => v === false)).toBe(true);
  });

  it("REFUSES a corpus line carrying anything but road/filled — a value cannot ride in", () => {
    expect(() => parseCorpusLines('{"road": "chat", "name": "Ramesh"}')).toThrow(/unexpected key/);
    expect(() => parseCorpusLines('{"road": "chat", "value": "+919876543210"}')).toThrow(
      /unexpected key/,
    );
  });

  it("refuses an unknown field, a duplicate, a bad road, malformed JSON and non-objects", () => {
    expect(() => parseCorpusLines('{"road": "chat", "filled": ["machines"]}')).toThrow(
      /unknown field/,
    );
    expect(() => parseCorpusLines('{"road": "chat", "filled": ["trade", "trade"]}')).toThrow(
      /listed twice/,
    );
    expect(() => parseCorpusLines('{"road": "upload"}')).toThrow(/road must be/);
    expect(() => parseCorpusLines("{not json}")).toThrow(/not valid JSON/);
    expect(() => parseCorpusLines("[]")).toThrow(/must be a JSON object/);
  });
});

describe("formatReport", () => {
  it("prints the per-road counts and the NULL-source line", () => {
    const lines = formatReport(aggregateFill([obs("chat", ["trade"]), obs("unknown")]));
    const text = lines.join("\n");
    expect(text).toContain("workers scored: 2 (form 0 · chat 1 · unknown 1)");
    expect(text).toContain("NULL-source workers (pre-0107): 1");
    expect(text).toContain("select count(*) from worker_profiles where source is null");
    expect(text).toContain("trade");
    expect(text).toContain("100.0% (1/1)");
  });

  it("says so explicitly when the corpus is empty", () => {
    expect(formatReport(aggregateFill([])).join("\n")).toContain("no workers in the corpus");
  });
});
