import { describe, expect, it, vi, beforeEach } from "vitest";
import type { ReactElement, ReactNode } from "react";
import type * as ReactModule from "react";
import { ACTION_ICON } from "@badabhai/icons";
import type { FacelessApplicant } from "../../../../../lib/contracts";
import { NEUTRAL_UNLOCK_MESSAGE, mapUnlockResult } from "../../../../../lib/unlock-view";
import type { GrantedUnlock } from "../../../../../lib/unlock-history";
import { Badge, Button } from "../../../../../components/ds";

/**
 * APPLICANT-ACTIONS tests — DS1.3 re-skin. CONFIRM-ON-SPEND (C11) + A11Y-OF-FAILURE (B8).
 *
 * C11: the FIRST unlock per row OPENS a DS Dialog (the spend gate) instead of `window.confirm`;
 * it does NOT call the unlock action yet. Clicking the dialog's confirm Button runs the (ids-only)
 * unlock and marks the row confirmed. A row already confirmed this session unlocks directly with
 * NO dialog (a retry never re-prompts; reveal/resume are not spend actions and never confirm).
 * B8: each per-row error region (unlock/contact/resume) is wrapped in `aria-live="polite"`.
 *
 * Env is node (no DOM); React state is injected via a mocked `useState` (source order:
 * rows, confirmedUnlock, stages, activeStage, confirmWorker). Actions are DS `Button`s — we
 * collect by `el.type === Button` and fire `props.onClick`. The component handlers are async; we
 * fire onClick and assert the gate + whether the unlock action ran.
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

// Injected per-render state queue (rows, confirmedUnlock, stages, activeStage, confirmWorker).
// Each call's SETTER is captured by index so a LOCAL transition (Keep/Pass/reach) can be asserted
// to fire the right setter (and, by exercising the updater, the right next state) with NO network.
let stateQueue: unknown[] = [];
let stateCursor = 0;
let setters: Array<ReturnType<typeof vi.fn>> = [];
const useState = vi.fn((initial: unknown) => {
  const i = stateCursor++;
  const seeded = i < stateQueue.length ? stateQueue[i] : initial;
  const setter = vi.fn();
  setters[i] = setter;
  return [seeded, setter] as [unknown, (v: unknown) => void];
});
vi.mock("react", async () => {
  const actual = await vi.importActual<typeof ReactModule>("react");
  return { ...actual, useState: (initial: unknown) => useState(initial) };
});

const { ApplicantActions } = await import("./applicant-actions");
const { PageHeader } = await import("../../../../../components/page-header");

/** The head text the page hands the feed (it names the posting from its own postings read). */
const HEADER = {
  back: { href: "/postings/33333333-3333-4333-8333-333333333333", label: "CNC Turner" },
  title: "Applicants",
  description: "Everyone who applied to CNC Turner, best match first and faceless until you unlock a contact.",
};

const WORKER = "55555555-5555-4555-8555-555555555555";
const APPLICANT: FacelessApplicant = {
  workerId: WORKER,
  rank: 1,
  score: 0.9,
  hot: true,
  signals: ["on-trade"],
  experienceBand: "6-10 yrs",
  tradeLabel: "VMC Operator",
  cityLabel: "pune",
};

interface Collected {
  buttons: Array<{
    text: string;
    onClick?: () => void;
    disabled?: boolean;
    loading?: boolean;
    iconLeft?: unknown;
    title?: unknown;
    describedBy?: unknown;
  }>;
  ariaLiveCount: number;
}

function textOf(node: ReactNode): string {
  if (node === null || node === undefined || typeof node === "boolean") return "";
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(textOf).join("");
  const el = node as ReactElement<{ children?: ReactNode }>;
  return el.props && "children" in el.props ? textOf(el.props.children) : "";
}

/**
 * The confirm-on-spend DS Dialog is CHROME (always in the tree, gated by `open`), not candidate
 * row data; its neutral static copy ("…never a phone number") and confirm Button are intentional.
 * Row-content walkers (faceless / no-PII / per-row buttons) skip it; the dialog-specific tests
 * walk its `footer` explicitly via `collect` (which descends footer) to find Cancel / confirm.
 */
function isDialogEl(el: { type?: unknown }): boolean {
  return typeof el.type === "function" && (el.type as { name?: string }).name === "Dialog";
}

/**
 * `ConfirmSpendDialog` (DS1.5) is a PURE wrapper around the hooked DS `Dialog` — invoking it is
 * safe and yields the inner `<Dialog footer=… open=…>`. Walkers expand it so the confirm/cancel
 * footer Buttons remain reachable (the inner `Dialog` itself is still NEVER invoked — `isDialogEl`).
 */
function isConfirmDialogEl(el: { type?: unknown }): boolean {
  return typeof el.type === "function" && (el.type as { name?: string }).name === "ConfirmSpendDialog";
}
function expandConfirmDialog(el: { type: (p: unknown) => ReactNode; props: unknown }): ReactNode {
  return el.type(el.props);
}

/**
 * Walk the element tree. Buttons are DS `Button` elements (props carry text/onClick/disabled/
 * loading); badges are DS `Badge` elements. We do NOT expand stateful components (Dialog has a
 * hook) — its footer Buttons live in its `footer` prop, which we walk explicitly.
 */
function walk(node: ReactNode, acc: Collected): void {
  if (node === null || node === undefined || typeof node === "boolean") return;
  if (typeof node === "string" || typeof node === "number") return;
  if (Array.isArray(node)) {
    for (const c of node) walk(c, acc);
    return;
  }
  const el = node as ReactElement<Record<string, unknown> & { children?: ReactNode }>;
  if (isConfirmDialogEl(el)) {
    walk(expandConfirmDialog(el as never), acc);
    return;
  }
  if (el.type === Button) {
    acc.buttons.push({
      text: textOf(el.props.children as ReactNode).trim(),
      onClick: el.props.onClick as (() => void) | undefined,
      disabled: el.props.disabled as boolean | undefined,
      loading: el.props.loading as boolean | undefined,
      iconLeft: el.props.iconLeft,
      title: el.props.title,
      describedBy: el.props["aria-describedby"],
    });
  }
  if (el.props["aria-live"] === "polite") acc.ariaLiveCount++;
  // Dialog footer Buttons live in the `footer` prop, not in children; the pipeline tabs live in
  // the page head's `toolbar` prop.
  if ("footer" in el.props) walk(el.props.footer as ReactNode, acc);
  if ("toolbar" in el.props) walk(el.props.toolbar as ReactNode, acc);
  if ("children" in el.props) walk(el.props.children, acc);
}

function collect(tree: ReactNode): Collected {
  const acc: Collected = { buttons: [], ariaLiveCount: 0 };
  walk(tree, acc);
  return acc;
}

function render(opts: {
  rows?: Record<string, unknown>;
  confirmedUnlock?: Record<string, boolean>;
  stages?: Record<string, "new" | "shortlist" | "passed">;
  activeStage?: "new" | "shortlist";
  confirmWorker?: string | null;
  applicants?: FacelessApplicant[];
  balance?: number;
  canBuyCredits?: boolean;
  /** The page's LIVE grants for this feed (omitted → the component's own default). */
  unlocked?: Record<string, GrantedUnlock>;
}) {
  // Source order of useState: rows, confirmedUnlock, stages, activeStage, confirmWorker.
  stateQueue = [
    opts.rows ?? {},
    opts.confirmedUnlock ?? {},
    opts.stages ?? {},
    opts.activeStage ?? "new",
    opts.confirmWorker ?? null,
  ];
  stateCursor = 0;
  setters = [];
  return ApplicantActions({
    header: HEADER,
    postingId: "33333333-3333-4333-8333-333333333333",
    applicants: opts.applicants ?? [APPLICANT],
    balance: opts.balance ?? 5,
    // An OWNER by default (the viewer who may open /credits); the recruiter case is explicit.
    canBuyCredits: opts.canBuyCredits ?? true,
    ...(opts.unlocked ? { unlocked: opts.unlocked } : {}),
  }) as ReactElement;
}

