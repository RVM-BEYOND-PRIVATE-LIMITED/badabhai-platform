import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import type { ReactElement, ReactNode } from "react";
import type * as ReactModule from "react";
import { Button, Card, Dialog } from "../../../components/ds";
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

// Observe the Server Actions (and the checkout, for the real-mode #2085 case).
const topUpAction = vi.fn();
const createOrderAction = vi.fn();
const loadCheckoutScript = vi.fn();
const openCheckout = vi.fn();
vi.mock("./actions", () => ({
  topUpAction: (i: unknown) => topUpAction(i),
  createOrderAction: (i: unknown) => createOrderAction(i),
  verifyPaymentAction: vi.fn(),
}));
vi.mock("./razorpay-checkout", () => ({
  loadCheckoutScript: () => loadCheckoutScript(),
  openCheckout: (i: unknown) => openCheckout(i),
}));

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
  createOrderAction.mockReset();
  loadCheckoutScript.mockReset();
  openCheckout.mockReset();
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
    // …and the price the dialog showed (#2085). Exact: no payer id, no other field.
    expect(topUpAction).toHaveBeenCalledWith({
      packCode: "pack_50",
      idempotencyKey: "key-1",
      expectedPriceInr: 2000,
    });
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

/**
 * PR-D2 — the best-value pack is the purchase decision's focal point, so its CONTAINER carries
 * the accent edge (`credit-pack--best`), not only the badge inside it. The flag must land on the
 * SAME pack as the badge — the config-derived lowest ₹/credit — and on exactly one pack, or the
 * ring would point at a different pack from the one the copy names.
 */
describe("credits panel — PR-D2 best-value container flag", () => {
  const packCards = (tree: ReactElement) =>
    findAll(tree, Card).filter((c) =>
      String((c.props as { className?: string }).className ?? "")
        .split(/\s+/)
        .includes("credit-pack"),
    );
  const isBest = (c: ReactElement) =>
    String((c.props as { className?: string }).className ?? "")
      .split(/\s+/)
      .includes("credit-pack--best");

  it("flags exactly ONE pack — the lowest ₹/credit — and it is the pack carrying the badge", () => {
    // PACK_A = ₹40/credit, PACK_B = ₹35/credit → B is the best value.
    const tree = render(PACK_A);
    const cards = packCards(tree);
    expect(cards).toHaveLength(2);
    const best = cards.filter(isBest);
    expect(best).toHaveLength(1);
    expect(best[0]!.key).toBe(PACK_B.code);
    expect(textOf(best[0]!)).toContain("Best value");
    // …and the unflagged pack carries no badge either (flag and copy agree).
    const other = cards.find((c) => !isBest(c))!;
    expect(other.key).toBe(PACK_A.code);
    expect(textOf(other)).not.toContain("Best value");
  });

  it("follows the catalog, not a position: re-price A below B and the flag moves with it", () => {
    stateQueue = [null, null, null, null, null];
    stateCursor = 0;
    const cheapA: CreditPack = { ...PACK_A, priceInr: 1000 }; // ₹20/credit now beats B's ₹35
    const tree = CreditsPanel({ packs: [cheapA, PACK_B], real: false }) as ReactElement;
    const best = packCards(tree).filter(isBest);
    expect(best).toHaveLength(1);
    expect(best[0]!.key).toBe(PACK_A.code);
  });
});

/**
 * Owner ruling 2026-10-07 (F35): "mock wording is not needing on plans and credit". No "mock" /
 * "(mock)" / "staging preview" copy on a pack's button, in the armed confirm, or while a purchase
 * runs — in EITHER payment mode — and no replacement disclaimer. The purchase itself is unchanged
 * (the key-lifecycle blocks above still pin it).
 */
