import { describe, expect, it, vi, beforeEach } from "vitest";
import type { ReactElement, ReactNode } from "react";
import type * as ReactModule from "react";

/**
 * AGENCY-BATCH-INVITE-PANEL tests — the FORM IS THE BOUNDARY.
 *
 * The batch mint is safe because its input is a CARDINALITY (a count + one shared non-PII
 * tag) and never a list of people. These tests pin that at the UI layer:
 *  - the count is validated INLINE to a whole number in [1,50]; 0 / 51 / 1.5 / text / blank
 *    never reach the Server Action;
 *  - a phone-like / email-like campaign tag is rejected INLINE (the tag is emitted into the
 *    event spine server-side, so a name/phone there is a §2 leak);
 *  - the panel has NO worker-identity field of any kind (no phone/name/email/CSV) — the only
 *    two fields are the count and the shared campaign tag;
 *  - the error region is `aria-live="polite"`.
 *
 * It also pins the four properties that make an ALREADY-MINTED batch survivable, because a
 * minted code is permanent, capped and has no readback endpoint — whatever this component
 * drops is gone for good:
 *  - a FAILED attempt never clears the links a SUCCESSFUL one put on screen;
 *  - invalid input is EXPLAINED (the submit is not silently disabled with no reason);
 *  - the live region announces the OUTCOME (the result list renders outside it, focus never
 *    moves, so an unannounced success is silence to a screen reader);
 *  - each link is a focusable anchor with the full url, and a failed clipboard write is said
 *    out loud and writes every link out untruncated.
 *
 * Env is node (no DOM); React state is injected via a mocked `useState` (source order:
 * count, countError, campaign, campaignError, invites, copied, error, copyError).
 * `useTransition` → [false, run-immediately].
 */

const createInviteBatchAction = vi.fn();
vi.mock("./batch-invite-actions", () => ({
  createInviteBatchAction: (i: unknown) => createInviteBatchAction(i),
}));

let stateQueue: unknown[] = [];
let stateCursor = 0;
/** Setters in source order, so a test can assert what the component did NOT touch. */
const setters: Array<ReturnType<typeof vi.fn>> = [];
const useState = vi.fn((initial: unknown) => {
  const i = stateCursor++;
  const seeded = i < stateQueue.length ? stateQueue[i] : initial;
  const set = vi.fn();
  setters.push(set);
  return [seeded, set] as [unknown, (v: unknown) => void];
});
const useTransition = vi.fn((): [boolean, (cb: () => void) => void] => [false, (cb) => cb()]);
vi.mock("react", async () => {
  const actual = await vi.importActual<typeof ReactModule>("react");
  return {
    ...actual,
    useState: (initial: unknown) => useState(initial),
    useTransition: () => useTransition(),
  };
});

const { AgencyBatchInvitePanel } = await import("./batch-invite-panel");

interface Collected {
  forms: Array<{ onSubmit?: (e: { preventDefault: () => void }) => void }>;
  ariaLiveCount: number;
  /** Every element's props, so field labels/types can be inspected (DS fields are components). */
  props: Array<Record<string, unknown>>;
  types: string[];
  text: string[];
}

function walk(node: ReactNode, acc: Collected): void {
  if (node === null || node === undefined || typeof node === "boolean") return;
  if (typeof node === "string" || typeof node === "number") {
    acc.text.push(String(node));
    return;
  }
  if (Array.isArray(node)) {
    for (const c of node) walk(c, acc);
    return;
  }
  const el = node as ReactElement<Record<string, unknown> & { children?: ReactNode }>;
  if (typeof el.type === "string") acc.types.push(el.type);
  if (el.type === "form") {
    acc.forms.push({
      onSubmit: el.props.onSubmit as ((e: { preventDefault: () => void }) => void) | undefined,
    });
  }
  if (el.props) {
    acc.props.push(el.props);
    if (el.props["aria-live"] === "polite") acc.ariaLiveCount++;
    if ("children" in el.props) walk(el.props.children, acc);
  }
}

function collect(tree: ReactNode): Collected {
  const acc: Collected = { forms: [], ariaLiveCount: 0, props: [], types: [], text: [] };
  walk(tree, acc);
  return acc;
}

/** Depth-first search for the announced region, so its CONTENT can be asserted. */
function findLiveRegion(node: ReactNode): ReactElement | null {
  if (node === null || node === undefined || typeof node !== "object") return null;
  if (Array.isArray(node)) {
    for (const c of node) {
      const hit = findLiveRegion(c);
      if (hit) return hit;
    }
    return null;
  }
  const el = node as ReactElement<Record<string, unknown> & { children?: ReactNode }>;
  if (!el.props) return null;
  if (el.props["aria-live"] === "polite") return el;
  return "children" in el.props ? findLiveRegion(el.props.children) : null;
}

/** The text a screen reader would actually be handed, whitespace-normalised. */
function liveText(tree: ReactNode): string {
  const region = findLiveRegion(tree);
  expect(region).not.toBeNull();
  return collect(region).text.join(" ").replace(/\s+/g, " ").trim();
}

