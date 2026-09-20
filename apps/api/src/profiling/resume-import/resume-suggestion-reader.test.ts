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

function setup(
  row:
    | {
        id?: string;
        status?: string;
        suggestionsEnc: string | null;
        identityRoleKind?: string | null;
        identityExperienceText?: string | null;
        identitySummaryText?: string | null;
      }
    | undefined,
  decrypt: (t: string) => string,
) {
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

describe("ResumeSuggestionReader.identityForChat — the staged Hinglish line", () => {
  const row = (over: Record<string, unknown> = {}) => ({
    id: IMPORT,
    status: "parsed",
    suggestionsEnc: null,
    identityRoleKind: "cnc_grinding",
    identityExperienceText: "2 saal 7 mahine ka tajurba",
    identitySummaryText: "CNC cylindrical grinder par kaam",
    ...over,
  });

  it("returns the staged line with its import id", async () => {
    const { reader } = setup(row(), () => "{}");
    await expect(reader.identityForChat(WORKER)).resolves.toEqual({
      importId: IMPORT,
      roleKind: "cnc_grinding",
      experienceText: "2 saal 7 mahine ka tajurba",
      summaryText: "CNC cylindrical grinder par kaam",
    });
  });

  it("serves a partial line — any single staged column is a bubble", async () => {
    const { reader } = setup(
      row({ identityRoleKind: null, identityExperienceText: null }),
      () => "{}",
    );
    const line = await reader.identityForChat(WORKER);
    expect(line?.summaryText).toBe("CNC cylindrical grinder par kaam");
  });

  it("null when nothing was staged, when the import is not parsed, or when it is gone", async () => {
    const { reader: empty } = setup(
      row({
        identityRoleKind: null,
        identityExperienceText: null,
        identitySummaryText: null,
      }),
      () => "{}",
    );
    await expect(empty.identityForChat(WORKER)).resolves.toBeNull();

    const { reader: parsing } = setup(row({ status: "parsing" }), () => "{}");
    await expect(parsing.identityForChat(WORKER)).resolves.toBeNull();

    const { reader: gone } = setup(undefined, () => "{}");
    await expect(gone.identityForChat(WORKER)).resolves.toBeNull();
  });

  it("is SOFT: an unreadable row degrades to null, never a throw", async () => {
    const imports = {
      findLatestForWorker: vi.fn(async () => {
        throw new Error("connection terminated unexpectedly");
      }),
    };
    const reader = new ResumeSuggestionReader(imports as never, {} as never);
    await expect(reader.identityForChat(WORKER)).resolves.toBeNull();
  });
});

describe("ResumeSuggestionReader.routeForImport — the handover lookup", () => {
  const row = (over: Record<string, unknown> = {}) => ({
    id: IMPORT,
    route: "form",
    formKind: "cnc_grinding",
    ...over,
  });

  function setupRoute(latest: unknown) {
    const imports = { findForWorker: vi.fn(async () => latest) };
    return new ResumeSuggestionReader(imports as never, {} as never);
  }

  it("returns route and form kind for the worker's own import", async () => {
    const reader = setupRoute(row());
    await expect(reader.routeForImport(WORKER, IMPORT)).resolves.toEqual({
      route: "form",
      formKind: "cnc_grinding",
    });
  });

  it("null for another worker's import id — no existence oracle", async () => {
    const reader = setupRoute(undefined);
    await expect(reader.routeForImport(WORKER, IMPORT)).resolves.toBeNull();
  });

  it("is SOFT: an unreadable row degrades to null, never a throw", async () => {
    const imports = {
      findForWorker: vi.fn(async () => {
        throw new Error("connection terminated unexpectedly");
      }),
    };
    const reader = new ResumeSuggestionReader(imports as never, {} as never);
    await expect(reader.routeForImport(WORKER, IMPORT)).resolves.toBeNull();
  });
});