/** A granted-unlock + ROUTED-reveal row state (the gate for "Mark as contacted"). */
function routedRowState() {
  return {
    [WORKER]: {
      busy: false,
      unlock: { kind: "granted", unlockId: "44444444-4444-4444-8444-444444444444", expiresAt: "2026-07-01T00:00:00.000Z" },
      unlockError: null,
      contactBusy: false,
      contact: { kind: "routed", relayHandle: "RELAY-abcdef", channel: "in_app_relay", expiresAt: "2026-07-01T00:00:00.000Z" },
      contactError: null,
      resumeBusy: false,
      resume: null,
      resumeError: null,
    },
  };
}

beforeEach(() => {
  unlockAction.mockReset().mockResolvedValue({ ok: true, view: { kind: "unavailable", message: "x" } });
  revealContactAction.mockReset();
  maskedResumeAction.mockReset();
});

describe("ApplicantActions — CONFIRM-ON-SPEND on the FIRST unlock per row (C11)", () => {
  it("the FIRST unlock click OPENS the confirm dialog and does NOT call the unlock action yet", () => {
    const { buttons } = collect(render({}));
    const unlock = buttons.find((b) => b.text.includes("Unlock contact"));
    expect(unlock).toBeDefined();
    unlock!.onClick!();
    // confirmWorker is setter index 4 — the FIRST unlock opens the dialog (the spend gate).
    expect(setters[4]).toHaveBeenCalledTimes(1);
    expect(setters[4]!.mock.calls[0]![0]).toBe(WORKER);
    // No spend yet: the unlock action has NOT run on the first click.
    expect(unlockAction).not.toHaveBeenCalled();
  });

  it("confirming in the dialog runs the unlock with ONLY ids (no amount) and marks confirmed", () => {
    // Seed confirmWorker = WORKER so the dialog's success Button reads it on click.
    const { buttons } = collect(render({ confirmWorker: WORKER }));
    const confirm = buttons.find((b) => b.text.includes("Unlock · 1 credit"));
    expect(confirm).toBeDefined();
    confirm!.onClick!();
    // confirmedUnlock is setter index 1; the updater marks WORKER confirmed.
    expect(setters[1]).toHaveBeenCalledTimes(1);
    const updater = setters[1]!.mock.calls[0]![0] as (p: Record<string, boolean>) => Record<string, boolean>;
    expect(updater({})).toEqual({ [WORKER]: true });
    // The dialog is closed (confirmWorker → null) and the (ids-only) unlock runs.
    expect(setters[4]).toHaveBeenCalledWith(null);
    expect(unlockAction).toHaveBeenCalledWith({
      postingId: "33333333-3333-4333-8333-333333333333",
      workerId: WORKER,
    });
    // XT5: ids only — no price/amount/credit number in the body.
    const arg = unlockAction.mock.calls[0]![0] as Record<string, unknown>;
    expect(Object.keys(arg).sort()).toEqual(["postingId", "workerId"]);
  });

  it("a row already confirmed this session unlocks DIRECTLY with no dialog (fires once per row)", () => {
    // Seed confirmedUnlock[WORKER] = true → the dialog branch is skipped; unlock runs directly.
    const { buttons } = collect(render({ confirmedUnlock: { [WORKER]: true } }));
    buttons.find((b) => b.text.includes("Unlock contact"))!.onClick!();
    // No dialog opened (confirmWorker setter untouched) and the retry unlock runs immediately.
    expect(setters[4]).not.toHaveBeenCalled();
    expect(unlockAction).toHaveBeenCalledTimes(1);
  });
});

describe("ApplicantActions — A11Y-OF-FAILURE: per-row unlock error region is aria-live='polite' (B8)", () => {
  it("renders an aria-live='polite' region around the per-row error", () => {
    const { ariaLiveCount } = collect(render({}));
    expect(ariaLiveCount).toBeGreaterThanOrEqual(1);
  });
});

describe("ApplicantActions — guardrails: faceless row, no PII / no oracle", () => {
  it("the rendered row carries no name/phone/email/employer text", () => {
    const tree = render({});
    const all: string[] = [];
    (function gather(node: ReactNode): void {
      if (node === null || node === undefined || typeof node === "boolean") return;
      if (typeof node === "string" || typeof node === "number") {
        all.push(String(node));
        return;
      }
      if (Array.isArray(node)) {
        node.forEach(gather);
        return;
      }
      const el = node as ReactElement<Record<string, unknown> & { children?: ReactNode; footer?: ReactNode }>;
      if (isDialogEl(el)) return; // the confirm dialog is chrome, not candidate row data
      if (el.props && "footer" in el.props) gather(el.props.footer as ReactNode);
      if (el.props && "toolbar" in el.props) gather(el.props.toolbar as ReactNode);
      // The page head's text props (title / description / back label) are rendered text too.
      for (const k of ["title", "description"] as const) {
        if (typeof el.props?.[k] === "string") all.push(el.props[k] as string);
      }
      if (el.props && "children" in el.props) gather(el.props.children);
    })(tree);
    const joined = all.join(" ");
    expect(joined).toContain("Applicants are faceless"); // the scan reaches the privacy note
    expect(joined).not.toMatch(/phone|\bemail\b|employer/i);
    // The candidate is shown as a truncated opaque id (8 hex chars), never a phone number:
    // no '+'-prefixed or 10+ digit run (a real Indian phone is 10+ digits).
    expect(joined).not.toMatch(/\+\d{7,}/);
    expect(joined).not.toMatch(/\d{10,}/);
  });
});

/**
 * Flatten every text node in the candidate-row tree (for content assertions). Skips the confirm
 * DS Dialog (chrome). Collects DS Tabs `tabs[].label` text (the per-stage counts live there, not
 * in children) so the pipeline-tab labels are assertable.
 */
function gatherText(tree: ReactNode): string {
  const all: string[] = [];
  (function gather(node: ReactNode): void {
    if (node === null || node === undefined || typeof node === "boolean") return;
    if (typeof node === "string" || typeof node === "number") {
      all.push(String(node));
      return;
    }
    if (Array.isArray(node)) {
      node.forEach(gather);
      return;
    }
    const el = node as ReactElement<Record<string, unknown> & { children?: ReactNode; tabs?: unknown }>;
    if (isDialogEl(el)) return; // the confirm dialog is chrome, not candidate row data
    if (Array.isArray(el.props?.tabs)) {
      for (const t of el.props.tabs as Array<{ label?: ReactNode }>) all.push(textOf(t.label));
    }
    // The pipeline tabs + the passed note are the page head's TOOLBAR (a prop, not children).
    if (el.props && "toolbar" in el.props) gather(el.props.toolbar as ReactNode);
    if (el.props && "children" in el.props) gather(el.props.children);
  })(tree);
  return all.join(" ");
}

/** The workerId-prefix mono cells (e.g. "aaaaaaaa…") in render order — the visible rows. */
function monoPrefixes(tree: ReactNode): string[] {
  const out: string[] = [];
  (function w(node: ReactNode): void {
    if (node === null || node === undefined || typeof node === "boolean") return;
    if (typeof node === "string" || typeof node === "number") return;
    if (Array.isArray(node)) {
      node.forEach(w);
      return;
    }
    const el = node as ReactElement<Record<string, unknown> & { children?: ReactNode }>;
    const cls = el.props?.className;
    if (typeof cls === "string" && cls.split(/\s+/).includes("bb-mono")) {
      const t = textOf(el.props.children as ReactNode);
      if (t.endsWith("…")) out.push(t);
    }
    if (el.props && "children" in el.props) w(el.props.children as ReactNode);
  })(tree);
  return out;
}

