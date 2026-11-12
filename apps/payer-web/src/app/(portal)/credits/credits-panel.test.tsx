import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import type { ReactElement, ReactNode } from "react";
import type * as ReactModule from "react";
import { Button, Card, Dialog } from "../../../components/ds";
import type { CreditPack } from "../../../lib/contracts";
import { formatInr } from "../../../lib/format";
import { creditsErrorMessage } from "../../../lib/credits-messages";

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
// handler set. useState order in credits-panel: 0 pendingCode, 1 pendingConfirm, 2 notice,
// 3 error. A completed purchase is no longer panel state: it is a toast (#2583, `toastShow`).
let stateSetters: ReturnType<typeof vi.fn>[] = [];
const NOTICE_IDX = 2;
const ERROR_IDX = 3;
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

// The portal's ToastProvider (#2583): the panel announces a completed purchase through it.
const toastShow = vi.fn();
vi.mock("../../../components/ds/toast-provider", () => ({
  useToast: () => ({ show: toastShow, dismiss: vi.fn() }),
}));

const routerRefresh = vi.fn();
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: routerRefresh }) }));

// Observe the Server Actions (and the checkout, for the real-mode cases).
const topUpAction = vi.fn();
const createOrderAction = vi.fn();
const verifyPaymentAction = vi.fn();
const loadCheckoutScript = vi.fn();
const openCheckout = vi.fn();
vi.mock("./actions", () => ({
  topUpAction: (i: unknown) => topUpAction(i),
  createOrderAction: (i: unknown) => createOrderAction(i),
  verifyPaymentAction: (i: unknown) => verifyPaymentAction(i),
}));
vi.mock("./razorpay-checkout", () => ({
  loadCheckoutScript: () => loadCheckoutScript(),
  openCheckout: (i: unknown) => openCheckout(i),
}));

const { CreditsPanel } = await import("./credits-panel");
const { CountUp } = await import("../../../components/ds/count-up");

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
  stateQueue = [null, pack, null, null];
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
  verifyPaymentAction.mockReset();
  loadCheckoutScript.mockReset();
  openCheckout.mockReset();
  routerRefresh.mockReset();
  toastShow.mockReset();
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
    expect(toastShow).not.toHaveBeenCalled();
    expect(argsOf(stateSetters[ERROR_IDX]!)).toEqual([null]);
  });
});

/**
 * #2744 item 3 — a tile shows its pack's CATALOGUE values and nothing worked out from them: the
 * credits and the price it is charged. No pack is flagged as the better buy (no best-value badge or
 * accent ring), no positional tier label is invented for it, no per-unlock rate is divided out, and
 * no list price is struck through — even when the catalogue reports one under an offer.
 */
describe("credits panel — #2744: a tile shows only its catalogue values", () => {
  /** Charged ₹1,234 against a ₹1,500 list price: the catalogue reports an offer. */
  const OFFER: CreditPack = { code: "pack_offer", priceInr: 1234, listPriceInr: 1500, credits: 30 };
  const PACKS = [PACK_A, PACK_B, OFFER];

  function tiles(): ReactElement[] {
    stateQueue = [null, null, null, null];
    stateCursor = 0;
    return findAll(CreditsPanel({ packs: PACKS, real: false }) as ReactElement, Card);
  }
  function classesIn(node: ReactNode, acc: string[] = []): string[] {
    if (node === null || node === undefined || typeof node !== "object") return acc;
    if (Array.isArray(node)) {
      node.forEach((c) => classesIn(c, acc));
      return acc;
    }
    const el = node as ReactElement<{ className?: unknown; children?: ReactNode }>;
    if (typeof el.props?.className === "string") acc.push(...el.props.className.split(/\s+/));
    if (el.props && "children" in el.props) classesIn(el.props.children, acc);
    return acc;
  }

  it("every tile's only ₹ figure is the pack's charged price, beside its credits", () => {
    const rendered = tiles();
    expect(rendered.map((t) => t.key)).toEqual(PACKS.map((p) => p.code));
    for (const [i, tile] of rendered.entries()) {
      const pack = PACKS[i]!;
      const text = textOf(tile).replace(/\s+/g, " ");
      expect(text.match(/₹[\d,]+/g), pack.code).toEqual([formatInr(pack.priceInr)]);
      expect(text, pack.code).toContain(`Pack ${pack.credits}`);
      expect(text, pack.code).toContain(`${pack.credits} unlock credits`);
    }
  });

  it("no tile is flagged, labelled, rated per unlock or struck through — even under an offer", () => {
    for (const tile of tiles()) {
      expect((tile.props as { className?: string }).className, String(tile.key)).toBe("cred-pack");
      expect(findAll(tile, "s"), String(tile.key)).toEqual([]);
      const classes = classesIn(tile);
      for (const gone of ["cred-pack__ribbon", "cred-pack__tier", "cred-pack__rate", "price-was"]) {
        expect(classes, `${String(tile.key)}: ${gone}`).not.toContain(gone);
      }
      const text = textOf(tile);
      expect(text, String(tile.key)).not.toMatch(/best value|volume discount|starter|standard/i);
      expect(text, String(tile.key)).not.toMatch(/per (contact )?unlock/i);
    }
  });
});

