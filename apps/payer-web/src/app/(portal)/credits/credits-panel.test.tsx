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
// The setter for each useState slot from the LAST render, so a test can assert WHICH toast a
// handler set. useState order in credits-panel: 0 pendingCode, 1 pendingConfirm, 2 message,
// 3 notice, 4 error.
let stateSetters: ReturnType<typeof vi.fn>[] = [];
const MESSAGE_IDX = 2;
const NOTICE_IDX = 3;
const ERROR_IDX = 4;
const useState = vi.fn((initial: unknown) => {
  const i = stateCursor++;
  const seeded = i < stateQueue.length ? stateQueue[i] : initial;
  const setter = vi.fn();
  stateSetters[i] = setter;
  return [seeded, setter] as [unknown, (v: unknown) => void];
});
/** The first argument of every call to a captured setter, in order. */
function argsOf(setter: ReturnType<typeof vi.fn>): unknown[] {
  return setter.mock.calls.map((c) => c[0]);
}
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
  stateSetters = [];
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

/**
 * A 409 = PENDING, not done (#1185). The action now returns a NON-terminal `{ ok:false, pending:true }`
 * for a duplicate-in-flight 409. The panel must render it as a NEUTRAL processing notice (never a
 * success toast) and must KEEP the idempotency key so a re-tap replays it — clearing it here would
 * mint a new key and could double-charge (the regression #1178 fixed).
 */
describe("credits panel — a 409 PENDING is honest + KEEPS the key (#1185)", () => {
  it("does NOT clear the key on a pending 409 — a re-tap reuses the SAME key", async () => {
    topUpAction.mockResolvedValue({ ok: false, pending: true, balance: 71 });
    await confirmBuy(PACK_A); // key-1, pending (outcome unknown)
    await confirmBuy(PACK_A); // re-tap of the SAME purchase → REUSES key-1 (backend dedupes)

    const keys = sentKeys();
    expect(keys[0]).toBe("key-1");
    expect(keys[1]).toBe("key-1"); // pending is non-terminal → the key survives, no double-charge
  });

  it("renders a NEUTRAL processing notice, never a success or error toast", async () => {
    topUpAction.mockResolvedValue({ ok: false, pending: true, balance: 71 });
    await confirmBuy(PACK_A);

    // The processing notice is set (the neutral toast)…
    expect(argsOf(stateSetters[NOTICE_IDX]!)).toContainEqual(
      expect.stringContaining("still processing"),
    );
    // …and NEITHER the success message NOR the error toast is ever set (only the reset-to-null).
    expect(argsOf(stateSetters[MESSAGE_IDX]!)).toEqual([null]);
    expect(argsOf(stateSetters[ERROR_IDX]!)).toEqual([null]);
  });
});
