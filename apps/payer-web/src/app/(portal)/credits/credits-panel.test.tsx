import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import type { ReactElement, ReactNode } from "react";
import type * as ReactModule from "react";
import { Button, Dialog } from "../../../components/ds";
import type { CreditPack } from "../../../lib/contracts";

/**
 * CREDITS PANEL — the per-purchase Idempotency-Key LIFECYCLE (#1165 / #1046).
 *
 * The contract these pin (the exact one the backend leans on):
 *  (a) a RETRY of the SAME purchase (same pack) reuses the SAME key → the backend dedupes a
 *      re-tap after a timeout into a replay, so the payer is charged ONCE;
 *  (b) two GENUINELY different purchases send DIFFERENT keys — a different pack, AND a repeat of
 *      the same pack AFTER a success — so a payer who really does want to buy again is unaffected.
 *
 * Env is node (no DOM), mirroring login-form.test.tsx: react hooks are mocked (useState seeded by
 * call order, useTransition runs the transition immediately, useRef returns a STABLE box so the
 * key survives re-renders exactly as it does in the browser), and `crypto.randomUUID` is stubbed
 * to a deterministic counter so key identity is assertable. The confirm handler is invoked via the
 * DS Dialog's "Add credits" footer button — the real commit point.
 */

let stateQueue: unknown[] = [];
let stateCursor = 0;
const useState = vi.fn((initial: unknown) => {
  const i = stateCursor++;
  const seeded = i < stateQueue.length ? stateQueue[i] : initial;
  return [seeded, vi.fn()] as [unknown, (v: unknown) => void];
});
const useTransition = vi.fn((): [boolean, (cb: () => void) => void] => [false, (cb) => cb()]);
// A STABLE ref box (created per test) — the useRef mock returns it on every render, so a mutation
// to `.current` persists across renders, exactly like the browser's ref semantics.
let keyBox: { current: unknown };
const useRef = vi.fn(() => keyBox);

vi.mock("react", async () => {
  const actual = await vi.importActual<typeof ReactModule>("react");
  return {
    ...actual,
    useState: (i: unknown) => useState(i),
    useTransition: () => useTransition(),
    useRef: () => useRef(),
  };
});

const routerRefresh = vi.fn();
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: routerRefresh }) }));

// Observe the Server Action; the other imports must exist so the module resolves.
const topUpAction = vi.fn();
vi.mock("./actions", () => ({
  topUpAction: (i: unknown) => topUpAction(i),
  createOrderAction: vi.fn(),
  verifyPaymentAction: vi.fn(),
}));
vi.mock("./razorpay-checkout", () => ({ loadCheckoutScript: vi.fn(), openCheckout: vi.fn() }));

const { CreditsPanel } = await import("./credits-panel");

const PACK_A: CreditPack = { code: "pack_50", priceInr: 2000, credits: 50 };
const PACK_B: CreditPack = { code: "pack_100", priceInr: 3500, credits: 100 };

function findAll(node: ReactNode, type: unknown, acc: ReactElement[] = []): ReactElement[] {
  if (node === null || node === undefined || typeof node !== "object") return acc;
  if (Array.isArray(node)) {
    node.forEach((c) => findAll(c, type, acc));
    return acc;
  }
  const el = node as ReactElement<{ children?: ReactNode }>;
  if (el.type === type) acc.push(el);
  if (el.props && "children" in el.props) findAll(el.props.children, type, acc);
  return acc;
}

function textOf(node: ReactNode): string {
  if (node === null || node === undefined || typeof node === "boolean") return "";
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(textOf).join(" ");
  const el = node as ReactElement<{ children?: ReactNode }>;
  return el.props && "children" in el.props ? textOf(el.props.children) : "";
}

/** Render with the confirm Dialog ARMED for `pack` (useState order: pendingCode, pendingConfirm, …). */
function render(pack: CreditPack): ReactElement {
  stateQueue = [null, pack, null, null, null];
  stateCursor = 0;
  return CreditsPanel({ packs: [PACK_A, PACK_B], real: false }) as ReactElement;
}

/** Arm `pack`, click the Dialog's "Add credits" (the commit), and flush the transition. */
async function confirmBuy(pack: CreditPack): Promise<void> {
  const tree = render(pack);
  const dialog = findAll(tree, Dialog)[0]!;
  const footer = (dialog.props as { footer?: ReactNode }).footer;
  const confirm = findAll(footer, Button).find((b) => textOf(b).includes("Add credits"))!;
  (confirm.props as { onClick?: () => void }).onClick?.();
  await new Promise((r) => setTimeout(r, 0)); // let the async transition continuation settle
}

/** The idempotency keys sent to the action, in call order. */
function sentKeys(): (string | undefined)[] {
  return topUpAction.mock.calls.map((c) => (c[0] as { idempotencyKey?: string }).idempotencyKey);
}

let uuidCounter = 0;

beforeEach(() => {
  useState.mockClear();
  useTransition.mockClear();
  useRef.mockClear();
  topUpAction.mockReset();
  routerRefresh.mockReset();
  keyBox = { current: null };
  uuidCounter = 0;
  vi.stubGlobal("crypto", { randomUUID: () => `key-${++uuidCounter}` });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("credits panel — ONE key per PURCHASE (a): a retry of the SAME pack reuses the SAME key", () => {
  it("two confirms of the same pack after a FAILURE send the identical Idempotency-Key", async () => {
    topUpAction.mockResolvedValue({ ok: false, error: "Top-up failed. Please retry." });
    await confirmBuy(PACK_A); // first attempt → mints key-1
    await confirmBuy(PACK_A); // retry of the SAME purchase → REUSES key-1

    expect(topUpAction).toHaveBeenCalledTimes(2);
    const keys = sentKeys();
    expect(keys[0]).toBe("key-1");
    expect(keys[1]).toBe("key-1"); // same purchase → same key → backend dedupes the re-tap
    expect(topUpAction).toHaveBeenCalledWith({ packCode: "pack_50", idempotencyKey: "key-1" });
  });
});

describe("credits panel — a genuinely NEW purchase (b) mints a FRESH key", () => {
  it("a DIFFERENT pack sends a different key (even while a prior key is still pending)", async () => {
    topUpAction.mockResolvedValue({ ok: false, error: "Top-up failed. Please retry." });
    await confirmBuy(PACK_A); // key-1
    await confirmBuy(PACK_B); // different pack → key-2
    const keys = sentKeys();
    expect(keys[0]).toBe("key-1");
    expect(keys[1]).toBe("key-2");
    expect(keys[0]).not.toBe(keys[1]);
  });

  it("a repeat of the SAME pack AFTER a success mints a fresh key (a real second purchase)", async () => {
    topUpAction.mockResolvedValueOnce({ ok: true, balance: 60, creditsAdded: 50 }); // success → key cleared
    await confirmBuy(PACK_A); // key-1, then the purchase is DONE
    topUpAction.mockResolvedValueOnce({ ok: true, balance: 110, creditsAdded: 50 });
    await confirmBuy(PACK_A); // a NEW purchase of the same pack → key-2

    const keys = sentKeys();
    expect(keys[0]).toBe("key-1");
    expect(keys[1]).toBe("key-2"); // NOT reused across a success — the payer wanted to buy again
    expect(keys[0]).not.toBe(keys[1]);
  });
});
