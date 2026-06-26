import { describe, expect, it, vi, beforeEach } from "vitest";
import type { ReactElement, ReactNode } from "react";
import type * as ReactModule from "react";
import type { FacelessApplicant } from "../../../../../lib/contracts";

/**
 * APPLICANT-FEED driven-render tests — render the faceless feed (a mock applicant-list
 * response) and DRIVE the real unlock→reveal flow with mocked Server Actions, asserting
 * on the rendered output. Complements applicant-actions.test.tsx (which seeds state): this
 * file proves the actual STATE TRANSITIONS.
 *
 * Env is node (no DOM) — the repo convention. We render the component with a STATEFUL
 * `useState` mock that persists state across re-renders and re-invokes the component on
 * setState (a minimal React-state model), so a click that calls a mocked action and then
 * `setState` actually flips the rendered tree. Pure child components (RoutedContact /
 * MaskedResume — no hooks) are EXPANDED when gathering text, so the no-PII check covers the
 * reveal card too. The Server Actions and `next/link` are mocked; `window.confirm` is stubbed.
 *
 * Acceptance covered:
 *  (a) Call/WhatsApp are DISABLED pre-unlock and stay disabled after unlock-but-before-reveal;
 *      they ENABLE only once a mocked reveal returns a routed relay handle.
 *  (b) No phone-number / full-name string appears in the rendered output (incl. the reveal card).
 *  (c) Keep moves a row New→Shortlist with NO network call.
 *  (d) Rows render in backend feed order (no client re-sort).
 *  (e) The `hot` badge reflects the backend boolean, not a client-side percentile.
 */

const unlockAction = vi.fn();
const revealContactAction = vi.fn();
const maskedResumeAction = vi.fn();

vi.mock("next/link", () => ({
  default: ({ children, href }: { children: ReactNode; href: string }) => ({
    type: "a",
    props: { href, children },
  }),
}));
vi.mock("./actions", () => ({
  unlockAction: (i: unknown) => unlockAction(i),
  revealContactAction: (i: unknown) => revealContactAction(i),
  maskedResumeAction: (i: unknown) => maskedResumeAction(i),
}));

/* ── Minimal stateful hooks model (persists cells; re-renders on setState) ──────── */
let cells: unknown[] = [];
let cursor = 0;
let renderFn: (() => void) | null = null;
let currentTree: ReactElement | null = null;

const useState = vi.fn((init: unknown) => {
  const i = cursor++;
  if (i >= cells.length) cells[i] = typeof init === "function" ? (init as () => unknown)() : init;
  const setter = (v: unknown) => {
    cells[i] = typeof v === "function" ? (v as (p: unknown) => unknown)(cells[i]) : v;
    renderFn?.(); // synchronous re-render — mirrors React applying state then re-rendering
  };
  return [cells[i], setter] as [unknown, (v: unknown) => void];
});
vi.mock("react", async () => {
  const actual = await vi.importActual<typeof ReactModule>("react");
  return { ...actual, useState: (init: unknown) => useState(init) };
});

const confirmMock = vi.fn();
vi.stubGlobal("window", { confirm: confirmMock });

const { ApplicantActions } = await import("./applicant-actions");

const POSTING = "33333333-3333-4333-8333-333333333333";
const A: FacelessApplicant = { workerId: "aaaaaaaa-0000-4000-8000-000000000001", rank: 1, score: 0.91, hot: true, signals: ["on-trade"], tradeLabel: "VMC Operator", experienceBand: "6-10 yrs", cityLabel: "pune" };
const B: FacelessApplicant = { workerId: "bbbbbbbb-0000-4000-8000-000000000002", rank: 2, score: 0.74, hot: false, signals: ["adjacent"], tradeLabel: "CNC Operator", experienceBand: "1-2 yrs", cityLabel: "nashik" };
const C: FacelessApplicant = { workerId: "cccccccc-0000-4000-8000-000000000003", rank: 3, score: 0.6, hot: true, signals: ["city"], tradeLabel: "Fitter", experienceBand: "3-5 yrs", cityLabel: "pune" };

/** Render the component fresh, wiring the stateful re-render loop. */
function mount(applicants: FacelessApplicant[], balance = 5) {
  cells = [];
  renderFn = () => {
    cursor = 0;
    currentTree = ApplicantActions({ postingId: POSTING, applicants, balance }) as ReactElement;
  };
  renderFn();
}

interface Btn {
  text: string;
  onClick?: () => unknown;
  disabled?: boolean;
}

