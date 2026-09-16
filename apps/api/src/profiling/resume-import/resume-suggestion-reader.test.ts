import { describe, expect, it, vi } from "vitest";

import type { EmploymentSuggestion } from "../../profiles/employment-suggestions";
import { ResumeSuggestionReader, type ResumeSuggestion } from "./resume-suggestion-reader";

const WORKER = "11111111-1111-4111-8111-111111111111";
const IMPORT = "22222222-2222-4222-8222-222222222222";

const answerSuggestion: ResumeSuggestion = {
  values: { option_keys: [], text: "CNC Turner", number: null, bool: null },
  source: "resume",
  confidence: 0.9,
};

const employmentSuggestion: EmploymentSuggestion = {
  source: "resume",
  values: {
    employer_name: "Sandhar Technologies",
    employer_city: null,
    role_label: "CNC Operator",
    start_ym: null,
    end_ym: null,
    work_done: null,
  },
};

function setup(row: { suggestionsEnc: string | null } | undefined, decrypt: (t: string) => string) {
  const imports = {
    findForWorker: vi.fn(async (_id: string, _w: string) => row),
    findLatestForWorker: vi.fn(async (_w: string) => row),
  };
  const crypto = { decrypt: vi.fn(decrypt) };
  const reader = new ResumeSuggestionReader(imports as never, crypto as never);
  return { reader, imports, crypto };
}

describe("ResumeSuggestionReader — the two-shape envelope (chat-jobs prefill)", () => {
  it("a NEW-shape envelope ({answers, employments}) yields both halves correctly", async () => {
    const token = "enc-token";
    const plaintext = JSON.stringify({
      answers: { primary_trade: answerSuggestion },
      employments: [employmentSuggestion],
    });
    const { reader } = setup({ suggestionsEnc: token }, () => plaintext);

    const answers = await reader.forWorker(WORKER);
    expect(answers.get("primary_trade")).toEqual(answerSuggestion);

    const employments = await reader.employmentSuggestionsForWorker(WORKER);
    expect(employments).toEqual([employmentSuggestion]);
  });

  it("a LEGACY flat-map envelope (no `answers` wrapper) still decodes answers, and yields zero employments", async () => {
    const token = "enc-token";
    // Exactly what `ResumeRouteService` wrote before this change — no wrapper at all.
    const plaintext = JSON.stringify({ primary_trade: answerSuggestion });
    const { reader } = setup({ suggestionsEnc: token }, () => plaintext);

    const answers = await reader.forWorker(WORKER);
    expect(answers.get("primary_trade")).toEqual(answerSuggestion);

    const employments = await reader.employmentSuggestionsForWorker(WORKER);
    expect(employments).toEqual([]);
  });

  it("employmentSuggestionsForWorker is SOFT: a decrypt failure degrades to zero, never a throw", async () => {
    const { reader } = setup({ suggestionsEnc: "token" }, () => {
      throw new Error("unsupported state or unable to authenticate data");
    });
    await expect(reader.employmentSuggestionsForWorker(WORKER)).resolves.toEqual([]);
  });

  it("no import row at all is zero employments, not an error", async () => {
    const { reader } = setup(undefined, () => "{}");
    await expect(reader.employmentSuggestionsForWorker(WORKER)).resolves.toEqual([]);
  });

  it("a malformed employments entry is dropped, not passed through", async () => {
    const token = "enc-token";
    const plaintext = JSON.stringify({
      answers: {},
      employments: [
        employmentSuggestion,
        { source: "not-a-real-source", values: {} },
        { source: "resume" }, // no `values` at all
      ],
    });
    const { reader } = setup({ suggestionsEnc: token }, () => plaintext);

    const employments = await reader.employmentSuggestionsForWorker(WORKER);
    expect(employments).toEqual([employmentSuggestion]);
  });

  it("forImport reads the NEW-shape envelope's answers only, exactly as before", async () => {
    const token = "enc-token";
    const plaintext = JSON.stringify({
      answers: { primary_trade: answerSuggestion },
      employments: [employmentSuggestion],
    });
    const { reader, imports } = setup({ suggestionsEnc: token }, () => plaintext);

    const answers = await reader.forImport(WORKER, IMPORT);
    expect(imports.findForWorker).toHaveBeenCalledWith(IMPORT, WORKER);
    expect(answers.get("primary_trade")).toEqual(answerSuggestion);
  });
});
