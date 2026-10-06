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

vi.mock("react", async () => {
  const actual = await vi.importActual<typeof ReactModule>("react");
  return {
    ...actual,
    useState: (init: unknown) => [init, vi.fn()],
    useTransition: () => [false, (cb: () => void) => cb()],
  };
});
vi.mock("./actions", () => ({
  inviteMemberAction: vi.fn(),
  removeMemberAction: vi.fn(),
}));

const { TeamManager } = await import("./team-manager");

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
