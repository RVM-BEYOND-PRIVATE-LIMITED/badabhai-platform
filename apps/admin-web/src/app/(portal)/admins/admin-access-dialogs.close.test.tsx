import { beforeEach, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type * as ReactModule from "react";
import type { ReactElement } from "react";

/**
 * A5 (#2575) — the Create / Invite dialog cannot be closed while its request is in flight.
 * Closing unmounts the form, and with it the temporary password or accept link the request is
 * about to show ONCE, so a close then (Escape, the scrim, the Close button — all `onClose`) must
 * do nothing.
 *
 * `useState` is seeded POSITIONALLY (the dialog's source order: open, pending) and its setters
 * are recorded; the Dialog is a stand-in that records the props it was given.
 */
let seeded: unknown[] = [];
let cursor = 0;
let sets: [number, unknown][] = [];
vi.mock("react", async () => {
  const actual = await vi.importActual<typeof ReactModule>("react");
  return {
    ...actual,
    useState: (initial: unknown) => {
      const i = cursor++;
      return [i < seeded.length ? seeded[i] : initial, (v: unknown) => sets.push([i, v])];
    },
  };
});

interface DialogStandInProps {
  open: boolean;
  onClose: () => void;
  children: ReactElement<{ onPendingChange?: (pending: boolean) => void }>;
}
let dialog: DialogStandInProps | null = null;
vi.mock("../../../components/dialog", () => ({
  Dialog: (p: DialogStandInProps) => {
    dialog = p;
    return null;
  },
}));
vi.mock("./create-admin-form", () => ({
  CREATE_ADMIN_DESCRIPTION: "",
  CreateAdminForm: () => null,
}));
vi.mock("./invite-admin-form", () => ({
  INVITE_ADMIN_DESCRIPTION: "",
  InviteAdminForm: () => null,
}));

const { CreateAdminDialog, InviteAdminDialog } = await import("./admin-access-dialogs");

const OPEN = 0;
const PENDING = 1;

beforeEach(() => {
  seeded = [];
  cursor = 0;
  sets = [];
  dialog = null;
});

describe.each([
  ["Create", CreateAdminDialog],
  ["Invite", InviteAdminDialog],
])("the %s dialog", (_name, OneShotDialog) => {
  it("closes when no request is in flight", () => {
    seeded = [true, false];
    renderToStaticMarkup(<OneShotDialog mayReadEvents />);
    expect(dialog!.open).toBe(true);
    dialog!.onClose();
    expect(sets).toEqual([[OPEN, false]]);
  });

  it("ignores a close while its request is in flight", () => {
    seeded = [true, true];
    renderToStaticMarkup(<OneShotDialog mayReadEvents />);
    dialog!.onClose();
    expect(sets).toEqual([]);
  });

  it("learns from its form when the request goes out and when it settles", () => {
    seeded = [true, false];
    renderToStaticMarkup(<OneShotDialog mayReadEvents />);
    const report = dialog!.children.props.onPendingChange!;
    report(true);
    report(false);
    expect(sets).toEqual([
      [PENDING, true],
      [PENDING, false],
    ]);
  });
});