function textOf(node: ReactNode): string {
  if (node === null || node === undefined || typeof node === "boolean") return "";
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(textOf).join("");
  const el = node as ReactElement<{ children?: ReactNode }>;
  return el.props && "children" in el.props ? textOf(el.props.children) : "";
}

/** Shallow walk for buttons (all live directly in the component output). */
function buttons(): Btn[] {
  const acc: Btn[] = [];
  (function walk(node: ReactNode): void {
    if (node === null || node === undefined || typeof node === "boolean") return;
    if (typeof node === "string" || typeof node === "number") return;
    if (Array.isArray(node)) {
      node.forEach(walk);
      return;
    }
    const el = node as ReactElement<Record<string, unknown> & { children?: ReactNode }>;
    if (el.type === "button") {
      acc.push({
        text: textOf(el.props.children as ReactNode).trim(),
        onClick: el.props.onClick as (() => unknown) | undefined,
        disabled: el.props.disabled as boolean | undefined,
      });
    }
    if (el.props && "children" in el.props) walk(el.props.children as ReactNode);
  })(currentTree);
  return acc;
}

/** Deep text — EXPANDS pure function child components (RoutedContact/MaskedResume). */
function deepText(node: ReactNode = currentTree): string {
  if (node === null || node === undefined || typeof node === "boolean") return "";
  if (typeof node === "string" || typeof node === "number") return ` ${node} `;
  if (Array.isArray(node)) return node.map((n) => deepText(n)).join("");
  const el = node as ReactElement<Record<string, unknown> & { children?: ReactNode }>;
  // Expand a PURE (hook-free) child component by invoking it with its props.
  if (typeof el.type === "function") {
    return deepText((el.type as (p: unknown) => ReactNode)(el.props));
  }
  return el.props && "children" in el.props ? deepText(el.props.children as ReactNode) : "";
}

/** Ordered workerId-prefix mono cells (the visible rows). */
function monoPrefixes(): string[] {
  const out: string[] = [];
  (function walk(node: ReactNode): void {
    if (node === null || node === undefined || typeof node === "boolean") return;
    if (typeof node === "string" || typeof node === "number") return;
    if (Array.isArray(node)) {
      node.forEach(walk);
      return;
    }
    const el = node as ReactElement<Record<string, unknown> & { children?: ReactNode }>;
    if (el.props?.className === "mono") {
      const t = textOf(el.props.children as ReactNode);
      if (t.endsWith("…")) out.push(t);
    }
    if (el.props && "children" in el.props) walk(el.props.children as ReactNode);
  })(currentTree);
  return out;
}

function hotBadgeCount(): number {
  let n = 0;
  (function walk(node: ReactNode): void {
    if (node === null || node === undefined || typeof node === "boolean") return;
    if (typeof node === "string" || typeof node === "number") return;
    if (Array.isArray(node)) {
      node.forEach(walk);
      return;
    }
    const el = node as ReactElement<Record<string, unknown> & { children?: ReactNode }>;
    if (el.props?.className === "badge badge-hot" && textOf(el.props.children as ReactNode).trim() === "Hot") {
      n += 1;
    }
    if (el.props && "children" in el.props) walk(el.props.children as ReactNode);
  })(currentTree);
  return n;
}

const find = (t: string) => buttons().find((b) => b.text === t);
const findStarts = (t: string) => buttons().find((b) => b.text.startsWith(t));

beforeEach(() => {
  unlockAction.mockReset();
  revealContactAction.mockReset();
  maskedResumeAction.mockReset();
  confirmMock.mockReset().mockReturnValue(true);
});

const GRANTED = {
  ok: true,
  view: { kind: "granted", unlockId: "44444444-4444-4444-8444-444444444444", expiresAt: "2026-07-01T00:00:00.000Z" },
};
const ROUTED = {
  ok: true,
  view: { kind: "routed", relayHandle: "RELAY-7h3k9q", channel: "in_app_relay", expiresAt: "2026-07-01T00:00:00.000Z" },
};

