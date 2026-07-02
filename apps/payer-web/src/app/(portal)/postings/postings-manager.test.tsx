import { describe, expect, it, vi, beforeEach } from "vitest";
import type { ReactElement, ReactNode } from "react";
import type * as ReactModule from "react";
import type { PostingSummary } from "../../../lib/contracts";
import { Badge, Button } from "../../../components/ds";

/**
 * POSTINGS-MANAGER tests (DS2.2, feature #178 pause/resume LIVE) — STATUS RENDERING +
 * PAUSE/RESUME WIRING + GATED QUOTA + A11Y (B8).
 *
 * The manager is now an INTERACTIVE client surface: it wires the Pause/Resume Buttons to the
 * `pausePostingAction`/`resumePostingAction` Server Actions (the applicant-quota top-up stays a
 * disabled "coming soon" Button). These tests assert:
 *  - the status Badge reflects the posting's real `status` (open → success tone, etc.);
 *  - an OPEN posting offers an ENABLED Pause Button wired to `pausePostingAction`;
 *  - a PAUSED posting renders a warning-tone paused Badge + an ENABLED Resume Button wired to
 *    `resumePostingAction`;
 *  - Pause is DISABLED for draft/closed (not a valid open<->paused transition);
 *  - the applicant-quota top-up Button stays DISABLED (gated, no fake live route);
 *  - each row keeps an `aria-live="polite"` region (B8 — announces a row failure).
 *
 * Env is node (no DOM); React state is injected via a mocked `useState` (source order:
 * overrides, rowState). Server Actions are mocked. Actions are DS `Button`s — we collect by
 * `el.type === Button` and fire `props.onClick`; handlers are async, so we fire and await.
 */

const pausePostingAction = vi.fn();
const resumePostingAction = vi.fn();

vi.mock("next/link", () => ({
  default: ({ children, href }: { children: ReactNode; href: string }) => ({
    type: "a",
    props: { href, children },
  }),
}));
vi.mock("./actions", () => ({
  pausePostingAction: (i: unknown) => pausePostingAction(i),
  resumePostingAction: (i: unknown) => resumePostingAction(i),
}));

// Injected per-render state queue (overrides, rowState). Each call's SETTER is captured by index.
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
      text: textOf(el.props.children as ReactNode).trim(),
      disabled: el.props.disabled === true,
      onClick: el.props.onClick as (() => void) | undefined,
    });
    return;
  }
  if (el.type === Badge) {
    acc.badges.push({
      text: textOf(el.props.children as ReactNode).trim(),
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
  opts: { overrides?: Record<string, PostingSummary>; rowState?: Record<string, unknown> } = {},
) {
  // Source order of useState: overrides, rowState.
  stateQueue = [opts.overrides ?? {}, opts.rowState ?? {}];
  stateCursor = 0;
  setters = [];
  return PostingsManager({ postings }) as ReactElement;
}

beforeEach(() => {
  pausePostingAction.mockReset().mockResolvedValue({ ok: true, posting: { ...OPEN, status: "paused" } });
  resumePostingAction.mockReset().mockResolvedValue({ ok: true, posting: { ...OPEN, status: "open" } });
});

describe("PostingsManager — STATUS RENDERING reflects the real status", () => {
  it("an open posting renders a success-tone status Badge with the real status text", () => {
    const status = collect(render([OPEN])).badges.find((b) => b.text === "open");
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

describe("PostingsManager — PAUSE / RESUME are LIVE (feature #178)", () => {
  it("an OPEN posting offers an ENABLED Pause Button wired to pausePostingAction (id only)", async () => {
    const pause = collect(render([OPEN])).buttons.find((b) => b.text === "Pause");
    expect(pause).toBeDefined();
    expect(pause!.disabled).toBe(false); // no longer a disabled coming-soon stub
    await pause!.onClick!();
    // XB-A: the client sends ONLY the posting id — never a payer id.
    expect(pausePostingAction).toHaveBeenCalledWith({ postingId: OPEN.id });
    expect(resumePostingAction).not.toHaveBeenCalled();
  });

  it("a PAUSED posting offers an ENABLED Resume Button wired to resumePostingAction", async () => {
    const resume = collect(render([{ ...OPEN, status: "paused" }])).buttons.find(
      (b) => b.text === "Resume",
    );
    expect(resume).toBeDefined();
    expect(resume!.disabled).toBe(false);
    await resume!.onClick!();
    expect(resumePostingAction).toHaveBeenCalledWith({ postingId: OPEN.id });
    expect(pausePostingAction).not.toHaveBeenCalled();
  });

  it("Pause is DISABLED for a draft / closed posting (not a valid open<->paused transition)", () => {
    const draftPause = collect(render([{ ...OPEN, status: "draft" }])).buttons.find(
      (b) => b.text === "Pause",
    );
    expect(draftPause?.disabled).toBe(true);
    const closedPause = collect(render([{ ...OPEN, status: "closed" }])).buttons.find(
      (b) => b.text === "Pause",
    );
    expect(closedPause?.disabled).toBe(true);
  });

  it("a pause failure surfaces the row error via the injected setter (no crash, no blank row)", async () => {
    pausePostingAction.mockResolvedValue({ ok: false, error: "Could not pause the posting right now." });
    const pause = collect(render([OPEN])).buttons.find((b) => b.text === "Pause");
    await pause!.onClick!();
    // rowState is the 2nd useState (index 1). The busy→error patch fires its setter.
    expect(setters[1]).toHaveBeenCalled();
  });
});

describe("PostingsManager — applicant-quota TOP-UP stays GATED (disabled, coming soon)", () => {
  it("the Top up applicant quota Button renders DISABLED (no fake live route)", () => {
    const topUp = collect(render([OPEN])).buttons.find((b) => b.text.includes("Top up applicant quota"));
    expect(topUp).toBeDefined();
    expect(topUp!.disabled).toBe(true);
  });

  it("renders the 'coming soon' gated note for the quota top-up", () => {
    expect(textOf(render([OPEN]))).toContain("coming soon");
  });
});

describe("PostingsManager — A11Y-OF-FAILURE: per-row error region is aria-live='polite' (B8)", () => {
  it("renders an aria-live='polite' error container per row", () => {
    expect(collect(render([OPEN])).ariaLiveCount).toBeGreaterThanOrEqual(1);
  });

  it("renders one aria-live region per posting row (announces a row failure)", () => {
    const second = { ...OPEN, id: "bbbb2222-0000-4000-8000-000000000002" };
    expect(collect(render([OPEN, second])).ariaLiveCount).toBe(2);
  });

  it("renders a faceless empty state when there are no postings", () => {
    expect(textOf(render([]))).toContain("haven");
  });
});
