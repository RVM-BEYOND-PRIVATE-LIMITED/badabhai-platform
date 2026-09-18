import { describe, expect, it } from "vitest";
import type { QuestionPackItem } from "@badabhai/ai-contracts";

import { recordAnswer, recordDeclined, recordUnanswered, type AnswerMap } from "../answer-map";
import {
  buildSessionFillView,
  storedFactsFromAttributeRows,
  STORED_FACT_ATTRIBUTE_KEYS,
} from "./session-fill-view";
import type { WorkerFactId } from "./worker-fact.registry";

/**
 * The Phase 3 view's three rules, each pinned on its own: projector-dropped answers are MISSING
 * to the profile, facts settled on another road count as settled here, and a chat decline is final.
 */

const item = (
  questionKey: string,
  targetField: string,
  over: Partial<QuestionPackItem> = {},
): Pick<QuestionPackItem, "question_key" | "target_field" | "is_core"> => ({
  question_key: questionKey,
  target_field: targetField,
  is_core: over.is_core ?? false,
});

const TRADE = item("primary_trade", "trade", { is_core: true });
const CITY = item("current_city", "current_city", { is_core: true });
const LANGUAGES = item("languages", "languages");
const SHIFT = item("shift_preference", "shift_preference");

const answered = (q: string, field: string, value: unknown): AnswerMap =>
  recordAnswer(
    {},
    {
      questionKey: q,
      targetField: field,
      valueRaw: String(value),
      valueNormalized: value,
      evidence: null,
    },
    1,
  );

const NONE: ReadonlySet<WorkerFactId> = new Set();

describe("buildSessionFillView — rule 1: projector-dropped answers count as missing", () => {
  it("keeps an answer the projector carries", () => {
    const view = buildSessionFillView([TRADE], answered("primary_trade", "trade", "welder"), NONE);
    expect(view.entries).toEqual([
      {
        fact: "trade",
        questionKey: "primary_trade",
        status: "answered",
        source: "chat",
        droppedByProjector: false,
        isCore: true,
      },
    ]);
    expect(view.settled).toEqual(["trade"]);
  });

  it("reports a NON-GAZETTEER city as missing with dropped_by_projector", () => {
    // The pinned #1504 city-seed rule: a raw `/name` city never reaches the profile, so to the
    // field's readers it is absent. Showing it as settled would leave the profile empty forever.
    const view = buildSessionFillView(
      [CITY],
      answered("current_city", "current_city", "Gaon XYZ"),
      NONE,
    );
    expect(view.entries[0]).toMatchObject({
      fact: "current_city",
      status: "missing",
      droppedByProjector: true,
      source: "chat",
    });
    expect(view.settled).toEqual([]);
  });

  it("carries the languages carve-out and plain attributes alike", () => {
    const answers = recordAnswer(
      answered("shift_preference", "shift_preference", "day"),
      {
        questionKey: "languages",
        targetField: "languages",
        valueRaw: "Hindi",
        valueNormalized: ["hindi"],
        evidence: null,
      },
      2,
    );
    const view = buildSessionFillView([LANGUAGES, SHIFT], answers, NONE);
    expect(view.entries.map((e) => [e.fact, e.status, e.droppedByProjector])).toEqual([
      ["languages", "answered", false],
      ["shift", "answered", false],
    ]);
  });
});

describe("buildSessionFillView — rule 2: another road settles the fact", () => {
  it("lifts a never-asked fact to answered/other_road", () => {
    const view = buildSessionFillView([LANGUAGES], {}, new Set(["languages"]));
    expect(view.entries[0]).toMatchObject({
      fact: "languages",
      status: "answered",
      source: "other_road",
      droppedByProjector: false,
    });
    expect(view.settled).toEqual(["languages"]);
  });

  it("lifts an UNANSWERED fact too — the answer exists, just not from this chat", () => {
    const view = buildSessionFillView(
      [LANGUAGES],
      recordUnanswered({}, "languages", 4),
      new Set(["languages"]),
    );
    expect(view.entries[0]).toMatchObject({ status: "answered", source: "other_road" });
  });

  it("does NOT invent facts outside the session's items", () => {
    // The view is exactly "what this session's packs could collect", reconciled — a stored fact
    // no item names cannot appear, or the surface would render rows it has no question for.
    const view = buildSessionFillView([TRADE], {}, new Set(["languages"]));
    expect(view.entries.map((e) => e.fact)).toEqual(["trade"]);
  });

  it("keeps a chat answer as the source when both roads settled the fact", () => {
    const view = buildSessionFillView(
      [LANGUAGES],
      answered("languages", "languages", ["hindi"]),
      new Set(["languages"]),
    );
    expect(view.entries[0]).toMatchObject({ status: "answered", source: "chat" });
  });
});

describe("buildSessionFillView — rule 3: a decline is final and settled", () => {
  it("never overrides a decline with a stored value", () => {
    const view = buildSessionFillView(
      [LANGUAGES],
      recordDeclined({}, "languages", 3),
      new Set(["languages"]),
    );
    expect(view.entries[0]).toMatchObject({ status: "declined", source: "chat" });
    // Declined IS settled: re-asking would badger a worker who already said they do not know.
    expect(view.settled).toEqual(["languages"]);
  });
});

describe("buildSessionFillView — the shape of the rest", () => {
  it("reports unanswered and missing as themselves", () => {
    const view = buildSessionFillView(
      [TRADE, CITY],
      recordUnanswered({}, "primary_trade", 2),
      NONE,
    );
    expect(view.entries).toEqual([
      {
        fact: "trade",
        questionKey: "primary_trade",
        status: "unanswered",
        source: "chat",
        droppedByProjector: false,
        isCore: true,
      },
      {
        fact: "current_city",
        questionKey: "current_city",
        status: "missing",
        source: "chat",
        droppedByProjector: false,
        isCore: true,
      },
    ]);
    expect(view.settled).toEqual([]);
  });
});

describe("storedFactsFromAttributeRows", () => {
  const row = (attributeKey: string, over: Record<string, unknown>) => ({
    attributeKey,
    valueKind: "text",
    ...over,
  });

  it("only counts REAL values", () => {
    const facts = storedFactsFromAttributeRows([
      row("languages", { valueKind: "text_list", valueTextList: ["hindi"] }),
      row("work_types", { valueKind: "text_list", valueTextList: [] }),
      row("shift_preference", { valueKind: "text", valueText: "day" }),
      row("accommodation_needed", { valueKind: "text", valueText: "   " }),
      row("willing_to_travel", { valueKind: "boolean", valueBool: true }),
      row("documents_ready", { valueKind: "boolean", valueBool: false }),
      row("commute_max_km", { valueKind: "number", valueNumber: 12 }),
      row("salary_period", { valueKind: "json", valueJson: null }),
    ]);
    expect([...facts].sort()).toEqual([
      "commute_max_km",
      "languages",
      "shift",
      "willing_to_travel",
    ]);
  });

  it("ignores attribute keys that are not facts", () => {
    expect(
      storedFactsFromAttributeRows([
        { attributeKey: "welding_process", valueKind: "text", valueText: "tig" },
      ]),
    ).toEqual(new Set());
  });

  it("is exhaustive over the registry's attribute aliases", () => {
    // `trade` settles through an attribute alias as well as its RFS spellings; the list the
    // service loads must include it, or a stored trade could never reconcile.
    expect(STORED_FACT_ATTRIBUTE_KEYS).toContain("languages");
    expect(STORED_FACT_ATTRIBUTE_KEYS).toContain("work_types");
    expect(STORED_FACT_ATTRIBUTE_KEYS).toContain("shift_preference");
  });
});
