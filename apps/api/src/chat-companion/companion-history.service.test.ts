import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Logger } from "@nestjs/common";
import type { NewCompanionMessage } from "@badabhai/db";
import type { CompanionTurn } from "./chat-companion.dto";
import { COMPANION_HISTORY_MAX, CompanionOpenTurnSchema } from "./chat-companion.dto";
import type { CompanionHistoryRow } from "./companion-history.repository";
import {
  COMPANION_HISTORY_WINDOW_DAYS,
  CompanionHistoryService,
  resetMissingTablesWarningForTests,
} from "./companion-history.service";
import { v2CareerAnswerTurn, v2CopyTurn } from "./v2/companion-v2-compose";
import { V2_CLARIFY } from "./companion-replies";

/**
 * #2297 (ADR-0056) — the stored conversation's POLICY over a faked repository: what is stored for a
 * turn and for a recap, what the window read returns, and that every failure — a missing table
 * above all — is "no history", never an error. The statements themselves run against Postgres in
 * `companion-history.db.test.ts`.
 */

const WORKER = "11111111-1111-4111-8111-111111111111";
const SUBMISSION = "22222222-2222-4222-8222-222222222222";
const NOW = new Date("2026-10-15T10:00:00.000Z");
const DAY_MS = 86_400_000;

/** A drizzle-wrapped Postgres error, the 0.45 shape: the SQLSTATE rides on `cause`. */
function pgError(code: string): Error {
  return Object.assign(new Error("Failed query: select ..."), {
    query: "select ...",
    params: ["worker words"],
    cause: Object.assign(new Error("relation does not exist"), { code }),
  });
}

function setup(over: Partial<Record<string, (...args: never[]) => Promise<unknown>>> = {}) {
  const repo = {
    listSince: vi.fn(async (..._args: unknown[]): Promise<CompanionHistoryRow[]> => []),
    listModelLinesSince: vi.fn(async (..._args: unknown[]) => []),
    append: vi.fn(async (lines: readonly NewCompanionMessage[]) => lines.length),
    appendIfNoneSince: vi.fn(async (..._args: unknown[]) => true),
    findLiveSummary: vi.fn(async (..._args: unknown[]) => undefined),
    upsertSummary: vi.fn(async (..._args: unknown[]) => true),
    deleteLinesBefore: vi.fn(async (..._args: unknown[]) => 0),
    deleteSummariesWithoutLinesSince: vi.fn(async (..._args: unknown[]) => 0),
    // An override stays a spy, so a test can both script it and assert on it.
    ...Object.fromEntries(Object.entries(over).map(([name, impl]) => [name, vi.fn(impl)])),
  };
  const service = new CompanionHistoryService(repo as never);
  return { repo, service };
}

function row(over: Partial<CompanionHistoryRow> = {}): CompanionHistoryRow {
  return {
    id: "33333333-3333-4333-8333-333333333333",
    role: "bada_bhai",
    bodyText: "Namaste!",
    ttsText: null,
    readAloud: null,
    suggestedOptions: null,
    suggestedFollowups: null,
    newsLinks: null,
    createdAt: new Date(NOW.getTime() - 60_000),
    ...over,
  };
}

let warn: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  resetMissingTablesWarningForTests();
  warn = vi.spyOn(Logger.prototype, "warn").mockImplementation(() => undefined);
  vi.spyOn(Logger.prototype, "error").mockImplementation(() => undefined);
});
afterEach(() => vi.restoreAllMocks());

