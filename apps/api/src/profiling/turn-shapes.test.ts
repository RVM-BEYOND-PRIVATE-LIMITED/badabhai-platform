import type { QuestionPackItem } from "@badabhai/ai-contracts";
import { describe, expect, it, vi } from "vitest";

import { emptyProfilingEnvelope, type ProfilingEnvelope } from "./conversation-state";
import { RESUME_CONFIRM_OPTIONS } from "./resume-confirm";
import { RESUME_IDENTITY_OPTIONS, type IdentitySummary } from "./resume-import/resume-identity";
import type { ResumeSuggestion } from "./resume-import/resume-suggestions";
import { identityFactsFor, importOpening, type ImportOpeningReads } from "./turn-shapes";

/**
 * #2052 — `importOpening`, the résumé-import half of a session's next opening, shared by the
 * identity intake's handoff and the free chat's opener. The free-chat orchestrator and wire tests
 * pin what each caller serves; this pins the READ ORDER both callers relied on: the identity line
 * first, and the batch-confirm only when no identity turn is served and no confirm is recorded.
 *
 * #2366 — when the identity turn IS served, the pending import is still read (once) to enrich
 * its bubble with every confirmable fact from the SAME import.
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
  pendingImportId: string = IMPORT_ID,
): ImportOpeningReads & {
  identity: ReturnType<typeof vi.fn>;
  pendingImport: ReturnType<typeof vi.fn>;
} {
  return {
    identity: vi.fn(async () => line),
    pendingImport: vi.fn(async () =>
      suggestions === null ? null : { importId: pendingImportId, suggestions },
    ),
  };
}

const base = (patch: Partial<ProfilingEnvelope> = {}): ProfilingEnvelope => ({
  ...emptyProfilingEnvelope(),
  ...patch,
});

describe("importOpening (#2052)", () => {
  it("serves the identity turn first, enriched with the same import's facts (#2366)", async () => {
    const r = reads(LINE, new Map([["experience_years", SUGGESTION]]));
    const opening = await importOpening(base(), r, ITEMS, ITEMS);
    expect(opening?.envelope.resumeIdentity).toEqual({ importId: IMPORT_ID, state: "pending" });
    expect(opening?.envelope.engineAsks).toBe(base().engineAsks + 1);
    expect(opening?.envelope.servedQuestionKey).toBeNull();
    expect(opening?.fields.options).toEqual([...RESUME_IDENTITY_OPTIONS]);
    expect(r.identity).toHaveBeenCalledTimes(1);
    expect(r.pendingImport).toHaveBeenCalledTimes(1);
    // The "6" is the confirmable experience fact; the question and chips stay the identity's.
    expect(opening?.fields.reply).toBe("Resume se ye mila: 6 saal. 6 Kya ye aap hi hain?");
  });

  it("serves the short identity bubble when the pending import names another document (#2366)", async () => {
    const r = reads(
      LINE,
      new Map([["experience_years", SUGGESTION]]),
      "22222222-2222-4222-8222-222222222222",
    );
    const opening = await importOpening(base(), r, ITEMS, ITEMS);
    expect(opening?.fields.reply).toBe("Resume se ye mila: 6 saal. Kya ye aap hi hain?");
    expect(opening?.fields.options).toEqual([...RESUME_IDENTITY_OPTIONS]);
  });

  it("serves the short identity bubble when there is no pending import (#2366)", async () => {
    const r = reads(LINE, null);
    const opening = await importOpening(base(), r, ITEMS, ITEMS);
    expect(opening?.fields.reply).toBe("Resume se ye mila: 6 saal. Kya ye aap hi hain?");
    expect(opening?.fields.options).toEqual([...RESUME_IDENTITY_OPTIONS]);
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

describe("identityFactsFor (#2366)", () => {
  const facts = [
    { questionKey: "experience_years", targetField: "experience_years", valueNormalized: 6, display: "6" },
  ] as const;
  it("returns the pending facts only for the same import", () => {
    expect(identityFactsFor(LINE, { importId: IMPORT_ID, facts: [...facts] })).toEqual([...facts]);
    expect(
      identityFactsFor(LINE, {
        importId: "22222222-2222-4222-8222-222222222222",
        facts: [...facts],
      }),
    ).toEqual([]);
    expect(identityFactsFor(LINE, null)).toEqual([]);
  });
});