/** Find the `view` prop handed to the routed-contact renderer (the opaque relay handle). */
function findRoutedView(tree: ReactNode): Record<string, unknown> | null {
  let found: Record<string, unknown> | null = null;
  (function w(node: ReactNode): void {
    if (node === null || node === undefined || typeof node === "boolean") return;
    if (typeof node === "string" || typeof node === "number") return;
    if (Array.isArray(node)) {
      node.forEach(w);
      return;
    }
    const el = node as ReactElement<Record<string, unknown> & { children?: ReactNode }>;
    const v = el.props?.view as Record<string, unknown> | undefined;
    if (v && typeof v.relayHandle === "string") found = v;
    if (el.props && "children" in el.props) w(el.props.children as ReactNode);
  })(tree);
  return found;
}

const A = { ...APPLICANT, workerId: "aaaaaaaa-0000-4000-8000-000000000001", rank: 1, hot: true };
const B = { ...APPLICANT, workerId: "bbbbbbbb-0000-4000-8000-000000000002", rank: 2, hot: false };
const C = { ...APPLICANT, workerId: "cccccccc-0000-4000-8000-000000000003", rank: 3, hot: true };

describe("ApplicantActions — pipeline Keep/Pass are LOCAL stage transitions (NO network)", () => {
  it("Keep moves the row New→Shortlist via local state, with no unlock/reveal/resume call", () => {
    const keep = collect(render({})).buttons.find((b) => b.text === "Keep");
    expect(keep).toBeDefined();
    keep!.onClick!();
    // setters order: [rows, confirmedUnlock, stages, activeStage, confirmWorker] → stages is index 2.
    expect(setters[2]).toHaveBeenCalledTimes(1);
    const updater = setters[2]!.mock.calls[0]![0] as (p: Record<string, string>) => Record<string, string>;
    expect(updater({})).toEqual({ [WORKER]: "shortlist" });
    expect(unlockAction).not.toHaveBeenCalled();
    expect(revealContactAction).not.toHaveBeenCalled();
    expect(maskedResumeAction).not.toHaveBeenCalled();
  });

  it("Pass dismisses the row (→ passed) via local state, with no network call", () => {
    collect(render({})).buttons.find((b) => b.text === "Pass")!.onClick!();
    expect(setters[2]).toHaveBeenCalledTimes(1);
    const updater = setters[2]!.mock.calls[0]![0] as (p: Record<string, string>) => Record<string, string>;
    expect(updater({})).toEqual({ [WORKER]: "passed" });
    expect(unlockAction).not.toHaveBeenCalled();
    expect(revealContactAction).not.toHaveBeenCalled();
  });

  it("a Shortlisted row shows a 'Shortlisted' badge instead of Keep (still Passable)", () => {
    const { buttons } = collect(
      render({ stages: { [WORKER]: "shortlist" }, activeStage: "shortlist" }),
    );
    expect(buttons.find((b) => b.text === "Keep")).toBeUndefined();
    expect(buttons.find((b) => b.text === "Pass")).toBeDefined();
  });
});

describe("ApplicantActions — no Call/WhatsApp while the routed channel is closed (F09); the routed card is the read-out", () => {
  // The routed card says "nothing to dial or message today" and no contract field says when that
  // changes, so an enabled Call that only set a local hint was a control that did nothing — and a
  // disabled one could never enable. Neither renders, at ANY stage, and nothing promises them.
  const reachControls = (tree: ReactNode) =>
    collect(tree).buttons.filter((b) => /^(Call|WhatsApp)$/.test(b.text));

  it("renders NO Call / WhatsApp control before an unlock, and no line promising them", () => {
    const tree = render({}); // not unlocked ⇒ not routed
    expect(reachControls(tree)).toEqual([]);
    expect(gatherText(tree)).not.toMatch(/Call|WhatsApp/);
  });

  it("still none once routed: the routed card is the ONE contact read-out; Mark as contacted stays LOCAL", () => {
    const tree = render({ rows: routedRowState() });
    expect(reachControls(tree)).toEqual([]);
    expect(gatherText(tree)).not.toMatch(/Call|WhatsApp|relay ready/);
    // The relay read-out is there (the routed card) and its own copy says there is nothing to dial.
    expect(findRoutedView(tree)).not.toBeNull();
    expect(deepGather(tree)).toContain("nothing to dial or message today");
    // The one contact-stage control left is the local marker — no reveal/unlock re-call.
    const mark = collect(tree).buttons.find((b) => b.text === "Mark as contacted");
    expect(mark).toBeDefined();
    mark!.onClick!();
    expect(setters[0]).toHaveBeenCalledTimes(1);
    expect(revealContactAction).not.toHaveBeenCalled();
    expect(unlockAction).not.toHaveBeenCalled();
  });

  it("the routed reveal carries ONLY the opaque relay handle + channel — never a phone", () => {
    const view = findRoutedView(render({ rows: routedRowState() }));
    expect(view).not.toBeNull();
    expect(view!.relayHandle).toBe("RELAY-abcdef"); // opaque handle
    expect(view!.channel).toBe("in_app_relay"); // channel is in_app_relay | proxy_number ONLY
    // Structural no-phone (ADR-0010 F-4): the routed view has no phone/number field at all.
    expect(view).not.toHaveProperty("phone");
    expect(view).not.toHaveProperty("number");
    // And the row's shallow tree leaks no phone-number digits.
    const joined = gatherText(render({ rows: routedRowState() }));
    expect(joined).not.toMatch(/\+\d{7,}/);
    expect(joined).not.toMatch(/\d{10,}/);
  });
});

/** Count DS Badge elements whose trimmed text is exactly "Hot". */
function hotBadgeCount(tree: ReactNode): number {
  let n = 0;
  (function walk2(node: ReactNode): void {
    if (node === null || node === undefined || typeof node === "boolean") return;
    if (typeof node === "string" || typeof node === "number") return;
    if (Array.isArray(node)) {
      node.forEach(walk2);
      return;
    }
    const el = node as ReactElement<Record<string, unknown> & { children?: ReactNode }>;
    if (el.type === Badge && textOf(el.props.children as ReactNode).trim() === "Hot") {
      n += 1;
    }
    if (el.props && "children" in el.props) walk2(el.props.children as ReactNode);
  })(tree);
  return n;
}

describe("ApplicantActions — preserves backend best-first order; renders hot AS-IS (no percentile)", () => {
  it("renders rows in feed order and a 'hot' badge ONLY where hot=true", () => {
    const tree = render({ applicants: [A, B, C] });
    expect(monoPrefixes(tree)).toEqual([
      `${A.workerId.slice(0, 8)}…`,
      `${B.workerId.slice(0, 8)}…`,
      `${C.workerId.slice(0, 8)}…`,
    ]);
    // hot=true for A and C only ⇒ exactly 2 badges — the engine boolean rendered as-is.
    expect(hotBadgeCount(tree)).toBe(2);
  });

  it("filters visible rows by the active stage and reflects per-stage counts in the tabs", () => {
    const tree = render({ applicants: [A, B], stages: { [A.workerId]: "shortlist" }, activeStage: "shortlist" });
    // Tab labels carry the per-stage counts (the Tabs `tabs` prop labels).
    const text = gatherText(tree);
    expect(text).toContain("New (1)");
    expect(text).toContain("Shortlist (1)");
    // Active = shortlist ⇒ only A (kept) is visible; B (new) is not rendered.
    expect(monoPrefixes(tree)).toEqual([`${A.workerId.slice(0, 8)}…`]);
  });
});