describe("the window read", () => {
  it("asks for the last 7 days, at most 200 lines, and returns them in the repository's order", async () => {
    const h = setup({
      listSince: async () => [
        row({ id: "33333333-3333-4333-8333-333333333331", role: "worker", bodyText: "hi" }),
        row({ id: "33333333-3333-4333-8333-333333333332", bodyText: "Haan ji" }),
      ],
    });
    const read = await h.service.window(WORKER, NOW);
    expect(read.ok).toBe(true);
    if (!read.ok) return;
    expect(read.value.map((item) => item.text)).toEqual(["hi", "Haan ji"]);
    const spy = setup();
    await spy.service.window(WORKER, NOW);
    expect(spy.repo.listSince).toHaveBeenCalledWith(
      WORKER,
      new Date(NOW.getTime() - COMPANION_HISTORY_WINDOW_DAYS * DAY_MS),
      COMPANION_HISTORY_MAX,
    );
    expect(COMPANION_HISTORY_WINDOW_DAYS).toBe(7);
    expect(COMPANION_HISTORY_MAX).toBe(200);
  });

  it("maps a line to the wire: absent values OMITTED, never null", async () => {
    const h = setup({
      listSince: async () => [
        row({
          ttsText: "नमस्ते",
          suggestedOptions: [{ option_key: "k", label_text: "Chip", is_none_of_above: false }],
          suggestedFollowups: ["Chip"],
        }),
        row({
          id: "33333333-3333-4333-8333-333333333334",
          readAloud: false,
          bodyText: "Model line",
        }),
        row({ id: "33333333-3333-4333-8333-333333333335", role: "worker", bodyText: "mera sawal" }),
      ],
    });
    const read = await h.service.window(WORKER, NOW);
    if (!read.ok) throw new Error("expected ok");
    expect(read.value[0]).toEqual({
      id: "33333333-3333-4333-8333-333333333333",
      role: "bada_bhai",
      text: "Namaste!",
      tts_text: "नमस्ते",
      suggested_options: [{ option_key: "k", label_text: "Chip", is_none_of_above: false }],
      suggested_followups: ["Chip"],
      created_at: new Date(NOW.getTime() - 60_000).toISOString(),
    });
    expect(read.value[1]).toMatchObject({ read_aloud: false });
    expect(read.value[1]).not.toHaveProperty("tts_text");
    expect(read.value[2]).toEqual({
      id: "33333333-3333-4333-8333-333333333335",
      role: "worker",
      text: "mera sawal",
      created_at: new Date(NOW.getTime() - 60_000).toISOString(),
    });
  });

  it("drops a stored line the wire contract refuses, and keeps the rest", async () => {
    const h = setup({
      listSince: async () => [row({ id: "not-a-uuid" }), row()],
    });
    const read = await h.service.window(WORKER, NOW);
    if (!read.ok) throw new Error("expected ok");
    expect(read.value).toHaveLength(1);
  });

  it("an open with history validates against the open-turn schema", async () => {
    const h = setup({ listSince: async () => [row()] });
    const read = await h.service.window(WORKER, NOW);
    if (!read.ok) throw new Error("expected ok");
    const turn = { ...v2CopyTurn(V2_CLARIFY), history: read.value };
    expect(CompanionOpenTurnSchema.safeParse(turn).success).toBe(true);
  });
});

describe("DEPLOY-SAFE: a missing table (42P01) is 'no history', said once per process", () => {
  it("every read answers ok:false, and the warning is given ONCE", async () => {
    const missing = async () => {
      throw pgError("42P01");
    };
    const h = setup({
      listSince: missing,
      listModelLinesSince: missing,
      findLiveSummary: missing,
      upsertSummary: missing,
    });
    expect(await h.service.window(WORKER, NOW)).toEqual({ ok: false });
    expect(await h.service.window(WORKER, NOW)).toEqual({ ok: false });
    expect(await h.service.modelLines(WORKER, NOW, 6)).toEqual({ ok: false });
    expect(await h.service.liveSummary(WORKER, NOW)).toEqual({ ok: false });
    expect(
      await h.service.storeSummary(WORKER, { summary: "- x", foldedThrough: NOW }, false),
    ).toBe(false);
    const missingWarnings = warn.mock.calls.filter((call) =>
      String(call[0]).includes("migration 0135 not applied"),
    );
    expect(missingWarnings).toHaveLength(1);
  });

  it("any other failure is 'no history' too, logged WITHOUT the bound parameters", async () => {
    const h = setup({
      listSince: async () => {
        throw pgError("57014");
      },
    });
    expect(await h.service.window(WORKER, NOW)).toEqual({ ok: false });
    const line = String(warn.mock.calls.at(-1)?.[0]);
    expect(line).toContain("57014");
    expect(line).not.toContain("worker words");
  });

  it("the sweep reports the tables missing instead of failing", async () => {
    const h = setup({
      deleteLinesBefore: async () => {
        throw pgError("42P01");
      },
    });
    expect(await h.service.sweep(NOW)).toEqual({
      linesDeleted: 0,
      summariesDeleted: 0,
      tablesMissing: true,
    });
  });
});