describe("applicant feed — (a) Call/WhatsApp enable ONLY after a mocked reveal returns a relay handle", () => {
  it("disabled pre-unlock → disabled after unlock-but-before-reveal → enabled after the reveal", async () => {
    unlockAction.mockResolvedValue(GRANTED);
    revealContactAction.mockResolvedValue(ROUTED);
    mount([A]);

    // Pre-unlock: both contact affordances are present but DISABLED.
    expect(find("Call")!.disabled).toBe(true);
    expect(find("WhatsApp")!.disabled).toBe(true);
    expect(revealContactAction).not.toHaveBeenCalled();

    // Drive the unlock (spend confirmed) → granted. Call/WhatsApp must STILL be disabled
    // (a granted unlock alone is not a routed reveal).
    await find("Unlock contact (1 credit)")!.onClick!();
    expect(unlockAction).toHaveBeenCalledTimes(1);
    expect(find("Call")!.disabled).toBe(true);
    expect(find("WhatsApp")!.disabled).toBe(true);
    expect(findStarts("Open routed contact")).toBeDefined();

    // Drive the reveal → routed relay handle. NOW Call/WhatsApp enable.
    await findStarts("Open routed contact")!.onClick!();
    expect(revealContactAction).toHaveBeenCalledTimes(1);
    expect(find("Call")!.disabled).toBeFalsy();
    expect(find("WhatsApp")!.disabled).toBeFalsy();
    // The opaque relay handle + channel rendered; clicking Call is local (no re-reveal).
    expect(deepText()).toContain("RELAY-7h3k9q");
    await find("Call")!.onClick!();
    expect(revealContactAction).toHaveBeenCalledTimes(1); // unchanged — no network re-call
  });
});

describe("applicant feed — (b) zero PII (no phone / full name) in the rendered output", () => {
  it("the faceless feed AND the revealed routed card carry no phone digits / email / name labels", async () => {
    unlockAction.mockResolvedValue(GRANTED);
    revealContactAction.mockResolvedValue(ROUTED);
    mount([A, B, C]);
    // Base feed: opaque ids + bands/signals only.
    let text = deepText();
    expect(text).not.toMatch(/\d{10,}/); // no 10+ digit run (a phone)
    expect(text).not.toMatch(/\+\d{7,}/); // no +country-code phone
    expect(text).not.toMatch(/@/); // no email
    expect(text).not.toMatch(/full name|employer/i);

    // Drive unlock + reveal on the first row, then re-check the FULL tree incl. the card.
    await find("Unlock contact (1 credit)")!.onClick!();
    await findStarts("Open routed contact")!.onClick!();
    text = deepText();
    expect(text).toContain("RELAY-7h3k9q"); // the opaque handle rendered (card is in the tree)
    expect(text).toContain("In-app relay"); // channel label only (in_app_relay | proxy_number)
    expect(text).not.toMatch(/\d{10,}/);
    expect(text).not.toMatch(/\+\d{7,}/);
  });
});

describe("applicant feed — (c) Keep moves a row New→Shortlist with NO network call", () => {
  it("Keep is a local stage transition; the row leaves New and appears under Shortlist", async () => {
    mount([A, B]);
    // Both rows start in New.
    expect(monoPrefixes()).toEqual(["aaaaaaaa…", "bbbbbbbb…"]);

    // Keep the FIRST row (A). Buttons render in row order, so the first "Keep" is A's.
    find("Keep")!.onClick!();
    expect(unlockAction).not.toHaveBeenCalled();
    expect(revealContactAction).not.toHaveBeenCalled();
    expect(maskedResumeAction).not.toHaveBeenCalled();

    // New now shows only B; the tab counts reflect the move.
    expect(monoPrefixes()).toEqual(["bbbbbbbb…"]);
    expect(findStarts("New")!.text).toBe("New (1)");
    expect(findStarts("Shortlist")!.text).toBe("Shortlist (1)");

    // Switch to the Shortlist tab → A is there.
    findStarts("Shortlist")!.onClick!();
    expect(monoPrefixes()).toEqual(["aaaaaaaa…"]);
  });
});

describe("applicant feed — (d) rows preserve backend order (no client re-sort)", () => {
  it("renders rows in the exact feed order they were given", () => {
    mount([A, B, C]);
    expect(monoPrefixes()).toEqual(["aaaaaaaa…", "bbbbbbbb…", "cccccccc…"]);
    // Even with a 'better' score later in the array, order is NOT changed (backend-owned).
    const reordered = [C, A, B];
    mount(reordered);
    expect(monoPrefixes()).toEqual(["cccccccc…", "aaaaaaaa…", "bbbbbbbb…"]);
  });
});

describe("applicant feed — (e) hot badge reflects the backend boolean, not a client percentile", () => {
  it("shows a hot badge on exactly the rows with hot=true", () => {
    mount([A, B, C]); // hot: A=true, B=false, C=true
    expect(hotBadgeCount()).toBe(2);
    // All-hot and none-hot feeds render N and 0 — never a fixed top-X% slice.
    mount([{ ...A, hot: true }, { ...B, hot: true }, { ...C, hot: true }]);
    expect(hotBadgeCount()).toBe(3);
    mount([{ ...A, hot: false }, { ...B, hot: false }]);
    expect(hotBadgeCount()).toBe(0);
  });
});