/* ── Production-quality hardening: loading / error / currently-engaged / contacted ─────────
 *
 * All on the SAME #145 RowState (no new endpoint). These seed a row's busy/error/unlock/contact
 * fields directly and assert the rendered affordance. The faceless + no-oracle + confirm-on-spend
 * guarantees from the blocks above continue to hold (no new network call is ever introduced).
 */

const baseRow = {
  busy: false,
  unlock: null,
  unlockError: null,
  contactBusy: false,
  contact: null,
  contactError: null,
  resumeBusy: false,
  resume: null,
  resumeError: null,
  contacted: false,
};

/** Find a DS `Button` whose text CONTAINS `contains`; report `disabled` + `loading` + `aria-busy`. */
function buttonInfo(
  tree: ReactNode,
  contains: string,
): { disabled?: boolean; loading?: boolean; ariaBusy?: unknown } | null {
  let res: { disabled?: boolean; loading?: boolean; ariaBusy?: unknown } | null = null;
  (function w(node: ReactNode): void {
    if (node === null || node === undefined || typeof node === "boolean") return;
    if (typeof node === "string" || typeof node === "number") return;
    if (Array.isArray(node)) {
      node.forEach(w);
      return;
    }
    const el = node as ReactElement<Record<string, unknown> & { children?: ReactNode }>;
    if (el.type === Button && textOf(el.props.children as ReactNode).includes(contains)) {
      res = {
        disabled: el.props.disabled as boolean | undefined,
        loading: el.props.loading as boolean | undefined,
        ariaBusy: el.props["aria-busy"],
      };
    }
    if (el.props && "children" in el.props) w(el.props.children as ReactNode);
  })(tree);
  return res;
}

describe("ApplicantActions — LOADING: per-action Button loading + disabled + aria-busy while pending", () => {
  it("an in-flight unlock disables the button, sets aria-busy + the Button loading spinner", () => {
    const tree = render({ rows: { [WORKER]: { ...baseRow, busy: true } } });
    const info = buttonInfo(tree, "Unlocking");
    expect(info).not.toBeNull();
    expect(info!.disabled).toBe(true);
    expect(info!.ariaBusy).toBe(true);
    expect(info!.loading).toBe(true); // the DS Button renders its bb-btn__spinner when loading.
  });

  it("an in-flight reveal disables the reveal button, sets aria-busy + Button loading", () => {
    const granted = { kind: "granted", unlockId: "44444444-4444-4444-8444-444444444444", expiresAt: "2026-07-01T00:00:00.000Z" };
    const tree = render({ rows: { [WORKER]: { ...baseRow, unlock: granted, contactBusy: true } } });
    const info = buttonInfo(tree, "Opening");
    expect(info!.disabled).toBe(true);
    expect(info!.ariaBusy).toBe(true);
    expect(info!.loading).toBe(true);
  });

  it("an idle row renders no loading Button", () => {
    const { buttons } = collect(render({}));
    expect(buttons.some((b) => b.loading === true)).toBe(false);
  });
});

describe("ApplicantActions — ERROR: retryable inline error, the row/feed are never blanked", () => {
  it("a transient unlock error relabels the button to Retry, keeps an aria-live error + the row", () => {
    const tree = render({
      rows: { [WORKER]: { ...baseRow, unlockError: "Unlock failed (service unavailable). Please retry." } },
    });
    const { buttons, ariaLiveCount } = collect(tree);
    const retry = buttons.find((b) => b.text === "Retry unlock (1 credit)");
    expect(retry).toBeDefined(); // retryable: the action button stays, relabeled
    expect(retry!.onClick).toBeTypeOf("function");
    expect(ariaLiveCount).toBeGreaterThanOrEqual(1);
    expect(gatherText(tree)).toContain("Please retry");
    // The row is NOT blanked — the candidate id cell still renders.
    expect(monoPrefixes(tree)).toHaveLength(1);
  });
});

describe("ApplicantActions — CURRENTLY ENGAGED: one neutral state, identical copy (no oracle)", () => {
  it("an unavailable unlock shows a constant 'Currently engaged' badge + the neutral message, no retry", () => {
    const tree = render({
      rows: { [WORKER]: { ...baseRow, unlock: { kind: "unavailable", message: NEUTRAL_UNLOCK_MESSAGE } } },
    });
    const joined = gatherText(tree);
    expect(joined).toContain("Currently engaged"); // constant label — identical for every cause
    expect(joined).toContain(NEUTRAL_UNLOCK_MESSAGE); // the mapper's single neutral message
    // Terminal no-oracle state (NOT a transient error) ⇒ there is no per-row unlock/retry button.
    // (The always-present confirm-dialog footer carries "Unlock · 1 credit"; that is chrome, not
    // the row affordance — the ROW unlock button reads "Unlock contact" / "Retry unlock".)
    const { buttons } = collect(tree);
    expect(buttons.find((b) => b.text.includes("Unlock contact") || b.text.includes("Retry unlock"))).toBeUndefined();
  });
});

describe("ApplicantActions — MOVE TO CONTACTED: local transition riding the spent unlock", () => {
  it("shows 'Mark as contacted' once routed; clicking patches ROWS state with NO network", () => {
    const { buttons } = collect(render({ rows: routedRowState() }));
    const mark = buttons.find((b) => b.text === "Mark as contacted");
    expect(mark).toBeDefined();
    mark!.onClick!();
    // contacted is patched on the ROWS state (index 0) — local; no unlock/reveal re-call.
    expect(setters[0]).toHaveBeenCalledTimes(1);
    const updater = setters[0]!.mock.calls[0]![0] as (p: Record<string, unknown>) => Record<string, Record<string, unknown>>;
    expect(updater({})[WORKER]!.contacted).toBe(true);
    expect(unlockAction).not.toHaveBeenCalled();
    expect(revealContactAction).not.toHaveBeenCalled();
  });

  it("a contacted row shows the 'Contacted' badge instead of the button (no re-spend)", () => {
    const seeded = { [WORKER]: { ...routedRowState()[WORKER], contacted: true } };
    const tree = render({ rows: seeded });
    const { buttons } = collect(tree);
    expect(buttons.find((b) => b.text === "Mark as contacted")).toBeUndefined();
    expect(gatherText(tree)).toContain("Contacted");
  });

  it("W3-A: 'Contacted' shows ONCE — in the toolbar; the band keeps the unlock's own status", () => {
    const seeded = { [WORKER]: { ...routedRowState()[WORKER], contacted: true } };
    const all = elements(render({ rows: seeded }));
    const badgesIn = (el: El | undefined, label: string) =>
      elements(el!.props.children as ReactNode).filter(
        (e) => e.type === Badge && textOf(e.props.children as ReactNode).trim() === label,
      );
    const card = all.find((e) => hasClass(e, "applicant"));
    expect(badgesIn(card, "Contacted")).toHaveLength(1);
    const toolbar = all.find((e) => hasClass(e, "applicant__pipeline"));
    expect(badgesIn(toolbar, "Contacted")).toHaveLength(1);
    const band = all.find((e) => hasClass(e, "applicant__contact"));
    expect(badgesIn(band, "Contacted")).toHaveLength(0);
    expect(badgesIn(band, "Unlocked")).toHaveLength(1);
  });
});

/** DEEP text — expands the pure RoutedContact / MaskedResume / DS children + Dialog footer too.
 *  Stateful components (Dialog) are NOT invoked (hooks); their footer is walked via props. A
 *  `seen` WeakSet dedupes element objects (expand a shared element reference once). */
