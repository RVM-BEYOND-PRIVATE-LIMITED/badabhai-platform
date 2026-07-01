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
  });

  it("renders masked email + role + status, and a per-row Remove for a removable member", () => {
    const tree = TeamManager({ members: [recruiter] }) as ReactElement;
    expect(gatherButtons(tree)).toContain("Remove");
    const text = gatherText(tree);
    expect(text).toContain("h•••@acme.example"); // server-masked, never raw
    expect(text).toContain("recruiter");
    expect(text).toContain("invited");
    expect(text).not.toMatch(/\d{10,}/);
  });

  it("hides Remove for the caller's own row / an owner (marks it 'You')", () => {
    const tree = TeamManager({ members: [self] }) as ReactElement;
    expect(gatherButtons(tree)).not.toContain("Remove");
    expect(gatherText(tree)).toContain("You");
  });
});
