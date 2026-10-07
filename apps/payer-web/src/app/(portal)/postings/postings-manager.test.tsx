import { afterEach, describe, expect, it, vi, beforeEach } from "vitest";
import type { ReactElement, ReactNode } from "react";
import type * as ReactModule from "react";
import type { PostingSummary } from "../../../lib/contracts";
import { Badge, Button, Dialog } from "../../../components/ds";
import { ConfirmSpendDialog } from "../../../components/unlock";

/**
 * POSTINGS-MANAGER tests — STATUS RENDERING + LIVE LIFECYCLE TRIO + CLOSE + A11Y (B8).
 *
 * The manager now wires the LIVE payer-authed lifecycle
 * (`POST /payer/job-postings/:id/{pause|resume|quota-topup|close}`, #178/#180) through the
 * Server Actions in ./actions. These tests assert:
 *  - the status Badge reflects the posting's real `status` (open → success tone, etc.);
 *  - the trio is ENABLED per the real lifecycle (pause⇔open, resume⇔paused, top-up
 *    unless closed, close only draft/open) and each button fires ITS action with ONLY
 *    the posting id (XB-A: never a payer id from the client);
 *  - each row keeps an `aria-live="polite"` region (B8 — announces a row failure).
 *
 * Env is node (no DOM); React state is injected via the mocked `useState` (source order:
 * rows, state, the posting whose slot purchase awaits confirmation). Refs persist by call order
 * (as React's do) and effects are collected to be run by hand. DS Button/Badge are collected by
 * `el.type === Button`/`Badge`.
 */

const pausePostingAction = vi.fn();
const resumePostingAction = vi.fn();
const topUpQuotaAction = vi.fn();
const closePostingAction = vi.fn();

vi.mock("next/link", () => ({
  default: ({ children, href }: { children: ReactNode; href: string }) => ({
    type: "a",
    props: { href, children },
  }),
}));
vi.mock("./actions", () => ({
  pausePostingAction: (i: unknown) => pausePostingAction(i),
  resumePostingAction: (i: unknown) => resumePostingAction(i),
  topUpQuotaAction: (i: unknown) => topUpQuotaAction(i),
  closePostingAction: (i: unknown) => closePostingAction(i),
}));

// Injected per-render state queue (source order: rows, state-record, confirming posting id).
let stateQueue: unknown[] = [];
let stateCursor = 0;
/** Each slot's setter from the LAST render, by source order (read to see what a click stores). */
const setters: Array<ReturnType<typeof vi.fn>> = [];
const useState = vi.fn((initial: unknown) => {
  const i = stateCursor++;
  const seeded = i < stateQueue.length ? stateQueue[i] : initial;
  const set = vi.fn();
  setters[i] = set;
  return [seeded, set] as [unknown, (v: unknown) => void];
});
// One ref object per call order that survives re-renders (as React's does); effects are
// collected per render so a test can run them as React would after a commit.
let refs: Array<{ current: unknown }> = [];
let refCursor = 0;
let effects: Array<() => void | (() => void)> = [];
vi.mock("react", async () => {
  const actual = await vi.importActual<typeof ReactModule>("react");
  return {
    ...actual,
    useState: (initial: unknown) => useState(initial),
    useRef: (init: unknown) => {
      const i = refCursor++;
      refs[i] ??= { current: init };
      return refs[i];
    },
    useEffect: (fn: () => void | (() => void)) => {
      effects.push(fn);
    },
  };
});

const { PostingsManager } = await import("./postings-manager");

/** The one slot top-up on offer — what the server page reads from the live catalog tier. */
const OFFER = { priceInr: 1000, additionalViews: 10 };
/** Its trigger's face: the slots AND the price (owner ruling 2026-10-07 — F11). */
const TOP_UP = "Add 10 applicant slots · ₹1,000";

const OPEN: PostingSummary = {
  id: "bbbb2222-0000-4000-8000-000000000001",
  roleTitle: "CNC Machinist",
  locationLabel: "Pune, MH",
  vacancyBand: "6-20",
  status: "open",
  applicantCount: 2,
  applicantQuota: 10,
  createdAt: "2026-06-22T00:00:00.000Z",
};

interface CollectedButton {
  text: string;
  disabled: boolean;
  loading: boolean;
  onClick?: () => void;
}
interface CollectedBadge {
  text: string;
  tone: string;
}
interface Collected {
  buttons: CollectedButton[];
  badges: CollectedBadge[];
  ariaLiveCount: number;
}

/** Every static className TOKEN in the tree (UI-1 markup is asserted by its primitive). */
function classTokens(node: ReactNode, acc: Set<string> = new Set()): Set<string> {
  if (node === null || node === undefined || typeof node !== "object") return acc;
  if (Array.isArray(node)) {
    for (const c of node) classTokens(c, acc);
    return acc;
  }
  const el = node as ReactElement<Record<string, unknown> & { children?: ReactNode }>;
  if (typeof el.props?.className === "string") {
    for (const t of el.props.className.split(/\s+/).filter(Boolean)) acc.add(t);
  }
  if (el.props && "children" in el.props) classTokens(el.props.children, acc);
  return acc;
}

