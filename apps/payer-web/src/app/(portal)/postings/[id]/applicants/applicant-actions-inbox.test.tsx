import { describe, expect, it, vi, beforeEach } from "vitest";
import type { ReactElement, ReactNode } from "react";
import type * as ReactModule from "react";
import { IconButtonBase } from "@badabhai/icons/button";
import { Button, Card } from "../../../../../components/ds";
import type { ApplicantPosting } from "../../../../../lib/candidate-inbox";
import type { CandidateRow } from "./applicant-actions";

/**
 * APPLICANT ACTIONS — INBOX MODE (the Candidates tab, `/candidates`).
 *
 * The cross-posting inbox renders the SAME card and unlock pipeline as a posting's Applicants
 * page, with no `postingId`: each row carries its own posting. Pinned here:
 *  - the unlock and the masked-resume disclosure name THE ROW'S posting — and when one worker sits
 *    on two rows (he applied to two postings), the row whose Unlock was pressed, through the
 *    confirm dialog (state cell 6, `confirmContext`, appended after `result`);
 *  - ONE ConfirmSpendDialog for the whole list, outside every card;
 *  - NO board: no New / Shortlist tabs, no Keep / Pass; the head's toolbar is the caller's;
 *  - each card names its posting — a link when the session has its page, plain text when not —
 *    and a `viewOnly` posting's card offers no spend;
 *  - one worker on two rows: two cards (distinct keys), and one grant shows on both;
 *  - faceless: no phone / email / full id in the rendered text.
 *
 * Env is node. A STATEFUL `useState` model (cells persist, setState re-renders) like
 * applicant-feed.test.tsx; the cells are positional — rows 0, confirmedUnlock 1, stages 2,
 * activeStage 3, confirmWorker 4, result 5, confirmContext 6.
 */

const unlockAction = vi.fn();
const revealContactAction = vi.fn();
const maskedResumeAction = vi.fn();

vi.mock("next/link", () => ({
  default: ({ children, href, className }: { children: ReactNode; href: string; className?: string }) => ({
    type: "a",
    props: { href, className, children },
  }),
}));
vi.mock("./actions", () => ({
  unlockAction: (i: unknown) => unlockAction(i),
  revealContactAction: (i: unknown) => revealContactAction(i),
  maskedResumeAction: (i: unknown) => maskedResumeAction(i),
}));

let cells: unknown[] = [];
let cursor = 0;
let renderFn: (() => void) | null = null;
let currentTree: ReactElement | null = null;

const useState = vi.fn((init: unknown) => {
  const i = cursor++;
  if (i >= cells.length) cells[i] = typeof init === "function" ? (init as () => unknown)() : init;
  const setter = (v: unknown) => {
    cells[i] = typeof v === "function" ? (v as (p: unknown) => unknown)(cells[i]) : v;
    renderFn?.();
  };
  return [cells[i], setter] as [unknown, (v: unknown) => void];
});
vi.mock("react", async () => {
  const actual = await vi.importActual<typeof ReactModule>("react");
  return { ...actual, useState: (init: unknown) => useState(init) };
});

const { ApplicantActions } = await import("./applicant-actions");

const P1 = "11111111-0000-4000-8000-000000000001";
const P2 = "11111111-0000-4000-8000-000000000002";
const J1 = "22222222-0000-4000-8000-000000000001";
const W1 = "aaaaaaaa-0000-4000-8000-000000000001";
const W2 = "bbbbbbbb-0000-4000-8000-000000000002";

const posting = (id: string, title: string, over: Partial<ApplicantPosting> = {}): ApplicantPosting => ({
  id,
  title,
  href: `/postings/${id}`,
  viewOnly: false,
  ...over,
});

/** W1 applied to BOTH company postings (two rows); W2 to an agency job. */
const ROW_A: CandidateRow = {
  workerId: W1,
  rank: 2,
  score: 0,
  hot: false,
  signals: [],
  tradeLabel: "CNC Turner",
  matchTier: 1,
  skillMonths: 36,
  posting: posting(P1, "CNC Turner"),
};
const ROW_B: CandidateRow = { ...ROW_A, rank: 1, posting: posting(P2, "VMC Operator") };
const ROW_C: CandidateRow = {
  workerId: W2,
  rank: 3,
  score: 0.71,
  hot: true,
  signals: ["Same trade"],
  tradeLabel: "Fitter",
  experienceBand: "3-5 yrs",
  cityLabel: "Pune",
  posting: posting(J1, "Fitter", { href: `/agency/jobs/${J1}` }),
};

