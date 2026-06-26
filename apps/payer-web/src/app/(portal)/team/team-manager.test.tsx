import { describe, expect, it, vi } from "vitest";
import type { ReactElement, ReactNode } from "react";
import type * as ReactModule from "react";
import type { OrgMemberView } from "../../../lib/org-members";

/**
 * (e) TeamManager scaffold render — the Owner user-management UI exists (invite form + members
 * list + per-row Remove) but carries NO fabricated members: an empty directory renders an empty
 * state, never fake rows. PII-free: members are a coarse label + role only. Env is node — React
 * state is stubbed via a mocked useState/useTransition; the Server Actions are mocked inert.
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
    if (el.type === "button") out.push(textOf(el.props.children as ReactNode).trim());
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

const member: OrgMemberView = { memberId: "stub-1", label: "member-a1b2", orgRole: "recruiter" };

describe("TeamManager scaffold — invite affordance + stub empty state, PII-free", () => {
  it("renders the invite affordance + an empty members state with NO fabricated members", () => {
    const tree = TeamManager({ members: [] }) as ReactElement;
    expect(gatherButtons(tree)).toContain("Send invite");
    const text = gatherText(tree);
    expect(text).toMatch(/No additional members yet/i);
    // PII-free: no phone-number digit runs anywhere.
    expect(text).not.toMatch(/\d{10,}/);
    expect(text).not.toMatch(/\+\d{7,}/);
  });

  it("renders a per-row Remove affordance + the coarse label/role for a supplied member", () => {
    // The member is TEST INPUT (the stub returns []); the component must render what it's given.
    const tree = TeamManager({ members: [member] }) as ReactElement;
    expect(gatherButtons(tree)).toContain("Remove");
    const text = gatherText(tree);
    expect(text).toContain("member-a1b2"); // coarse opaque label
    expect(text).toContain("recruiter"); // role badge
    expect(text).not.toMatch(/\d{10,}/);
  });
});