/**
 * #2583 (W3) — ONE success pattern and ONE primary. A completed purchase is a toast from the
 * portal's ToastProvider with the balance counting up from the old figure to the server's new
 * one; it is never panel state. Only the first pack's Buy is primary — a position in the
 * catalogue's order, never a value claim (#2744).
 */
describe("credits panel — #2583: success is a toast; one primary", () => {
  it("a completed top-up shows ONE success toast whose balance counts up to the server's figure", async () => {
    topUpAction.mockResolvedValueOnce({ ok: true, balance: 60, creditsAdded: 50 });
    await confirmBuy(PACK_A);
    expect(toastShow).toHaveBeenCalledTimes(1);
    const shown = toastShow.mock.calls[0]![0] as { tone: string; title: string; message: ReactNode };
    expect(shown.tone).toBe("success");
    expect(shown.title).toBe("Credits added");
    const counts = findAll(shown.message, CountUp);
    expect(counts).toHaveLength(1);
    expect(counts[0]!.props).toMatchObject({ from: 10, to: 60 });
    expect(textOf(shown.message)).toContain("Added 50 credits.");
    // Not panel state: no neutral notice, no error.
    expect(argsOf(stateSetters[NOTICE_IDX]!)).toEqual([null]);
    expect(argsOf(stateSetters[ERROR_IDX]!)).toEqual([null]);
  });

  it("a failed top-up shows no toast — the error stays in the panel", async () => {
    topUpAction.mockResolvedValueOnce({ ok: false, error: "Top-up failed. Please retry." });
    await confirmBuy(PACK_A);
    expect(toastShow).not.toHaveBeenCalled();
    expect(argsOf(stateSetters[ERROR_IDX]!)).toContain("Top-up failed. Please retry.");
  });

  it("only the first pack's Buy is primary; the rest are secondary — by position, not by price", () => {
    const variants = (packs: CreditPack[]) => {
      stateQueue = [null, null, null, null];
      stateCursor = 0;
      const tree = CreditsPanel({ packs, real: false }) as ReactElement;
      return findAll(tree, Card).map((c) => [
        c.key,
        (findAll(c, Button)[0]!.props as { variant?: string }).variant,
      ]);
    };
    expect(variants([PACK_A, PACK_B])).toEqual([
      [PACK_A.code, "primary"],
      [PACK_B.code, "secondary"],
    ]);
    // The catalogue's order decides it: reversed, the other pack leads. No ₹/credit comparison.
    expect(variants([PACK_B, PACK_A])).toEqual([
      [PACK_B.code, "primary"],
      [PACK_A.code, "secondary"],
    ]);
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
      stateQueue = [null, null, null, null];
      stateCursor = 0;
      const tree = CreditsPanel({ packs: [PACK_A, PACK_B], real }) as ReactElement;
      expect(packButtons(tree), `real=${real}`).toEqual([
        `Buy Pack ${PACK_A.credits}`,
        `Buy Pack ${PACK_B.credits}`,
      ]);
    }
  });

  it("the armed confirm and a running purchase carry no mock copy", () => {
    for (const real of [false, true]) {
      for (const queue of [
        [null, PACK_A, null, null], // the confirm armed
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
    stateQueue = [null, PACK_A, null, null];
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
    stateQueue = [null, PACK_A, null, null];
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
 * payer saw: the confirm's price (mock), or the tile's (real, which has no confirm of its own). Under
 * an active offer the tile shows only the price charged — no struck list price (#2744) — and that
 * charged price is the one shown on the confirm and sent. A refused price (409 `price_mismatch`) is a neutral notice naming
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
    stateQueue = [null, pack, null, null];
    stateCursor = 0;
    const tree = CreditsPanel({ packs: PACKS, real: false }) as ReactElement;
    const body = textOf((findAll(tree, Dialog)[0]!.props as { children?: ReactNode }).children);
    const figures = body.match(/₹[\d,]+/g) ?? [];
    expect(figures, body).toHaveLength(1); // one number on the confirm — no ambiguity
    return rupees(figures[0]!);
  }

  /** Arm `pack` and press the confirm, as the payer does. */
  async function confirmFrom(pack: CreditPack): Promise<void> {
    stateQueue = [null, pack, null, null];
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

  it("#2744: under an offer the tile shows the charged price only — the list price is not struck", () => {
    stateQueue = [null, null, null, null];
    stateCursor = 0;
    const tree = CreditsPanel({ packs: PACKS, real: false }) as ReactElement;
    const tile = findAll(tree, Card).find((c) => c.key === OFFER_PACK.code)!;
    expect(findAll(tile, "s")).toEqual([]);
    expect(textOf(tile)).toContain("₹6,000");
    expect(textOf(tile)).not.toContain("₹8,000");
  });

  it("#2741: no tile carries a savings label, even under an offer", () => {
    stateQueue = [null, null, null, null];
    stateCursor = 0;
    const tree = CreditsPanel({ packs: PACKS, real: false }) as ReactElement;
    for (const tile of findAll(tree, Card)) {
      expect(textOf(tile)).not.toMatch(/save\s*\d+\s*%/i);
    }
  });

  it("a refused price: a neutral notice with the new price, the page refreshed, ONE call, no retry", async () => {
    topUpAction.mockResolvedValueOnce({ ok: false, priceChanged: true, currentPriceInr: 2400 });
    await confirmBuy(PACK_A);
    expect(topUpAction).toHaveBeenCalledTimes(1);
    expect(argsOf(stateSetters[NOTICE_IDX]!)).toContain(
      "The price changed to ₹2,400. Review and confirm again.",
    );
    // Neutral: neither the success toast nor the danger toast.
    expect(toastShow).not.toHaveBeenCalled();
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
    stateQueue = [null, null, null, null];
    stateCursor = 0;
    const tree = CreditsPanel({ packs: PACKS, real: true }) as ReactElement;
    const tile = findAll(tree, Card).find((c) => c.key === OFFER_PACK.code)!;
    const tilePrice = findAll(tile, "div").find((d) =>
      String((d.props as { className?: string }).className).includes("cred-pack__price"),
    )!;
    // The tile's charged figure is the only ₹ on it (#2744: no struck list price beside it).
    const figures = textOf(tilePrice).match(/₹[\d,]+/g) ?? [];
    expect(figures).toHaveLength(1);
    const shown = rupees(figures[0]!);
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
    stateQueue = [null, OFFER_PACK, null, null];
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

/**
 * #2085 L2 — ONE KEY, ONE CONFIRMED PRICE. A key still held for a pack belongs to an earlier attempt
 * whose outcome is unknown; reusing it makes the API replay THAT attempt (at its price). So when
 * the payer confirms a DIFFERENT price for the pack under a held key, nothing is sent — the panel
 * says an earlier purchase may still be processing. The key itself is kept (a fresh one could
 * double-charge), and a confirm at the held price still reuses it.
 */
describe("credits panel — #2085 L2: a held key is never sent under a different price", () => {
  const REPRICED: CreditPack = { ...PACK_A, priceInr: 2400 };
  const HELD = "An earlier purchase at ₹2,000 may still be processing — check back in a moment.";

  for (const [label, first] of [
    ["still processing", { ok: false, pending: true, balance: 71 }],
    ["a failure", { ok: false, error: "Purchase failed (service unavailable). Please retry." }],
  ] as const) {
    it(`after ${label} at ₹2,000, a confirm at ₹2,400 sends NOTHING and says so; ₹2,000 still reuses the key`, async () => {
      topUpAction.mockResolvedValueOnce(first);
      await confirmBuy(PACK_A); // key-1, held at ₹2,000
      await confirmBuy(REPRICED); // the page re-rendered at ₹2,400 — held, not sent
      expect(topUpAction).toHaveBeenCalledTimes(1);
      expect(argsOf(stateSetters[NOTICE_IDX]!)).toContain(HELD);
      expect(argsOf(stateSetters[ERROR_IDX]!)).toEqual([null]); // neutral, not a failure
      expect(stateSetters[0]).not.toHaveBeenCalled(); // no spinner: nothing is running

      topUpAction.mockResolvedValueOnce({ ok: true, balance: 60, creditsAdded: 50 });
      await confirmBuy(PACK_A); // the SAME confirmed purchase — reuses the held key
      expect(sentKeys()).toEqual(["key-1", "key-1"]);
    });
  }
});

/**
 * #2744 items 4 + 10 — in REAL mode "paid" comes from the SERVER, never from the checkout callback
 * alone. Checkout opens with the server's order (its amount, not one the panel works out). A failed
 * or dismissed callback verifies nothing and announces nothing. A successful callback is only a
 * claim until `verifyPaymentAction` answers: `ok:false` or a throw shows no success toast, and the
 * toast follows `ok:true` only, at the server's balance. Tests only — razorpay-checkout.ts and
 * actions.ts (the payments owner's review) are unchanged.
 */
describe("credits panel — #2744: real mode says 'paid' only after the server confirms", () => {
  /** The server's order: its amount is deliberately unlike the tile's price, to prove whose it is. */
  const ORDER = {
    ok: true,
    orderId: "order_synthetic",
    keyId: "key_synthetic",
    amount: 123456,
    currency: "INR",
    packCode: PACK_A.code,
  } as const;
  /** What the checkout callback hands back on a completed payment — still unverified. */
  const CALLBACK_PAID = {
    outcome: "success",
    orderId: ORDER.orderId,
    paymentId: "pay_synthetic",
    signature: "sig_synthetic",
  } as const;
  const PAID = /payment successful/i;

  /** Tap PACK_A's Buy in real mode and let the order → checkout → verify chain settle. */
  async function buyReal(): Promise<void> {
    stateQueue = [null, null, null, null];
    stateCursor = 0;
    const tree = CreditsPanel({ packs: [PACK_A, PACK_B], real: true }) as ReactElement;
    const tile = findAll(tree, Card).find((c) => c.key === PACK_A.code)!;
    (findAll(tile, Button)[0]!.props as { onClick: () => void }).onClick();
    await new Promise((r) => setTimeout(r, 0));
  }

  beforeEach(() => {
    createOrderAction.mockResolvedValue(ORDER);
    loadCheckoutScript.mockResolvedValue(true);
  });

  it("checkout opens with the SERVER's order and amount", async () => {
    openCheckout.mockResolvedValue({ outcome: "dismissed" });
    await buyReal();
    expect(openCheckout).toHaveBeenCalledTimes(1);
    expect(openCheckout).toHaveBeenCalledWith(
      expect.objectContaining({
        orderId: ORDER.orderId,
        keyId: ORDER.keyId,
        amount: ORDER.amount,
        currency: ORDER.currency,
      }),
    );
  });

  it("a FAILED checkout callback: nothing verified, no success toast, the failure said", async () => {
    openCheckout.mockResolvedValue({ outcome: "failed" });
    await buyReal();
    expect(verifyPaymentAction).not.toHaveBeenCalled();
    expect(toastShow).not.toHaveBeenCalled();
    expect(argsOf(stateSetters[ERROR_IDX]!)).toContain(
      "Payment failed. No credits were added — you can try again.",
    );
    expect(routerRefresh).not.toHaveBeenCalled();
  });

  it("a DISMISSED checkout: nothing verified, no success toast, a neutral notice", async () => {
    openCheckout.mockResolvedValue({ outcome: "dismissed" });
    await buyReal();
    expect(verifyPaymentAction).not.toHaveBeenCalled();
    expect(toastShow).not.toHaveBeenCalled();
    expect(argsOf(stateSetters[NOTICE_IDX]!)).toContain(
      "Payment cancelled. You haven't been charged.",
    );
    expect(argsOf(stateSetters[ERROR_IDX]!)).toEqual([null]);
  });

  it("a successful callback is only a claim: verification ok:false shows no success toast", async () => {
    openCheckout.mockResolvedValue(CALLBACK_PAID);
    verifyPaymentAction.mockResolvedValue({ ok: false, error: "payment_unconfirmed" });
    await buyReal();
    // The callback's ids went to the server…
    expect(verifyPaymentAction).toHaveBeenCalledTimes(1);
    expect(verifyPaymentAction).toHaveBeenCalledWith({
      orderId: CALLBACK_PAID.orderId,
      paymentId: CALLBACK_PAID.paymentId,
      signature: CALLBACK_PAID.signature,
    });
    // …and its refusal is what the payer sees: no "paid", no refresh.
    expect(toastShow).not.toHaveBeenCalled();
    expect(argsOf(stateSetters[ERROR_IDX]!)).toContain(creditsErrorMessage("payment_unconfirmed"));
    expect(routerRefresh).not.toHaveBeenCalled();
  });

  it("a verification that throws shows no success toast either", async () => {
    openCheckout.mockResolvedValue(CALLBACK_PAID);
    verifyPaymentAction.mockRejectedValue(new Error("network down"));
    await buyReal();
    expect(toastShow).not.toHaveBeenCalled();
    const errors = argsOf(stateSetters[ERROR_IDX]!);
    expect(errors).toContainEqual(expect.stringContaining("If money left your account"));
    expect(errors.join(" ")).not.toMatch(PAID);
  });

  it("only verification ok:true shows the success toast: once, after the server answered, at its balance", async () => {
    openCheckout.mockResolvedValue(CALLBACK_PAID);
    verifyPaymentAction.mockResolvedValue({ ok: true, balance: 73, creditsAdded: 30 });
    await buyReal();
    expect(toastShow).toHaveBeenCalledTimes(1);
    // The toast follows the server's answer, never the callback alone.
    expect(verifyPaymentAction.mock.invocationCallOrder[0]!).toBeLessThan(
      toastShow.mock.invocationCallOrder[0]!,
    );
    const shown = toastShow.mock.calls[0]![0] as { tone: string; message: ReactNode };
    expect(shown.tone).toBe("success");
    expect(textOf(shown.message)).toMatch(PAID);
    expect(findAll(shown.message, CountUp)[0]!.props).toMatchObject({ from: 43, to: 73 });
    expect(argsOf(stateSetters[ERROR_IDX]!)).toEqual([null]);
    expect(routerRefresh).toHaveBeenCalledTimes(1);
  });

  it("while an order is in flight every Buy is disabled, so a second tap starts no second order", () => {
    stateQueue = [PACK_A.code, null, null, null]; // a purchase of PACK_A is running
    stateCursor = 0;
    const tree = CreditsPanel({ packs: [PACK_A, PACK_B], real: true }) as ReactElement;
    const buys = findAll(tree, Button).filter((b) => (b.props as { block?: boolean }).block === true);
    expect(buys).toHaveLength(2);
    for (const b of buys) expect((b.props as { disabled?: boolean }).disabled).toBe(true);
  });
});
