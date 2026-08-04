import { describe, it, expect } from "vitest";
import {
  ADMIN_CAPABILITIES,
  CAPABILITY_LABELS,
  ROLE_LABELS,
  ADMIN_ROLES,
  can,
  canAll,
  canAny,
  isAdminCapability,
  isAdminRole,
  type AdminCapability,
} from "./capabilities";

/**
 * The portal's capability layer.
 *
 * The property that matters is FAIL-CLOSED: every malformed, missing or unknown input
 * must grant nothing. A permissive default here would render privileged controls to an
 * operator the server will refuse — which is a broken screen at best, and at worst
 * teaches an analyst that a suspend button exists for them.
 */

describe("can() — fails closed on every non-list input", () => {
  it("grants nothing for null / undefined", () => {
    for (const cap of ADMIN_CAPABILITIES) {
      expect(can(null, cap)).toBe(false);
      expect(can(undefined, cap)).toBe(false);
    }
  });

  it("grants nothing for an empty list", () => {
    for (const cap of ADMIN_CAPABILITIES) {
      expect(can([], cap)).toBe(false);
    }
  });

  it("grants nothing when handed a non-array (a malformed /admin/me)", () => {
    const junk = ["nope", 7, {}, true] as unknown as AdminCapability[];
    // Deliberately bypassing the type system: this models a server response that parsed
    // into the wrong shape, which is exactly when a UI must not start guessing.
    expect(can(junk as never, "manage_admins")).toBe(false);
  });

  it("grants ONLY what is present", () => {
    const granted: AdminCapability[] = ["read_events", "export"];
    expect(can(granted, "read_events")).toBe(true);
    expect(can(granted, "export")).toBe(true);
    expect(can(granted, "manage_admins")).toBe(false);
    expect(can(granted, "reveal_pii")).toBe(false);
  });
});

describe("canAll / canAny", () => {
  const granted: AdminCapability[] = ["read_events", "export"];

  it("canAll requires every one", () => {
    expect(canAll(granted, ["read_events", "export"])).toBe(true);
    expect(canAll(granted, ["read_events", "manage_admins"])).toBe(false);
  });

  it("canAny requires at least one", () => {
    expect(canAny(granted, ["manage_admins", "export"])).toBe(true);
    expect(canAny(granted, ["manage_admins", "reveal_pii"])).toBe(false);
  });

  it("the empty-list edge cases go the SAFE way in each direction", () => {
    // Nothing was asked for, so nothing is missing.
    expect(canAll(granted, [])).toBe(true);
    // Nothing was asked for, so nothing can satisfy it — never a blanket yes.
    expect(canAny(granted, [])).toBe(false);
    // And a null grant list still refuses even the empty "any".
    expect(canAny(null, [])).toBe(false);
  });
});

describe("narrowing — unknown strings are dropped, never trusted", () => {
  it("isAdminCapability accepts only the known vocabulary", () => {
    expect(isAdminCapability("manage_admins")).toBe(true);
    expect(isAdminCapability("delete_everything")).toBe(false);
    expect(isAdminCapability("")).toBe(false);
    expect(isAdminCapability(undefined)).toBe(false);
    expect(isAdminCapability(123)).toBe(false);
  });

  it("isAdminRole accepts only the four roles", () => {
    expect(isAdminRole("super_admin")).toBe(true);
    expect(isAdminRole("root")).toBe(false);
    expect(isAdminRole(null)).toBe(false);
  });

  it("a future server capability this build has never heard of is filtered out", () => {
    const fromServer = ["read_events", "quantum_override"];
    expect(fromServer.filter(isAdminCapability)).toEqual(["read_events"]);
  });
});

describe("labels stay in lockstep with the vocabulary", () => {
  it("every capability has a label (a missing one renders `undefined` in the UI)", () => {
    for (const cap of ADMIN_CAPABILITIES) {
      expect(CAPABILITY_LABELS[cap]).toBeTruthy();
    }
    expect(Object.keys(CAPABILITY_LABELS).sort()).toEqual([...ADMIN_CAPABILITIES].sort());
  });

  it("every role has a label", () => {
    for (const role of ADMIN_ROLES) {
      expect(ROLE_LABELS[role]).toBeTruthy();
    }
    expect(Object.keys(ROLE_LABELS).sort()).toEqual([...ADMIN_ROLES].sort());
  });

  it("the vocabulary matches the server's ten capabilities", () => {
    // Pinned as a literal: if the API adds one, this fails and someone has to decide how
    // the portal should present it, rather than silently ignoring it. It did exactly that
    // when BP-1 implemented `read_entities`.
    expect([...ADMIN_CAPABILITIES].sort()).toEqual(
      [
        "export",
        "flag_worker",
        "force_close_posting",
        "grant_credits",
        "manage_admins",
        "read_entities",
        "read_events",
        "reveal_pii",
        "suspend_payer",
        "toggle_kill_switch",
      ].sort(),
    );
  });
});
