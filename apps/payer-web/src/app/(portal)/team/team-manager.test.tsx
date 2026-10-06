import { describe, expect, it, vi } from "vitest";
import type { ReactElement, ReactNode } from "react";
import type * as ReactModule from "react";
import type { OrgMemberView } from "../../../lib/org-members";
import { Button } from "../../../components/ds";

/**
 * TeamManager render (Owner user-management, LIVE-wired B5.5) — invite form + members list +
 * per-row Remove. FACELESS: members render a SERVER-MASKED email + role + status only, never a raw
 * address; an empty directory renders an empty state. A member's own row / an owner row hides the
 * Remove affordance. Env is node — React state is stubbed via a mocked useState/useTransition; the
 * Server Actions are mocked inert.
 *
 * UI-1: the two blocks are now `panel`s, the directory is the `table` primitive and the empty
 * directory is the shared `state` block — the assertions below name those primitives instead of
 * the retired `team-table` / `team-empty` classes.
 */

// Hooks run outside React here: state is SEEDED by call order (source order: email, message,
// confirming) and each slot's setter is kept; effects are collected to be run by hand; a ref is
// one object per call order that survives re-renders (as React's does); `pending` is settable.
let stateQueue: unknown[] = [];
let stateCursor = 0;
const setters: Array<ReturnType<typeof vi.fn>> = [];
let refs: Array<{ current: unknown }> = [];
let refCursor = 0;
let effects: Array<() => void | (() => void)> = [];
let pendingNow = false;
vi.mock("react", async () => {
  const actual = await vi.importActual<typeof ReactModule>("react");
  return {
    ...actual,
    useState: (init: unknown) => {
      const i = stateCursor++;
      const set = vi.fn();
      setters[i] = set;
      return [i < stateQueue.length ? stateQueue[i] : init, set];
    },
    useTransition: () => [pendingNow, (cb: () => void) => cb()],
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
const removeMemberAction = vi.fn();
vi.mock("./actions", () => ({
  inviteMemberAction: vi.fn(),
  removeMemberAction: (i: unknown) => removeMemberAction(i),
}));

const { TeamManager: TeamManagerImpl } = await import("./team-manager");
const { Dialog } = await import("../../../components/ds");

/** Render once (the hooks above reset their cursors; seeded state persists until reset). */
function TeamManager(props: Parameters<typeof TeamManagerImpl>[0]) {
  stateCursor = 0;
  refCursor = 0;
  effects = [];
  return TeamManagerImpl(props);
}

function textOf(node: ReactNode): string {
  if (node === null || node === undefined || typeof node === "boolean") return "";
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(textOf).join("");
  const el = node as ReactElement<{ children?: ReactNode }>;
  return el.props && "children" in el.props ? textOf(el.props.children) : "";
}

function gatherButtons(tree: ReactNode): string[] {
  const out: string[] = [];
  (function w(node: ReactNode): void {
    if (node === null || node === undefined || typeof node === "boolean") return;
    if (typeof node === "string" || typeof node === "number") return;
    if (Array.isArray(node)) {
      node.forEach(w);
      return;
    }
    const el = node as ReactElement<Record<string, unknown> & { children?: ReactNode }>;
    if (el.type === "button" || el.type === Button)
      out.push(textOf(el.props.children as ReactNode).trim());
    if (el.props && "children" in el.props) w(el.props.children as ReactNode);
  })(tree);
  return out;
}

/** Every element carrying `cls` in its className (space-separated), depth-first. */
function findByClass(node: ReactNode, cls: string, acc: ReactElement[] = []): ReactElement[] {
  if (node === null || node === undefined || typeof node !== "object") return acc;
  if (Array.isArray(node)) {
    node.forEach((c) => findByClass(c, cls, acc));
    return acc;
  }
  const el = node as ReactElement<{ className?: unknown; children?: ReactNode }>;
  const cn = el.props?.className;
  if (typeof cn === "string" && cn.split(/\s+/).includes(cls)) acc.push(el);
  if (el.props && "children" in el.props) findByClass(el.props.children, cls, acc);
  return acc;
}

function gatherText(tree: ReactNode): string {
  const all: string[] = [];
  (function w(node: ReactNode): void {
    if (node === null || node === undefined || typeof node === "boolean") return;
    if (typeof node === "string" || typeof node === "number") {
      all.push(String(node));
      return;
    }
    if (Array.isArray(node)) {
      node.forEach(w);
      return;
    }
    const el = node as ReactElement<{ children?: ReactNode }>;
    if (el.props && "children" in el.props) w(el.props.children);
  })(tree);
  return all.join(" ");
}

const recruiter: OrgMemberView = {
  memberId: "mem-1",
  orgRole: "recruiter",
  status: "invited",
  emailMasked: "h•••@acme.example",
  invitedAt: "2026-07-01T00:00:00.000Z",
  isSelf: false,
};
const self: OrgMemberView = {
  memberId: "mem-self",
  orgRole: "owner",
  status: "active",
  emailMasked: "o•••@acme.example",
  invitedAt: "2026-06-01T00:00:00.000Z",
  isSelf: true,
};

describe("TeamManager — invite affordance + masked members list, PII-free", () => {
  it("renders the invite affordance + an empty members state with NO fabricated members", () => {
    const tree = TeamManager({ members: [] }) as ReactElement;
    expect(gatherButtons(tree)).toContain("Send invite");
    const text = gatherText(tree);
    expect(text).toMatch(/No members yet/i);
    expect(text).not.toMatch(/\d{10,}/);
    expect(text).not.toMatch(/\+\d{7,}/);
    // The empty directory is the shared `state` block, and it offers a way forward.
    expect(findByClass(tree, "state").length).toBe(1);
    expect(findByClass(tree, "state__actions").length).toBe(1);
    // No table is rendered when there is nothing to put in it.
    expect(findByClass(tree, "table").length).toBe(0);
  });

  it("renders masked email + role + status, and a per-row Remove for a removable member", () => {
    const tree = TeamManager({ members: [recruiter] }) as ReactElement;
    expect(gatherButtons(tree)).toContain("Remove");
    const text = gatherText(tree);
    expect(text).toContain("h•••@acme.example"); // server-masked, never raw
    expect(text).toContain("recruiter");
    expect(text).toContain("invited");
    expect(text).not.toMatch(/\d{10,}/);
    // The directory is the `table` primitive inside its scroll wrapper — no empty state.
    expect(findByClass(tree, "table").length).toBe(1);
    expect(findByClass(tree, "tablewrap").length).toBe(1);
    expect(findByClass(tree, "state").length).toBe(0);
  });

  it("hides Remove for the caller's own row / an owner (marks it 'You')", () => {
    const tree = TeamManager({ members: [self] }) as ReactElement;
    expect(gatherButtons(tree)).not.toContain("Remove");
    expect(gatherText(tree)).toContain("You");
  });
});

describe("TeamManager — W3-B: the directory is a labelled, keyboard-scrollable region", () => {
  it("the table scroller is focusable, a region, and NAMED BY the Members heading (referenced)", () => {
    const tree = TeamManager({ members: [recruiter, self] }) as ReactElement;
    const wrap = findByClass(tree, "tablewrap");
    expect(wrap).toHaveLength(1);
    const props = wrap[0]!.props as Record<string, unknown>;
    expect(props).toMatchObject({ tabIndex: 0, role: "region" });
    // The name is the heading's own text, referenced — not a second hand-kept copy of it.
    expect(props["aria-label"]).toBeUndefined();
    const heading = findByClass(tree, "panel__title").find(
      (h) => gatherText(h).trim() === "Members",
    );
    expect(heading).toBeDefined();
    const id = (heading!.props as { id?: unknown }).id;
    expect(typeof id === "string" && id.length > 0).toBe(true);
    expect(props["aria-labelledby"]).toBe(id);
  });

  it("the table keeps wrapping (not `table--nowrap`): a long masked email must not push role/status off a phone", () => {
    const table = findByClass(TeamManager({ members: [recruiter] }) as ReactElement, "table");
    expect((table[0]!.props as { className: string }).className).toBe("table");
  });

  it("renders ONLY the server-masked email — a stray raw address on the row object never reaches the DOM", () => {
    const leaky = { ...recruiter, email: "harish.kumar@acme.example" } as OrgMemberView;
    const text = gatherText(TeamManager({ members: [leaky] }) as ReactElement);
    expect(text).toContain("h•••@acme.example");
    expect(text).not.toContain("harish");
  });
});

/** Every element of the given host tag, depth-first (the tree is NOT expanded). */
function byTag(node: ReactNode, tag: string, acc: ReactElement[] = []): ReactElement[] {
  if (node === null || node === undefined || typeof node !== "object") return acc;
  if (Array.isArray(node)) {
    node.forEach((c) => byTag(c, tag, acc));
    return acc;
  }
  const el = node as ReactElement<{ children?: ReactNode }>;
  if (el.type === tag) acc.push(el);
  if (el.props && "children" in el.props) byTag(el.props.children, tag, acc);
  return acc;
}

describe("TeamManager — a failed members read (F30)", () => {
  it("keeps the invite form and shows the in-place error with a Retry — never 'No members yet'", async () => {
    const { RetryButton } = await import("../../../components/retry-button");
    const tree = TeamManager({ members: null }) as ReactElement;
    // The invite form still works: inviting does not depend on the list read.
    expect(gatherButtons(tree)).toContain("Send invite");
    const errors = findByClass(tree, "state--error");
    expect(errors).toHaveLength(1);
    expect(gatherText(errors[0]!)).toContain("We couldn’t load your team");
    const retry: ReactElement[] = [];
    (function w(node: ReactNode): void {
      if (node === null || node === undefined || typeof node !== "object") return;
      if (Array.isArray(node)) return node.forEach(w);
      const el = node as ReactElement<{ children?: ReactNode }>;
      if (el.type === RetryButton) retry.push(el);
      if (el.props && "children" in el.props) w(el.props.children);
    })(errors[0]!);
    expect(retry).toHaveLength(1);
    // Nothing is claimed about a team that was not read.
    expect(gatherText(tree)).not.toMatch(/No members yet/i);
    expect(findByClass(tree, "table")).toHaveLength(0);
  });
});

describe("TeamManager — the members table stacks into cards on a phone (F38)", () => {
  // On a phone the table is re-laid as one card per member (w3b-page-polish.css.test.ts), so
  // Remove is on screen without scrolling the table sideways. A table re-displayed by CSS can
  // lose its table semantics in some engines, so the markup states them explicitly.
  it("every table part carries its explicit table role", () => {
    const tree = TeamManager({ members: [recruiter, self] }) as ReactElement;
    const role = (tag: string) => byTag(tree, tag).map((e) => (e.props as { role?: string }).role);
    expect(role("table")).toEqual(["table"]);
    expect(role("thead")).toEqual(["rowgroup"]);
    expect(role("tbody")).toEqual(["rowgroup"]);
    expect(role("tr")).toEqual(["row", "row", "row"]);
    expect(role("th")).toEqual(["columnheader", "columnheader", "columnheader", "columnheader"]);
    expect(role("td")).toEqual(Array(8).fill("cell"));
  });

  it("the Remove cell is the row's LAST cell (the phone card pins it to the card's end)", () => {
    const tree = TeamManager({ members: [recruiter] }) as ReactElement;
    const row = byTag(tree, "tr")[1]!;
    const cells = byTag(row, "td");
    expect(cells).toHaveLength(4);
    expect((cells[3]!.props as { className?: string }).className).toBe("rowactions");
    expect(gatherButtons(cells[3]!)).toEqual(["Remove"]);
  });
});

/**
 * Review of #2037 — Remove was ONE tap: `onRemove` fired the action at once, and on a phone card it
 * now sits under the thumb. It asks first, in the generic DS Dialog (not the spend dialog), and
 * focus goes back to where the payer was once the dialog has closed AND the removal has settled.
 */
describe("TeamManager — Remove asks first (generic DS Dialog), then returns focus", () => {
  const reset = () => {
    stateQueue = [];
    refs = [];
    pendingNow = false;
    removeMemberAction.mockReset().mockResolvedValue({ ok: true, message: "Member removed." });
  };
  /** Every element of a component type, depth-first (props.children only). */
  const ofType = (node: ReactNode, type: unknown, acc: ReactElement[] = []): ReactElement[] => {
    if (node === null || node === undefined || typeof node !== "object") return acc;
    if (Array.isArray(node)) {
      node.forEach((c) => ofType(c, type, acc));
      return acc;
    }
    const el = node as ReactElement<{ children?: ReactNode }>;
    if (el.type === type) acc.push(el);
    if (el.props && "children" in el.props) ofType(el.props.children, type, acc);
    return acc;
  };
  const props = (el: ReactElement) => el.props as Record<string, unknown>;
  const rowRemove = (tree: ReactNode) =>
    ofType(tree, Button).find((b) => textOf(props(b).children as ReactNode).trim() === "Remove")!;
  const dialogOf = (tree: ReactNode) => {
    const found = ofType(tree, Dialog);
    expect(found).toHaveLength(1);
    return found[0]!;
  };
  const footerButtons = (dialog: ReactElement) =>
    ofType(props(dialog).footer as ReactNode, Button).map((b) => ({
      text: textOf(props(b).children as ReactNode).trim(),
      variant: props(b).variant,
      onClick: props(b).onClick as () => void,
    }));

  it("tapping a row's Remove opens the confirm — it does NOT remove anyone", () => {
    reset();
    const tree = TeamManager({ members: [recruiter] }) as ReactElement;
    expect(props(dialogOf(tree)).open).toBe(false);
    (props(rowRemove(tree)).onClick as () => void)();
    expect(removeMemberAction).not.toHaveBeenCalled();
    // Slot 3 (source order) is the member awaiting confirmation.
    expect(setters[2]).toHaveBeenCalledWith(recruiter);
  });

  it("the confirm names the member by MASKED email, with Cancel and a destructive Remove", () => {
    reset();
    stateQueue = ["", null, recruiter];
    const dialog = dialogOf(TeamManager({ members: [recruiter] }) as ReactElement);
    expect(props(dialog).open).toBe(true);
    expect(props(dialog).title).toBe("Remove h•••@acme.example from your team?");
    expect(footerButtons(dialog).map((b) => [b.text, b.variant])).toEqual([
      ["Cancel", "ghost"],
      ["Remove", "danger"],
    ]);
  });

  it("Cancel (and Esc / the scrim — the Dialog's onClose) closes it without removing", () => {
    reset();
    stateQueue = ["", null, recruiter];
    const dialog = dialogOf(TeamManager({ members: [recruiter] }) as ReactElement);
    footerButtons(dialog)[0]!.onClick();
    (props(dialog).onClose as () => void)();
    expect(setters[2]!.mock.calls).toEqual([[null], [null]]);
    expect(removeMemberAction).not.toHaveBeenCalled();
  });

  it("confirming closes the dialog and removes THAT member, sending only its id", async () => {
    reset();
    stateQueue = ["", null, recruiter];
    const dialog = dialogOf(TeamManager({ members: [recruiter] }) as ReactElement);
    footerButtons(dialog)[1]!.onClick();
    expect(setters[2]).toHaveBeenCalledWith(null);
    expect(removeMemberAction).toHaveBeenCalledWith({ memberId: "mem-1" });
    await new Promise((r) => setTimeout(r, 0));
    expect(setters[1]).toHaveBeenCalledWith({ ok: true, text: "Member removed." });
  });

  it("focus returns to the row's Remove — only once the dialog is closed AND the removal settled", () => {
    reset();
    const focus = vi.fn();
    const headingFocus = vi.fn();
    (globalThis as { document?: unknown }).document = {
      getElementById: (id: string) =>
        id === "team-remove-mem-1"
          ? { focus }
          : id === "team-members-title"
            ? { focus: headingFocus }
            : null,
    };
    // Ask (the trigger is remembered), then render the open dialog: nothing moves focus yet.
    const first = TeamManager({ members: [recruiter] }) as ReactElement;
    expect(props(rowRemove(first)).id).toBe("team-remove-mem-1");
    (props(rowRemove(first)).onClick as () => void)();
    stateQueue = ["", null, recruiter];
    TeamManager({ members: [recruiter] });
    effects.forEach((run) => run());
    expect(focus).not.toHaveBeenCalled();
    // Confirmed: closed but still pending (the row's Remove is disabled) — still nothing.
    stateQueue = ["", null, null];
    pendingNow = true;
    TeamManager({ members: [recruiter] });
    effects.forEach((run) => run());
    expect(focus).not.toHaveBeenCalled();
    // Settled: focus lands back on the Remove that opened it, once.
    pendingNow = false;
    TeamManager({ members: [recruiter] });
    effects.forEach((run) => run());
    expect(focus).toHaveBeenCalledTimes(1);
    TeamManager({ members: [recruiter] });
    effects.forEach((run) => run());
    expect(focus).toHaveBeenCalledTimes(1);
    expect(headingFocus).not.toHaveBeenCalled();
  });

  it("…and to the Members heading when that row is gone", () => {
    reset();
    const headingFocus = vi.fn();
    (globalThis as { document?: unknown }).document = {
      getElementById: (id: string) =>
        id === "team-members-title" ? { focus: headingFocus } : null,
    };
    const first = TeamManager({ members: [recruiter] }) as ReactElement;
    (props(rowRemove(first)).onClick as () => void)();
    stateQueue = ["", null, null];
    const tree = TeamManager({ members: [self] }) as ReactElement;
    effects.forEach((run) => run());
    expect(headingFocus).toHaveBeenCalledTimes(1);
    // The heading can take that focus (programmatically only — it is not a Tab stop).
    const heading = findByClass(tree, "panel__title").find(
      (h) => gatherText(h).trim() === "Members",
    );
    expect(props(heading!).tabIndex).toBe(-1);
  });

  it("uses the generic Dialog — never the credit-spend confirm", async () => {
    reset();
    const { ConfirmSpendDialog } = await import("../../../components/unlock");
    stateQueue = ["", null, recruiter];
    const tree = TeamManager({ members: [recruiter] }) as ReactElement;
    expect(ofType(tree, ConfirmSpendDialog)).toEqual([]);
    expect(ofType(tree, Dialog)).toHaveLength(1);
  });
});