function deepGather(node: ReactNode, seen: WeakSet<object> = new WeakSet()): string {
  if (node === null || node === undefined || typeof node === "boolean") return "";
  if (typeof node === "string" || typeof node === "number") return ` ${node} `;
  if (Array.isArray(node)) return node.map((n) => deepGather(n, seen)).join("");
  const el = node as ReactElement<Record<string, unknown> & { children?: ReactNode; footer?: ReactNode }>;
  if (seen.has(el)) return "";
  seen.add(el);
  // Expand PURE (hook-free) child components — but never the hooked DS Dialog.
  const isDialog = typeof el.type === "function" && (el.type as { name?: string }).name === "Dialog";
  if (typeof el.type === "function" && !isDialog) {
    return deepGather((el.type as (p: unknown) => ReactNode)(el.props), seen);
  }
  let out = "";
  if (el.props && "footer" in el.props) out += deepGather(el.props.footer as ReactNode, seen);
  if (el.props && "children" in el.props) out += deepGather(el.props.children as ReactNode, seen);
  return out;
}

/** Every STATIC className token in the tree (function components are not invoked). */
function classTokens(tree: ReactNode): Set<string> {
  const out = new Set<string>();
  (function w(node: ReactNode): void {
    if (node === null || node === undefined || typeof node === "boolean") return;
    if (typeof node === "string" || typeof node === "number") return;
    if (Array.isArray(node)) {
      node.forEach(w);
      return;
    }
    const el = node as ReactElement<Record<string, unknown> & { children?: ReactNode }>;
    const cls = el.props?.className;
    if (typeof cls === "string") for (const t of cls.split(/\s+/)) if (t) out.add(t);
    if (el.props && "children" in el.props) w(el.props.children as ReactNode);
  })(tree);
  return out;
}

describe("ApplicantActions — (b) each stage renders its OWN empty state at zero rows", () => {
  it("New empty copy ≠ Shortlist empty copy (per-stage, never a shared blank)", () => {
    // A is kept (shortlist) ⇒ the New stage is empty; switch active to New to see its copy.
    const newEmpty = gatherText(
      render({ applicants: [A], stages: { [A.workerId]: "shortlist" }, activeStage: "new" }),
    );
    expect(newEmpty).toContain("No applicants in New");
    // Nothing kept ⇒ the Shortlist stage is empty; its copy is distinct.
    const shortlistEmpty = gatherText(render({ applicants: [A], activeStage: "shortlist" }));
    expect(shortlistEmpty).toContain("No shortlisted applicants yet");
    // "Applicant" is the feed's one word for the person (owner ruling 2026-10-01).
    expect(`${newEmpty} ${shortlistEmpty}`).not.toMatch(/candidate/i);
    expect(newEmpty).not.toEqual(shortlistEmpty);
  });

  it("renders the empty stage through the shared UI-1 `.state` block, not a bespoke card", () => {
    // UI-1: an empty surface says WHAT is empty (title), WHY (body) and WHAT TO DO
    // (actions — here the LOCAL switch to the other stage). The old `.applicants-empty`
    // one-liner card is retired.
    const tokens = classTokens(render({ applicants: [A], activeStage: "shortlist" }));
    expect(tokens.has("state")).toBe(true);
    expect(tokens.has("state__title")).toBe(true);
    expect(tokens.has("state__actions")).toBe(true);
    expect(tokens.has("applicants-empty")).toBe(false);
  });

  it("the 0-credit top-up guidance is the shared inline `.alert`, not an ad-hoc card+badge", () => {
    // Same nudge, same words, one primitive — and it stays guidance about the payer's OWN
    // balance (never a signal about a candidate), which is why it is a warning, not an error.
    const tokens = classTokens(render({ balance: 0 }));
    expect(tokens.has("alert")).toBe(true);
    expect(tokens.has("alert--warning")).toBe(true);
    expect(tokens.has("applicants-warn")).toBe(false);
    expect(gatherText(render({ balance: 0 }))).toContain("not a signal about any applicant");
  });
});

describe("ApplicantActions — (c) a contactError is inline, retryable, cause-free, never blanks the row", () => {
  it("keeps the reveal button (relabeled Retry) + an aria-live error; the Unlocked row stays", () => {
    const granted = { kind: "granted", unlockId: "44444444-4444-4444-8444-444444444444", expiresAt: "2026-07-01T00:00:00.000Z" };
    const tree = render({
      rows: { [WORKER]: { ...baseRow, unlock: granted, contactError: "Reveal failed (service unavailable). Please retry." } },
    });
    const { buttons, ariaLiveCount } = collect(tree);
    const retry = buttons.find((b) => b.text === "Retry — open routed contact");
    expect(retry).toBeDefined(); // retryable: the reveal button stays, relabeled
    expect(retry!.onClick).toBeTypeOf("function");
    expect(ariaLiveCount).toBeGreaterThanOrEqual(1);
    const joined = gatherText(tree);
    // No-oracle: the transient error names NO deny cause.
    expect(joined).not.toMatch(/consent|capped|no credits|already.?unlocked|forbidden/i);
    // Row not blanked: the candidate id + the Unlocked chip still render.
    expect(monoPrefixes(tree)).toHaveLength(1);
    expect(joined).toContain("Unlocked");
  });
});

describe("ApplicantActions — (e) one neutral 'currently engaged' state; identical copy unknown vs cap", () => {
  it("two distinct deny causes collapse to byte-identical rendered copy (no oracle)", () => {
    // The wire collapses EVERY cause to {status:"unavailable"} before the mapper, so 'unknown'
    // and 'cap' are indistinguishable — mapUnlockResult yields one message; the component shows it.
    const unknown = mapUnlockResult({ status: "unavailable" });
    const cap = mapUnlockResult({ status: "unavailable" });
    expect(unknown).toEqual(cap); // identical view — no cause survives the mapper
    const renderedUnknown = gatherText(render({ rows: { [WORKER]: { ...baseRow, unlock: unknown } } }));
    const renderedCap = gatherText(render({ rows: { [WORKER]: { ...baseRow, unlock: cap } } }));
    expect(renderedUnknown).toEqual(renderedCap); // identical COPY for both causes
    expect(renderedUnknown).toContain("Currently engaged"); // the cap-enforcement landing UI
    expect(renderedUnknown).toContain(NEUTRAL_UNLOCK_MESSAGE);
  });
});

describe("ApplicantActions — (f) balance === 0 disables Unlock (own-balance FE pre-check)", () => {
  it("renders the Unlock button disabled when the payer has 0 credits", () => {
    const info = buttonInfo(render({ balance: 0 }), "Unlock contact");
    expect(info).not.toBeNull();
    expect(info!.disabled).toBe(true);
  });
});

describe("ApplicantActions — (h) zero PII (no phone digits / email) in ANY row state", () => {
  const granted = { kind: "granted", unlockId: "44444444-4444-4444-8444-444444444444", expiresAt: "2026-07-01T00:00:00.000Z" };
  const routed = { kind: "routed", relayHandle: "RELAY-7h3k9q", channel: "in_app_relay", expiresAt: "2026-07-01T00:00:00.000Z" };
  const states: Array<[string, Record<string, unknown>]> = [
    ["idle", { ...baseRow }],
    ["unlock pending", { ...baseRow, busy: true }],
    ["unlock error", { ...baseRow, unlockError: "Unlock failed (service unavailable). Please retry." }],
    ["currently engaged", { ...baseRow, unlock: { kind: "unavailable", message: NEUTRAL_UNLOCK_MESSAGE } }],
    ["granted + reveal pending", { ...baseRow, unlock: granted, contactBusy: true }],
    ["routed reveal", { ...baseRow, unlock: granted, contact: routed }],
    ["contacted", { ...baseRow, unlock: granted, contact: routed, contacted: true }],
  ];
  it.each(states)("state '%s' leaks no phone-number digits / email (deep, incl. the routed card)", (_label, row) => {
    const joined = deepGather(render({ rows: { [WORKER]: row } }));
    expect(joined).not.toMatch(/\d{10,}/); // no 10+ digit phone run
    expect(joined).not.toMatch(/\+\d{7,}/); // no +country-code phone
    expect(joined).not.toMatch(/@/); // no email
  });
});

