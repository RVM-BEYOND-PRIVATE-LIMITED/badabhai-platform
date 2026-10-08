import { describe, expect, it, vi, beforeEach } from "vitest";
import type { ReactElement, ReactNode } from "react";
import type * as ReactModule from "react";
import { IconButtonBase } from "@badabhai/icons/button";
import { Badge, Button, Card, Tabs } from "../../../../../components/ds";
import type { FacelessApplicant } from "../../../../../lib/contracts";
import type { ApplicantPosting } from "../../../../../lib/candidate-inbox";
import type { CandidateRow } from "./applicant-actions";
import type { StageActionResult } from "./actions";

/**
 * SAVED APPLICANT STAGES on the board and in the inbox (#2139; API #2137).
 *
 * The server saves the New / Shortlist / Passed board behind a flag the portal cannot read; the
 * ROWS say which: every row carries `stage` (flag on) or none does (flag off). Pinned here:
 *  - FLAG OFF: the board is the LOCAL one, unchanged — two tabs, Keep / Pass write local state
 *    only, and the stage action is NEVER called; the inbox has no stage controls at all;
 *  - FLAG ON: the board is SEEDED from the rows (three tabs, Passed its own); Keep → shortlist,
 *    Pass → passed, Move to New → new go through `setApplicantStageAction` with the row's posting
 *    and worker only — OPTIMISTIC (the row moves before the server answers), then RECONCILED to
 *    the server's stage, or ROLLED BACK to where it was (a move made earlier this session
 *    included) with one polite toast whose words name the reason;
 *  - NO DOUBLE-SUBMIT: while a row's move is in flight its stage buttons are disabled and a second
 *    press sends nothing; the server's idempotent no-op (`changed: false`) is a quiet success;
 *  - THE INBOX: each card shows its stage and moves keyed by the CARD (one worker on two postings
 *    holds two stages), naming the card's own posting; a moved card stays on the page; a view-only
 *    posting's card shows its stage and offers no move;
 *  - one ConfirmSpendDialog, and a live region for the toast that exists before any toast does.
 *
 * Env is node. A STATEFUL `useState` model (cells persist, setState re-renders), as
 * applicant-actions-inbox.test.tsx; cells are positional — rows 0, confirmedUnlock 1, stages 2,
 * activeStage 3, confirmWorker 4, result 5, confirmContext 6, stageSaving 7, stageNotice 8,
 * inFlight 9 (a live Set, mutated in place).
 */

const unlockAction = vi.fn();
const revealContactAction = vi.fn();
const maskedResumeAction = vi.fn();
const setApplicantStageAction = vi.fn<(i: unknown) => Promise<StageActionResult>>();

