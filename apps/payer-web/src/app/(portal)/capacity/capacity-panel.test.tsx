import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import type { ReactElement, ReactNode } from "react";
import type * as ReactModule from "react";
import { Button, Dialog } from "../../../components/ds";
import { ConfirmSpendDialog } from "../../../components/unlock";
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
 * the confirm handler is driven through the DS Dialog's "Upgrade" footer button. Refs persist by
 * call order (slot 0 the purchase key, slot 1 where focus returns) and effects are collected per
 * render, to be run by hand as React would after a commit.
 */

let stateQueue: unknown[] = [];
let stateCursor = 0;
// The setter for each useState slot from the LAST render, so a test can assert WHICH toast a
// handler set. useState order in capacity-panel: 0 pendingCode, 1 pendingConfirm, 2 message,
// 3 error, 4 notice.
let stateSetters: ReturnType<typeof vi.fn>[] = [];
const MESSAGE_IDX = 2;
const ERROR_IDX = 3;
const NOTICE_IDX = 4;
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
// One STABLE ref box per call order (created per test), so a mutation to `.current` persists
// across renders exactly like the browser's ref semantics.
let refs: Array<{ current: unknown }> = [];
let refCursor = 0;
const useRef = vi.fn((init: unknown) => {
  const i = refCursor++;
  refs[i] ??= { current: init };
  return refs[i];
});
let effects: Array<() => void | (() => void)> = [];

