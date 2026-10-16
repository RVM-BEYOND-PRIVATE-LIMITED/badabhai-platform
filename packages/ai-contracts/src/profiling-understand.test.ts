/**
 * The profiling turn's understanding (ADR-0057, #2309) — Zod <-> Pydantic parity against the
 * golden fixture `apps/ai-service/tests/test_contract_parity.py` reads too, plus the behaviour the
 * key names alone cannot pin.
 */
import { describe, expect, it } from "vitest";
import {
  PROFILING_EDIT_OPS,
  PROFILING_FIELD_KINDS,
  PROFILING_FIELD_STATUSES,
  PROFILING_TURN_INTENTS,
} from "@badabhai/types";

import understandKeys from "./__fixtures__/profiling-understand.keys.json";
import {
  ProfilingEditSchema,
  ProfilingFillSchema,
  ProfilingOnScreenSchema,
  ProfilingProgressSchema,
  ProfilingSchemaEntrySchema,
  ProfilingSchemaRowSchema,
  ProfilingTurnUnderstandInputSchema,
  ProfilingTurnUnderstandOutputSchema,
} from "./profiling-understand";

const shapes: Array<[string, Record<string, unknown>]> = [
  ["ProfilingSchemaEntry", ProfilingSchemaEntrySchema.shape],
  ["ProfilingSchemaRow", ProfilingSchemaRowSchema.shape],
  ["ProfilingOnScreen", ProfilingOnScreenSchema.shape],
  ["ProfilingProgress", ProfilingProgressSchema.shape],
  ["ProfilingTurnUnderstandInput", ProfilingTurnUnderstandInputSchema.shape],
  ["ProfilingFill", ProfilingFillSchema.shape],
  ["ProfilingEdit", ProfilingEditSchema.shape],
  ["ProfilingTurnUnderstandOutput", ProfilingTurnUnderstandOutputSchema.shape],
];

const row = (over: Record<string, unknown> = {}) => ({
  key: "experience_years",
  label: "Experience",
  kind: "duration",
  status: "answered",
  value: "5",
  ...over,
});

describe("Profiling turn understanding contract parity (contracts.py mirror)", () => {
  it.each(shapes)("%s keys match the golden fixture shared with Pydantic", (name, shape) => {
    const golden = (understandKeys as unknown as Record<string, string[] | string>)[name];
    expect(golden, `fixture is missing ${name}`).toBeDefined();
    expect(Array.isArray(golden)).toBe(true);
    expect(Object.keys(shape).sort()).toEqual([...(golden as string[])].sort());
  });

  it("the fixture declares no contract the TypeScript side lacks", () => {
    const declared = Object.keys(understandKeys).filter((k) => !k.startsWith("_"));
    expect(declared.sort()).toEqual(shapes.map(([n]) => n).sort());
  });

  it("the closed sets come from @badabhai/types, not a private copy", () => {
    // The API's handlers and the `profiling.turn_understood` event read the same lists.
    expect(ProfilingTurnUnderstandOutputSchema.shape.intent.removeDefault().options).toEqual([
      ...PROFILING_TURN_INTENTS,
    ]);
    expect(ProfilingSchemaRowSchema.shape.kind.options).toEqual([...PROFILING_FIELD_KINDS]);
    expect(ProfilingSchemaRowSchema.shape.status.options).toEqual([...PROFILING_FIELD_STATUSES]);
    expect(ProfilingEditSchema.shape.op.options).toEqual([...PROFILING_EDIT_OPS]);
  });

  it("filling an empty field is not an edit — the edit ops carry no `add`", () => {
    expect(PROFILING_EDIT_OPS).not.toContain("add");
  });
});

describe("Profiling turn understanding behaviour", () => {
  it("an empty response is the fail-safe answer: unclear, nothing proposed", () => {
    expect(ProfilingTurnUnderstandOutputSchema.parse({})).toEqual({
      intent: "unclear",
      confidence: 0,
      fills: [],
      edits: [],
      page_owned_mentions: [],
      // #2328: a response from before the field is not a "none" — today's turn.
      on_screen_none: false,
      blocked: false,
      ai_metadata: null,
    });
  });

  it("a request needs only the message and the schema; the rest defaults", () => {
    const parsed = ProfilingTurnUnderstandInputSchema.parse({
      text: "paanch saal ka experience hai",
      schema_rows: [row()],
    });
    expect(parsed.recent_turns).toEqual([]);
    expect(parsed.on_screen).toBeNull();
    expect(parsed.page_owned).toEqual([]);
    expect(parsed.progress).toBeNull();
    expect(parsed.schema_rows[0]).toMatchObject({ options: [], entries: [] });
  });

  it("refuses a message past the chat DTO's bound and a schema past 64 rows", () => {
    expect(() =>
      ProfilingTurnUnderstandInputSchema.parse({ text: "x".repeat(4001), schema_rows: [] }),
    ).toThrow();
    expect(() =>
      ProfilingTurnUnderstandInputSchema.parse({
        text: "hi",
        schema_rows: Array.from({ length: 65 }, (_, i) => row({ key: `k${i}` })),
      }),
    ).toThrow();
  });

  it("a delete and a value-less edit both parse with a null value", () => {
    expect(ProfilingEditSchema.parse({ op: "delete", key: "skills", ref: "s1" }).value).toBeNull();
    expect(ProfilingEditSchema.parse({ op: "edit", key: "experience_years" }).value).toBeNull();
  });
});