describe("credits panel — no mock wording, in either mode", () => {
  const allCopy = (tree: ReactElement) =>
    [
      textOf(tree),
      ...findAll(tree, Dialog).map((d) => textOf((d.props as { footer?: ReactNode }).footer)),
      ...findAll(tree, Dialog).map((d) => textOf((d.props as { title?: ReactNode }).title)),
    ].join(" ");
  const packButtons = (tree: ReactElement) =>
    findAll(tree, Button)
      .filter((b) => (b.props as { block?: boolean }).block === true)
      .map((b) => textOf(b).trim());

  it("a pack's button reads 'Buy' in both modes", () => {
    for (const real of [false, true]) {
      stateQueue = [null, null, null, null, null];
      stateCursor = 0;
      const tree = CreditsPanel({ packs: [PACK_A, PACK_B], real }) as ReactElement;
      expect(packButtons(tree), `real=${real}`).toEqual(["Buy", "Buy"]);
    }
  });

  it("the armed confirm and a running purchase carry no mock copy", () => {
    for (const real of [false, true]) {
      for (const queue of [
        [null, PACK_A, null, null, null], // the confirm armed
        [PACK_A.code, null, null, null, null], // a purchase running
      ]) {
        stateQueue = queue;
        stateCursor = 0;
        const tree = CreditsPanel({ packs: [PACK_A, PACK_B], real }) as ReactElement;
        const copy = allCopy(tree);
        expect(copy, `real=${real}`).not.toMatch(/\bmock\b/i);
        expect(copy, `real=${real}`).not.toMatch(/staging preview/i);
      }
    }
    // …and the confirm still names what is bought and its price (the flow is unchanged).
    stateQueue = [null, PACK_A, null, null, null];
    stateCursor = 0;
    const dialog = findAll(
      CreditsPanel({ packs: [PACK_A, PACK_B], real: false }) as ReactElement,
      Dialog,
    )[0]!;
    const body = textOf((dialog.props as { children?: ReactNode }).children).replace(/\s+/g, " ");
    expect(body).toContain("50 credits");
    expect(body).toContain("₹2,000");
  });
});

describe("credits panel — fence: the purchase dialog never says it charges (review B1)", () => {
  it("the armed confirm shows the price and claims no charge", () => {
    stateQueue = [null, PACK_A, null, null, null];
    stateCursor = 0;
    const tree = CreditsPanel({ packs: [PACK_A, PACK_B], real: false }) as ReactElement;
    const dialog = findAll(tree, Dialog)[0]!;
    const p = dialog.props as { title?: ReactNode; children?: ReactNode; footer?: ReactNode };
    const copy = [textOf(p.title), textOf(p.children), textOf(p.footer)].join(" ");
    expect(copy).toContain("₹2,000");
    expect(copy).not.toMatch(/charg/i);
  });
});

/**
 * #2085 — SHOWN == SENT. The purchase sends back `expectedPriceInr` equal to the exact number the
 * payer saw: the confirm's price (mock), or the tile's (real, which has no confirm of its own). An
 * active offer is shown honestly — the tile strikes the list price — and the OFFER price is the one
 * shown on the confirm and sent. A refused price (409 `price_mismatch`) is a neutral notice naming
 * the new price, the page is refreshed so it shows, the purchase key is retired, and nothing is
 * retried on its own.
 */