describe("ApplicantActions — masked-resume threads the POSTING context (disclosure audit)", () => {
  it("fires maskedResumeAction with { unlockId, workerId, postingId } — the page's posting id", async () => {
    maskedResumeAction.mockResolvedValue({ ok: false, error: "x" });
    const { buttons } = collect(render({ rows: routedRowState() }));
    const masked = buttons.find((b) => b.text.includes("View masked resume"));
    expect(masked).toBeDefined();
    await masked!.onClick!();
    expect(maskedResumeAction).toHaveBeenCalledWith({
      unlockId: "44444444-4444-4444-8444-444444444444",
      workerId: WORKER,
      postingId: "33333333-3333-4333-8333-333333333333",
    });
  });
});

describe("ApplicantActions — Matching V1 tier badge (ADR-0036 moment ⑥ / E18)", () => {
  /** A V1 row: no meaningful score/hot (the seam pins them), tier + months instead. */
  const v1 = (over: Partial<FacelessApplicant>): FacelessApplicant => ({
    workerId: WORKER,
    rank: 1,
    score: 0,
    hot: false,
    signals: [],
    matchTier: 1,
    effectiveTier: 1,
    skillMonths: 48,
    ...over,
  });

  it("badges a tier-1 candidate as having the posted skill, with coarse months", () => {
    const text = gatherText(render({ applicants: [v1({})] }));
    expect(text).toContain("Has the skill");
    // Coarse: the stored months are bucketed to 6, so the label reads back in years.
    expect(text).toContain("4 yrs");
    expect(text).not.toContain("48");
  });

  it("E18: a tier-2 candidate PROMOTED by the floor is STILL badged 'Related'", () => {
    // The whole point of surfacing the RAW tier. effectiveTier 1 means he was ORDERED
    // among the exact-skill workers (36+ months on a related skill), but he does not
    // have the skill the company posted — and it is about to spend ₹40 to unlock him.
    const text = gatherText(
      render({
        applicants: [
          v1({ matchTier: 2, effectiveTier: 1, skillMonths: 48, matchedSkillLabel: "VMC operating" }),
        ],
      }),
    );
    expect(text).toContain("Related · VMC operating");
    expect(text).not.toContain("Has the skill");
  });

  it("W3-A: the 'Related' badge is INFO-toned (Safety Yellow is the Unlock CTA's), text unchanged", () => {
    const tierBadges = (a: FacelessApplicant) =>
      elements(render({ applicants: [a] }))
        .filter((e) => hasClass(e, "applicant__relevance"))
        .flatMap((rel) => elements(rel.props.children as ReactNode))
        .filter((e) => e.type === Badge && e.props.tone !== "neutral");
    const related = tierBadges(
      v1({ matchTier: 2, effectiveTier: 1, matchedSkillLabel: "VMC operating" }),
    );
    expect(related).toHaveLength(1);
    expect(related[0]!.props.tone).toBe("info");
    expect(related[0]!.props.variant).toBeUndefined(); // soft, never solid
    expect(textOf(related[0]!.props.children as ReactNode)).toBe("Related · VMC operating");
    const fallback = tierBadges(v1({ matchTier: 2, effectiveTier: 2 }));
    expect(fallback[0]!.props.tone).toBe("info");
    expect(textOf(fallback[0]!.props.children as ReactNode)).toBe("Related skill");
    // …and no badge anywhere in a relevance cluster is brand-toned any more.
    expect(tierBadges(v1({ matchTier: 2 })).some((b) => b.props.tone === "brand")).toBe(false);
  });

  it("renders NO score and NO hot badge on the V1 path (they are placeholders, not values)", () => {
    const tree = render({ applicants: [v1({ hot: false, score: 0 })] });
    expect(hotBadgeCount(tree)).toBe(0);
    // A "0.00" on screen would be the one number on the card that means nothing while
    // looking like it means something.
    expect(gatherText(tree)).not.toContain("0.00");
  });

  it("still renders the LEGACY score + hot branch when no tier is present (flag off)", () => {
    const tree = render({ applicants: [APPLICANT] });
    expect(hotBadgeCount(tree)).toBe(1);
    expect(gatherText(tree)).toContain("0.90");
  });
});

/* ── W2-B layout: one toolbar of secondary actions + ONE focal spend band per card ───────── */

type El = ReactElement<Record<string, unknown> & { children?: ReactNode }>;

/** Every element (static className or component) in render order — Dialog internals excluded. */
function elements(tree: ReactNode): El[] {
  const out: El[] = [];
  (function w(node: ReactNode): void {
    if (node === null || node === undefined || typeof node === "boolean") return;
    if (typeof node === "string" || typeof node === "number") return;
    if (Array.isArray(node)) {
      node.forEach(w);
      return;
    }
    const el = node as El;
    out.push(el);
    if (isDialogEl(el)) return;
    if (el.props && "children" in el.props) w(el.props.children as ReactNode);
  })(tree);
  return out;
}

const hasClass = (el: El, c: string) =>
  typeof el.props?.className === "string" &&
  (el.props.className as string).split(/\s+/).includes(c);

/** The direct child elements of `el`, in source order. */
function childEls(el: El): El[] {
  const kids = ([] as ReactNode[]).concat(el.props.children as ReactNode);
  return kids.filter((k): k is El => k !== null && typeof k === "object" && !Array.isArray(k));
}

/** DS Button labels inside `el`'s subtree. */
const buttonLabels = (el: El) =>
  elements(el.props.children as ReactNode)
    .filter((e) => e.type === Button)
    .map((e) => textOf(e.props.children as ReactNode).trim());

describe("ApplicantActions — W2-B card anatomy: identity → tags → toolbar → focal spend band", () => {
  it("every card reads head → signals → actions, and ENDS with the contact band", () => {
    const cards = elements(render({ applicants: [A, B, C] })).filter((e) =>
      hasClass(e, "applicant"),
    );
    expect(cards).toHaveLength(3);
    for (const card of cards) {
      const order = childEls(card).map((k) => String(k.props.className));
      expect(order).toEqual([
        "applicant__head",
        "applicant__signals",
        "applicant__actions",
        "applicant__contact",
      ]);
    }
  });

  it("the spend CTA lives in the band; the triage pair is the whole toolbar", () => {
    const all = elements(render({}));
    const band = all.find((e) => hasClass(e, "applicant__contact"))!;
    const toolbar = all.find((e) => hasClass(e, "applicant__actions"))!;
    expect(buttonLabels(band)).toEqual(["Unlock contact (1 credit)"]);
    expect(buttonLabels(toolbar)).toEqual(["Keep", "Pass"]);
    // The toolbar is exactly ONE group (triage); the Call / WhatsApp group is gone (F09).
    expect(childEls(toolbar).map((k) => String(k.props.className))).toEqual([
      "applicant__pipeline",
    ]);
  });

  it("after a routed reveal the band holds the reveal actions and the toolbar gains 'Mark as contacted'", () => {
    const all = elements(render({ rows: routedRowState() }));
    const band = all.find((e) => hasClass(e, "applicant__contact"))!;
    const toolbar = all.find((e) => hasClass(e, "applicant__actions"))!;
    expect(buttonLabels(band)).toEqual(["View masked resume"]);
    expect(buttonLabels(toolbar)).toEqual(["Keep", "Pass", "Mark as contacted"]);
  });
});

