import { beforeEach, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

/**
 * /app-versions (#3058): the manage_app_release_policy gate, one card per app and platform in a
 * fixed order with readable names, the three fields and their helpers, who changed each row and
 * when (or "Never changed"), and the honest 503 and failure states with Retry.
 */
const stub = vi.hoisted(() => ({
  gate: vi.fn(),
  rows: [] as Record<string, unknown>[],
  failure: null as unknown,
}));

vi.mock("../../../lib/auth", () => ({
  requireCapability: async (capability: string) => {
    stub.gate(capability);
    return {
      adminId: "a1b2c3d4-0000-4000-8000-000000000001",
      role: "super_admin",
      capabilities: [capability],
    };
  },
}));
vi.mock("../../../lib/app-release-policy", () => ({
  getAppReleasePolicies: async () => {
    if (stub.failure) throw stub.failure;
    return stub.rows;
  },
}));
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: vi.fn() }) }));
vi.mock("./actions", () => ({ saveAppReleasePolicyAction: vi.fn() }));

const { default: AppVersionsPage, metadata } = await import("./page");
const { AdminRequestError } = await import("../../../lib/admin-http");

const row = (over: Record<string, unknown> = {}) => ({
  app: "worker",
  platform: "android",
  min_supported_build: 0,
  latest_build: 0,
  store_url: null,
  message_key: "update_default",
  updated_by: null,
  updated_at: "2026-11-25T04:00:00.000Z",
  ...over,
});

const render = async () => renderToStaticMarkup(await AppVersionsPage());
const titles = (html: string) =>
  [...html.matchAll(/<h2 class="panel__title"[^>]*>([^<]*)<\/h2>/g)].map((m) => m[1]);

beforeEach(() => {
  stub.gate.mockReset();
  stub.failure = null;
  // Deliberately out of order: the page puts them in its own.
  stub.rows = [
    row({ app: "payer", platform: "ios" }),
    row({ app: "payer", platform: "android" }),
    row({
      app: "worker",
      platform: "ios",
      min_supported_build: 31,
      latest_build: 33,
      store_url: "https://apps.apple.com/app/id1",
      updated_by: "be16a0c2-1111-4111-8111-00000000a3f2",
      updated_at: "2026-11-24T09:30:00.000Z",
    }),
    row(),
  ];
});

describe("the gate and the title", () => {
  it("requires manage_app_release_policy and names the tab", async () => {
    await render();
    expect(stub.gate).toHaveBeenCalledWith("manage_app_release_policy");
    expect(stub.gate).toHaveBeenCalledTimes(1);
    expect(metadata.title).toBe("App versions");
  });
});

describe("the four cards", () => {
  it("one per app and platform, worker before company, Android before iOS — no raw slugs", async () => {
    const html = await render();
    expect(titles(html)).toEqual([
      "Worker app Android",
      "Worker app iOS",
      "Company app Android",
      "Company app iOS",
    ]);
    expect(html).not.toMatch(/>[^<]*\b(payer|worker\/|android|ios)\b[^<]*</);
  });

  it("each has the minimum, the latest and the store link, with the issue's helpers", async () => {
    const html = await render();
    expect((html.match(/>Minimum build</g) ?? []).length).toBe(4);
    expect((html.match(/>Latest build</g) ?? []).length).toBe(4);
    expect((html.match(/>Store link \(optional\)</g) ?? []).length).toBe(4);
    expect(html).toContain("Builds below this are blocked from writing.");
    expect(html).toContain("new version available");
    expect((html.match(/type="number"/g) ?? []).length).toBe(8);
    expect((html.match(/type="url"/g) ?? []).length).toBe(4);
  });

  it("shows the saved values", async () => {
    const html = await render();
    expect(html).toContain('id="app-version-worker-ios-min_supported_build"');
    expect(html).toMatch(/id="app-version-worker-ios-min_supported_build"[^>]*value="31"/);
    expect(html).toMatch(/id="app-version-worker-ios-latest_build"[^>]*value="33"/);
    expect(html).toMatch(
      /id="app-version-worker-ios-store_url"[^>]*value="https:\/\/apps.apple.com\/app\/id1"/,
    );
  });

  it("a seeded row says Never changed; a set row names its admin (shortened, copyable) and IST time", async () => {
    const html = await render();
    expect((html.match(/Never changed/g) ?? []).length).toBe(3);
    expect(html).toContain("Last changed by");
    expect(html).toContain("be16…a3f2");
    expect(html).toContain('title="be16a0c2-1111-4111-8111-00000000a3f2"');
    expect(html).toContain("Copy admin id");
    expect(html).toContain("24 Nov 2026, 15:00 IST");
  });

  it("says you when the signed-in admin made the last change", async () => {
    stub.rows = [row({ updated_by: "a1b2c3d4-0000-4000-8000-000000000001" })];
    const html = await render();
    expect(html).toContain("Last changed by you");
    expect(html).not.toContain("Copy admin id");
  });

  it("saves each card on its own, and opens no confirm until asked", async () => {
    const html = await render();
    expect((html.match(/<form /g) ?? []).length).toBe(4);
    expect(html).toContain('<span class="sr-only"> Company app iOS</span>');
    expect(html).not.toContain("will be stopped until it updates");
  });
});

describe("when the read fails", () => {
  it("503 says the database step is pending, with Retry", async () => {
    stub.failure = new AdminRequestError(503, "Service Unavailable");
    const html = await render();
    expect(html).toContain("Not available yet: the database step is pending.");
    expect(html).toContain('href="/app-versions"');
    expect(html).toContain("Retry");
    expect(html).not.toContain("Minimum build");
  });

  it("any other failure is an honest error state with Retry, not empty cards", async () => {
    stub.failure = new AdminRequestError(500, "boom");
    const html = await render();
    expect(html).toContain("App versions are unavailable");
    expect(html).toContain('href="/app-versions"');
    expect(html).not.toContain("boom");
    expect(html).not.toContain("Minimum build");
  });

  it("a session error is left to the portal's own handling", async () => {
    stub.failure = new Error("admin session expired or missing");
    await expect(render()).rejects.toThrow("admin session expired or missing");
  });
});