describe("credits panel — #2085: the price shown is the price sent; a refused price is said, never retried", () => {
  /** A pack under an active offer: charged ₹6,000, list ₹8,000. */
  const OFFER_PACK: CreditPack = { code: "pack_200", priceInr: 6000, listPriceInr: 8000, credits: 200 };
  const PACKS = [PACK_A, PACK_B, OFFER_PACK];
  const rupees = (s: string) => Number(s.replace(/[₹,\s]/g, ""));

  /** Render with `pack` armed and read back the ONE ₹ figure its confirm question shows. */
  function shownInConfirm(pack: CreditPack): number {
    stateQueue = [null, pack, null, null, null];
    stateCursor = 0;
    const tree = CreditsPanel({ packs: PACKS, real: false }) as ReactElement;
    const body = textOf((findAll(tree, Dialog)[0]!.props as { children?: ReactNode }).children);
    const figures = body.match(/₹[\d,]+/g) ?? [];
    expect(figures, body).toHaveLength(1); // one number on the confirm — no ambiguity
    return rupees(figures[0]!);
  }

  /** Arm `pack` and press the confirm, as the payer does. */
  async function confirmFrom(pack: CreditPack): Promise<void> {
    stateQueue = [null, pack, null, null, null];
    stateCursor = 0;
    const tree = CreditsPanel({ packs: PACKS, real: false }) as ReactElement;
    const footer = (findAll(tree, Dialog)[0]!.props as { footer?: ReactNode }).footer;
    const confirm = findAll(footer, Button).find((b) => textOf(b).includes("Add credits"))!;
    (confirm.props as { onClick: () => void }).onClick();
    await new Promise((r) => setTimeout(r, 0));
  }
  const lastSent = () =>
    (topUpAction.mock.calls.at(-1)![0] as { expectedPriceInr?: number }).expectedPriceInr;

  it("the confirm sends exactly the number its dialog showed — at list price and under an offer", async () => {
    topUpAction.mockResolvedValue({ ok: true, balance: 60, creditsAdded: 50 });
    for (const pack of [PACK_A, PACK_B, OFFER_PACK]) {
      const shown = shownInConfirm(pack);
      await confirmFrom(pack);
      expect(lastSent(), pack.code).toBe(shown);
    }
    // Under the offer, what is shown and sent is the OFFER price, never the list price.
    expect(shownInConfirm(OFFER_PACK)).toBe(6000);
  });

  it("an offer is shown honestly: the tile strikes the list price beside the offer price", () => {
    stateQueue = [null, null, null, null, null];
    stateCursor = 0;
    const tree = CreditsPanel({ packs: PACKS, real: false }) as ReactElement;
    const tile = findAll(tree, Card).find((c) => c.key === OFFER_PACK.code)!;
    const struck = findAll(tile, "s");
    expect(struck).toHaveLength(1);
    expect((struck[0]!.props as { className?: string }).className).toBe("price-was");
    expect(textOf(struck[0]!)).toBe("₹8,000");
    expect(textOf(tile)).toContain("₹6,000");
    // A pack with no offer strikes nothing.
    const plain = findAll(tree, Card).find((c) => c.key === PACK_A.code)!;
    expect(findAll(plain, "s")).toEqual([]);
  });

  it("a refused price: a neutral notice with the new price, the page refreshed, ONE call, no retry", async () => {
    topUpAction.mockResolvedValueOnce({ ok: false, priceChanged: true, currentPriceInr: 2400 });
    await confirmBuy(PACK_A);
    expect(topUpAction).toHaveBeenCalledTimes(1);
    expect(argsOf(stateSetters[NOTICE_IDX]!)).toContain(
      "The price changed to ₹2,400. Review and confirm again.",
    );
    // Neutral: neither the success toast nor the danger toast.
    expect(argsOf(stateSetters[MESSAGE_IDX]!)).toEqual([null]);
    expect(argsOf(stateSetters[ERROR_IDX]!)).toEqual([null]);
    expect(routerRefresh).toHaveBeenCalledTimes(1);
  });

  it("after a refused price the next confirm is a NEW purchase — a fresh key (the old one would replay the refusal)", async () => {
    topUpAction.mockResolvedValueOnce({ ok: false, priceChanged: true, currentPriceInr: 2400 });
    await confirmBuy(PACK_A);
    topUpAction.mockResolvedValueOnce({ ok: true, balance: 60, creditsAdded: 50 });
    await confirmBuy(PACK_A);
    expect(sentKeys()).toEqual(["key-1", "key-2"]);
  });

  it("real mode: the order carries the tile's price; a refused price opens no checkout and says so", async () => {
    createOrderAction.mockResolvedValue({ ok: false, priceChanged: true, currentPriceInr: 7000 });
    stateQueue = [null, null, null, null, null];
    stateCursor = 0;
    const tree = CreditsPanel({ packs: PACKS, real: true }) as ReactElement;
    const tile = findAll(tree, Card).find((c) => c.key === OFFER_PACK.code)!;
    const tilePrice = findAll(tile, "div").find((d) =>
      String((d.props as { className?: string }).className).includes("credit-pack__price"),
    )!;
    // The tile's charged figure is the last ₹ on it (the struck list price comes first).
    const shown = rupees((textOf(tilePrice).match(/₹[\d,]+/g) ?? []).at(-1)!);
    (findAll(tile, Button)[0]!.props as { onClick: () => void }).onClick();
    await new Promise((r) => setTimeout(r, 0));

    expect(createOrderAction).toHaveBeenCalledTimes(1);
    expect(createOrderAction).toHaveBeenCalledWith({ packCode: "pack_200", expectedPriceInr: shown });
    expect(shown).toBe(6000);
    expect(loadCheckoutScript).not.toHaveBeenCalled();
    expect(openCheckout).not.toHaveBeenCalled();
    expect(argsOf(stateSetters[NOTICE_IDX]!)).toContain(
      "The price changed to ₹7,000. Review and confirm again.",
    );
    expect(routerRefresh).toHaveBeenCalledTimes(1);
  });

  it("Cancel sends nothing", () => {
    stateQueue = [null, OFFER_PACK, null, null, null];
    stateCursor = 0;
    const tree = CreditsPanel({ packs: PACKS, real: false }) as ReactElement;
    const dialog = findAll(tree, Dialog)[0]!;
    const footer = (dialog.props as { footer?: ReactNode }).footer;
    (findAll(footer, Button).find((b) => textOf(b).includes("Cancel"))!.props as {
      onClick: () => void;
    }).onClick();
    (dialog.props as { onClose: () => void }).onClose();
    expect(topUpAction).not.toHaveBeenCalled();
  });
});
