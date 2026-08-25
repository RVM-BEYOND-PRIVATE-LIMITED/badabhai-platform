import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import type { ReactElement, ReactNode } from "react";
import type * as ReactModule from "react";
import { Button, Dialog } from "../../../components/ds";
import type { CapacityTier } from "./capacity-panel";

/**
 * CAPACITY PANEL — the per-purchase Idempotency-Key LIFECYCLE (#1165 / #1148).
 *
 * A duplicate capacity purchase is WORSE than a duplicate pack: `greatest()` grants no extra
 * allowance but re-fires the payment/coupon spine. So the same contract is pinned here:
 *  (a) a RETRY of the SAME tier reuses the SAME key (a re-tap dedupes to a replay);
 *  (b) a DIFFERENT tier, and a repeat of the same tier AFTER a success, mint FRESH keys.
 *
 * Same node-env manual harness as credits-panel.test.tsx (mocked hooks + stubbed randomUUID);
 * the confirm handler is driven through the DS Dialog's "Upgrade" footer button.
 */

let stateQueue: unknown[] = [];
let stateCursor = 0;
const useState = vi.fn((initial: unknown) => {
  const i = stateCursor++;
  const seeded = i < stateQueue.length ? stateQueue[i] : initial;
  return [seeded, vi.fn()] as [unknown, (v: unknown) => void];
});
const useTransition = vi.fn((): [boolean, (cb: () => void) => void] => [false, (cb) => cb()]);
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

const upgradeCapacityAction = vi.fn();
vi.mock("./actions", () => ({ upgradeCapacityAction: (i: unknown) => upgradeCapacityAction(i) }));

const { CapacityPanel } = await import("./capacity-panel");

const TIER_A: CapacityTier = { code: "starter", priceInr: 999, maxActiveVacancies: 5 };
const TIER_B: CapacityTier = { code: "growth", priceInr: 4999, maxActiveVacancies: 10 };

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

/** Render with the confirm Dialog ARMED for `tier` (useState order: pendingCode, pendingConfirm, …). */
function render(tier: CapacityTier): ReactElement {
  stateQueue = [null, tier, null, null];
  stateCursor = 0;
  return CapacityPanel({ tiers: [TIER_A, TIER_B] }) as ReactElement;
}

/** Arm `tier`, click the Dialog's "Upgrade" (the commit), and flush the transition. */
async function confirmUpgrade(tier: CapacityTier): Promise<void> {
  const tree = render(tier);
  const dialog = findAll(tree, Dialog)[0]!;
  const footer = (dialog.props as { footer?: ReactNode }).footer;
  const confirm = findAll(footer, Button).find((b) => textOf(b).includes("Upgrade"))!;
  (confirm.props as { onClick?: () => void }).onClick?.();
  await new Promise((r) => setTimeout(r, 0));
}

function sentKeys(): (string | undefined)[] {
  return upgradeCapacityAction.mock.calls.map(
    (c) => (c[0] as { idempotencyKey?: string }).idempotencyKey,
  );
}

let uuidCounter = 0;

beforeEach(() => {
  useState.mockClear();
  useTransition.mockClear();
  useRef.mockClear();
  upgradeCapacityAction.mockReset();
  routerRefresh.mockReset();
  keyBox = { current: null };
  uuidCounter = 0;
  vi.stubGlobal("crypto", { randomUUID: () => `key-${++uuidCounter}` });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("capacity panel — ONE key per PURCHASE (a): a retry of the SAME tier reuses the SAME key", () => {
  it("two confirms of the same tier after a FAILURE send the identical Idempotency-Key", async () => {
    upgradeCapacityAction.mockResolvedValue({ ok: false, error: "Capacity upgrade failed. Please retry." });
    await confirmUpgrade(TIER_B); // key-1
    await confirmUpgrade(TIER_B); // retry of the SAME purchase → key-1

    expect(upgradeCapacityAction).toHaveBeenCalledTimes(2);
    const keys = sentKeys();
    expect(keys[0]).toBe("key-1");
    expect(keys[1]).toBe("key-1");
    expect(upgradeCapacityAction).toHaveBeenCalledWith({ tier: "growth", idempotencyKey: "key-1" });
  });
});

describe("capacity panel — a genuinely NEW purchase (b) mints a FRESH key", () => {
  it("a DIFFERENT tier sends a different key (even while a prior key is still pending)", async () => {
    upgradeCapacityAction.mockResolvedValue({ ok: false, error: "Capacity upgrade failed. Please retry." });
    await confirmUpgrade(TIER_A); // key-1
    await confirmUpgrade(TIER_B); // different tier → key-2
    const keys = sentKeys();
    expect(keys[0]).toBe("key-1");
    expect(keys[1]).toBe("key-2");
    expect(keys[0]).not.toBe(keys[1]);
  });

  it("a repeat of the SAME tier AFTER a success mints a fresh key (a real second purchase)", async () => {
    upgradeCapacityAction.mockResolvedValueOnce({ ok: true, resumedCount: 1, allowance: 10 });
    await confirmUpgrade(TIER_B); // key-1, purchase DONE
    upgradeCapacityAction.mockResolvedValueOnce({ ok: true, resumedCount: 0, allowance: 10 });
    await confirmUpgrade(TIER_B); // NEW purchase → key-2
    const keys = sentKeys();
    expect(keys[0]).toBe("key-1");
    expect(keys[1]).toBe("key-2");
    expect(keys[0]).not.toBe(keys[1]);
  });
});
