import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ReactElement, ReactNode } from "react";
import type * as ReactModule from "react";
import { createHookHarness, findByType, propsOf, textOf } from "../../../../test/hook-harness";

/**
 * #2984 §4 — the follow-up control.
 *
 * Server half: a 404 (`off`) and an empty page render NOTHING (the control hides); a 429/5xx
 * (`retry`) renders one neutral retry; a page of due contacts renders faceless rows.
 *
 * Client half: one row per due unlock, three answers; a successful answer REMOVES the row, a
 * retryable refusal keeps it (and reuses the SAME idempotency key), and a `not_found` hides the
 * whole control.
 */

const h = createHookHarness();
let refs: { current: unknown }[] = [];
let refCursor = 0;

function useRefHook<T>(initial: T): { current: T } {
  const i = refCursor++;
  if (!(i in refs)) refs[i] = { current: initial };
  return refs[i] as { current: T };
}

vi.mock("react", async () => {
  const actual = await vi.importActual<typeof ReactModule>("react");
  return {
    ...actual,
    useState: (initial: unknown) => h.useState(initial),
    useTransition: () => h.useTransition(),
    useRef: (initial: unknown) => useRefHook(initial),
  };
});

const getDueUnlockOutcomes = vi.fn();
vi.mock("../../../lib/payer-api", () => ({
  getDueUnlockOutcomes: () => getDueUnlockOutcomes(),
}));

const actions = { recordUnlockOutcomeAction: vi.fn() };
vi.mock("./actions", () => ({
  recordUnlockOutcomeAction: (input: unknown) => actions.recordUnlockOutcomeAction(input),
}));

const { UnlockFollowup } = await import("./unlock-followup");
const { UnlockFollowupList } = await import("./unlock-followup-list");
const { Button, Card } = await import("../../../components/ds");
const { RetryButton } = await import("../../../components/retry-button");

const U1 = "11111111-0000-4000-8000-000000000001";
const U2 = "22222222-0000-4000-8000-000000000002";
const ITEMS = [
  { unlockId: U1, grantedAt: "2026-10-01T09:00:00.000Z", outcome: null },
  { unlockId: U2, grantedAt: "2026-10-02T09:00:00.000Z", outcome: "still_talking" as const },
];

function button(tree: ReactNode, label: string) {
  return findByType(tree, Button).filter(
    (b) => textOf(propsOf(b).children as ReactNode).trim() === label,
  );
}

function click(el: ReactElement | undefined) {
  expect(el, "button").toBeDefined();
  (propsOf(el!).onClick as () => void)();
}

/** A fresh render frame: the hook harness resets useState order, so reset useRef order too. */
function renderList(items: typeof ITEMS): ReactNode {
  refCursor = 0;
  return h.render(UnlockFollowupList, { items }) as ReactNode;
}

let keys: string[] = [];
beforeEach(() => {
  h.reset();
  refs = [];
  refCursor = 0;
  keys = ["intent-key-1", "intent-key-2", "intent-key-3", "intent-key-4"];
  vi.stubGlobal("crypto", { randomUUID: () => keys.shift() ?? "intent-key-fallback" });
  getDueUnlockOutcomes.mockReset();
  actions.recordUnlockOutcomeAction.mockReset();
});

describe("server half — the three due-list states", () => {
  it("404 (`off`) hides the whole control", async () => {
    getDueUnlockOutcomes.mockResolvedValue({ status: "off" });
    expect(await UnlockFollowup()).toBeNull();
  });

  it("an empty page renders nothing (no empty band)", async () => {
    getDueUnlockOutcomes.mockResolvedValue({ status: "ok", items: [], nextCursor: null });
    expect(await UnlockFollowup()).toBeNull();
  });

  it("429/5xx (`retry`) renders one neutral retry, never the backend's reason", async () => {
    getDueUnlockOutcomes.mockResolvedValue({ status: "retry" });
    const tree = await UnlockFollowup();
    expect(textOf(tree)).toContain("We couldn’t load your follow-ups");
    expect(findByType(tree, RetryButton)).toHaveLength(1);
    expect(findByType(tree, Button)).toEqual([]);
    expect(textOf(tree)).not.toMatch(/429|500|502|503|payer API/);
  });

  it("a due page renders faceless rows with the date and current outcome", async () => {
    getDueUnlockOutcomes.mockResolvedValue({
      status: "ok",
      items: [
        {
          unlockId: U1,
          workerId: "worker-uuid-AAAA",
          grantedAt: "2026-10-01T09:00:00.000Z",
          outcome: null,
        },
      ],
      nextCursor: null,
    });
    const tree = await UnlockFollowup();
    expect(textOf(tree)).toContain("Did you hire this person?");
    const list = findByType(tree, UnlockFollowupList)[0]!;
    // The client is handed only what it renders: unlock id, date and outcome — never the worker.
    expect(propsOf(list).items).toEqual([
      { unlockId: U1, grantedAt: "2026-10-01T09:00:00.000Z", outcome: null },
    ]);
    expect(JSON.stringify(propsOf(list).items)).not.toContain("worker-uuid");
  });
});

