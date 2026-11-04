import { beforeEach, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type * as ReactModule from "react";

/**
 * A5 (#2575) — Create and Invite open in dialogs, and a new admin's temporary password is shown
 * ONCE, with a copy button, after a successful create.
 *
 * `useState` is seeded POSITIONALLY. CreateAdminForm's source order: email, name, role, password,
 * confirm, outcome, issuedPassword; every later call (the password fields' and the action
 * button's own state) gets its initial value.
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
vi.mock("./actions", () => ({
  createAdminAction: async () => ({ ok: true, changed: true, message: "" }),
  inviteAdminAction: async () => ({ ok: true, changed: true, message: "" }),
}));

const { CreateAdminForm } = await import("./create-admin-form");
const { CreateAdminDialog, InviteAdminDialog } = await import("./admin-access-dialogs");

const CREATED = {
  ok: true,
  changed: true,
  message: "Created admin 1a2b3c4d as Analyst.",
} as const;
const TEMP = "Temp1234xYz!";

beforeEach(() => {
  seeded = [];
  cursor = 0;
});

describe("the header's Create / Invite buttons", () => {
  it("Create is the primary button and its dialog stays closed until clicked", () => {
    const out = renderToStaticMarkup(<CreateAdminDialog mayReadEvents />);
    expect(out).toBe(
      '<button type="button" class="btn btn--primary"><i class="ph-fill ph-user-plus" aria-hidden="true"></i><span>Create an admin</span></button>',
    );
  });

  it("Invite is a quiet button and its dialog stays closed until clicked", () => {
    const out = renderToStaticMarkup(<InviteAdminDialog mayReadEvents />);
    expect(out).toContain('<button type="button" class="btn btn--ghost">');
    expect(out).toContain("<span>Invite an admin</span>");
    expect(out).not.toContain('role="dialog"');
  });

  it("an open Create dialog holds the form, titled and described by the dialog", () => {
    seeded = [true];
    const out = renderToStaticMarkup(<CreateAdminDialog mayReadEvents />);
    expect(out).toMatch(/role="dialog" aria-modal="true"/);
    expect(out).toContain(">Create an admin</h2>");
    expect(out).toContain("They must replace it at their first sign-in.");
    expect(out).toContain("Temporary password");
  });

  it("an open Invite dialog holds the invite form", () => {
    seeded = [true];
    const out = renderToStaticMarkup(<InviteAdminDialog mayReadEvents />);
    expect(out).toContain(">Invite an admin</h2>");
    expect(out).toContain("one-time accept link");
    expect(out).toContain("Work email");
  });
});

describe("the temporary password, after a successful create", () => {
  it("is shown once, read-only, with a copy button", () => {
    seeded = ["", "", "analyst", "", "", CREATED, TEMP];
    const out = renderToStaticMarkup(<CreateAdminForm mayReadEvents />);
    expect(out).toContain('<p class="alert__title">Temporary password</p>');
    expect(out).toContain("Shown once.");
    expect(out).toContain(
      '<input class="field__input mono" type="text" readOnly="" aria-label="Temporary password for the new admin"' +
        ` autoComplete="off" spellCheck="false" value="${TEMP}"/>`,
    );
    expect(out).toContain("<span>Copy password</span>");
  });

  it("is never part of the result banner's copy", () => {
    seeded = ["", "", "analyst", "", "", CREATED, TEMP];
    const out = renderToStaticMarkup(<CreateAdminForm mayReadEvents />);
    const banner = out.slice(out.indexOf("Created admin"), out.indexOf("Temporary password</p>"));
    expect(banner).not.toContain(TEMP);
  });

  it("is not shown after a failed create", () => {
    seeded = ["", "", "analyst", "", "", { ok: false, error: "Email already in use." }, TEMP];
    const out = renderToStaticMarkup(<CreateAdminForm mayReadEvents />);
    expect(out).toContain("Email already in use.");
    expect(out).not.toContain(TEMP);
    expect(out).not.toContain("Copy password");
  });
});