const FILTER = { type: "form", props: { className: "candidates-filter-stub", children: "filter" } };

function mount(
  applicants: CandidateRow[],
  opts: { balance?: number; unlocked?: Record<string, { kind: "granted"; unlockId: string; expiresAt: string }> } = {},
) {
  cells = [];
  renderFn = () => {
    cursor = 0;
    currentTree = ApplicantActions({
      header: { title: "Candidates", description: "Everyone who applied.", toolbar: FILTER as unknown as ReactNode },
      applicants,
      balance: opts.balance ?? 5,
      ...(opts.unlocked ? { unlocked: opts.unlocked } : {}),
    }) as ReactElement;
  };
  renderFn();
}

function textOf(node: ReactNode): string {
  if (node === null || node === undefined || typeof node === "boolean") return "";
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(textOf).join("");
  const el = node as ReactElement<{ children?: ReactNode }>;
  return el.props && "children" in el.props ? textOf(el.props.children) : "";
}

const isNamed = (el: { type?: unknown }, name: string) =>
  typeof el.type === "function" && (el.type as { name?: string }).name === name;

type El = ReactElement<Record<string, unknown> & { children?: ReactNode }>;

/** Every element in the returned tree (ConfirmSpendDialog expanded; the hooked Dialog never). */
function elements(node: ReactNode = currentTree, out: El[] = []): El[] {
  if (node === null || node === undefined || typeof node !== "object") return out;
  if (Array.isArray(node)) {
    for (const n of node) elements(n, out);
    return out;
  }
  const el = node as El;
  out.push(el);
  if (isNamed(el, "ConfirmSpendDialog")) {
    elements((el.type as (p: unknown) => ReactNode)(el.props), out);
    return out;
  }
  if (el.props && "toolbar" in el.props) elements(el.props.toolbar as ReactNode, out);
  if (el.props && "footer" in el.props) elements(el.props.footer as ReactNode, out);
  if (el.props && "children" in el.props) elements(el.props.children, out);
  return out;
}

interface Btn {
  text: string;
  onClick?: () => unknown;
  disabled?: boolean;
}
function buttons(scope: ReactNode = currentTree): Btn[] {
  return elements(scope)
    .filter((el) => el.type === Button)
    .map((el) => ({
      text: textOf(el.props.children as ReactNode).trim(),
      onClick: el.props.onClick as (() => unknown) | undefined,
      disabled: el.props.disabled as boolean | undefined,
    }));
}

/** The cards (DS Card elements with the `applicant` class), in render order. */
const cards = () =>
  elements().filter((el) => el.type === Card && el.props.className === "applicant");

/** Deep visible text, expanding pure child components (never the hooked Dialog / icon button). */
function deepText(node: ReactNode = currentTree, seen: WeakSet<object> = new WeakSet()): string {
  if (node === null || node === undefined || typeof node === "boolean") return "";
  if (typeof node === "string" || typeof node === "number") return ` ${node} `;
  if (Array.isArray(node)) return node.map((n) => deepText(n, seen)).join("");
  const el = node as El;
  if (seen.has(el)) return "";
  seen.add(el);
  const hooked = isNamed(el, "Dialog") || el.type === IconButtonBase;
  if (typeof el.type === "function" && !hooked) {
    return deepText((el.type as (p: unknown) => ReactNode)(el.props), seen);
  }
  let out = "";
  if (el.props && "toolbar" in el.props) out += deepText(el.props.toolbar as ReactNode, seen);
  if (el.props && "footer" in el.props) out += deepText(el.props.footer as ReactNode, seen);
  if (el.props && "children" in el.props) out += deepText(el.props.children as ReactNode, seen);
  return out;
}

