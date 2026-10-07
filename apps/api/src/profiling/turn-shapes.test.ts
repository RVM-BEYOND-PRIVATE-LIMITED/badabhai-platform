import type { QuestionPackItem } from "@badabhai/ai-contracts";
import { describe, expect, it, vi } from "vitest";

import { emptyProfilingEnvelope, type ProfilingEnvelope } from "./conversation-state";
import { RESUME_CONFIRM_OPTIONS } from "./resume-confirm";
import { RESUME_IDENTITY_OPTIONS, type IdentitySummary } from "./resume-import/resume-identity";
import type { ResumeSuggestion } from "./resume-import/resume-suggestions";
import { importOpening, type ImportOpeningReads } from "./turn-shapes";

/**
 * #2052 — `importOpening`, the résumé-import half of a session's next opening, shared by the
 * identity intake's handoff and the free chat's opener. The free-chat orchestrator and wire tests
 * pin what each caller serves; this pins the READ ORDER both callers relied on: the identity line
 * first, and the pending import only when no identity turn is served and no confirm is recorded.
 */

const item = (
  questionKey: string,
  targetField: string,
  displayOrder: number,
): QuestionPackItem => ({
  question_key: questionKey,
  prompt_text: questionKey,
  display_order: displayOrder,
  target_kind: "attribute",
  target_field: targetField,
  target_skill_id: null,
  answer_type: "number",
  is_mandatory: true,
  is_core: false,
  max_asks: 2,
  min_turn: null,
  max_turn: null,
  ask_if: null,
  skip_if: null,
  parent_item_key: null,
  retry_text: null,
  why_text: null,
  options: [],
});

const ITEMS: QuestionPackItem[] = [item("experience_years", "experience_years", 1)];
const IMPORT_ID = "11111111-1111-4111-8111-111111111111";
const LINE: IdentitySummary = {
  importId: IMPORT_ID,
  roleKind: null,
  experienceText: "6 saal",
  summaryText: null,
};
const SUGGESTION: ResumeSuggestion = {
  values: { option_keys: [], text: null, number: 6, bool: null },
  source: "resume",
  confidence: 0.9,
};

function reads(
  line: IdentitySummary | null,
  suggestions: ReadonlyMap<string, ResumeSuggestion> | null,
): ImportOpeningReads & {
  identity: ReturnType<typeof vi.fn>;
  pendingImport: ReturnType<typeof vi.fn>;
} {
  return {
    identity: vi.fn(async () => line),
    pendingImport: vi.fn(async () =>
      suggestions === null ? null : { importId: IMPORT_ID, suggestions },
    ),
  };
}

const base = (patch: Partial<ProfilingEnvelope> = {}): ProfilingEnvelope => ({
  ...emptyProfilingEnvelope(),
  ...patch,
});

describe("importOpening (#2052)", () => {
  it("serves the identity turn first and never reads the pending import", async () => {
    const r = reads(LINE, new Map([["experience_years", SUGGESTION]]));
    const opening = await importOpening(base(), r, ITEMS, ITEMS);
    expect(opening?.envelope.resumeIdentity).toEqual({ importId: IMPORT_ID, state: "pending" });
    expect(opening?.envelope.engineAsks).toBe(base().engineAsks + 1);
    expect(opening?.envelope.servedQuestionKey).toBeNull();
    expect(opening?.fields.options).toEqual([...RESUME_IDENTITY_OPTIONS]);
    expect(r.identity).toHaveBeenCalledTimes(1);
    expect(r.pendingImport).not.toHaveBeenCalled();
  });

  it("falls through to the batch-confirm once the line has been asked about", async () => {
    const r = reads(LINE, new Map([["experience_years", SUGGESTION]]));
    const opening = await importOpening(
      base({ resumeIdentity: { importId: IMPORT_ID, state: "settled" } }),
      r,
      ITEMS,
      ITEMS,
    );
    expect(opening?.envelope.resumeConfirm).toEqual({ importId: IMPORT_ID, state: "pending" });
    expect(opening?.fields.options).toEqual([...RESUME_CONFIRM_OPTIONS]);
    expect(r.pendingImport).toHaveBeenCalledTimes(1);
  });

  it("reads no pending import once a confirm is recorded", async () => {
    const r = reads(null, new Map([["experience_years", SUGGESTION]]));
    const opening = await importOpening(
      base({ resumeConfirm: { importId: IMPORT_ID, state: "settled" } }),
      r,
      ITEMS,
      ITEMS,
    );
    expect(opening).toBeNull();
    expect(r.pendingImport).not.toHaveBeenCalled();
  });

  it("serves nothing when the pending import has nothing left to confirm", async () => {
    const r = reads(null, new Map());
    expect(await importOpening(base(), r, ITEMS, ITEMS)).toBeNull();
    expect(r.pendingImport).toHaveBeenCalledTimes(1);
  });
});
