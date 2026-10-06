import { describe, it, expect, beforeEach, vi } from "vitest";

/**
 * `requireCapabilities` — the page gate for a page whose reads sit on more than one capability
 * (#1900). It must refuse on ANY missing capability, and name the first one missing in the
 * redirect so the dashboard's denial notice says which.
 */
const stub = vi.hoisted(() => ({ capabilities: [] as string[] }));

class Redirect extends Error {
  constructor(public readonly to: string) {
    super(`redirect ${to}`);
  }
}

vi.mock("next/navigation", () => ({
  redirect: (to: string) => {
    throw new Redirect(to);
  },
}));

vi.mock("../admin-http", () => ({
  adminFetch: async () => ({ admin_id: "a-1", role: "analyst", capabilities: stub.capabilities }),
  isAdminUnauthorized: () => false,
}));

const { requireCapabilities, requireCapability } = await import("./session");

const redirectOf = async (p: Promise<unknown>) =>
  p.then(
    () => null,
    (e: unknown) => (e instanceof Redirect ? e.to : Promise.reject(e)),
  );

beforeEach(() => {
  stub.capabilities = [];
});

describe("requireCapabilities", () => {
  it("passes, returning the session, when every capability is held", async () => {
    stub.capabilities = ["read_events", "read_entities"];
    const s = await requireCapabilities(["read_events", "read_entities"]);
    expect(s.capabilities).toEqual(["read_events", "read_entities"]);
  });

  it("refuses when ANY is missing, naming the first missing one", async () => {
    stub.capabilities = ["read_events"];
    expect(await redirectOf(requireCapabilities(["read_events", "read_entities"]))).toBe(
      "/?denied=read_entities",
    );
    stub.capabilities = [];
    expect(await redirectOf(requireCapabilities(["read_events", "read_entities"]))).toBe(
      "/?denied=read_events",
    );
  });

  it("requireCapability is the one-capability case", async () => {
    stub.capabilities = ["read_entities"];
    expect(await redirectOf(requireCapability("read_events"))).toBe("/?denied=read_events");
    await expect(requireCapability("read_entities")).resolves.toBeTruthy();
  });
});