const GRANTED = {
  ok: true,
  view: { kind: "granted", unlockId: "44444444-4444-4444-8444-444444444444", expiresAt: "2026-11-01T00:00:00.000Z" },
};

beforeEach(() => {
  unlockAction.mockReset();
  revealContactAction.mockReset();
  maskedResumeAction.mockReset();
});

describe("inbox mode — the unlock names THE ROW's posting (one worker, two postings)", () => {
  it("the second row's Unlock → confirm spends with the SECOND row's posting as job context", async () => {
    unlockAction.mockResolvedValue(GRANTED);
    mount([ROW_A, ROW_B]);
    const unlocks = (scope: ReactNode) => buttons(scope).filter((b) => b.text === "Unlock contact (1 credit)");
    const second = cards()[1]!;
    unlocks(second)[0]!.onClick!();
    expect(unlockAction).not.toHaveBeenCalled(); // the dialog opened; nothing spent yet
    expect(cells[4]).toBe(W1);
    expect(cells[6]).toBe(P2);
    await buttons().find((b) => b.text.startsWith("Unlock · 1 credit"))!.onClick!();
    expect(unlockAction).toHaveBeenCalledTimes(1);
    expect(unlockAction).toHaveBeenCalledWith({ postingId: P2, workerId: W1 });
    // The dialog closed and forgot the row.
    expect(cells[4]).toBeNull();
    expect(cells[6]).toBeNull();
  });

  it("the first row's Unlock names the first row's posting", async () => {
    unlockAction.mockResolvedValue(GRANTED);
    mount([ROW_A, ROW_B]);
    buttons(cards()[0]!).find((b) => b.text === "Unlock contact (1 credit)")!.onClick!();
    await buttons().find((b) => b.text.startsWith("Unlock · 1 credit"))!.onClick!();
    expect(unlockAction).toHaveBeenCalledWith({ postingId: P1, workerId: W1 });
  });

  it("one grant per (payer, worker): unlocking him on one row shows BOTH of his rows unlocked", async () => {
    unlockAction.mockResolvedValue(GRANTED);
    mount([ROW_A, ROW_B, ROW_C]);
    buttons(cards()[0]!).find((b) => b.text === "Unlock contact (1 credit)")!.onClick!();
    await buttons().find((b) => b.text.startsWith("Unlock · 1 credit"))!.onClick!();
    const [a, b, c] = cards();
    for (const card of [a!, b!]) {
      expect(buttons(card).map((x) => x.text)).toContain("Open routed contact");
      expect(buttons(card).map((x) => x.text)).not.toContain("Unlock contact (1 credit)");
    }
    expect(buttons(c!).map((x) => x.text)).toContain("Unlock contact (1 credit)");
  });

  it("the masked resume names the row's posting as its disclosure context", async () => {
    maskedResumeAction.mockResolvedValue({ ok: false, error: "x" });
    const held = { kind: "granted" as const, unlockId: GRANTED.view.unlockId, expiresAt: GRANTED.view.expiresAt };
    mount([ROW_A, ROW_B], { unlocked: { [W1]: held } });
    await buttons(cards()[1]!).find((b) => b.text === "View masked resume")!.onClick!();
    expect(maskedResumeAction).toHaveBeenCalledWith({ unlockId: held.unlockId, workerId: W1, postingId: P2 });
  });
});

describe("inbox mode — ONE confirm dialog, the shared chrome", () => {
  it("renders exactly one ConfirmSpendDialog for a three-card list, never inside a card", () => {
    mount([ROW_A, ROW_B, ROW_C]);
    const dialogs = elements().filter((el) => isNamed(el, "ConfirmSpendDialog"));
    expect(dialogs).toHaveLength(1);
    for (const card of cards()) {
      expect(elements(card).filter((el) => isNamed(el, "ConfirmSpendDialog"))).toHaveLength(0);
    }
    expect(cards()).toHaveLength(3);
  });
});

