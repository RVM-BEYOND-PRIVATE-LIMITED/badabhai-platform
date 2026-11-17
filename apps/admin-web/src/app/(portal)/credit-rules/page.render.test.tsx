import { beforeEach, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { DEFAULT_CREDIT_RULES } from "@badabhai/pricing";

/**
 * /credit-rules (#2878): the super-admin gate, the switch-off 404 state, the pre-migration
 * 503 retry, and the editor rendered from the server's fresh read.
 */
const stub = vi.hoisted(() => ({
  gate: vi.fn(),
  snapshot: null as unknown,
  failure: null as unknown,
}));

vi.mock("../../../lib/auth", () => ({
  requireCapability: async (capability: string) => {
    stub.gate(capability);
    return { adminId: "a-1", role: "super_admin", capabilities: [capability] };
  },
}));
vi.mock("../../../lib/credit-rules", () => ({
  getCreditRules: async () => {
    if (stub.failure) throw stub.failure;
    return stub.snapshot;
  },
}));
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: vi.fn() }) }));
vi.mock("./actions", () => ({ saveCreditRulesAction: vi.fn() }));

const { default: CreditRulesPage, metadata } = await import("./page");
const { AdminRequestError } = await import("../../../lib/admin-http");

const snapshot = (over: Record<string, unknown> = {}) => ({
  rules: DEFAULT_CREDIT_RULES,
  defaults: DEFAULT_CREDIT_RULES,
  revision: 3,
  source: "db" as const,
  updated_at: "2026-11-17T08:00:00.000Z",
  ...over,
});

const render = async () => renderToStaticMarkup(await CreditRulesPage());

beforeEach(() => {
  stub.gate.mockReset();
  stub.snapshot = snapshot();
  stub.failure = null;
});

describe("the gate and the title", () => {
  it("requires manage_credit_rules and names the tab", async () => {
    await render();
    expect(stub.gate).toHaveBeenCalledWith("manage_credit_rules");
    expect(metadata.title).toBe("Credit rules");
  });
});

describe("when the switch is off", () => {
  it("404 is 'not switched on yet', not an error", async () => {
    stub.failure = new AdminRequestError(404, "Not Found");
    const html = await render();
    expect(html).toContain("Credit rules are not switched on yet");
    expect(html).not.toContain("Save credit rules");
  });

  it("503 offers a retry", async () => {
    stub.failure = new AdminRequestError(503, "The credit rules are not available yet");
    const html = await render();
    expect(html).toContain("Credit rules are not available yet");
    expect(html).toContain('href="/credit-rules"');
    expect(html).toContain("Retry");
  });
});

describe("the editor", () => {
  it("renders every rule, its bounds and the brief's default", async () => {
    const html = await render();
    expect(html).toContain("Standard contact cost");
    expect(html).toContain("Goodwill credit validity (days)");
    expect(html).toContain("default 2");
    expect((html.match(/type="number"/g) ?? []).length).toBe(17);
  });

  it("shows the fresh revision, when it was last changed and its source", async () => {
    const html = await render();
    expect(html).toContain("Revision");
    expect(html).toContain(">3<");
    expect(html).toContain("Saved values");
    expect(html).toContain("2026");
  });

  it("marks a field whose value differs from the brief's default", async () => {
    stub.snapshot = snapshot({
      rules: { ...DEFAULT_CREDIT_RULES, higherCost: 3 },
    });
    const html = await render();
    expect(html).toContain("Changed");
  });

  it("requires a written reason before saving", async () => {
    const html = await render();
    expect(html).toContain("Reason for this change (required)");
  });
});