describe("storing a served turn", () => {
  const card: CompanionTurn = {
    ...v2CareerAnswerTurn(["Welding mein ₹18,000 se shuru hota hai."], ["Aur batao"]),
    news_links: [{ title: "Story", url: "https://example.com/a", site: "example.com" }],
  };

  it("writes the worker's line and the reply exactly as served, the reply one millisecond later", async () => {
    const h = setup();
    h.service.keepTurn({
      workerId: WORKER,
      workerText: "  welding mein kitna milta hai  ",
      submissionId: SUBMISSION,
      turn: card,
      modelContext: true,
      at: NOW,
    });
    await h.service.idle();
    const lines = h.repo.append.mock.calls[0]![0];
    expect(lines).toEqual([
      {
        workerId: WORKER,
        role: "worker",
        bodyText: "welding mein kitna milta hai",
        submissionId: SUBMISSION,
        modelContext: true,
        createdAt: NOW,
      },
      {
        workerId: WORKER,
        role: "bada_bhai",
        bodyText: card.reply,
        ttsText: null,
        readAloud: false,
        suggestedOptions: card.suggested_options.length > 0 ? card.suggested_options : null,
        suggestedFollowups: ["Aur batao"],
        newsLinks: card.news_links,
        submissionId: SUBMISSION,
        modelContext: true,
        createdAt: new Date(NOW.getTime() + 1),
      },
    ]);
  });

  it("a fixed line keeps its read-aloud twin and its chips", async () => {
    const h = setup();
    const turn = v2CopyTurn(V2_CLARIFY, [
      { option_key: "k", label_text: "Chip", is_none_of_above: false },
    ]);
    h.service.keepTurn({
      workerId: WORKER,
      workerText: "Chip",
      submissionId: null,
      turn,
      modelContext: false,
      at: NOW,
    });
    await h.service.idle();
    const reply = h.repo.append.mock.calls[0]![0][1]!;
    expect(reply).toMatchObject({
      ttsText: V2_CLARIFY.dev,
      readAloud: null,
      suggestedOptions: [{ option_key: "k", label_text: "Chip", is_none_of_above: false }],
      suggestedFollowups: ["Chip"],
      submissionId: null,
      modelContext: false,
    });
  });

  it("runs the after-store hook only when lines were written — never on a replay", async () => {
    const after = vi.fn(async () => undefined);
    const first = setup();
    first.service.keepTurn(
      {
        workerId: WORKER,
        workerText: "x",
        submissionId: SUBMISSION,
        turn: card,
        modelContext: true,
        at: NOW,
      },
      after,
    );
    await first.service.idle();
    expect(after).toHaveBeenCalledTimes(1);

    const replay = setup({ append: async () => 0 });
    const again = vi.fn(async () => undefined);
    replay.service.keepTurn(
      {
        workerId: WORKER,
        workerText: "x",
        submissionId: SUBMISSION,
        turn: card,
        modelContext: true,
        at: NOW,
      },
      again,
    );
    await replay.service.idle();
    expect(again).not.toHaveBeenCalled();
  });

  it("NEVER FAILS A TURN: a write that throws is swallowed, and the hook does not run", async () => {
    const h = setup({
      append: async () => {
        throw pgError("53300");
      },
    });
    const after = vi.fn(async () => undefined);
    expect(() =>
      h.service.keepTurn(
        {
          workerId: WORKER,
          workerText: "x",
          submissionId: null,
          turn: card,
          modelContext: true,
          at: NOW,
        },
        after,
      ),
    ).not.toThrow();
    await h.service.idle();
    expect(after).not.toHaveBeenCalled();
  });
});

describe("storing the recap", () => {
  it("stores the recap bubble only while the worker has no line in the window", async () => {
    const h = setup();
    const recap = v2CopyTurn(V2_CLARIFY);
    h.service.keepRecap(WORKER, recap, NOW);
    await h.service.idle();
    const [line, since] = h.repo.appendIfNoneSince.mock.calls[0]!;
    expect(line).toMatchObject({
      workerId: WORKER,
      role: "bada_bhai",
      bodyText: recap.reply,
      createdAt: NOW,
    });
    expect(since).toEqual(new Date(NOW.getTime() - 7 * DAY_MS));
  });
});

describe("the retention sweep", () => {
  it("deletes in bounded batches until a short one, then the summaries without a live line", async () => {
    const batches = [5_000, 5_000, 12];
    const h = setup({
      deleteLinesBefore: async () => batches.shift() ?? 0,
      deleteSummariesWithoutLinesSince: async () => 3,
    });
    expect(await h.service.sweep(NOW)).toEqual({
      linesDeleted: 10_012,
      summariesDeleted: 3,
      tablesMissing: false,
    });
    const cutoff = new Date(NOW.getTime() - 7 * DAY_MS);
    expect(h.repo.deleteLinesBefore).toHaveBeenCalledWith(cutoff, 5_000);
    expect(h.repo.deleteSummariesWithoutLinesSince).toHaveBeenCalledWith(cutoff);
  });
});