describe("inbox mode — no board: the head's toolbar is the caller's, no stage controls", () => {
  it("renders no stage tabs and no Keep / Pass / Mark as contacted on any card", () => {
    mount([ROW_A, ROW_B, ROW_C]);
    const texts = buttons().map((b) => b.text);
    expect(texts).not.toContain("Keep");
    expect(texts).not.toContain("Pass");
    expect(elements().filter((el) => Array.isArray(el.props?.tabs))).toHaveLength(0);
    expect(elements().filter((el) => el.props?.className === "applicant__actions")).toHaveLength(0);
    expect(deepText()).not.toMatch(/New \(\d+\)|Shortlist \(\d+\)/);
  });

  it("the ONE PageHeader carries the caller's toolbar (the posting filter)", () => {
    mount([ROW_A]);
    const heads = elements().filter((el) => isNamed(el, "PageHeader"));
    expect(heads).toHaveLength(1);
    expect(heads[0]!.props.toolbar).toBe(FILTER);
    expect(heads[0]!.props.title).toBe("Candidates");
  });

  it("every row the page was given is shown, in the server's order", () => {
    mount([ROW_C, ROW_A, ROW_B]);
    const ids = cards().map((card) =>
      textOf(
        elements(card).find((el) => String(el.props?.className ?? "").includes("applicant__id-code"))!
          .props.children as ReactNode,
      ),
    );
    expect(ids).toEqual(["bbbbbbbb…", "aaaaaaaa…", "aaaaaaaa…"]);
  });
});

describe("inbox mode — each card names its posting", () => {
  it("links the title to the posting's details when the session has that page", () => {
    mount([ROW_A, ROW_C]);
    const links = elements().filter((el) => el.props?.className === "applicant__posting-link");
    expect(links.map((l) => [l.props.href, textOf(l.props.children as ReactNode)])).toEqual([
      [`/postings/${P1}`, "CNC Turner"],
      [`/agency/jobs/${J1}`, "Fitter"],
    ]);
    expect(deepText()).toContain("Applied to");
  });

  it("a posting with no page for this session is plain text — no link at all", () => {
    mount([{ ...ROW_A, posting: posting(P1, "Old company posting", { href: null, viewOnly: true }) }]);
    expect(elements().filter((el) => el.props?.className === "applicant__posting-link")).toHaveLength(0);
    const title = elements().find((el) => el.props?.className === "applicant__posting-title")!;
    expect(textOf(title.props.children as ReactNode)).toBe("Old company posting");
  });

  it("a viewOnly posting's card offers NO spend — a constant line instead", () => {
    mount([
      { ...ROW_A, posting: posting(P1, "Old company posting", { href: null, viewOnly: true }) },
      ROW_C,
    ]);
    const [viewOnly, open] = cards();
    expect(buttons(viewOnly!).map((b) => b.text)).toEqual([]);
    expect(deepText(viewOnly!)).toContain("View only");
    expect(buttons(open!).map((b) => b.text)).toContain("Unlock contact (1 credit)");
  });

  it("one worker on two postings is two cards with distinct keys", () => {
    mount([ROW_A, ROW_B]);
    const keys = cards().map((c) => c.key);
    expect(keys).toHaveLength(2);
    expect(new Set(keys).size).toBe(2);
  });
});

describe("inbox mode — faceless", () => {
  it("no phone / email / full worker id in the rendered text, before and after an unlock", async () => {
    unlockAction.mockResolvedValue(GRANTED);
    revealContactAction.mockResolvedValue({
      ok: true,
      view: { kind: "routed", relayHandle: "RELAY-7h3k9q", channel: "in_app_relay", expiresAt: "2026-11-01T00:00:00.000Z" },
    });
    mount([ROW_A, ROW_B, ROW_C]);
    const check = () => {
      const text = deepText();
      expect(text).not.toMatch(/\d{10,}/);
      expect(text).not.toMatch(/\+\d{7,}/);
      expect(text).not.toMatch(/@/);
      for (const id of [W1, W2]) expect(text).not.toContain(id);
    };
    check();
    buttons(cards()[2]!).find((b) => b.text === "Unlock contact (1 credit)")!.onClick!();
    await buttons().find((b) => b.text.startsWith("Unlock · 1 credit"))!.onClick!();
    await buttons(cards()[2]!).find((b) => b.text === "Open routed contact")!.onClick!();
    expect(deepText()).toContain("RELAY-7h3k9q");
    check();
  });
});
