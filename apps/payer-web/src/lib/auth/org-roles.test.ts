import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { PayerSession } from "./types";

/**
 * ORG-RBAC gate tests (Owner vs Recruiter) — the SECOND role dimension, mirroring roles.test.ts:
 *  (a) getOrgRole FAILS CLOSED to `recruiter` with no claim; the dev-only Owner override is
 *      honored ONLY under isDevEnv() (ignored in production);
 *  (b) requireOwner 404s a Recruiter NEUTRALLY (server gate, no "forbidden" oracle);
 *  (d) the GATE is the authorization (it decides off the SERVER getOrgRole, not a client flag);
 *  (f) the seam carries the wire-to-Divyanshu STUB TODO.
 *
 * isDevEnv (from @badabhai/config/shared) reads RAW NODE_ENV; vitest defaults it to "test" (dev),
 * so the preview override is honored unless we stub NODE_ENV="production". notFound() throws.
 */

const NOT_FOUND = new Error("NEXT_NOT_FOUND");
const notFound = vi.fn(() => {
  throw NOT_FOUND;
});
const requirePayer = vi.fn<() => Promise<PayerSession>>();

vi.mock("next/navigation", () => ({ notFound: () => notFound() }));
vi.mock("./index", () => ({ requirePayer: () => requirePayer() }));

const { getOrgRole, requireOwner, requireRecruiter } = await import("./org-roles");

const session: PayerSession = {
  payerId: "11111111-1111-4111-8111-111111111111",
  displayLabel: "Acme Tools (mock)",
  role: "employer",
  status: "active",
};

beforeEach(() => {
  notFound.mockClear();
  requirePayer.mockReset().mockResolvedValue(session);
});
afterEach(() => {
  vi.unstubAllEnvs();
});

describe("(a) getOrgRole — fail-closed default + dev-only preview override", () => {
  it("defaults to recruiter (least privilege) with no claim + no override", () => {
    // vitest runs NODE_ENV=test (isDevEnv true) but no PAYER_DEV_ORG_ROLE ⇒ still recruiter.
    expect(getOrgRole(session)).toBe("recruiter");
  });

  it("honors the dev-only override to 'owner' under isDevEnv (preview the Owner UI)", () => {
    vi.stubEnv("PAYER_DEV_ORG_ROLE", "owner");
    expect(getOrgRole(session)).toBe("owner");
  });

  it("honors an explicit 'recruiter' override too", () => {
    vi.stubEnv("PAYER_DEV_ORG_ROLE", "recruiter");
    expect(getOrgRole(session)).toBe("recruiter");
  });

  it("IGNORES the override outside dev/test (a stray prod env var cannot unlock Owner)", () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("PAYER_DEV_ORG_ROLE", "owner");
    expect(getOrgRole(session)).toBe("recruiter");
  });

  it("IGNORES a garbage override value (only owner|recruiter are recognized)", () => {
    vi.stubEnv("PAYER_DEV_ORG_ROLE", "superadmin");
    expect(getOrgRole(session)).toBe("recruiter");
  });
});

describe("(b)/(d) requireOwner — server gate (Owner-only: billing/wallet + user management)", () => {
  it("admits an Owner session (dev override) and does not 404", async () => {
    vi.stubEnv("PAYER_DEV_ORG_ROLE", "owner");
    await expect(requireOwner()).resolves.toEqual(session);
    expect(notFound).not.toHaveBeenCalled();
  });

  it("404s a Recruiter session NEUTRALLY — the GATE is the authz, not the nav (no oracle)", async () => {
    // No override ⇒ recruiter. Even if the nav had shown the link, the gate decides here.
    await expect(requireOwner()).rejects.toBe(NOT_FOUND);
    expect(notFound).toHaveBeenCalledOnce();
  });
});

describe("(c)/(d) requireRecruiter — member area: Owner ⊇ Recruiter (admits both)", () => {
  it("admits a Recruiter session", async () => {
    await expect(requireRecruiter()).resolves.toEqual(session);
    expect(notFound).not.toHaveBeenCalled();
  });

  it("admits an Owner session too (an Owner sees everything a Recruiter sees)", async () => {
    vi.stubEnv("PAYER_DEV_ORG_ROLE", "owner");
    await expect(requireRecruiter()).resolves.toEqual(session);
    expect(notFound).not.toHaveBeenCalled();
  });
});

describe("(f) org-role seam carries the wire-to-Divyanshu STUB TODO (source)", () => {
  const src = readFileSync(fileURLToPath(new URL("./org-roles.ts", import.meta.url)), "utf8");

  it("getOrgRole is flagged STUB + names the org API owner + the XB-A session-claim wiring", () => {
    expect(src).toMatch(/STUB/);
    expect(src).toMatch(/Divyanshu/);
    expect(src).toMatch(/XB-A/);
    expect(src).toMatch(/org-role not yet in the signed session/i);
  });
});
