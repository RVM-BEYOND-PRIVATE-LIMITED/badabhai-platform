import { describe, expect, it, vi } from "vitest";
import {
  REASON_CATEGORIES,
  REASON_MIN_CHARS,
  confirmBlockers,
  reasonLongEnough,
  runReversible,
  toConfirmReason,
  typedNameMatches,
} from "./confirm-tiers";

/** A5 (#2575) — the three confirmation tiers' gates. */
const GOOD_REASON = "Repeated fake postings reported";

describe("T2 consequential — a category and a reason of at least 15 characters", () => {
  it("the minimum is 15, counted after trimming", () => {
    expect(REASON_MIN_CHARS).toBe(15);
    expect(reasonLongEnough("a".repeat(15))).toBe(true);
    expect(reasonLongEnough("a".repeat(14))).toBe(false);
    expect(reasonLongEnough(`  ${"a".repeat(14)}   `)).toBe(false);
  });

  it("blocks until both are given, naming the first missing one", () => {
    const empty = { category: "", reason: "", typedName: "" };
    expect(confirmBlockers("consequential", empty, REASON_CATEGORIES)).toEqual([
      "Choose a reason category.",
      "Explain the reason in at least 15 characters.",
    ]);
    expect(
      confirmBlockers("consequential", { ...empty, category: "fraud" }, REASON_CATEGORIES),
    ).toEqual(["Explain the reason in at least 15 characters."]);
    expect(
      confirmBlockers(
        "consequential",
        { ...empty, category: "fraud", reason: GOOD_REASON },
        REASON_CATEGORIES,
      ),
    ).toEqual([]);
  });

  it("a category outside the offered list does not count", () => {
    expect(
      confirmBlockers(
        "consequential",
        { category: "made-up", reason: GOOD_REASON, typedName: "" },
        REASON_CATEGORIES,
      ),
    ).toEqual(["Choose a reason category."]);
  });

  it("never asks for a typed name", () => {
    expect(
      confirmBlockers(
        "consequential",
        { category: "fraud", reason: GOOD_REASON, typedName: "" },
        REASON_CATEGORIES,
        "Acme Steel",
      ),
    ).toEqual([]);
  });

  it("hands the action the category and the trimmed reason", () => {
    expect(
      toConfirmReason({ category: "fraud", reason: `  ${GOOD_REASON} `, typedName: "x" }),
    ).toEqual({ category: "fraud", text: GOOD_REASON });
  });
});

describe("T3 destructive — T2 plus typing the target's name", () => {
  const ready = { category: "security", reason: GOOD_REASON };

  it("blocks until the name is typed exactly", () => {
    expect(
      confirmBlockers("destructive", { ...ready, typedName: "" }, REASON_CATEGORIES, "Acme Steel"),
    ).toEqual(["Type the name exactly to confirm."]);
    expect(
      confirmBlockers(
        "destructive",
        { ...ready, typedName: "acme steel" },
        REASON_CATEGORIES,
        "Acme Steel",
      ),
    ).toEqual(["Type the name exactly to confirm."]);
    expect(
      confirmBlockers(
        "destructive",
        { ...ready, typedName: " Acme Steel " },
        REASON_CATEGORIES,
        "Acme Steel",
      ),
    ).toEqual([]);
  });

  it("still needs the T2 reason", () => {
    expect(
      confirmBlockers(
        "destructive",
        { category: "", reason: "", typedName: "Acme Steel" },
        REASON_CATEGORIES,
        "Acme Steel",
      ),
    ).toHaveLength(2);
  });

  it("an empty target name can never be matched", () => {
    expect(typedNameMatches("", "")).toBe(false);
    expect(typedNameMatches("  ", " ")).toBe(false);
  });
});

describe("T1 reversible — act at once, then an Undo toast", () => {
  const ok = { ok: true as const, changed: true, message: "" };

  it("acts immediately and offers Undo with the done message", async () => {
    const act = vi.fn(async () => ok);
    const undo = vi.fn(async () => ok);
    const show = vi.fn();
    const outcome = await runReversible({
      act,
      undo,
      doneMessage: "Posting hidden",
      undoneMessage: "Posting shown again",
      show,
    });
    expect(outcome).toBe(ok);
    expect(act).toHaveBeenCalledTimes(1);
    expect(undo).not.toHaveBeenCalled();
    expect(show).toHaveBeenCalledWith(
      expect.objectContaining({
        message: "Posting hidden",
        tone: "success",
        undo: expect.any(Function),
      }),
    );
  });

  it("Undo runs the inverse and reports it", async () => {
    const undo = vi.fn(async () => ok);
    const show = vi.fn();
    await runReversible({
      act: async () => ok,
      undo,
      doneMessage: "Posting hidden",
      undoneMessage: "Posting shown again",
      show,
    });
    show.mock.calls[0]![0].undo();
    await vi.waitFor(() =>
      expect(show).toHaveBeenLastCalledWith({ message: "Posting shown again", tone: "info" }),
    );
    expect(undo).toHaveBeenCalledTimes(1);
  });

  it("a failed Undo says why", async () => {
    const show = vi.fn();
    await runReversible({
      act: async () => ok,
      undo: async () => ({ ok: false, error: "Posting already closed." }),
      doneMessage: "Posting hidden",
      undoneMessage: "Posting shown again",
      show,
    });
    show.mock.calls[0]![0].undo();
    await vi.waitFor(() =>
      expect(show).toHaveBeenLastCalledWith({ message: "Posting already closed.", tone: "danger" }),
    );
  });

  it("a failed action shows the server's text and offers no Undo", async () => {
    const show = vi.fn();
    const undo = vi.fn();
    const outcome = await runReversible({
      act: async () => ({ ok: false, error: "Not found." }),
      undo,
      doneMessage: "Posting hidden",
      undoneMessage: "Posting shown again",
      show,
    });
    expect(outcome.ok).toBe(false);
    expect(show).toHaveBeenCalledTimes(1);
    expect(show).toHaveBeenCalledWith({ message: "Not found.", tone: "danger" });
    expect(undo).not.toHaveBeenCalled();
  });
});
