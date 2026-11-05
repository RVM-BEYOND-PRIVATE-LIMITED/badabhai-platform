import { describe, it, expect, beforeEach, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type * as ReactModule from "react";

/**
 * ONE NAME, ONE TARGET for the admin directory's way into the audit log (sweep AW-10), now
 * delivered as the success toast's single action (#2689). Success no longer renders an inline
 * banner, so this file pins the shared target and that neither the row action nor the invite
 * form paints a second, stale result block.
 */
let seeded: unknown[] = [];
let cursor = 0;
vi.mock("react", async () => {
  const actual = await vi.importActual<typeof ReactModule>("react");
  return {
    ...actual,
    useState: (initial: unknown) => {
      const i = cursor++;
      return [i < seeded.length ? seeded[i] : initial, () => {}];
    },
  };
});

vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: () => {} }) }));

// Server Actions: never called by a render.
vi.mock("./actions", () => ({
  changeAdminRoleAction: async () => ({ ok: true, changed: true, message: "" }),
  resetAdminMfaAction: async () => ({ ok: true, changed: true, message: "" }),
  suspendAdminAction: async () => ({ ok: true, changed: true, message: "" }),
  inviteAdminAction: async () => ({ ok: true, changed: true, message: "" }),
}));

const { AdminRowActions } = await import("./admin-row-actions");
const { InviteAdminForm } = await import("./invite-admin-form");
const { ALL_ADMIN_ACTIONS_LINK } = await import("../../../components/admin-action-result-banner");

const DONE = { ok: true, changed: true, message: "Role changed to Analyst." } as const;
const ROW = {
  id: "aaaaaaaa-0000-4000-8000-000000000002",
  role: "ops_admin",
  status: "active",
  is_self: false,
} as const;

beforeEach(() => {
  seeded = [];
  cursor = 0;
});

describe("the shared admin-action target", () => {
  it("is the page header's name and the filtered audit log", () => {
    expect(ALL_ADMIN_ACTIONS_LINK).toEqual({
      href: "/events?eventName=admin.action_performed",
      label: "View all admin actions",
    });
    expect(ALL_ADMIN_ACTIONS_LINK.href).not.toContain("subjectType=admin_session");
  });
});

describe("a row action's result", () => {
  it("renders no inline success banner — the toast owns it", () => {
    seeded = [ROW.role, DONE];
    const out = renderToStaticMarkup(<AdminRowActions admin={ROW} mayReadEvents />);
    expect(out).not.toContain("Role changed to Analyst.");
    expect(out).not.toContain("alert--success");
  });
});

describe("the invite form", () => {
  it("names its submit the way the page header names the action", () => {
    const out = renderToStaticMarkup(<InviteAdminForm mayReadEvents />);
    expect(out).toContain("<span>Invite an admin</span>");
    expect(out).not.toContain(">Invite admin<");
  });

  it("renders no inline success banner — the toast owns it", () => {
    seeded = ["new.admin@badabhai.ai", "analyst", { ...DONE, message: "Invited." }];
    const out = renderToStaticMarkup(<InviteAdminForm mayReadEvents />);
    expect(out).not.toContain("Invited.");
    expect(out).not.toContain("alert--success");
  });
});
