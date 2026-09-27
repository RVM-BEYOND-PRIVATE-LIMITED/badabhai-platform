import "reflect-metadata";
import { describe, expect, it, vi } from "vitest";

import { TradeFormSchemaResponse } from "../form/trade-form.dto";
import { TRADE_FORM_KINDS } from "../trade-form-router";
import {
  BRIEF_RAW_MAX_UNITS,
  BRIEF_REFUSAL_REASONS,
  BRIEF_WIRE_MAX_UNITS,
} from "./general-form-brief";
import {
  BRIEF_REFUSAL_CODES,
  GENERAL_FORM_ANSWER_ERROR_CODES,
  GeneralFormAnswerSchema,
  GeneralFormSchemaResponse,
} from "./general-form.dto";
import { GeneralFormService } from "./general-form.service";

/**
 * ═══ THE WIRE CONTRACT ═══
 *
 * The general form's screens MIRROR the trade form's rather than import its private schemas, so
 * the app can render them with the trade form's widgets. A mirror drifts silently — so this file
 * parses the served screens with the trade form's OWN exported parser, and fails the day the two
 * stop agreeing.
 */

const WORKER = "11111111-1111-4111-8111-111111111111";
const SESSION = "22222222-2222-4222-8222-222222222222";

async function servedSchema(): Promise<GeneralFormSchemaResponse> {
  const service = new GeneralFormService(
    {
      findLatestGeneralHandoverSession: vi.fn(async () => ({
        id: SESSION,
        workerId: WORKER,
        conversationState: {
          general_road: {
            v: 1,
            lane: "skills",
            role_label: "Graphic designer",
            domain_label: null,
            skills: [],
            outcome: "no_skills",
            handed_over: true,
          },
        },
      })),
    } as never,
    {
      loadKeys: vi.fn(async () => [
        {
          attributeKey: "profile_brief",
          valueKind: "json",
          valueBool: null,
          valueNumber: null,
          valueText: null,
          valueTextList: null,
          valueJson: { status: "answered", text: "Welder hoon" },
        },
        {
          attributeKey: "has_work_history",
          valueKind: "boolean",
          valueBool: true,
          valueNumber: null,
          valueText: null,
          valueTextList: null,
          valueJson: null,
        },
      ]),
    } as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
  );
  return service.schema(WORKER);
}

/** Wrap general-form screens in a trade-form response and parse it with the trade form's parser. */
function throughTradeParser(screens: readonly unknown[]) {
  return TradeFormSchemaResponse.parse({
    kind: TRADE_FORM_KINDS[0],
    pack_id: "qp_x",
    pack_version: 1,
    session_id: SESSION,
    sections: [{ id: "x", title: "x", screens }],
  }).sections[0]!.screens;
}

describe("the general form's screens are the trade form's screens", () => {
  it("the served response satisfies its own strict schema", async () => {
    const out = await servedSchema();
    expect(GeneralFormSchemaResponse.parse(out)).toEqual(out);
  });

  it("every QUESTION screen parses through the trade form's parser UNCHANGED — no key added or lost", async () => {
    const out = await servedSchema();
    const questions = out.sections.flatMap((s) => s.screens).filter((s) => s.type === "question");
    expect(questions).toHaveLength(2);
    expect(throughTradeParser(questions)).toEqual(questions);
  });

  it("every MARKER is readable by the trade decoder — its extra keys are additive, never required there", async () => {
    const out = await servedSchema();
    const markers = out.sections.flatMap((s) => s.screens).filter((s) => s.type !== "question");
    expect(markers.map((m) => m.type)).toEqual([
      "preferences",
      "employment",
      "qualifications",
      "qualifications",
    ]);
    const parsed = throughTradeParser(markers);
    // The trade parser keeps exactly the shared fields; the general form's own (`fields`,
    // `require_start_ym`, `lists`, `education_options`) are what an older decoder ignores.
    expect(parsed.map((m) => ({ ...m }))).toEqual(
      markers.map((m) => {
        const { type, endpoint } = m as { type: string; endpoint: string };
        return type === "qualifications"
          ? { type, endpoint, suggested_certificates: [] }
          : { type, endpoint };
      }),
    );
  });
});

describe("GeneralFormAnswerSchema — the POST body", () => {
  it("accepts each of the three answer kinds", () => {
    for (const answer of [
      { kind: "text", text: "Welder hoon" },
      { kind: "boolean", value: false },
      { kind: "declined" },
    ]) {
      expect(
        GeneralFormAnswerSchema.safeParse({ question_key: "profile_brief", answer }).success,
      ).toBe(true);
    }
  });

  it("the key is a CLOSED enum — a pack slug the trade form would take is refused here", () => {
    expect(
      GeneralFormAnswerSchema.safeParse({
        question_key: "turning_machine",
        answer: { kind: "declined" },
      }).success,
    ).toBe(false);
  });

  it("is strict at every level, and carries no session or worker id", () => {
    const base = { question_key: "has_work_history", answer: { kind: "boolean", value: true } };
    expect(GeneralFormAnswerSchema.safeParse({ ...base, session_id: SESSION }).success).toBe(false);
    expect(GeneralFormAnswerSchema.safeParse({ ...base, worker_id: WORKER }).success).toBe(false);
    expect(
      GeneralFormAnswerSchema.safeParse({ ...base, answer: { ...base.answer, extra: 1 } }).success,
    ).toBe(false);
    // The trade form's `chips` kind does not exist on this form.
    expect(
      GeneralFormAnswerSchema.safeParse({
        question_key: "profile_brief",
        answer: { kind: "chips", option_keys: [] },
      }).success,
    ).toBe(false);
  });

  it("text is bounded only by the request-size cap; empty and over-long are the screen's, with a reason", () => {
    const at = (n: number) =>
      GeneralFormAnswerSchema.safeParse({
        question_key: "profile_brief",
        answer: { kind: "text", text: "a".repeat(n) },
      }).success;
    expect(at(BRIEF_WIRE_MAX_UNITS)).toBe(true);
    expect(at(BRIEF_WIRE_MAX_UNITS + 1)).toBe(false);
    // Reaches the screen, which answers brief_empty / brief_too_long.
    expect(at(0)).toBe(true);
    expect(at(BRIEF_RAW_MAX_UNITS + 1)).toBe(true);
  });
});

describe("the 400 codes are closed", () => {
  it("every refusal reason has exactly one code, and every code is in the published list", () => {
    for (const reason of BRIEF_REFUSAL_REASONS) {
      expect(BRIEF_REFUSAL_CODES[reason]).toBe(`brief_${reason}`);
      expect(GENERAL_FORM_ANSWER_ERROR_CODES).toContain(BRIEF_REFUSAL_CODES[reason]);
    }
    expect(GENERAL_FORM_ANSWER_ERROR_CODES).toContain("answer_kind_not_allowed");
    expect(new Set(GENERAL_FORM_ANSWER_ERROR_CODES).size).toBe(
      GENERAL_FORM_ANSWER_ERROR_CODES.length,
    );
  });
});