vi.mock("react", async () => {
  const actual = await vi.importActual<typeof ReactModule>("react");
  return {
    ...actual,
    useState: (i: unknown) => useState(i),
    useTransition: () => useTransition(),
    useRef: (init: unknown) => useRef(init),
    useEffect: (fn: () => void | (() => void)) => {
      effects.push(fn);
    },
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
function render(tier: CapacityTier | null, pendingCode: string | null = null): ReactElement {
  stateQueue = [pendingCode, tier, null, null];
  stateCursor = 0;
  refCursor = 0;
  effects = [];
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
  stateSetters = [];
  upgradeCapacityAction.mockReset();
  routerRefresh.mockReset();
  refs = [];
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

/**
 * A 409 = PENDING, not done (#1185). The action returns a NON-terminal `{ ok:false, pending:true }`
 * for a duplicate-in-flight 409. The panel must render it as a NEUTRAL processing notice (never a
 * success toast) and must KEEP the idempotency key so a re-tap replays it — clearing it here would
 * mint a new key and could double-fire the payment/coupon spine (the regression #1178 fixed).
 */
describe("capacity panel — a 409 PENDING is honest + KEEPS the key (#1185)", () => {
  it("does NOT clear the key on a pending 409 — a re-tap reuses the SAME key", async () => {
    upgradeCapacityAction.mockResolvedValue({ ok: false, pending: true, allowance: 10 });
    await confirmUpgrade(TIER_B); // key-1, pending (outcome unknown)
    await confirmUpgrade(TIER_B); // re-tap of the SAME purchase → REUSES key-1 (backend dedupes)

    const keys = sentKeys();
    expect(keys[0]).toBe("key-1");
    expect(keys[1]).toBe("key-1"); // pending is non-terminal → the key survives, no double-fire
  });

  it("renders a NEUTRAL processing notice, never a success or error toast", async () => {
    upgradeCapacityAction.mockResolvedValue({ ok: false, pending: true, allowance: 10 });
    await confirmUpgrade(TIER_B);

    // The processing notice is set (the neutral toast)…
    expect(argsOf(stateSetters[NOTICE_IDX]!)).toContainEqual(
      expect.stringContaining("still processing"),
    );
    // …and NEITHER the success message NOR the error toast is ever set (only the reset-to-null).
    expect(argsOf(stateSetters[MESSAGE_IDX]!)).toEqual([null]);
    expect(argsOf(stateSetters[ERROR_IDX]!)).toEqual([null]);
  });
});

/**
 * OWNER RULINGS 2026-10-07 — "one tap should have a price shown with confirmation" (F11) and "mock
 * wording is not needing on plans and credit" (F35). Each tier's trigger carries its price; it opens
 * the GENERIC DS Dialog (never a ConfirmSpendDialog — the app keeps exactly one, the unlock's), which
 * says what is bought, the price and that it is charged now, with Cancel and a priced confirm. Only
 * that confirm sends the upgrade. No "mock" copy anywhere. Who may buy is unchanged.
 */
describe("capacity panel — the price is on the trigger, and the confirm says what is charged", () => {
  /** Every tier trigger's text / spinner / disabled, in order. */
  const triggers = (tree: ReactElement) =>
    findAll(tree, Button)
      .filter((b) => (b.props as { block?: boolean }).block === true)
      .map((b) => {
        const p = b.props as { loading?: boolean; disabled?: boolean; id?: string };
        return {
          text: textOf(b).replace(/\s+/g, " ").trim(),
          loading: p.loading === true,
          disabled: p.disabled === true,
          id: p.id,
        };
      });
  const dialogOf = (tree: ReactElement) => {
    const found = findAll(tree, Dialog);
    expect(found).toHaveLength(1);
    return found[0]!;
  };
  const footer = (dialog: ReactElement) =>
    findAll((dialog.props as { footer?: ReactNode }).footer, Button).map((b) => ({
      text: textOf(b).replace(/\s+/g, " ").trim(),
      variant: (b.props as { variant?: string }).variant,
      onClick: (b.props as { onClick: () => void }).onClick,
    }));

  /** Tap the tier button whose face carries `price`. */
  const tapTier = (tree: ReactElement, price: string) =>
    (
      findAll(tree, Button).find((b) => textOf(b).includes(price))!.props as {
        onClick: () => void;
      }
    ).onClick();

  it("each tier's button reads plainly and carries its price (₹ in mono)", () => {
    const tree = render(null);
    expect(triggers(tree).map((t) => t.text)).toEqual(["Upgrade · ₹999", "Upgrade · ₹4,999"]);
    const mono = findAll(tree, Button)
      .flatMap((b) => findAll(b, "span"))
      .filter((s) => (s.props as { className?: string }).className === "bb-mono")
      .map((s) => textOf(s));
    expect(mono).toEqual(["₹999", "₹4,999"]);
  });

  it("tapping a tier opens the confirm — nothing is sent", () => {
    const tree = render(null);
    tapTier(tree, "₹4,999");
    expect(upgradeCapacityAction).not.toHaveBeenCalled();
    expect(stateSetters[1]).toHaveBeenCalledWith(TIER_B);
  });

  it("the confirm is the generic Dialog: what is bought, the price, charged now — Cancel + a priced confirm", () => {
    const tree = render(TIER_B);
    expect(findAll(tree, ConfirmSpendDialog)).toEqual([]);
    const dialog = dialogOf(tree);
    const props = dialog.props as { open: boolean; title?: ReactNode; children?: ReactNode };
    expect(props.open).toBe(true);
    expect(textOf(props.title)).toBe("Upgrade capacity?");
    const body = textOf(props.children).replace(/\s+/g, " ");
    expect(body).toContain("10 -posting tier");
    expect(body).toContain("₹4,999 is charged now");
    expect(footer(dialog).map((b) => [b.text, b.variant])).toEqual([
      ["Cancel", "ghost"],
      ["Upgrade · ₹4,999", "primary"],
    ]);
  });

  it("Cancel (and Esc / the scrim / the close button — onClose) closes it and sends nothing", () => {
    const dialog = dialogOf(render(TIER_B));
    footer(dialog)[0]!.onClick();
    (dialog.props as { onClose: () => void }).onClose();
    expect(argsOf(stateSetters[1]!)).toEqual([null, null]);
    expect(stateSetters[0]).not.toHaveBeenCalled();
    expect(upgradeCapacityAction).not.toHaveBeenCalled();
  });

  it("only the confirm sends — ONCE, the tier code and a purchase key, never a price", async () => {
    upgradeCapacityAction.mockResolvedValue({ ok: true, resumedCount: 0, allowance: 10 });
    await confirmUpgrade(TIER_B);
    expect(upgradeCapacityAction).toHaveBeenCalledTimes(1);
    expect(upgradeCapacityAction).toHaveBeenCalledWith({ tier: "growth", idempotencyKey: "key-1" });
    expect(JSON.stringify(upgradeCapacityAction.mock.calls[0])).not.toMatch(/price|inr|4999/i);
  });

  it("while it runs, the busy state is on the confirmed tier's button only", () => {
    const busy = triggers(render(null, TIER_B.code));
    expect(busy.filter((t) => t.loading).map((t) => t.id)).toEqual([
      `capacity-tier-${TIER_B.code}`,
    ]);
    expect(busy.every((t) => t.disabled)).toBe(true);
  });

  it("no 'mock' copy — on the buttons, in the confirm, or while it runs", () => {
    for (const tree of [render(null), render(TIER_A), render(null, TIER_A.code)]) {
      const footers = findAll(tree, Dialog).map((d) =>
        textOf((d.props as { footer?: ReactNode }).footer),
      );
      const all = [textOf(tree), ...footers].join(" ");
      expect(all).not.toMatch(/\bmock\b/i);
      expect(all).not.toMatch(/staging preview/i);
    }
  });

  /**
   * FOCUS, ONLY WHEN IT WAS LOST (the team Remove pattern). The Dialog hands focus back to its
   * trigger on close, but a confirmed upgrade disables every tier button while it runs, so that
   * restore falls to the body. Once closed AND settled, focus goes back to the tier's button —
   * only if it is still lost.
   */
  function stubDocument() {
    const body = { tag: "body" };
    const trigger = { focus: vi.fn() };
    const doc = {
      body,
      activeElement: body as unknown,
      getElementById: (id: string) => (id === `capacity-tier-${TIER_B.code}` ? trigger : null),
    };
    (globalThis as { document?: unknown }).document = doc;
    return { doc, trigger };
  }
  function commit(confirming: CapacityTier | null, pendingCode: string | null) {
    const tree = render(confirming, pendingCode);
    effects.forEach((run) => run());
    return tree;
  }
  async function askThenConfirm() {
    upgradeCapacityAction.mockResolvedValue({
      ok: false,
      error: "Capacity upgrade failed. Please retry.",
    });
    const first = commit(null, null);
    const b = findAll(first, Button).find((x) => textOf(x).includes("₹4,999"))!;
    expect((b.props as { id?: string }).id).toBe(`capacity-tier-${TIER_B.code}`);
    (b.props as { onClick: () => void }).onClick();
    const open = commit(TIER_B, null);
    footer(dialogOf(open))[1]!.onClick();
    await new Promise((r) => setTimeout(r, 0));
  }

  it("after a confirm: nothing moves focus while it runs; once settled it returns to the tier's button, once", async () => {
    const { trigger } = stubDocument();
    await askThenConfirm();
    commit(null, TIER_B.code);
    expect(trigger.focus).not.toHaveBeenCalled();
    commit(null, null);
    expect(trigger.focus).toHaveBeenCalledTimes(1);
    commit(null, null);
    expect(trigger.focus).toHaveBeenCalledTimes(1);
  });

  it("after Cancel: the Dialog's own restore stands — focus is not moved again", () => {
    const { doc, trigger } = stubDocument();
    const first = commit(null, null);
    tapTier(first, "₹4,999");
    const open = commit(TIER_B, null);
    footer(dialogOf(open))[0]!.onClick();
    doc.activeElement = trigger; // the Dialog put it back on its trigger
    commit(null, null);
    doc.activeElement = doc.body;
    commit(null, null);
    expect(trigger.focus).not.toHaveBeenCalled();
  });

  it("a payer who moved on while it ran is left where they are", async () => {
    const { doc, trigger } = stubDocument();
    await askThenConfirm();
    commit(null, TIER_B.code);
    doc.activeElement = { id: "somewhere-else" };
    commit(null, null);
    commit(null, null);
    expect(trigger.focus).not.toHaveBeenCalled();
  });
});
