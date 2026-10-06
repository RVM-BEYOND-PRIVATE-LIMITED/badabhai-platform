import { describe, it, expect, beforeEach, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type * as ReactModule from "react";

/**
 * ONE NAME, ONE TARGET for the admin directory's way into the audit log (sweep AW-10).
 *
 * The page header said "View all admin actions" → `/events?eventName=admin.action_performed`;
 * the invite result said "View events" to the same place; and a row action's result said "View
 * events" to `/events?subjectType=admin_session` — everyone's sessions, not the action just
 * taken. Two names for one function, one name for two. All three now read the shared link.
 *
 * And the invite form's submit names the page's own action the way its header does: "Invite an
 * admin" (AW-30).
 *
 * The two forms are Client Components. They are rendered on the server here, with `useState`
 * seeded so the result banner is on screen — read POSITIONALLY in each component's source
 * order (row actions: role, outcome; invite form: email, role, outcome). Every later call
 * (the action buttons' own state) gets its initial value.
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

const DONE = { ok: true, changed: true, message: "Role changed to Analyst." } as const;
const ROW = {
  id: "aaaaaaaa-0000-4000-8000-000000000002",
  role: "ops_admin",
  status: "active",
  is_self: false,
} as const;

/** The result banner's link: its href and its text, read from the markup. */
function bannerLink(out: string): { href: string; label: string } | null {
  const m = /<div class="alert__actions"><a class="[^"]*" href="([^"]*)">([^<]*)<\/a>/.exec(out);
  return m ? { href: m[1]!.replace(/&amp;/g, "&"), label: m[2]! } : null;
}

const ALL_ADMIN_ACTIONS = {
  href: "/events?eventName=admin.action_performed",
  label: "View all admin actions",
};

beforeEach(() => {
  seeded = [];
  cursor = 0;
});

describe("a row action's result", () => {
  it("links where the action landed — admin.action_performed — by the header's name", () => {
    seeded = [ROW.role, DONE];
    const out = renderToStaticMarkup(<AdminRowActions admin={ROW} mayReadEvents />);
    expect(out).toContain("Role changed to Analyst.");
    expect(bannerLink(out)).toEqual(ALL_ADMIN_ACTIONS);
    // Never everyone's sessions under a label that reads like this action's record.
    expect(out).not.toContain("subjectType=admin_session");
  });

  it("offers no link to a session that may not open /events", () => {
    seeded = [ROW.role, DONE];
    const out = renderToStaticMarkup(<AdminRowActions admin={ROW} mayReadEvents={false} />);
    expect(out).toContain("Role changed to Analyst.");
    expect(bannerLink(out)).toBeNull();
  });
});

describe("the invite form", () => {
  it("names its submit the way the page header names the action", () => {
    const out = renderToStaticMarkup(<InviteAdminForm mayReadEvents />);
    expect(out).toContain("<span>Invite an admin</span>");
    expect(out).not.toContain(">Invite admin<");
  });

  it("links its result to the same place, by the same name, as a row action's", () => {
    seeded = ["new.admin@badabhai.ai", "analyst", { ...DONE, message: "Invited." }];
    const out = renderToStaticMarkup(<InviteAdminForm mayReadEvents />);
    expect(out).toContain("Invited.");
    expect(bannerLink(out)).toEqual(ALL_ADMIN_ACTIONS);
  });
});
