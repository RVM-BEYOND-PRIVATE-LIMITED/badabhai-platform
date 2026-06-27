import { describe, expect, it, vi, beforeEach } from "vitest";
import type { PayerSession } from "./types";

/**
 * Role-authz gate tests (XB-A / XT3 — an employer can NEVER reach an agent-only
 * section, and vice-versa, decided SERVER-SIDE off the signed session).
 *
 * `next/navigation`'s `notFound()` throws a sentinel in the App Router; we mock it
 * to a throwing spy so we can assert the gate 404s on a role mismatch (a neutral
 * not-found, never a "forbidden" oracle) and PASSES on a role match.
 */

const NOT_FOUND = new Error("NEXT_NOT_FOUND");
const notFound = vi.fn(() => {
  throw NOT_FOUND;
});
const requirePayer = vi.fn<() => Promise<PayerSession>>();

vi.mock("next/navigation", () => ({ notFound: () => notFound() }));
vi.mock("./index", () => ({ requirePayer: () => requirePayer() }));

// Imported AFTER the mocks are registered.
const { requireAgent, requireEmployer } = await import("./roles");

const employer: PayerSession = {
  payerId: "11111111-1111-4111-8111-111111111111",
  displayLabel: "Acme Tools (mock)",
  role: "employer",
  status: "active",
};
const agent: PayerSession = {
  payerId: "22222222-2222-4222-8222-222222222222",
  displayLabel: "HireFast Agency (mock)",
  role: "agent",
  status: "active",
};

beforeEach(() => {
  notFound.mockClear();
  requirePayer.mockReset();
});

describe("requireAgent (agency-only section)", () => {
  it("admits an agent session", async () => {
    requirePayer.mockResolvedValue(agent);
    await expect(requireAgent()).resolves.toEqual(agent);
    expect(notFound).not.toHaveBeenCalled();
  });

  it("404s an employer session (no cross-role access, neutral not-found)", async () => {
    requirePayer.mockResolvedValue(employer);
    await expect(requireAgent()).rejects.toBe(NOT_FOUND);
    expect(notFound).toHaveBeenCalledOnce();
  });
});

describe("requireEmployer (company-only section)", () => {
  it("admits an employer session", async () => {
    requirePayer.mockResolvedValue(employer);
    await expect(requireEmployer()).resolves.toEqual(employer);
    expect(notFound).not.toHaveBeenCalled();
  });

  it("404s an agent session (no cross-role access, neutral not-found)", async () => {
    requirePayer.mockResolvedValue(agent);
    await expect(requireEmployer()).rejects.toBe(NOT_FOUND);
    expect(notFound).toHaveBeenCalledOnce();
  });
});