/** Render with the full state vector (source order) — for the states a submit cannot reach. */
function renderState(state: unknown[]) {
  stateQueue = state;
  stateCursor = 0;
  setters.length = 0;
  return AgencyBatchInvitePanel() as ReactElement;
}

function render(count: string, campaign = "") {
  // useState order: count, countError, campaign, campaignError, invites, copied, error, copyError.
  return renderState([count, null, campaign, null, null, false, null, null]);
}

/** A batch that is ALREADY MINTED: permanent, capped, and readable nowhere else. */
const MINTED = [
  { code: "aaaaaaaaaaaa", link: "/i/aaaaaaaaaaaa" },
  { code: "bbbbbbbbbbbb", link: "/i/bbbbbbbbbbbb" },
];

/** Flush the awaited Server Action inside the (immediately-run) transition callback. */
async function flush() {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

function submit(tree: ReactElement) {
  const { forms } = collect(tree);
  expect(forms[0]?.onSubmit).toBeDefined();
  forms[0]!.onSubmit!({ preventDefault: () => {} });
}

beforeEach(() => {
  createInviteBatchAction.mockReset().mockResolvedValue({
    ok: true,
    invites: [{ code: "abc123def456", link: "/i/abc123def456" }],
  });
  useState.mockClear();
  useTransition.mockClear();
});

describe("AgencyBatchInvitePanel — the count is validated inline before the action", () => {
  for (const bad of ["0", "51", "1.5", "abc", "", "  ", "-3", "1e3"]) {
    it(`rejects "${bad}" inline; the action is NEVER called`, () => {
      submit(render(bad));
      expect(createInviteBatchAction).not.toHaveBeenCalled();
    });
  }

  it("accepts a valid count and forwards it as a NUMBER", () => {
    submit(render("12"));
    expect(createInviteBatchAction).toHaveBeenCalledWith({ count: 12, campaign: undefined });
  });

  it("accepts the bounds 1 and 50", () => {
    submit(render("1"));
    expect(createInviteBatchAction).toHaveBeenLastCalledWith({ count: 1, campaign: undefined });
    submit(render("50"));
    expect(createInviteBatchAction).toHaveBeenLastCalledWith({ count: 50, campaign: undefined });
  });
});

describe("AgencyBatchInvitePanel — INLINE PII screen rejects a phone/email tag", () => {
  it("a phone-like campaign tag is rejected inline; the action is NEVER called", () => {
    submit(render("10", "call +91 98123 45678"));
    expect(createInviteBatchAction).not.toHaveBeenCalled();
  });

  it("an email-like campaign tag is rejected inline; the action is NEVER called", () => {
    submit(render("10", "ping ramesh@example.com"));
    expect(createInviteBatchAction).not.toHaveBeenCalled();
  });

  it("a clean (non-PII) tag proceeds as ONE batch-wide scalar", () => {
    submit(render("10", "pune-gate-2"));
    expect(createInviteBatchAction).toHaveBeenCalledWith({ count: 10, campaign: "pune-gate-2" });
  });
});

describe("AgencyBatchInvitePanel — no worker-identity input exists (not bulk upload)", () => {
  it("has exactly two labelled fields: the count and the shared campaign tag", () => {
    const labels = collect(render("10"))
      .props.map((p) => p.label)
      .filter((l): l is string => typeof l === "string");
    expect(labels).toEqual(["How many links", "Campaign tag"]);
  });

  it("has NO tel/email/file input and no per-invite list control", () => {
    const { props, types } = collect(render("10"));
    const inputTypes = props.map((p) => p.type).filter((t): t is string => typeof t === "string");
    for (const forbidden of ["tel", "email", "file"]) {
      expect(inputTypes).not.toContain(forbidden);
    }
    expect(types).not.toContain("textarea");
    // No field placeholder invites a name/phone/number list.
    const placeholders = props
      .map((p) => p.placeholder)
      .filter((p): p is string => typeof p === "string");
    for (const p of placeholders) {
      expect(p).not.toMatch(/phone|mobile|name|email|csv|number/i);
    }
  });
});

describe("AgencyBatchInvitePanel — A11Y-OF-FAILURE + honest results", () => {
  it("wraps the error in an aria-live='polite' region", () => {
    expect(collect(render("10")).ariaLiveCount).toBeGreaterThanOrEqual(1);
  });

  it("renders NO result list before a successful mint", () => {
    const { props } = collect(render("10"));
    expect(props.some((p) => p.className === "agency-batch__list")).toBe(false);
  });

  it("renders exactly the links that came back — the count asked for is never claimed", () => {
    // Seeded state: asked for 50, the backend returned 2 (a partial batch).
    stateQueue = [
      "50",
      null,
      "",
      null,
      [
        { code: "aaaaaaaaaaaa", link: "/i/aaaaaaaaaaaa" },
        { code: "bbbbbbbbbbbb", link: "/i/bbbbbbbbbbbb" },
      ],
      false,
      null,
    ];
    stateCursor = 0;
    const { props, text } = collect(AgencyBatchInvitePanel() as ReactElement);
    const items = props.filter((p) => p.className === "agency-batch__item");
    expect(items).toHaveLength(2);
    expect(text).toContain("aaaaaaaaaaaa");
    expect(text).toContain("bbbbbbbbbbbb");
    // The requested 50 is never presented as created — only the 2 that came back.
    expect(text.join(" ").replace(/\s+/g, " ")).toContain("2 links created");
  });
});

describe("AgencyBatchInvitePanel — a FAILED attempt never destroys an EARLIER batch", () => {
  it("leaves the already-minted links untouched when the next mint fails", async () => {
    // Mint 50, hit the hourly cap on the second attempt: those codes are already written and
    // already charged, and NO endpoint can read them back. Clearing them loses them for good.
    createInviteBatchAction.mockReset().mockResolvedValue({
      ok: false,
      error: "Could not create invite links right now. Please try again shortly.",
    });
    const tree = renderState(["10", null, "", null, MINTED, false, null, null]);
    submit(tree);
    await flush();
    // setters (source order): 4 = setInvites, 6 = setError.
    expect(setters[4]).not.toHaveBeenCalled();
    expect(setters[6]).toHaveBeenLastCalledWith(
      "Could not create invite links right now. Please try again shortly.",
    );
  });

  it("still renders the earlier links alongside the failure, and says they are unaffected", () => {
    const tree = renderState(["10", null, "", null, MINTED, false, "Could not create.", null]);
    const { props, text } = collect(tree);
    expect(props.filter((p) => p.className === "agency-batch__item")).toHaveLength(2);
    expect(text).toContain("aaaaaaaaaaaa");
    expect(liveText(tree)).toContain("still listed below");
  });
});

describe("AgencyBatchInvitePanel — invalid input is EXPLAINED, not silently blocked", () => {
  it("keeps the submit reachable so the reason is produced (a disabled button also kills Enter)", () => {
    const { props } = collect(render("0"));
    const submitBtn = props.find((p) => p.type === "submit");
    expect(submitBtn).toBeDefined();
    // Disabled-while-invalid meant handleCreate never ran, so countError was never set and the
    // message below the field was unreachable dead code.
    expect(submitBtn!.disabled).toBeFalsy();
  });

  it("announces the inline validation message instead of only greying the button out", () => {
    const tree = renderState([
      "0",
      "Choose between 1 and 50 links at a time.",
      "",
      null,
      null,
      false,
      null,
      null,
    ]);
    expect(liveText(tree)).toContain("Choose between 1 and 50 links at a time.");
  });
});

describe("AgencyBatchInvitePanel — the mint OUTCOME is announced, not just the failure", () => {
  it("announces the created count in the live region (the list renders outside it)", () => {
    // Success payload = 50 rows rendered outside the aria-live region with no focus move; if
    // it is not announced here, a screen-reader user hears nothing at all.
    expect(liveText(renderState(["10", null, "", null, MINTED, false, null, null]))).toContain(
      "2 links created",
    );
  });
});

describe("AgencyBatchInvitePanel — the links survive a dead clipboard", () => {
  it("renders every link as a focusable anchor carrying the FULL url", () => {
    const { types, props } = collect(
      renderState(["10", null, "", null, MINTED, false, null, null]),
    );
    expect(types).toContain("a"); // was a non-focusable <span>, unreachable by keyboard
    const hrefs = props.map((p) => p.href).filter((h): h is string => typeof h === "string");
    expect(hrefs).toEqual(["/i/aaaaaaaaaaaa", "/i/bbbbbbbbbbbb"]);
  });

  it("SAYS so when the copy fails (node has no clipboard — the same as a non-secure context)", async () => {
    const { props } = collect(renderState(["10", null, "", null, MINTED, false, null, null]));
    const copyBtn = props.find(
      (p) => typeof p.onClick === "function" && p.children === "Copy all links",
    );
    expect(copyBtn).toBeDefined();
    await (copyBtn!.onClick as () => Promise<void>)();
    // setters (source order): 7 = setCopyError. Previously the catch block set nothing at all.
    expect(setters[7]).toHaveBeenLastCalledWith(expect.stringContaining("Could not copy"));
  });

  it("writes every link out in full once copying failed (nothing is only-truncated)", () => {
    const { props, text } = collect(
      renderState(["10", null, "", null, MINTED, false, null, "Could not copy the links."]),
    );
    // The single-mint fallback shape: `.agency-invite__dl dd` wraps instead of ellipsising.
    expect(props.some((p) => p.className === "agency-invite__dl")).toBe(true);
    expect(text.filter((t) => t === "/i/bbbbbbbbbbbb").length).toBeGreaterThanOrEqual(2);
  });
});