describe("client half — answering removes the row", () => {
  it("a successful answer removes exactly that row", async () => {
    actions.recordUnlockOutcomeAction.mockResolvedValue({
      ok: true,
      unlockId: U1,
      outcome: "hired",
      previousOutcome: null,
      answeredAt: "2026-10-10T09:00:00.000Z",
      changed: true,
    });
    let tree = renderList(ITEMS);
    expect(findByType(tree, Card)).toHaveLength(2);

    click(button(tree, "Hired")[0]);
    await h.settle();
    tree = renderList(ITEMS);

    expect(actions.recordUnlockOutcomeAction).toHaveBeenCalledWith({
      unlockId: U1,
      outcome: "hired",
      idempotencyKey: "intent-key-1",
    });
    expect(findByType(tree, Card)).toHaveLength(1);
    expect(textOf(tree)).toContain("2026-10-02");
    expect(textOf(tree)).not.toContain("2026-10-01");
  });

  it("a retryable refusal keeps the row and reuses the SAME key on retry", async () => {
    actions.recordUnlockOutcomeAction
      .mockResolvedValueOnce({
        ok: false,
        reason: "unavailable",
        error: "Couldn’t save that answer. Please retry.",
      })
      .mockResolvedValueOnce({
        ok: true,
        unlockId: U1,
        outcome: "hired",
        previousOutcome: null,
        answeredAt: "2026-10-10T09:00:00.000Z",
        changed: true,
      });

    let tree = renderList(ITEMS);
    click(button(tree, "Hired")[0]);
    await h.settle();
    tree = renderList(ITEMS);
    expect(findByType(tree, Card)).toHaveLength(2);
    expect(textOf(tree)).toContain("Couldn’t save that answer");

    // Same answer intent: the SAME key (a lost response cannot double-write).
    click(button(tree, "Hired")[0]);
    await h.settle();
    const calls = actions.recordUnlockOutcomeAction.mock.calls.map(
      (c) => c[0] as { idempotencyKey: string },
    );
    expect(calls[0]!.idempotencyKey).toBe("intent-key-1");
    expect(calls[1]!.idempotencyKey).toBe("intent-key-1");

    tree = renderList(ITEMS);
    expect(findByType(tree, Card)).toHaveLength(1);
  });

  it("a different outcome is a new intent and mints a new key", async () => {
    actions.recordUnlockOutcomeAction.mockResolvedValue({
      ok: false,
      reason: "rate_limited",
      error: "Too many answers right now. Please try again later.",
    });
    let tree = renderList([ITEMS[0]!]);
    click(button(tree, "Hired")[0]);
    await h.settle();
    tree = renderList([ITEMS[0]!]);
    click(button(tree, "Not hired")[0]);
    await h.settle();
    const calls = actions.recordUnlockOutcomeAction.mock.calls.map(
      (c) => c[0] as { idempotencyKey: string },
    );
    expect(calls[0]!.idempotencyKey).toBe("intent-key-1");
    expect(calls[1]!.idempotencyKey).toBe("intent-key-2");
  });

  it("a `not_found` hides the whole control", async () => {
    actions.recordUnlockOutcomeAction.mockResolvedValue({
      ok: false,
      reason: "not_found",
      error: "This follow-up is no longer available.",
    });
    let tree = renderList(ITEMS);
    click(button(tree, "Still talking")[0]);
    await h.settle();
    tree = renderList(ITEMS);
    expect(tree).toBeNull();
  });
});
