import { describe, expect, it, vi, beforeEach } from "vitest";
import type { ReactElement, ReactNode } from "react";
import type * as ReactModule from "react";
import type { PostingSummary } from "../../../lib/contracts";
import { Badge, Button } from "../../../components/ds";

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
 * rows, state). DS Button/Badge are collected by `el.type === Button`/`Badge`.
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

// Injected per-render state queue (source order: rows, state-record).
let stateQueue: unknown[] = [];
let stateCursor = 0;
const useState = vi.fn((initial: unknown) => {
  const i = stateCursor++;
  const seeded = i < stateQueue.length ? stateQueue[i] : initial;
  return [seeded, vi.fn()] as [unknown, (v: unknown) => void];
});
vi.mock("react", async () => {
  const actual = await vi.importActual<typeof ReactModule>("react");
  return { ...actual, useState: (initial: unknown) => useState(initial) };
});

const { PostingsManager } = await import("./postings-manager");

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

function render(postings: PostingSummary[], rowState: Record<string, unknown> = {}) {
  // Seed the two useState slots for this render — source order in the component:
  // (1) freshRows overlay (Record<id, PostingSummary>), (2) per-row action state.
  // Rows themselves render FROM PROPS (the freshRows overlay only patches by id).
  stateQueue = [{}, rowState];
  stateCursor = 0;
  return PostingsManager({ postings }) as ReactElement;
}

beforeEach(() => {
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
  it("an OPEN posting offers ENABLED Pause / Top up / Close; clicking Pause fires the action with ONLY the posting id", () => {
    const { buttons } = collect(render([OPEN]));
    const pause = buttons.find((b) => b.text === "Pause");
    const topUp = buttons.find((b) => b.text.includes("Top up applicant quota"));
    const close = buttons.find((b) => b.text === "Close");
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
    expect(buttons.find((b) => b.text === "Close")).toBeUndefined();
    resume!.onClick!();
    expect(resumePostingAction).toHaveBeenCalledWith({ postingId: OPEN.id });
  });

  it("a CLOSED posting disables Pause + Top up and offers no Close (terminal)", () => {
    const { buttons } = collect(render([{ ...OPEN, status: "closed" }]));
    expect(buttons.find((b) => b.text === "Pause")?.disabled).toBe(true);
    expect(buttons.find((b) => b.text.includes("Top up applicant quota"))?.disabled).toBe(true);
    expect(buttons.find((b) => b.text === "Close")).toBeUndefined();
  });

  it("a busy row disables its buttons (no double-fire while an action is pending)", () => {
    const { buttons } = collect(render([OPEN], { [OPEN.id]: { busy: true, error: null } }));
    expect(buttons.every((b) => b.disabled)).toBe(true);
  });

  it("clicking Top up fires ITS action; a seeded row error renders in the row", () => {
    const first = collect(render([OPEN]));
    first.buttons.find((b) => b.text.includes("Top up applicant quota"))!.onClick!();
    expect(topUpQuotaAction).toHaveBeenCalledWith({ postingId: OPEN.id });

    const errored = render([OPEN], {
      [OPEN.id]: { busy: false, error: "This posting has no active plan yet — buy a plan first.", notice: null },
    });
    expect(textOf(errored)).toContain("no active plan");
  });

  it("a DRAFT posting offers ENABLED Close (Pause disabled); clicking Close fires ITS action", () => {
    const { buttons } = collect(render([{ ...OPEN, status: "draft" }]));
    const close = buttons.find((b) => b.text === "Close");
    expect(close?.disabled).toBe(false);
    // Pause requires an OPEN posting — a draft renders it disabled, never a fake action.
    expect(buttons.find((b) => b.text === "Pause")?.disabled).toBe(true);
    close!.onClick!();
    expect(closePostingAction).toHaveBeenCalledWith({ postingId: OPEN.id });
  });

  it("a seeded SUCCESS notice (the paid top-up confirmation) renders in the aria-live row region", () => {
    const tree = render([OPEN], {
      [OPEN.id]: { busy: false, error: null, notice: "Top-up applied — added 10 applicant views." },
    });
    expect(textOf(tree)).toContain("added 10 applicant views");
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

  it("renders a faceless empty state when there are no postings", () => {
    expect(textOf(render([]))).toContain("haven");
  });
});