/** Every `href` in the tree — used to pin an empty state's recovery action. */
function hrefs(node: ReactNode, acc: string[] = []): string[] {
  if (node === null || node === undefined || typeof node !== "object") return acc;
  if (Array.isArray(node)) {
    for (const c of node) hrefs(c, acc);
    return acc;
  }
  const el = node as ReactElement<Record<string, unknown> & { children?: ReactNode }>;
  if (typeof el.props?.href === "string") acc.push(el.props.href);
  if (el.props && "children" in el.props) hrefs(el.props.children, acc);
  return acc;
}

function textOf(node: ReactNode): string {
  if (node === null || node === undefined || typeof node === "boolean") return "";
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(textOf).join("");
  const el = node as ReactElement<{ children?: ReactNode }>;
  return el.props && "children" in el.props ? textOf(el.props.children) : "";
}

function walk(node: ReactNode, acc: Collected): void {
  if (node === null || node === undefined || typeof node === "boolean") return;
  if (typeof node === "string" || typeof node === "number") return;
  if (Array.isArray(node)) {
    for (const c of node) walk(c, acc);
    return;
  }
  const el = node as ReactElement<Record<string, unknown> & { children?: ReactNode }>;

  if (el.type === Button) {
    acc.buttons.push({
      text: textOf(el.props.children).trim(),
      disabled: el.props.disabled === true,
      loading: el.props.loading === true,
      onClick: typeof el.props.onClick === "function" ? (el.props.onClick as () => void) : undefined,
    });
    return;
  }
  if (el.type === Badge) {
    acc.badges.push({
      text: textOf(el.props.children).trim(),
      tone: typeof el.props.tone === "string" ? el.props.tone : "neutral",
    });
    return;
  }
  if (el.props["aria-live"] === "polite") acc.ariaLiveCount++;
  if ("children" in el.props) walk(el.props.children, acc);
}

function collect(tree: ReactNode): Collected {
  const acc: Collected = { buttons: [], badges: [], ariaLiveCount: 0 };
  walk(tree, acc);
  return acc;
}

function render(
  postings: PostingSummary[],
  rowState: Record<string, unknown> = {},
  readOnly?: boolean,
  opts: { confirming?: string | null; offer?: typeof OFFER | null } = {},
) {
  // Seed the useState slots for this render — source order in the component:
  // (1) freshRows overlay (Record<id, PostingSummary>), (2) per-row action state,
  // (3) the posting whose slot purchase is awaiting confirmation (the dialog is open while set).
  // Rows themselves render FROM PROPS (the freshRows overlay only patches by id).
  stateQueue = [{}, rowState, opts.confirming ?? null];
  stateCursor = 0;
  refCursor = 0;
  effects = [];
  const topUpOffer = opts.offer === undefined ? OFFER : opts.offer;
  return PostingsManager({ postings, readOnly, topUpOffer }) as ReactElement;
}