describe("ApplicantActions — W3-A zero balance: an enabled Buy credits beside the disabled Unlock", () => {
  const topUps = (tree: ReactNode) =>
    elements(tree).filter(
      (e) =>
        e.props.href === "/credits" && hasClass(e, "bb-btn") && hasClass(e, "bb-btn--secondary"),
    );

  it("balance 0 (owner): one secondary Buy credits link to /credits per card, in the action row", () => {
    const all = elements(render({ applicants: [A, B], balance: 0 }));
    const rows = all.filter((e) => hasClass(e, "applicant__unlock-actions"));
    expect(rows).toHaveLength(2);
    for (const row of rows) {
      const inRow = elements(row.props.children as ReactNode);
      const unlock = inRow.find((e) => e.type === Button)!;
      expect(unlock.props.disabled).toBe(true);
      const link = topUps(row.props.children as ReactNode);
      expect(link).toHaveLength(1);
      // An icon + the label: "Buy credits" (never "Top up", which also meant applicant slots).
      expect(textOf(link[0]!.props.children as ReactNode).trim()).toBe("Buy credits");
    }
    const bands = all.filter((e) => hasClass(e, "applicant__contact"));
    for (const band of bands) {
      expect(topUps(band.props.children as ReactNode)).toHaveLength(1);
      // …and it is the band's ONLY way to /credits: the hint under it is plain text (two
      // adjacent links to one page were a redundant tab stop on every card).
      const toCredits = elements(band.props.children as ReactNode).filter(
        (e) => e.props.href === "/credits",
      );
      expect(toCredits).toHaveLength(1);
      const hint = elements(band.props.children as ReactNode).find((e) =>
        hasClass(e, "applicant__hint"),
      )!;
      expect(elements(hint.props.children as ReactNode)).toEqual([]);
      expect(textOf(hint.props.children as ReactNode).replace(/\s+/g, " ").trim()).toBe(
        "Buy credits to unlock. Guidance only — this is your own balance, never a signal about this applicant.",
      );
    }
  });

  it("any positive balance (incl. the page's 1 for an UNREAD balance): no Top up, Unlock enabled", () => {
    for (const balance of [1, 5]) {
      const tree = render({ balance });
      expect(topUps(tree), `balance ${balance}`).toEqual([]);
      expect(buttonInfo(tree, "Unlock contact")!.disabled).toBe(false);
    }
  });

  it("a granted row has nothing to spend: no Top up even on a zero balance", () => {
    const tree = render({ rows: routedRowState(), balance: 0 });
    expect(topUps(tree)).toEqual([]);
  });

  it("balance 0 for a RECRUITER: no link to /credits anywhere (it 404s for them), Unlock still disabled", () => {
    // `/credits` is requireOwner(); a recruiter sent there meets a neutral 404. The band and the
    // alert still say what is wrong — in words that point at the person who can fix it.
    const tree = render({ applicants: [A, B], balance: 0, canBuyCredits: false });
    expect(elements(tree).filter((e) => e.props.href === "/credits")).toEqual([]);
    expect(buttonInfo(tree, "Unlock contact")!.disabled).toBe(true);
    const text = gatherText(tree);
    // The alert and each row's hint say who can fix it — and offer no button (L7).
    expect(text).toContain("Ask your account owner to buy credits to unlock");
    expect(text).toContain("Ask your account owner to buy credits.");
    expect(text).not.toMatch(/\bBuy credits\b/);
    expect(text).toContain("not a signal about any applicant");
  });

  it("the alert's own link to /credits exists for an owner only", () => {
    const alertLinks = (canBuyCredits: boolean) =>
      elements(render({ balance: 0, canBuyCredits }))
        .filter((e) => hasClass(e, "alert"))
        .flatMap((a) => elements(a.props.children as ReactNode))
        .filter((e) => e.props.href === "/credits");
    expect(alertLinks(true)).toHaveLength(1);
    expect(alertLinks(false)).toEqual([]);
  });
});

describe("ApplicantActions — the screen's head: ONE PageHeader, the stage tabs in its toolbar", () => {
  const heads = (tree: ReactNode) => elements(tree).filter((e) => e.type === PageHeader);

  it("renders the page's head text first, with the New / Shortlist tabs as its toolbar", () => {
    const tree = render({ applicants: [A, B] });
    const top = (tree.props as { children: ReactNode[] }).children.filter(Boolean) as El[];
    expect(top[0]!.type).toBe(PageHeader);
    expect(heads(tree)).toHaveLength(1);
    const head = heads(tree)[0]!.props as Record<string, unknown>;
    // The page's own words, untouched: the back link names the posting, the H1 the screen.
    expect(head.back).toEqual(HEADER.back);
    expect(head.title).toBe("Applicants");
    expect(head.description).toBe(HEADER.description);
    // The toolbar is the pipeline: the segmented tabs, labelled, with their per-stage counts.
    const toolbar = elements(head.toolbar as ReactNode);
    const tabs = toolbar.find((e) => Array.isArray((e.props as { tabs?: unknown }).tabs))!;
    expect((tabs.props as { "aria-label"?: string })["aria-label"]).toBe("Applicant pipeline");
    expect(gatherText(head.toolbar as ReactNode)).toMatch(/New \(2\)\s+Shortlist \(0\)/);
  });

  it("no second heading under it: the feed starts after one privacy note, no section head", () => {
    const tree = render({ applicants: [A, B] });
    expect(elements(tree).filter((e) => hasClass(e, "section__head"))).toEqual([]);
    expect(elements(tree).filter((e) => e.type === "h2" || e.type === "h1")).toEqual([]);
    const notes = elements(tree).filter((e) => hasClass(e, "alert--info"));
    expect(notes).toHaveLength(1);
    // One sentence: what a row is, and what unlocking it costs.
    const body = gatherText(notes[0]!.props.children as ReactNode);
    expect(body).toContain("Applicants are faceless");
    expect(body.replace("Applicants are faceless", "")).not.toMatch(/[.!?]\s+[A-Z]/);
  });

  it("the passed count rides beside the tabs as plain words, only once something was passed", () => {
    const toolbarText = (tree: ReactNode) =>
      gatherText((heads(tree)[0]!.props as { toolbar: ReactNode }).toolbar);
    expect(toolbarText(render({ applicants: [A, B] }))).not.toContain("passed");
    const text = toolbarText(render({ applicants: [A, B], stages: { [A.workerId]: "passed" } }));
    expect(text).toMatch(/\b1\s+passed\b/);
    // Its own words — not a "·" glued onto the tabs.
    expect(text).not.toContain("·");
  });
});

describe("ApplicantActions — ONE shared confirm-on-spend dialog, outside every card", () => {
  it("renders exactly one ConfirmSpendDialog for a three-card feed, never inside a card", () => {
    const tree = render({ applicants: [A, B, C] });
    const dialogs = elements(tree).filter(isConfirmDialogEl);
    expect(dialogs).toHaveLength(1);
    const cards = elements(tree).filter((e) => hasClass(e, "applicant"));
    for (const card of cards) {
      expect(elements(card.props.children as ReactNode).filter(isConfirmDialogEl)).toHaveLength(0);
    }
  });
});

