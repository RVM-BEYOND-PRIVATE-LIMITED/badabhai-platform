import "reflect-metadata";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Logger } from "@nestjs/common";

import { FreeChatSummaryReader } from "./free-chat-summary.reader";

/**
 * ADR-0055 R4 — the Bada Bhai chat's READ-ONLY view of the profiling chat's rolling summary: the
 * text, or null for none, a watermark-only record, an off-shape value, or a read that throws (fail
 * soft, with a warning that names the worker id and the error class only).
 */

const WORKER = "11111111-1111-4111-8111-111111111111";
const SUMMARY = {
  v: 1,
  text: "- Welder, 5 saal tajurba, Pune mein kaam chahta hai",
  updated_at: "2026-10-10T10:00:00.000Z",
  session_id: "22222222-2222-4222-8222-222222222222",
  folded_lines: 4,
};

/** A drizzle-shaped SELECT chain that resolves `rows` (or rejects with `error`). */
function db(rows: unknown[] | Error) {
  const chain = {
    from: () => chain,
    where: () => chain,
    orderBy: () => chain,
    limit: async () => {
      if (rows instanceof Error) throw rows;
      return rows;
    },
  };
  return { select: vi.fn(() => chain) };
}

afterEach(() => vi.restoreAllMocks());

describe("FreeChatSummaryReader.latestText", () => {
  it("returns the newest stored summary's TEXT", async () => {
    const reader = new FreeChatSummaryReader(db([{ id: "s1", summary: SUMMARY }]) as never);
    expect(await reader.latestText(WORKER)).toBe(SUMMARY.text);
  });

  it("no row, a watermark-only record and an off-shape value all read as null", async () => {
    for (const rows of [
      [],
      [{ id: "s1", summary: { ...SUMMARY, text: null } }],
      [{ id: "s1", summary: "x" }],
    ]) {
      expect(await new FreeChatSummaryReader(db(rows) as never).latestText(WORKER)).toBeNull();
    }
  });

  it("a read that THROWS is null and a warning with the worker id only — never the text", async () => {
    const warn = vi.spyOn(Logger.prototype, "warn").mockImplementation(() => undefined);
    const reader = new FreeChatSummaryReader(db(new TypeError("connection reset")) as never);
    expect(await reader.latestText(WORKER)).toBeNull();
    const line = String(warn.mock.calls[0]?.[0]);
    expect(line).toContain(`worker ${WORKER}`);
    expect(line).toContain("TypeError");
    expect(line).not.toMatch(/Welder|Pune/);
  });
});