vi.mock("next/link", () => ({
  useLinkStatus: () => ({ pending: false }),
  default: ({
    children,
    href,
    className,
  }: {
    children: ReactNode;
    href: string;
    className?: string;
  }) => ({
    type: "a",
    props: { href, className, children },
  }),
}));
vi.mock("../../../../../components/nav-pending", () => ({ NavPendingCue: () => null }));
vi.mock("./actions", () => ({
  unlockAction: (i: unknown) => unlockAction(i),
  revealContactAction: (i: unknown) => revealContactAction(i),
  maskedResumeAction: (i: unknown) => maskedResumeAction(i),
  setApplicantStageAction: (i: unknown) => setApplicantStageAction(i),
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

const POSTING = "33333333-3333-4333-8333-333333333333";
const P1 = "11111111-0000-4000-8000-000000000001";
const P2 = "11111111-0000-4000-8000-000000000002";
const WA = "aaaaaaaa-0000-4000-8000-000000000001";
const WB = "bbbbbbbb-0000-4000-8000-000000000002";
const WC = "cccccccc-0000-4000-8000-000000000003";
const STAGES = 2;
const ACTIVE = 3;
const SAVING = 7;
const NOTICE = 8;

const applicant = (
  workerId: string,
  rank: number,
  over: Partial<FacelessApplicant> = {},
): FacelessApplicant => ({
  workerId,
  rank,
  score: 0,
  hot: false,
  signals: [],
  tradeLabel: "CNC Turner",
  matchTier: 1,
  skillMonths: 24,
  ...over,
});

/** Mount ONE posting's board (its Applicants page). */
function mountBoard(applicants: FacelessApplicant[] | (() => FacelessApplicant[])) {
  cells = [];
  renderFn = () => {
    cursor = 0;
    currentTree = ApplicantActions({
      header: { title: "Applicants", description: "Everyone who applied." },
      postingId: POSTING,
      // A function stands for the page re-rendered from a fresh read (a revalidation).
      applicants: typeof applicants === "function" ? applicants() : applicants,
      balance: 5,
    }) as ReactElement;
  };
  renderFn();
}

/** Mount the Candidates inbox. */
function mountInbox(applicants: CandidateRow[]) {
  cells = [];
  renderFn = () => {
    cursor = 0;
    currentTree = ApplicantActions({
      header: { title: "Candidates", description: "Everyone who applied." },
      applicants,
      balance: 5,
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

/**
 * Every element under `scope` (the whole tree when omitted). ConfirmSpendDialog and the stage
 * toast are expanded; the hooked Dialog never. The walk recurses through `walkEls`, which has no
 * default — an `undefined` slot (an absent toolbar) is nothing, never the whole tree again.
 */
function elements(...scope: [ReactNode?]): El[] {
  return walkEls(scope.length > 0 ? scope[0] : currentTree, []);
}
function walkEls(node: ReactNode, out: El[]): El[] {
  if (node === null || node === undefined || typeof node !== "object") return out;
  if (Array.isArray(node)) {
    for (const n of node) walkEls(n, out);
    return out;
  }
  const el = node as El;
  out.push(el);
  if (isNamed(el, "ConfirmSpendDialog") || isNamed(el, "StageNoticeToast")) {
    walkEls((el.type as (p: unknown) => ReactNode)(el.props), out);
    return out;
  }
  if (el.props && "toolbar" in el.props) walkEls(el.props.toolbar as ReactNode, out);
  if (el.props && "footer" in el.props) walkEls(el.props.footer as ReactNode, out);
  if (el.props && "children" in el.props) walkEls(el.props.children, out);
  return out;
}

interface Btn {
  text: string;
  onClick?: () => unknown;
  disabled?: boolean;
  busy?: unknown;
}
function buttons(...scope: [ReactNode?]): Btn[] {
  return elements(...scope)
    .filter((el) => el.type === Button)
    .map((el) => ({
      text: textOf(el.props.children as ReactNode).trim(),
      onClick: el.props.onClick as (() => unknown) | undefined,
      disabled: el.props.disabled as boolean | undefined,
      busy: el.props["aria-busy"],
    }));
}
const button = (scope: ReactNode, text: string) => buttons(scope).find((b) => b.text === text);
const badges = (scope: ReactNode) =>
  elements(scope)
    .filter((el) => el.type === Badge)
    .map((el) => textOf(el.props.children as ReactNode).trim());

/** The cards, in render order, with their opaque id prefix. */
const cards = () =>
  elements().filter((el) => el.type === Card && el.props.className === "applicant");
const cardIds = () =>
  cards().map((c) =>
    elements(c)
      .filter(
        (e) =>
          typeof e.props.className === "string" &&
          (e.props.className as string).includes("applicant__id-code"),
      )
      .map((e) => textOf(e.props.children as ReactNode))
      .join(""),
  );
const cardOf = (workerId: string) => cards()[cardIds().indexOf(`${workerId.slice(0, 8)}…`)];

/** The pipeline tab labels (the DS Tabs `tabs` prop). */
const tabLabels = () =>
  ((elements().find((el) => el.type === Tabs)?.props.tabs as Array<{ label: string }>) ?? []).map(
    (t) => t.label,
  );
const showTab = (id: string) =>
  (elements().find((el) => el.type === Tabs)!.props.onChange as (id: string) => void)(id);

/** The pipeline container's class (the tabs' wrapper in the head's toolbar). */
const pipelineClass = () =>
  elements().find((el) => String(el.props.className).startsWith("applicants-pipeline") && !String(el.props.className).includes("__"))
    ?.props.className;

/** The DS Toast elements' text (title + message), in the toast region. */
const toastText = () =>
  elements()
    .filter((el) => isNamed(el, "Toast"))
    .map((el) => `${textOf(el.props.title as ReactNode)} ${textOf(el.props.children as ReactNode)}`)
    .join(" | ");

/** A promise the test settles by hand — the server's answer, while the move is in flight. */
function deferred<T>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}
const flush = () => new Promise((r) => setTimeout(r, 0));

const SAVED_ROWS = [
  applicant(WA, 1, { stage: "new" }),
  applicant(WB, 2, { stage: "shortlist" }),
  applicant(WC, 3, { stage: "passed" }),
];
const ok = (stage: "new" | "shortlist" | "passed", changed = true): StageActionResult => ({
  ok: true,
  stage,
  changed,
});

beforeEach(() => {
  unlockAction.mockReset();
  revealContactAction.mockReset();
  maskedResumeAction.mockReset();
  setApplicantStageAction.mockReset();
});

describe("FLAG OFF — rows with no stage keep today's LOCAL board", () => {
  const LOCAL_ROWS = [applicant(WA, 1), applicant(WB, 2)];

  it("two tabs, no Passed tab, no Move to New, no toast region", () => {
    mountBoard(LOCAL_ROWS);
    expect(tabLabels()).toEqual(["New (2)", "Shortlist (0)"]);
    expect(pipelineClass()).toBe("applicants-pipeline");
    expect(buttons().map((b) => b.text)).not.toContain("Move to New");
    expect(elements().some((el) => el.props.className === "unlock-toast-region")).toBe(false);
    expect(
      elements().some((el) => String(el.props.className).includes("unlock-toast-region--stack")),
    ).toBe(false);
  });

  it("Keep and Pass write LOCAL state only — the stage action is never called", async () => {
    mountBoard(LOCAL_ROWS);
    button(cardOf(WA), "Keep")!.onClick!();
    button(cardOf(WB), "Pass")!.onClick!();
    await flush();
    expect(setApplicantStageAction).not.toHaveBeenCalled();
    expect(cells[STAGES]).toEqual({ [WA]: "shortlist", [WB]: "passed" });
    // The passed count still rides beside the two tabs as words (the local board's own read-out).
    expect(tabLabels()).toEqual(["New (0)", "Shortlist (1)"]);
    expect(
      textOf(
        elements().find((el) => el.props.className === "applicants-pipeline__note")!.props
          .children as ReactNode,
      ),
    ).toMatch(/1\s*passed/);
  });

  it("the inbox with no stages has no stage controls at all", () => {
    const posting: ApplicantPosting = {
      id: P1,
      title: "CNC Turner",
      href: `/postings/${P1}`,
      viewOnly: false,
    };
    mountInbox([{ ...applicant(WA, 1), posting }]);
    expect(buttons().map((b) => b.text)).not.toEqual(expect.arrayContaining(["Keep"]));
    expect(buttons().map((b) => b.text)).not.toContain("Pass");
    expect(badges(cards()[0]!)).not.toContain("New");
    expect(elements().some((el) => el.props.className === "applicant__actions")).toBe(false);
  });
});

describe("FLAG ON — the board is seeded from the rows", () => {
  it("three tabs with the server's counts; each tab lists its own rows in feed order", () => {
    mountBoard(SAVED_ROWS);
    expect(tabLabels()).toEqual(["New (1)", "Shortlist (1)", "Passed (1)"]);
    // The three segments may shrink to fit a phone's track (globals.css: applicants-pipeline--saved).
    expect(pipelineClass()).toBe("applicants-pipeline applicants-pipeline--saved");
    expect(cardIds()).toEqual([`${WA.slice(0, 8)}…`]);
    showTab("shortlist");
    expect(cardIds()).toEqual([`${WB.slice(0, 8)}…`]);
    expect(badges(cards()[0]!)).toContain("Shortlisted");
    showTab("passed");
    expect(cells[ACTIVE]).toBe("passed"); // a tab switch is LOCAL state — nothing sent
    expect(setApplicantStageAction).not.toHaveBeenCalled();
    expect(cardIds()).toEqual([`${WC.slice(0, 8)}…`]);
    expect(badges(cards()[0]!)).toContain("Passed");
    // No "N passed" words: Passed is a tab now.
    expect(elements().some((el) => el.props.className === "applicants-pipeline__note")).toBe(false);
  });

  it("each stage offers its moves: New → Keep, Pass · Shortlist → Pass, Move to New · Passed → Move to New", () => {
    mountBoard(SAVED_ROWS);
    expect(buttons(cardOf(WA)).map((b) => b.text)).toEqual(
      expect.arrayContaining(["Keep", "Pass"]),
    );
    expect(button(cardOf(WA), "Move to New")).toBeUndefined();
    showTab("shortlist");
    expect(button(cardOf(WB), "Keep")).toBeUndefined();
    expect(button(cardOf(WB), "Pass")).toBeDefined();
    expect(button(cardOf(WB), "Move to New")).toBeDefined();
    showTab("passed");
    expect(button(cardOf(WC), "Keep")).toBeUndefined();
    expect(button(cardOf(WC), "Pass")).toBeUndefined();
    expect(button(cardOf(WC), "Move to New")).toBeDefined();
  });

  it("an empty Passed tab says so, with a way back to New", () => {
    mountBoard([applicant(WA, 1, { stage: "new" })]);
    showTab("passed");
    const text = elements()
      .map((el) => (typeof el.props.children === "string" ? el.props.children : ""))
      .join(" ");
    expect(text).toContain("No passed applicants");
    expect(button(currentTree, "View New")).toBeDefined();
  });

  it("ONE ConfirmSpendDialog, and the toast's live region exists before any toast", () => {
    mountBoard(SAVED_ROWS);
    expect(elements().filter((el) => isNamed(el, "ConfirmSpendDialog"))).toHaveLength(1);
    const region = elements().find((el) =>
      String(el.props.className).includes("unlock-toast-region"),
    );
    expect(region).toBeDefined();
    expect(region!.props["aria-live"]).toBe("polite");
    expect(toastText()).toBe("");
  });
});

describe("FLAG ON — a move is optimistic, then reconciled or rolled back", () => {
  it("Keep moves the row AT ONCE, sends only the posting / worker / stage, and settles on the server's answer", async () => {
    const answer = deferred<StageActionResult>();
    setApplicantStageAction.mockReturnValueOnce(answer.promise);
    mountBoard(SAVED_ROWS);
    button(cardOf(WA), "Keep")!.onClick!();
    // Before the server answers: already on Shortlist, and the move is in flight.
    expect(tabLabels()).toEqual(["New (0)", "Shortlist (2)", "Passed (1)"]);
    expect(cells[SAVING]).toEqual({ [WA]: true });
    expect(setApplicantStageAction).toHaveBeenCalledTimes(1);
    expect(setApplicantStageAction.mock.calls[0]![0]).toEqual({
      jobId: POSTING,
      workerId: WA,
      stage: "shortlist",
    });
    answer.resolve(ok("shortlist"));
    await flush();
    expect(cells[SAVING]).toEqual({});
    expect(cells[STAGES]).toEqual({ [WA]: "shortlist" });
    expect(tabLabels()).toEqual(["New (0)", "Shortlist (2)", "Passed (1)"]);
    expect(toastText()).toBe("");
  });

  it("reconciles to the stage the SERVER answered", async () => {
    setApplicantStageAction.mockResolvedValueOnce(ok("passed"));
    mountBoard(SAVED_ROWS);
    button(cardOf(WA), "Keep")!.onClick!();
    await flush();
    expect(cells[STAGES]).toEqual({ [WA]: "passed" });
    expect(tabLabels()).toEqual(["New (0)", "Shortlist (1)", "Passed (2)"]);
  });

  it("a failure ROLLS BACK to where the row was and says so once, politely", async () => {
    const answer = deferred<StageActionResult>();
    setApplicantStageAction.mockReturnValueOnce(answer.promise);
    mountBoard(SAVED_ROWS);
    button(cardOf(WA), "Pass")!.onClick!();
    expect(tabLabels()).toEqual(["New (0)", "Shortlist (1)", "Passed (2)"]);
    answer.resolve({ ok: false, reason: "failed" });
    await flush();
    expect(cells[STAGES]).toEqual({});
    expect(tabLabels()).toEqual(["New (1)", "Shortlist (1)", "Passed (1)"]);
    expect(cardIds()).toEqual([`${WA.slice(0, 8)}…`]);
    expect(cells[SAVING]).toEqual({});
    expect(toastText()).toBe(
      `Couldn’t save that move ${WA.slice(0, 8)}… is back in New. Please try again.`,
    );
  });

  it("…to a move made EARLIER this session, not to the row's original stage", async () => {
    setApplicantStageAction.mockResolvedValueOnce(ok("shortlist"));
    setApplicantStageAction.mockResolvedValueOnce({ ok: false, reason: "failed" });
    mountBoard(SAVED_ROWS);
    button(cardOf(WA), "Keep")!.onClick!();
    await flush();
    showTab("shortlist");
    button(cardOf(WA), "Pass")!.onClick!();
    await flush();
    expect(cells[STAGES]).toEqual({ [WA]: "shortlist" });
    expect(toastText()).toContain("is back in Shortlist.");
  });

  it("a 429 says too many changes; the neutral 404 says the list changed (and names no cause)", async () => {
    setApplicantStageAction.mockResolvedValueOnce({ ok: false, reason: "rate-limited" });
    mountBoard(SAVED_ROWS);
    button(cardOf(WA), "Keep")!.onClick!();
    await flush();
    expect(toastText()).toBe(
      `Too many changes ${WA.slice(0, 8)}… is back in New. Try again in a few minutes.`,
    );

    setApplicantStageAction.mockResolvedValueOnce({ ok: false, reason: "gone" });
    mountBoard(SAVED_ROWS);
    button(cardOf(WA), "Keep")!.onClick!();
    await flush();
    expect(cells[STAGES]).toEqual({});
    expect(toastText()).toBe(
      "Couldn’t save that move This list changed since it loaded, so it has been refreshed.",
    );
  });

  it("an action that never arrives (it throws) is a failure too — rolled back", async () => {
    setApplicantStageAction.mockRejectedValueOnce(new Error("Failed to fetch"));
    mountBoard(SAVED_ROWS);
    button(cardOf(WA), "Keep")!.onClick!();
    await flush();
    expect(cells[STAGES]).toEqual({});
    expect(cells[SAVING]).toEqual({});
    expect(toastText()).toContain("Please try again.");
  });

  it("the next move clears the toast at once, and its ✕ closes it", async () => {
    setApplicantStageAction.mockResolvedValueOnce({ ok: false, reason: "failed" });
    mountBoard(SAVED_ROWS);
    button(cardOf(WA), "Keep")!.onClick!();
    await flush();
    expect(cells[NOTICE]).not.toBeNull();
    // A new move, still in flight: the old toast is already gone (it described the last move).
    const answer = deferred<StageActionResult>();
    setApplicantStageAction.mockReturnValueOnce(answer.promise);
    button(cardOf(WA), "Keep")!.onClick!();
    expect(cells[NOTICE]).toBeNull();
    expect(toastText()).toBe("");
    answer.resolve(ok("shortlist"));
    await flush();
    // A failed move's toast closes on its ✕.
    setApplicantStageAction.mockResolvedValueOnce({ ok: false, reason: "failed" });
    showTab("shortlist");
    button(cardOf(WA), "Pass")!.onClick!();
    await flush();
    expect(cells[NOTICE]).not.toBeNull();
    const dismiss = elements().find((el) => isNamed(el, "Toast"))!.props.onClose as () => void;
    dismiss();
    expect(cells[NOTICE]).toBeNull();
  });

  it("the server stops saving stages mid-session: the 'gone' re-read turns the board LOCAL, and the toast still says why", async () => {
    let rows: FacelessApplicant[] = SAVED_ROWS;
    setApplicantStageAction.mockImplementationOnce(async () => {
      // The action's revalidation re-renders the page from a fresh read: no row carries a stage.
      rows = SAVED_ROWS.map(({ stage: _stage, ...a }) => a);
      return { ok: false, reason: "gone" };
    });
    mountBoard(() => rows);
    button(cardOf(WA), "Keep")!.onClick!();
    await flush();
    expect(tabLabels()).toEqual(["New (3)", "Shortlist (0)"]);
    expect(toastText()).toBe(
      "Couldn’t save that move This list changed since it loaded, so it has been refreshed.",
    );
    // Its region is the live one, and the next LOCAL move needs no server.
    expect(elements().find((el) => String(el.props.className).includes("unlock-toast-region"))!.props["aria-live"]).toBe("polite");
    button(cardOf(WA), "Keep")!.onClick!();
    expect(setApplicantStageAction).toHaveBeenCalledTimes(1);
  });

  it("Move to New brings a passed row back", async () => {
    setApplicantStageAction.mockResolvedValueOnce(ok("new"));
    mountBoard(SAVED_ROWS);
    showTab("passed");
    button(cardOf(WC), "Move to New")!.onClick!();
    expect(setApplicantStageAction.mock.calls[0]![0]).toEqual({
      jobId: POSTING,
      workerId: WC,
      stage: "new",
    });
    await flush();
    expect(tabLabels()).toEqual(["New (2)", "Shortlist (1)", "Passed (0)"]);
  });
});

describe("FLAG ON — after a `gone`, the re-read wins (review #2162 Low 2)", () => {
  it("this session's SETTLED moves stop overriding the re-read; a move still in flight keeps its own", async () => {
    const fresh = [
      applicant(WA, 1, { stage: "new" }),
      applicant(WB, 2, { stage: "new" }),
      applicant(WC, 3, { stage: "new" }),
    ];
    let rows: FacelessApplicant[] = fresh;
    mountBoard(() => rows);
    // 1 · WA is kept, and saved.
    setApplicantStageAction.mockResolvedValueOnce(ok("shortlist"));
    button(cardOf(WA), "Keep")!.onClick!();
    await flush();
    expect(cells[STAGES]).toEqual({ [WA]: "shortlist" });
    // 2 · WC's Keep is still in flight…
    const pending = deferred<StageActionResult>();
    setApplicantStageAction.mockReturnValueOnce(pending.promise);
    button(cardOf(WC), "Keep")!.onClick!();
    // 3 · …when WB's move answers `gone`: the page is re-read, and another session has since
    //     passed WA. The re-read must win for WA (and WB); WC's optimistic move stands.
    setApplicantStageAction.mockImplementationOnce(async () => {
      rows = [
        applicant(WA, 1, { stage: "passed" }),
        applicant(WB, 2, { stage: "new" }),
        applicant(WC, 3, { stage: "new" }),
      ];
      return { ok: false, reason: "gone" };
    });
    button(cardOf(WB), "Keep")!.onClick!();
    await flush();
    expect(cells[STAGES]).toEqual({ [WC]: "shortlist" });
    expect(tabLabels()).toEqual(["New (1)", "Shortlist (1)", "Passed (1)"]);
    showTab("passed");
    expect(cardIds()).toEqual([`${WA.slice(0, 8)}…`]);
    // WC's own answer still settles it.
    pending.resolve(ok("shortlist"));
    await flush();
    expect(cells[STAGES]).toEqual({ [WC]: "shortlist" });
    expect(cells[SAVING]).toEqual({});
  });
});

describe("FLAG ON — no double-submit; the server's idempotent no-op is a quiet success", () => {
  it("two presses of the SAME rendered button send once (the in-flight check is live, not the render's)", () => {
    const answer = deferred<StageActionResult>();
    setApplicantStageAction.mockReturnValueOnce(answer.promise);
    mountBoard(SAVED_ROWS);
    const keep = button(cardOf(WA), "Keep")!;
    keep.onClick!();
    keep.onClick!(); // a double click handled before the re-render reached the handler
    expect(setApplicantStageAction).toHaveBeenCalledTimes(1);
  });

  it("while a move is in flight the row's stage buttons are disabled and a second press sends nothing", async () => {
    const answer = deferred<StageActionResult>();
    setApplicantStageAction.mockReturnValueOnce(answer.promise);
    mountBoard(SAVED_ROWS);
    button(cardOf(WA), "Keep")!.onClick!();
    showTab("shortlist");
    const pass = button(cardOf(WA), "Pass")!;
    const back = button(cardOf(WA), "Move to New")!;
    expect([pass.disabled, back.disabled]).toEqual([true, true]);
    expect([pass.busy, back.busy]).toEqual([true, true]);
    pass.onClick!(); // a press that slipped through (the handler re-checks)
    back.onClick!();
    expect(setApplicantStageAction).toHaveBeenCalledTimes(1);
    // Another row is not held up by it.
    expect(button(cardOf(WB), "Pass")!.disabled).toBe(false);
    answer.resolve(ok("shortlist"));
    await flush();
    expect(button(cardOf(WA), "Pass")!.disabled).toBe(false);
  });

  it("`changed: false` (he already held it) settles exactly like a change — no toast", async () => {
    setApplicantStageAction.mockResolvedValueOnce(ok("shortlist", false));
    mountBoard(SAVED_ROWS);
    button(cardOf(WA), "Keep")!.onClick!();
    await flush();
    expect(cells[STAGES]).toEqual({ [WA]: "shortlist" });
    expect(cells[NOTICE]).toBeNull();
    expect(toastText()).toBe("");
  });
});

describe("FLAG ON — the Candidates inbox", () => {
  const posting = (
    id: string,
    title: string,
    over: Partial<ApplicantPosting> = {},
  ): ApplicantPosting => ({
    id,
    title,
    href: `/postings/${id}`,
    viewOnly: false,
    ...over,
  });
  // WA applied to BOTH postings (two cards, two independent stages).
  const ROW_1: CandidateRow = {
    ...applicant(WA, 1, { stage: "new" }),
    posting: posting(P1, "CNC Turner"),
  };
  const ROW_2: CandidateRow = {
    ...applicant(WA, 2, { stage: "new" }),
    posting: posting(P2, "VMC Operator"),
  };
  const ROW_3: CandidateRow = {
    ...applicant(WB, 1, { stage: "passed" }),
    posting: posting(P1, "CNC Turner"),
  };

  it("every card shows its stage; no tabs", () => {
    mountInbox([ROW_1, ROW_3]);
    expect(elements().some((el) => el.type === Tabs)).toBe(false);
    expect(badges(cards()[0]!)).toContain("New");
    expect(badges(cards()[1]!)).toContain("Passed");
  });

  it("Keep names THE CARD's posting, moves only that card, and the card stays on the page", async () => {
    setApplicantStageAction.mockResolvedValueOnce(ok("shortlist"));
    mountInbox([ROW_1, ROW_2, ROW_3]);
    button(cards()[1]!, "Keep")!.onClick!();
    expect(setApplicantStageAction.mock.calls[0]![0]).toEqual({
      jobId: P2,
      workerId: WA,
      stage: "shortlist",
    });
    await flush();
    expect(cards()).toHaveLength(3);
    expect(badges(cards()[1]!)).toContain("Shortlisted");
    expect(badges(cards()[0]!)).toContain("New"); // his other posting's card is its own stage
    expect(cells[STAGES]).toEqual({ [`${P2}:${WA}`]: "shortlist" });
  });

  it("a failed move in the inbox rolls back that card, with the same toast", async () => {
    setApplicantStageAction.mockResolvedValueOnce({ ok: false, reason: "failed" });
    mountInbox([ROW_3]);
    button(cards()[0]!, "Move to New")!.onClick!();
    await flush();
    expect(badges(cards()[0]!)).toContain("Passed");
    expect(toastText()).toContain("is back in Passed.");
  });

  describe("keyboard focus after a move (the pressed button is replaced; the card stays)", () => {
    /** A browser stand-in: the pressed button's toolbar, the page's focus, a frame that runs now. */
    function fakeDom(opts: { connected?: boolean; focusElsewhere?: boolean; settlesLate?: number } = {}) {
      const focus = vi.fn();
      // `settlesLate`: frames in which the settled render has not landed yet (buttons still disabled).
      const querySelector = vi.fn();
      for (let i = 0; i < (opts.settlesLate ?? 0); i++) querySelector.mockReturnValueOnce(null);
      querySelector.mockReturnValue({ focus });
      const toolbar = { isConnected: opts.connected ?? true, querySelector };
      class FakeElement {
        closest = vi.fn(() => toolbar);
      }
      const body = {};
      vi.stubGlobal("Element", FakeElement);
      vi.stubGlobal("requestAnimationFrame", (cb: (t: number) => void) => {
        cb(0);
        return 0;
      });
      vi.stubGlobal("document", { body, activeElement: opts.focusElsewhere ? {} : body });
      return { focus, toolbar, press: { currentTarget: new FakeElement() } };
    }
    const press = (text: string, event: unknown) =>
      (button(cards()[0]!, text)!.onClick as unknown as (e: unknown) => void)(event);

    it("focus that fell to the page lands on the card's first enabled stage button once the move settles", async () => {
      const dom = fakeDom();
      try {
        setApplicantStageAction.mockResolvedValueOnce(ok("shortlist"));
        mountInbox([ROW_1]);
        press("Keep", dom.press);
        expect(dom.focus).not.toHaveBeenCalled(); // not while the buttons are disabled (in flight)
        await flush();
        expect(dom.press.currentTarget.closest).toHaveBeenCalledWith(".applicant__pipeline");
        expect(dom.toolbar.querySelector).toHaveBeenCalledWith("button:not([disabled])");
        expect(dom.focus).toHaveBeenCalledTimes(1);
      } finally {
        vi.unstubAllGlobals();
      }
    });

    it("waits out a settled render that lands a few frames late, then gives up (never loops)", async () => {
      for (const [late, focused] of [
        [3, 1],
        [11, 0],
      ] as const) {
        const dom = fakeDom({ settlesLate: late });
        try {
          setApplicantStageAction.mockResolvedValueOnce(ok("shortlist"));
          mountInbox([ROW_1]);
          press("Keep", dom.press);
          await flush();
          expect(dom.focus).toHaveBeenCalledTimes(focused);
          expect(dom.toolbar.querySelector).toHaveBeenCalledTimes(Math.min(late + 1, 11));
        } finally {
          vi.unstubAllGlobals();
        }
      }
    });

    it("never takes focus the user has put elsewhere, nor reaches a card that has left the page", async () => {
      for (const opts of [{ focusElsewhere: true }, { connected: false }]) {
        const dom = fakeDom(opts);
        try {
          setApplicantStageAction.mockResolvedValueOnce(ok("shortlist"));
          mountInbox([ROW_1]);
          press("Keep", dom.press);
          await flush();
          expect(dom.focus).not.toHaveBeenCalled();
        } finally {
          vi.unstubAllGlobals();
        }
      }
    });
  });

  it("a view-only posting's card shows its stage and offers no move", () => {
    const viewOnly: CandidateRow = {
      ...ROW_3,
      posting: posting(P1, "Old posting", { href: null, viewOnly: true }),
    };
    mountInbox([viewOnly]);
    expect(badges(cards()[0]!)).toContain("Passed");
    for (const t of ["Keep", "Pass", "Move to New"]) expect(button(cards()[0]!, t)).toBeUndefined();
  });

  it("the toast's dismiss is the shared icon-only control (one tab stop, named)", async () => {
    setApplicantStageAction.mockResolvedValueOnce({ ok: false, reason: "failed" });
    mountInbox([ROW_1]);
    button(cards()[0]!, "Keep")!.onClick!();
    await flush();
    const toast = elements().find((el) => isNamed(el, "Toast"))!;
    expect(typeof toast.props.onClose).toBe("function");
    // The DS Toast renders IconButtonBase for its ✕ (expanded here to check the label).
    const inner = (toast.type as (p: unknown) => ReactNode)(toast.props) as El;
    const close = elements(inner).find((el) => el.type === IconButtonBase)!;
    expect(close.props.label).toBe("Dismiss");
  });
});