/** The manager's one DS Dialog (the slot-purchase confirm). */
function dialogOf(tree: ReactNode): ReactElement {
  const found = ofType(tree, Dialog);
  expect(found).toHaveLength(1);
  return found[0]!;
}
/** The confirm's footer buttons, in order. */
function footerButtons(dialog: ReactElement) {
  return ofType((dialog.props as { footer?: ReactNode }).footer, Button).map((b) => {
    const p = b.props as Record<string, unknown>;
    return {
      text: textOf(p.children as ReactNode).trim(),
      variant: p.variant,
      loading: p.loading === true,
      onClick: p.onClick as () => void,
    };
  });
}
/** Every element of a component type, depth-first (props.children only). */
function ofType(node: ReactNode, type: unknown, acc: ReactElement[] = []): ReactElement[] {
  if (node === null || node === undefined || typeof node !== "object") return acc;
  if (Array.isArray(node)) {
    node.forEach((c) => ofType(c, type, acc));
    return acc;
  }
  const el = node as ReactElement<{ children?: ReactNode }>;
  if (el.type === type) acc.push(el);
  if (el.props && "children" in el.props) ofType(el.props.children, type, acc);
  return acc;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

let uuidCounter = 0;

beforeEach(() => {
  refs = [];
  // A deterministic purchase key (#2085), so key identity is assertable.
  uuidCounter = 0;
  vi.stubGlobal("crypto", { randomUUID: () => `key-${++uuidCounter}` });
  pausePostingAction.mockReset().mockResolvedValue({ ok: true, posting: OPEN });
  resumePostingAction.mockReset().mockResolvedValue({ ok: true, posting: OPEN });
  topUpQuotaAction.mockReset().mockResolvedValue({ ok: true, posting: OPEN });
  closePostingAction.mockReset().mockResolvedValue({ ok: true, posting: OPEN });
});

describe("PostingsManager — STATUS RENDERING reflects the real status", () => {
  it("an open posting renders a success-tone status Badge with the real status text", () => {
    const { badges } = collect(render([OPEN]));
    const status = badges.find((b) => b.text === "open");
    expect(status).toBeDefined();
    expect(status!.tone).toBe("success");
  });

  it("a paused posting renders a warning-tone status Badge; draft/closed render neutral", () => {
    const paused = collect(render([{ ...OPEN, status: "paused" }])).badges.find(
      (b) => b.text === "paused",
    );
    expect(paused?.tone).toBe("warning");

    const draft = collect(render([{ ...OPEN, status: "draft" }])).badges.find(
      (b) => b.text === "draft",
    );
    expect(draft?.tone).toBe("neutral");

    const closed = collect(render([{ ...OPEN, status: "closed" }])).badges.find(
      (b) => b.text === "closed",
    );
    expect(closed?.tone).toBe("neutral");
  });
});

describe("PostingsManager — LIVE lifecycle trio + close (per the real lifecycle)", () => {
  it("an OPEN posting offers ENABLED Pause / Add applicant slots / Close posting; clicking Pause fires the action with ONLY the posting id", () => {
    const { buttons } = collect(render([OPEN]));
    const pause = buttons.find((b) => b.text === "Pause");
    const topUp = buttons.find((b) => b.text === TOP_UP);
    const close = buttons.find((b) => b.text === "Close posting");
    expect(pause?.disabled).toBe(false);
    expect(topUp?.disabled).toBe(false);
    expect(close?.disabled).toBe(false);

    pause!.onClick!();
    expect(pausePostingAction).toHaveBeenCalledWith({ postingId: OPEN.id });
    // XB-A: the client sends ONLY the posting id — never a payer id.
    expect(JSON.stringify(pausePostingAction.mock.calls[0])).not.toMatch(/payer/i);
  });

  it("a PAUSED posting offers ENABLED Resume (no Close — resume first); clicking fires the action", () => {
    const { buttons } = collect(render([{ ...OPEN, status: "paused" }]));
    const resume = buttons.find((b) => b.text === "Resume");
    expect(resume?.disabled).toBe(false);
    expect(buttons.find((b) => b.text === "Close posting")).toBeUndefined();
    resume!.onClick!();
    expect(resumePostingAction).toHaveBeenCalledWith({ postingId: OPEN.id });
  });

  it("a CLOSED posting offers NO lifecycle button and no empty action bar (terminal — F27)", () => {
    // A disabled button can't show its reason (no hover on a disabled control), so an action
    // that does not apply is not drawn at all.
    const tree = render([{ ...OPEN, status: "closed" }]);
    expect(collect(tree).buttons).toEqual([]);
    expect(byClass(tree, "posting-card__actions")).toEqual([]);
  });

  it("a busy row disables its buttons (no double-fire while an action is pending)", () => {
    const { buttons } = collect(
      render([OPEN], { [OPEN.id]: { busy: "pause", error: null, notice: null } }),
    );
    expect(buttons).toHaveLength(3);
    expect(buttons.every((b) => b.disabled)).toBe(true);
  });

  it("only the PRESSED button shows the spinner; the others are just disabled (F39)", () => {
    for (const [busy, label] of [
      ["pause", "Pause"],
      ["topUp", TOP_UP],
      ["close", "Close posting"],
    ] as const) {
      const { buttons } = collect(
        render([OPEN], { [OPEN.id]: { busy, error: null, notice: null } }),
      );
      expect(
        buttons.filter((b) => b.loading).map((b) => b.text),
        busy,
      ).toEqual([label]);
      expect(
        buttons.every((b) => b.disabled),
        busy,
      ).toBe(true);
    }
    const resuming = collect(
      render([{ ...OPEN, status: "paused" }], {
        [OPEN.id]: { busy: "resume", error: null, notice: null },
      }),
    );
    expect(resuming.buttons.filter((b) => b.loading).map((b) => b.text)).toEqual(["Resume"]);
  });

  it("pressing a button records WHICH action is running for that row (F39)", () => {
    // (Add applicant slots is a PURCHASE: pressing it only asks — its confirm marks the row busy,
    // pinned in the "asks first" block below.)
    for (const [label, busy] of [
      ["Pause", "pause"],
      ["Close posting", "close"],
    ] as const) {
      const { buttons } = collect(render([OPEN]));
      buttons.find((b) => b.text === label)!.onClick!();
      // Slot 2 (source order) is the per-row action state; its first write marks the row busy.
      const update = setters[1]!.mock.calls[0]![0] as (
        prev: Record<string, unknown>,
      ) => Record<string, unknown>;
      expect(update({}), label).toEqual({
        [OPEN.id]: { busy, error: null, notice: null, info: null },
      });
    }
  });

  it("Add applicant slots fires ITS action from the confirm; a seeded row error renders in the row", () => {
    const first = collect(render([OPEN]));
    first.buttons.find((b) => b.text === TOP_UP)!.onClick!();
    expect(topUpQuotaAction).not.toHaveBeenCalled(); // asks first (owner ruling 2026-10-07)
    const open = render([OPEN], {}, false, { confirming: OPEN.id });
    footerButtons(dialogOf(open))[1]!.onClick();
    expect(topUpQuotaAction).toHaveBeenCalledWith({
      postingId: OPEN.id,
      expectedPriceInr: 1000,
      idempotencyKey: "key-1",
    });

    const errored = render([OPEN], {
      [OPEN.id]: {
        busy: null,
        error: "This posting has no active plan yet — buy a plan first.",
        notice: null,
      },
    });
    expect(textOf(errored)).toContain("no active plan");
    // A row that has reported is IDLE again: every action is pressable, nothing spins.
    const idle = collect(errored).buttons;
    expect(idle.every((b) => !b.disabled && !b.loading)).toBe(true);
  });

  it("a DRAFT posting offers ENABLED Close posting and NO Pause; clicking Close fires ITS action", () => {
    const { buttons } = collect(render([{ ...OPEN, status: "draft" }]));
    const close = buttons.find((b) => b.text === "Close posting");
    expect(close?.disabled).toBe(false);
    // Pause requires an OPEN posting — a draft does not draw it (a disabled Pause said nothing
    // about why — F27), never a fake action either.
    expect(buttons.map((b) => b.text)).toEqual([TOP_UP, "Close posting"]);
    expect(buttons.every((b) => !b.disabled)).toBe(true);
    close!.onClick!();
    expect(closePostingAction).toHaveBeenCalledWith({ postingId: OPEN.id });
  });

  it("a SUSPENDED posting draws no Pause it could never use; slots stay as they are today", () => {
    const { buttons } = collect(render([{ ...OPEN, status: "suspended" }]));
    expect(buttons.map((b) => `${b.text}${b.disabled ? " [disabled]" : ""}`)).toEqual([TOP_UP]);
  });

  it("a seeded SUCCESS notice (the paid slots confirmation) renders in the aria-live row region", () => {
    const tree = render([OPEN], {
      [OPEN.id]: {
        busy: null,
        error: null,
        notice: "Applicant slots added — 10 more applicant views.",
      },
    });
    expect(textOf(tree)).toContain("Applicant slots added — 10 more applicant views.");
    expect(collect(tree).buttons.every((b) => !b.disabled && !b.loading)).toBe(true);
  });
});

/**
 * OWNER RULING 2026-10-07 (sweep F11): "one tap should have a price shown with confirmation".
 * Add applicant slots used to commit a charge on one tap with no price anywhere. Now its trigger
 * carries the slots AND the price, and it opens the GENERIC DS Dialog (never a second
 * ConfirmSpendDialog — the app keeps exactly one, the unlock's); only that dialog's confirm buys.
 * The price is the server page's live-catalog tier (the one the action charges by), never a literal.
 * Who may buy is unchanged (no gate added or removed here).
 */
describe("PostingsManager — Add applicant slots shows its price and asks first", () => {
  it("the trigger carries the slots and the price, the ₹ in mono", () => {
    const tree = render([OPEN]);
    const trigger = ofType(tree, Button).find(
      (b) => textOf((b.props as { children?: ReactNode }).children).trim() === TOP_UP,
    );
    expect(trigger).toBeDefined();
    const mono = byClass(trigger!, "bb-mono").map((m) => textOf(m));
    expect(mono).toContain("₹1,000");
  });

  it("the price follows the offer it is given (an ops re-price shows on the button)", () => {
    const tree = render([OPEN], {}, false, { offer: { priceInr: 1500, additionalViews: 25 } });
    expect(collect(tree).buttons.map((b) => b.text)).toContain("Add 25 applicant slots · ₹1,500");
  });

  it("no priced offer (no top-up tier in the catalog) draws no purchase button at all", () => {
    const tree = render([OPEN], {}, false, { offer: null });
    expect(collect(tree).buttons.map((b) => b.text)).toEqual(["Pause", "Close posting"]);
  });

  it("tapping it opens the confirm — it buys NOTHING and marks no row busy", () => {
    const { buttons } = collect(render([OPEN]));
    buttons.find((b) => b.text === TOP_UP)!.onClick!();
    expect(topUpQuotaAction).not.toHaveBeenCalled();
    expect(setters[1]).not.toHaveBeenCalled();
    // Slot 3 (source order) is the posting whose purchase awaits confirmation.
    expect(setters[2]).toHaveBeenCalledWith(OPEN.id);
  });

  it("the confirm is the generic DS Dialog: what is bought, the price, charged now; Cancel + a priced confirm", () => {
    const closed = render([OPEN]);
    expect((dialogOf(closed).props as { open: boolean }).open).toBe(false);

    const tree = render([OPEN], {}, false, { confirming: OPEN.id });
    expect(ofType(tree, ConfirmSpendDialog)).toEqual([]);
    const dialog = dialogOf(tree);
    const props = dialog.props as { open: boolean; title?: ReactNode; children?: ReactNode };
    expect(props.open).toBe(true);
    expect(textOf(props.title)).toBe("Add applicant slots?");
    // A neutral priced question, like the credits confirm (review B1): what is bought and its
    // price — no claim that money moves (these purchases only record a payment today).
    const body = textOf(props.children);
    expect(body).toBe("Add 10 applicant slots to “CNC Machinist” for ₹1,000?");
    expect(body).not.toMatch(/\bmock\b/i);
    expect(footerButtons(dialog).map((b) => [b.text, b.variant])).toEqual([
      ["Cancel", "ghost"],
      ["Add slots · ₹1,000", "primary"],
    ]);
  });

  it("fence: the purchase dialog never says it charges (review B1)", () => {
    const dialog = dialogOf(render([OPEN], {}, false, { confirming: OPEN.id }));
    const p = dialog.props as { title?: ReactNode; children?: ReactNode; footer?: ReactNode };
    const copy = [textOf(p.title), textOf(p.children), textOf(p.footer)].join(" ");
    expect(copy).toContain("₹1,000"); // the price is shown…
    expect(copy).not.toMatch(/charg/i); // …but no charge is claimed
  });

  it("Cancel (and Esc / the scrim / the close button — the Dialog's onClose) closes it and buys nothing", () => {
    const dialog = dialogOf(render([OPEN], {}, false, { confirming: OPEN.id }));
    footerButtons(dialog)[0]!.onClick();
    (dialog.props as { onClose: () => void }).onClose();
    expect(setters[2]!.mock.calls).toEqual([[null], [null]]);
    expect(setters[1]).not.toHaveBeenCalled();
    expect(topUpQuotaAction).not.toHaveBeenCalled();
  });

  it("only the dialog's confirm buys — ONCE: the posting id, the price it showed and a purchase key — and that row's slot button then spins", () => {
    const dialog = dialogOf(render([OPEN], {}, false, { confirming: OPEN.id }));
    footerButtons(dialog)[1]!.onClick();
    expect(setters[2]).toHaveBeenCalledWith(null); // the dialog closes
    expect(topUpQuotaAction).toHaveBeenCalledTimes(1);
    // #2085: the confirmed price rides along as a guard (the server still prices the charge).
    // EXACTLY these three keys — XB-A: never a payer id; never an amount to charge.
    const sent = topUpQuotaAction.mock.calls[0]![0] as Record<string, unknown>;
    expect(sent).toStrictEqual({ postingId: OPEN.id, expectedPriceInr: 1000, idempotencyKey: "key-1" });
    expect(JSON.stringify(sent)).not.toMatch(/payer|amount/i);
    const update = setters[1]!.mock.calls[0]![0] as (
      prev: Record<string, unknown>,
    ) => Record<string, unknown>;
    expect(update({})).toEqual({
      [OPEN.id]: { busy: "topUp", error: null, notice: null, info: null },
    });
    // While it runs, the busy state is on THAT row's slot button only (siblings just disabled).
    const busy = collect(
      render([OPEN], { [OPEN.id]: { busy: "topUp", error: null, notice: null } }),
    );
    expect(busy.buttons.filter((b) => b.loading).map((b) => b.text)).toEqual([TOP_UP]);
  });

  /**
   * FOCUS, ONLY WHEN IT WAS LOST (the team Remove pattern). The Dialog hands focus back to its
   * trigger on close — but a confirmed purchase disables the row's buttons while it runs, so that
   * restore falls to the body. Once the dialog is closed and the purchase has settled, focus goes
   * back to the row's slot button — only if it is still lost.
   */
  function stubDocument() {
    const body = { tag: "body" };
    const trigger = { focus: vi.fn() };
    const doc = {
      body,
      activeElement: body as unknown,
      getElementById: (id: string) => (id === `posting-topup-${OPEN.id}` ? trigger : null),
    };
    vi.stubGlobal("document", doc);
    return { doc, trigger };
  }
  /** Re-render with the given state and run the committed effects (as React would). */
  function commit(rowState: Record<string, unknown>, confirming: string | null) {
    const tree = render([OPEN], rowState, false, { confirming });
    effects.forEach((run) => run());
    return tree;
  }
  const BUSY = { [OPEN.id]: { busy: "topUp", error: null, notice: null } };
  const DONE = { [OPEN.id]: { busy: null, error: null, notice: "Applicant slots added." } };
  /** Ask about the row's slots, then confirm in the dialog. */
  function askThenConfirm() {
    const first = commit({}, null);
    const trigger = ofType(first, Button).find(
      (b) => textOf((b.props as { children?: ReactNode }).children).trim() === TOP_UP,
    )!;
    expect((trigger.props as { id?: string }).id).toBe(`posting-topup-${OPEN.id}`);
    (trigger.props as { onClick: () => void }).onClick();
    const open = commit({}, OPEN.id);
    footerButtons(dialogOf(open))[1]!.onClick();
  }

  it("after a confirm: nothing moves focus while it runs; once settled it returns to the slot button, once", () => {
    const { trigger } = stubDocument();
    askThenConfirm();
    commit(BUSY, null);
    expect(trigger.focus).not.toHaveBeenCalled();
    commit(DONE, null);
    expect(trigger.focus).toHaveBeenCalledTimes(1);
    commit(DONE, null);
    expect(trigger.focus).toHaveBeenCalledTimes(1);
  });

  it("after Cancel: the Dialog's own restore stands — focus is not moved again", () => {
    const { doc, trigger } = stubDocument();
    const first = commit({}, null);
    const ask = ofType(first, Button).find(
      (b) => textOf((b.props as { children?: ReactNode }).children).trim() === TOP_UP,
    )!;
    (ask.props as { onClick: () => void }).onClick();
    const open = commit({}, OPEN.id);
    footerButtons(dialogOf(open))[0]!.onClick();
    doc.activeElement = trigger; // the Dialog put it back on its trigger
    commit({}, null);
    doc.activeElement = doc.body; // …and a later blur is none of this purchase's business
    commit({}, null);
    expect(trigger.focus).not.toHaveBeenCalled();
  });

  it("a payer who moved on while it ran is left where they are", () => {
    const { doc, trigger } = stubDocument();
    askThenConfirm();
    commit(BUSY, null);
    doc.activeElement = { id: "somewhere-else" };
    commit(DONE, null);
    commit(DONE, null);
    expect(trigger.focus).not.toHaveBeenCalled();
  });
});

describe("PostingsManager — A11Y-OF-FAILURE: per-row error region is aria-live='polite' (B8)", () => {
  it("renders an aria-live='polite' error container per row", () => {
    const { ariaLiveCount } = collect(render([OPEN]));
    expect(ariaLiveCount).toBeGreaterThanOrEqual(1);
  });

  it("renders one aria-live region per posting row (announces a row failure)", () => {
    const second = { ...OPEN, id: "bbbb2222-0000-4000-8000-000000000002" };
    const { ariaLiveCount } = collect(render([OPEN, second]));
    expect(ariaLiveCount).toBe(2);
  });

  it("renders a faceless empty state that NAMES the way forward, without a second door to it", () => {
    // UI-1/Phase 16: the empty case is the shared `.state` block (what is empty + why + what to
    // do). What to do is the page head's one primary action, "New posting" — the state names
    // it rather than repeating it as a button (one door per destination, as on the agency list).
    const tree = render([]);
    const cls = classTokens(tree);
    expect(cls.has("state")).toBe(true);
    expect(cls.has("state__actions")).toBe(false);
    const text = textOf(tree);
    expect(text).toContain("No postings yet");
    expect(text).toContain("use New posting above");
    expect(hrefs(tree)).toEqual([]);
    // FACELESS: an empty feed names nobody.
    expect(text).not.toMatch(/\b(phone|worker name)\b/i);
  });
});

/** Every element whose className carries `cls` (space-separated), depth-first. */
function byClass(node: ReactNode, cls: string, acc: ReactElement[] = []): ReactElement[] {
  if (node === null || node === undefined || typeof node !== "object") return acc;
  if (Array.isArray(node)) {
    for (const c of node) byClass(c, cls, acc);
    return acc;
  }
  const el = node as ReactElement<Record<string, unknown> & { children?: ReactNode }>;
  const cn = el.props?.className;
  if (typeof cn === "string" && cn.split(/\s+/).includes(cls)) acc.push(el);
  if (el.props && "children" in el.props) byClass(el.props.children, cls, acc);
  return acc;
}

describe("PostingsManager — W3-B card anatomy (facts row / links row / action bar)", () => {
  it("the facts row holds FACTS only; Applicants / Edit are their own row, each named for its page", () => {
    const tree = render([OPEN]);
    const meta = byClass(tree, "posting-card__meta");
    const links = byClass(tree, "posting-card__links");
    expect(meta).toHaveLength(1);
    expect(links).toHaveLength(1);
    // No link inside the facts row — its separator slot is clipped (globals.css), so a focusable
    // there could lose its focus ring.
    expect(hrefs(meta[0]!)).toEqual([]);
    // The title opens the details, so the row's links are the two OTHER pages, by name.
    expect(hrefs(links[0]!)).toEqual([
      `/postings/${OPEN.id}/applicants`,
      `/postings/${OPEN.id}/edit`,
    ]);
    // One name per destination on every company surface (F13): "Applicants", "Edit posting".
    expect(textOf(links[0]!).replace(/\s+/g, " ").trim()).toBe("Applicants Edit posting");
    // The facts: the headcount is "openings" (the entity is a posting; "vacancies" named both).
    expect(textOf(meta[0]!)).toBe("Pune, MH6-20 openings2 / 10 applicantsPosted 2026-06-22");
  });

  it("the links row sits in the text column, BEFORE the row's aria-live result region", () => {
    const main = byClass(render([OPEN]), "posting-card__main")[0]!;
    const kids = (main.props as { children: ReactNode[] }).children.filter(
      (c): c is ReactElement => typeof c === "object" && c !== null,
    );
    const order = kids.map((k) => {
      const p = k.props as Record<string, unknown>;
      return typeof p.className === "string" ? p.className : `aria-live=${String(p["aria-live"])}`;
    });
    expect(order).toEqual([
      "posting-card__head",
      "posting-card__meta",
      "posting-card__links",
      "aria-live=polite",
    ]);
  });

  it("the idle result region renders EMPTY (globals.css takes it out of flow via :empty), and fills in place", () => {
    const liveOf = (tree: ReactElement) => {
      const main = byClass(tree, "posting-card__main")[0]!;
      const kids = (main.props as { children: ReactNode[] }).children;
      const live = kids.find(
        (c): c is ReactElement =>
          typeof c === "object" &&
          c !== null &&
          (c as ReactElement<Record<string, unknown>>).props["aria-live"] === "polite",
      );
      expect(live).toBeDefined();
      return live!.props as { children: ReactNode[] };
    };
    // Idle: every child is a falsy guard, so the DOM node has no children and `:empty` matches.
    expect(liveOf(render([OPEN])).children.every((c) => c === false || c == null)).toBe(true);
    // With a result, the SAME region (still in the a11y tree all along) holds the band.
    const errored = liveOf(
      render([OPEN], { [OPEN.id]: { busy: null, error: "That failed.", notice: null } }),
    );
    expect(errored.children.some((c) => typeof c === "object" && c !== null)).toBe(true);
  });

  it("the title opens the posting's DETAILS (as on the agency list); one link per destination", () => {
    const tree = render([OPEN]);
    const title = byClass(tree, "posting-card__title")[0]!;
    expect((title.props as { href: string }).href).toBe(`/postings/${OPEN.id}`);
    // Each of the row's three pages is linked exactly once.
    const all = hrefs(tree);
    for (const h of [`/postings/${OPEN.id}`, `/postings/${OPEN.id}/applicants`, `/postings/${OPEN.id}/edit`]) {
      expect(all.filter((x) => x === h), h).toHaveLength(1);
    }
  });
});

describe("PostingsManager — READ-ONLY (an agent's older company postings)", () => {
  it("shows each posting (its title opens the view-only details) — no button, no Applicants, no Edit", () => {
    const paused = { ...OPEN, id: "bbbb2222-0000-4000-8000-000000000002", status: "paused" as const };
    const tree = render([OPEN, paused], {}, true);
    expect(collect(tree).buttons).toEqual([]);
    expect(byClass(tree, "posting-card__actions")).toEqual([]);
    expect(byClass(tree, "posting-card__links")).toEqual([]);
    // The only links are the two titles, to the details.
    expect(hrefs(tree)).toEqual([`/postings/${OPEN.id}`, `/postings/${paused.id}`]);
    expect(textOf(tree)).not.toMatch(/Applicants\b|\bEdit\b/);
  });

  it("the default (company) list still offers every control — read-only is opt-in", () => {
    const tree = render([OPEN]);
    expect(collect(tree).buttons.map((b) => b.text)).toEqual(["Pause", TOP_UP, "Close posting"]);
    expect(hrefs(byClass(tree, "posting-card__links")[0]!)).toContain(`/postings/${OPEN.id}/edit`);
  });

  it("a read-only empty list offers no create action", () => {
    const tree = render([], {}, true);
    expect(hrefs(tree)).not.toContain("/postings/new");
  });
});

/**
 * #2085 — Add applicant slots is a CONFIRMED, IDEMPOTENT purchase.
 *  - SHOWN == SENT: the confirm sends back `expectedPriceInr` equal to the one ₹ figure its dialog
 *    showed (under an offer, the offer price).
 *  - ONE KEY PER CONFIRMED PURCHASE, PER POSTING: a retry of a posting's purchase (after a failure
 *    or a dropped connection) reuses its key, so the backend replays rather than buys again; another
 *    posting's purchase has its own key and never displaces it; success retires it.
 *  - A refused price is a NEUTRAL row note naming the new price (one call, no retry) and retires the
 *    key; the in-flight duplicate is a NEUTRAL "still processing" and KEEPS the key.
 */
describe("PostingsManager — #2085: the price shown is the price sent, under one key per purchase", () => {
  const SECOND: PostingSummary = {
    ...OPEN,
    id: "bbbb2222-0000-4000-8000-000000000002",
    roleTitle: "VMC Operator",
  };
  /** The top-up under an active offer: charged ₹750, list ₹1,000. */
  const OFFER_750 = { priceInr: 750, listPriceInr: 1000, additionalViews: 10 };
  const rupees = (s: string) => Number(s.replace(/[₹,\s]/g, ""));
  type Row = { busy: unknown; error: unknown; notice: unknown; info: unknown };

  /** Arm `postingId`'s confirm, press it as the payer does, and return the row's settled state. */
  async function confirmOn(postingId: string, offer: typeof OFFER = OFFER): Promise<Row> {
    const tree = render([OPEN, SECOND], {}, false, { confirming: postingId, offer });
    footerButtons(dialogOf(tree))[1]!.onClick();
    const setRows = setters[1]!;
    await new Promise((r) => setTimeout(r, 0));
    // Fold this confirm's row-state writes into the record React would hold.
    const rows = setRows.mock.calls.reduce(
      (acc, [update]) => (update as (p: Record<string, Row>) => Record<string, Row>)(acc),
      {} as Record<string, Row>,
    );
    return rows[postingId]!;
  }
  const sent = () =>
    topUpQuotaAction.mock.calls.map(
      (c) => c[0] as { postingId: string; expectedPriceInr?: number; idempotencyKey?: string },
    );
  const keys = () => sent().map((s) => s.idempotencyKey);
  const FAILED = { ok: false, error: "Could not add applicant slots right now. Please retry." };

  it("the confirm sends exactly the number its dialog showed — under an offer, the offer price", async () => {
    for (const offer of [OFFER, OFFER_750]) {
      const dialog = dialogOf(render([OPEN], {}, false, { confirming: OPEN.id, offer }));
      const body = textOf((dialog.props as { children?: ReactNode }).children);
      const figures = body.match(/₹[\d,]+/g) ?? [];
      expect(figures, body).toHaveLength(1); // one number on the confirm — no ambiguity
      await confirmOn(OPEN.id, offer);
      expect(sent().at(-1)!.expectedPriceInr, body).toBe(rupees(figures[0]!));
    }
    expect(sent().map((s) => s.expectedPriceInr)).toEqual([1000, 750]);
  });

  it("a retry reuses the posting's key; another posting has its own and never displaces it; success retires it", async () => {
    topUpQuotaAction
      .mockResolvedValueOnce(FAILED) // OPEN, first attempt
      .mockResolvedValueOnce(FAILED) // OPEN, retry
      .mockResolvedValueOnce(FAILED) // SECOND, its own purchase
      .mockResolvedValueOnce({ ok: true, posting: OPEN, notice: "Applicant slots added." }) // OPEN, retry lands
      .mockResolvedValueOnce(FAILED) // OPEN, a NEW purchase
      .mockResolvedValueOnce(FAILED); // SECOND, retry
    await confirmOn(OPEN.id);
    await confirmOn(OPEN.id);
    await confirmOn(SECOND.id);
    await confirmOn(OPEN.id);
    await confirmOn(OPEN.id);
    await confirmOn(SECOND.id);
    expect(keys()).toEqual(["key-1", "key-1", "key-2", "key-1", "key-3", "key-2"]);
    expect(sent().map((s) => s.postingId)).toEqual([OPEN.id, OPEN.id, SECOND.id, OPEN.id, OPEN.id, SECOND.id]);
  });

  it("a rejected action (connection dropped) keeps the key — the retry is the same purchase", async () => {
    topUpQuotaAction.mockRejectedValueOnce(new Error("network")).mockResolvedValueOnce(FAILED);
    const row = await confirmOn(OPEN.id);
    expect(row.error).toBe("Could not reach the server. Please retry.");
    await confirmOn(OPEN.id);
    expect(keys()).toEqual(["key-1", "key-1"]);
  });

  it("a refused price: a NEUTRAL row note with the new price, ONE call, no retry — and the key is retired", async () => {
    topUpQuotaAction.mockResolvedValueOnce({ ok: false, priceChanged: true, currentPriceInr: 1200 });
    const row = await confirmOn(OPEN.id);
    expect(row).toEqual({
      busy: null,
      error: null,
      notice: null,
      info: "The price changed to ₹1,200. Review and confirm again.",
    });
    expect(topUpQuotaAction).toHaveBeenCalledTimes(1);
    // The payer re-reads the new price and confirms again: a NEW purchase, a fresh key.
    topUpQuotaAction.mockResolvedValueOnce({ ok: true, posting: OPEN, notice: "Applicant slots added." });
    await confirmOn(OPEN.id);
    expect(keys()).toEqual(["key-1", "key-2"]);
  });

  it("the in-flight duplicate: a NEUTRAL 'still processing' note — and the key is KEPT for the re-tap", async () => {
    topUpQuotaAction.mockResolvedValueOnce({ ok: false, pending: true });
    const row = await confirmOn(OPEN.id);
    expect(row.error).toBeNull();
    expect(row.notice).toBeNull();
    expect(row.info).toMatch(/still processing/);
    topUpQuotaAction.mockResolvedValueOnce({ ok: true, posting: OPEN, notice: "Applicant slots added." });
    await confirmOn(OPEN.id);
    expect(keys()).toEqual(["key-1", "key-1"]);
  });

  it("a new attempt clears the row's last neutral note — a stale 'price changed' never sits beside the next result", () => {
    const noted = {
      [OPEN.id]: {
        busy: null,
        error: null,
        notice: null,
        info: "The price changed to ₹1,200. Review and confirm again.",
      },
    };
    const dialog = dialogOf(render([OPEN], noted, false, { confirming: OPEN.id }));
    footerButtons(dialog)[1]!.onClick();
    const update = setters[1]!.mock.calls[0]![0] as (
      prev: Record<string, unknown>,
    ) => Record<string, unknown>;
    expect(update(noted)).toEqual({
      [OPEN.id]: { busy: "topUp", error: null, notice: null, info: null },
    });
  });

  it("a neutral note renders as the info alert in the row's live region — not the danger or success band", () => {
    const tree = render([OPEN], {
      [OPEN.id]: {
        busy: null,
        error: null,
        notice: null,
        info: "The price changed to ₹1,200. Review and confirm again.",
      },
    });
    const info = byClass(tree, "alert--info");
    expect(info).toHaveLength(1);
    expect(textOf(info[0]!)).toBe("The price changed to ₹1,200. Review and confirm again.");
    expect(byClass(tree, "alert--danger")).toEqual([]);
    expect(byClass(tree, "alert--success")).toEqual([]);
    // A row that has reported is idle again: the payer can confirm at the new price.
    expect(collect(tree).buttons.every((b) => !b.disabled && !b.loading)).toBe(true);
  });

  it("Cancel sends nothing and mints no key", () => {
    const dialog = dialogOf(render([OPEN], {}, false, { confirming: OPEN.id, offer: OFFER_750 }));
    footerButtons(dialog)[0]!.onClick();
    (dialog.props as { onClose: () => void }).onClose();
    expect(topUpQuotaAction).not.toHaveBeenCalled();
    expect(uuidCounter).toBe(0);
  });
});