describe("ApplicantActions — the skill/signal TAGS are static text, not controls (W2-B)", () => {
  const tagList = (applicant: FacelessApplicant) =>
    elements(render({ applicants: [applicant] })).find((e) => hasClass(e, "applicant__signals"))!;

  it("renders the tags as a list of OUTLINE neutral Badges — no buttons, same visible text", () => {
    const withSkills = { ...APPLICANT, skills: ["CNC turning", "Fanuc control"] };
    const list = tagList(withSkills);
    expect(list.type).toBe("ul");
    const items = childEls(list);
    expect(items.map((li) => li.type)).toEqual(["li", "li"]);
    const badges = items.map((li) => childEls(li)[0]!);
    for (const b of badges) {
      expect(b.type).toBe(Badge);
      expect(b.props).toMatchObject({ tone: "neutral", variant: "outline" });
    }
    expect(badges.map((b) => textOf(b.props.children as ReactNode))).toEqual([
      "CNC turning",
      "Fanuc control",
    ]);
    // Nothing in the tag list is a control any more (they were disabled toggle buttons).
    expect(elements(list.props.children as ReactNode).some((e) => e.type === Button)).toBe(false);
    expect(elements(list.props.children as ReactNode).some((e) => e.type === "button")).toBe(false);
  });

  it("names the list for what it holds: Skills when present, else the relevance signals", () => {
    expect(tagList({ ...APPLICANT, skills: ["CNC turning"] }).props["aria-label"]).toBe("Skills");
    const signalsOnly = tagList({ ...APPLICANT, skills: undefined, signals: ["on-trade"] });
    expect(signalsOnly.props["aria-label"]).toBe("Relevance signals");
    expect(textOf(childEls(childEls(signalsOnly)[0]!)[0]!.props.children as ReactNode)).toBe(
      "on-trade",
    );
  });
});

/* ── Final acceptance sweep B: icons, honest disabled reasons, unlocked state, compact note ── */

describe("ApplicantActions — every row control leads with its icon (F08)", () => {
  const iconOf = (tree: ReactNode, text: string) =>
    collect(tree).buttons.find((b) => b.text === text)?.iconLeft;

  it("Keep / Pass / Unlock carry the product icons; Unlock and its confirm share ONE glyph", () => {
    const tree = render({ confirmWorker: WORKER });
    expect(iconOf(tree, "Keep")).toBe("bookmark-simple");
    expect(iconOf(tree, "Pass")).toBe(ACTION_ICON.reject);
    expect(iconOf(tree, "Unlock contact (1 credit)")).toBe(ACTION_ICON.unlock);
    // The dialog's spend button ("Unlock · 1 credit") is the same action — the same icon.
    expect(iconOf(tree, "Unlock · 1 credit")).toBe(ACTION_ICON.unlock);
  });

  it("'Mark as contacted' (routed rows) carries one too, so the toolbar reads as one set", () => {
    expect(iconOf(render({ rows: routedRowState() }), "Mark as contacted")).toBe("check-circle");
  });
});

describe("ApplicantActions — a disabled Unlock says WHY in visible text, not a dead title (F27)", () => {
  it("balance 0: no `title` on the disabled Unlock; it is described by the visible hint beneath it", () => {
    const tree = render({ applicants: [A, B], balance: 0 });
    const unlocks = collect(tree).buttons.filter((b) => b.text === "Unlock contact (1 credit)");
    expect(unlocks).toHaveLength(2);
    const hints = elements(tree).filter((e) => hasClass(e, "applicant__hint"));
    for (const [i, u] of unlocks.entries()) {
      expect(u.disabled).toBe(true);
      // A disabled button takes no hover, so a title there is never seen.
      expect(u.title).toBeUndefined();
      expect(typeof u.describedBy).toBe("string");
      const hint = hints.find((h) => h.props.id === u.describedBy);
      expect(hint, `row ${i}: aria-describedby must name a rendered hint`).toBeDefined();
      expect(textOf(hint!.props.children as ReactNode)).toContain("Buy credits to unlock.");
    }
    // One id per row — two rows never point at the same line.
    expect(new Set(unlocks.map((u) => u.describedBy)).size).toBe(2);
    // The ids are positional: no full worker id lands in a DOM attribute.
    for (const u of unlocks) expect(String(u.describedBy)).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}/);
  });

  it("a positive balance (incl. the unread-balance 1): Unlock enabled, described by nothing", () => {
    for (const balance of [1, 5]) {
      const unlock = collect(render({ balance })).buttons.find(
        (b) => b.text === "Unlock contact (1 credit)",
      )!;
      expect(unlock.disabled).toBe(false);
      expect(unlock.describedBy).toBeUndefined();
      expect(unlock.title).toBeUndefined();
    }
  });
});

describe("ApplicantActions — an applicant the payer already unlocked STARTS unlocked (F10)", () => {
  const HELD: GrantedUnlock = {
    kind: "granted",
    unlockId: "66666666-6666-4666-8666-666666666666",
    expiresAt: "2026-11-04T09:30:00.000Z",
  };

  it("a held row renders the granted band (Unlocked · Open routed contact), never a fresh spend", () => {
    const tree = render({ applicants: [A, B], unlocked: { [A.workerId]: HELD } });
    const cards = elements(tree).filter((e) => hasClass(e, "applicant"));
    expect(cards).toHaveLength(2);
    const [held, fresh] = cards.map((c) => elements(c.props.children as ReactNode));
    const labels = (els: El[]) =>
      els.filter((e) => e.type === Button).map((e) => textOf(e.props.children as ReactNode).trim());
    // A: the payer holds a live grant — the band is the granted one, with its window end.
    expect(labels(held!)).toContain("Open routed contact");
    expect(labels(held!)).not.toContain("Unlock contact (1 credit)");
    expect(held!.some((e) => e.type === Badge && textOf(e.props.children as ReactNode) === "Unlocked")).toBe(true);
    expect(gatherText(cards[0]!)).toContain("2026-11-04");
    // B: not held — the spend is offered as before.
    expect(labels(fresh!)).toContain("Unlock contact (1 credit)");
  });

  it("opening the held row's contact reveals THAT grant — no unlock, no confirm, no spend", () => {
    revealContactAction.mockResolvedValue({ ok: false, error: "x" });
    const { buttons } = collect(render({ unlocked: { [WORKER]: HELD } }));
    buttons.find((b) => b.text === "Open routed contact")!.onClick!();
    expect(revealContactAction).toHaveBeenCalledWith({ unlockId: HELD.unlockId });
    expect(unlockAction).not.toHaveBeenCalled();
    expect(setters[4]).not.toHaveBeenCalled(); // the confirm dialog never opened
  });

  it("session state layers OVER the held grant (the patch keeps it; this session's state wins)", () => {
    revealContactAction.mockReturnValue(new Promise(() => {}));
    const { buttons } = collect(render({ unlocked: { [WORKER]: HELD } }));
    buttons.find((b) => b.text === "Open routed contact")!.onClick!();
    // The busy patch starts from the held row, so the grant survives the patch.
    const updater = setters[0]!.mock.calls[0]![0] as (
      p: Record<string, unknown>,
    ) => Record<string, Record<string, unknown>>;
    expect(updater({})[WORKER]).toMatchObject({ unlock: HELD, contactBusy: true });
    // A row this session already moved (e.g. a routed reveal) renders from session state.
    const routed = collect(render({ rows: routedRowState(), unlocked: { [WORKER]: HELD } }));
    expect(routed.buttons.map((b) => b.text)).toContain("Mark as contacted");
  });
});

describe("ApplicantActions — the privacy note is ONE compact line (F20)", () => {
  it("no title row: one short sentence that still says applicants are faceless", () => {
    const notes = elements(render({ applicants: [A, B] })).filter((e) => hasClass(e, "alert--info"));
    expect(notes).toHaveLength(1);
    const inside = elements(notes[0]!.props.children as ReactNode);
    // The title row was the second line that pushed the first Unlock under a 375×812 fold.
    expect(inside.filter((e) => hasClass(e, "alert__title"))).toEqual([]);
    const body = inside.filter((e) => hasClass(e, "alert__body"));
    expect(body).toHaveLength(1);
    expect(textOf(body[0]!.props.children as ReactNode)).toBe(
      "Applicants are faceless until unlocked.",
    );
  });
});
