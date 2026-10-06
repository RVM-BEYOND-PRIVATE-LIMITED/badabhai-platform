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
/** Each slot's setter from the LAST render, by source order (read to see what a click stores). */
const setters: Array<ReturnType<typeof vi.fn>> = [];
const useState = vi.fn((initial: unknown) => {
  const i = stateCursor++;
  const seeded = i < stateQueue.length ? stateQueue[i] : initial;
  const set = vi.fn();
  setters[i] = set;
  return [seeded, set] as [unknown, (v: unknown) => void];
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
) {
  // Seed the two useState slots for this render — source order in the component:
  // (1) freshRows overlay (Record<id, PostingSummary>), (2) per-row action state.
  // Rows themselves render FROM PROPS (the freshRows overlay only patches by id).
  stateQueue = [{}, rowState];
  stateCursor = 0;
  return PostingsManager({ postings, readOnly }) as ReactElement;
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
  it("an OPEN posting offers ENABLED Pause / Add applicant slots / Close posting; clicking Pause fires the action with ONLY the posting id", () => {
    const { buttons } = collect(render([OPEN]));
    const pause = buttons.find((b) => b.text === "Pause");
    const topUp = buttons.find((b) => b.text === "Add applicant slots");
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
      ["topUp", "Add applicant slots"],
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
    for (const [label, busy] of [
      ["Pause", "pause"],
      ["Add applicant slots", "topUp"],
      ["Close posting", "close"],
    ] as const) {
      const { buttons } = collect(render([OPEN]));
      buttons.find((b) => b.text === label)!.onClick!();
      // Slot 2 (source order) is the per-row action state; its first write marks the row busy.
      const update = setters[1]!.mock.calls[0]![0] as (
        prev: Record<string, unknown>,
      ) => Record<string, unknown>;
      expect(update({}), label).toEqual({ [OPEN.id]: { busy, error: null, notice: null } });
    }
  });

  it("clicking Add applicant slots fires ITS action; a seeded row error renders in the row", () => {
    const first = collect(render([OPEN]));
    first.buttons.find((b) => b.text === "Add applicant slots")!.onClick!();
    expect(topUpQuotaAction).toHaveBeenCalledWith({ postingId: OPEN.id });

    const errored = render([OPEN], {
      [OPEN.id]: { busy: false, error: "This posting has no active plan yet — buy a plan first.", notice: null },
    });
    expect(textOf(errored)).toContain("no active plan");
  });

  it("a DRAFT posting offers ENABLED Close posting and NO Pause; clicking Close fires ITS action", () => {
    const { buttons } = collect(render([{ ...OPEN, status: "draft" }]));
    const close = buttons.find((b) => b.text === "Close posting");
    expect(close?.disabled).toBe(false);
    // Pause requires an OPEN posting — a draft does not draw it (a disabled Pause said nothing
    // about why — F27), never a fake action either.
    expect(buttons.map((b) => b.text)).toEqual(["Add applicant slots", "Close posting"]);
    expect(buttons.every((b) => !b.disabled)).toBe(true);
    close!.onClick!();
    expect(closePostingAction).toHaveBeenCalledWith({ postingId: OPEN.id });
  });

  it("a SUSPENDED posting draws no Pause it could never use; slots stay as they are today", () => {
    const { buttons } = collect(render([{ ...OPEN, status: "suspended" }]));
    expect(buttons.map((b) => `${b.text}${b.disabled ? " [disabled]" : ""}`)).toEqual([
      "Add applicant slots",
    ]);
  });

  it("a seeded SUCCESS notice (the paid slots confirmation) renders in the aria-live row region", () => {
    const tree = render([OPEN], {
      [OPEN.id]: { busy: false, error: null, notice: "Applicant slots added — 10 more applicant views." },
    });
    expect(textOf(tree)).toContain("Applicant slots added — 10 more applicant views.");
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
      render([OPEN], { [OPEN.id]: { busy: false, error: "That failed.", notice: null } }),
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
    expect(collect(tree).buttons.map((b) => b.text)).toEqual([
      "Pause",
      "Add applicant slots",
      "Close posting",
    ]);
    expect(hrefs(byClass(tree, "posting-card__links")[0]!)).toContain(`/postings/${OPEN.id}/edit`);
  });

  it("a read-only empty list offers no create action", () => {
    const tree = render([], {}, true);
    expect(hrefs(tree)).not.toContain("/postings/new");
  });
});
