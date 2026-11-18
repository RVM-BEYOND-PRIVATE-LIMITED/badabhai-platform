import { beforeEach, describe, expect, it, vi } from "vitest";
import { CREDIT_RULE_KEYS, DEFAULT_CREDIT_RULES } from "@badabhai/pricing";

/**
 * `PUT /admin/credit-rules` (#2878).
 *
 * The action sends the WHOLE rule set, the revision that was loaded and the written reason;
 * a 409 is the reload state, a 400 is mapped back onto the field that caused it, and nothing
 * invalid reaches the network.
 */
const adminFetch = vi.fn();

class FakeRequestError extends Error {
  status: number;
  body?: Record<string, unknown>;
  constructor(status: number, message = "boom", body?: Record<string, unknown>) {
    super(message);
    this.name = "AdminRequestError";
    this.status = status;
    this.body = body;
  }
}

vi.mock("../../../lib/admin-http", () => ({
  adminFetch: (...a: unknown[]) => adminFetch(...a),
  AdminRequestError: FakeRequestError,
  isAdminRequestError: (e: unknown) => e instanceof FakeRequestError,
  isAdminUnauthorized: (e: unknown) => e instanceof FakeRequestError && e.status === 401,
  isAdminForbidden: (e: unknown) => e instanceof FakeRequestError && e.status === 403,
}));

const { saveCreditRulesAction } = await import("./actions");
const { SERVICE_UNAVAILABLE } = await import("../../../lib/admin-action-messages");

const REASON = "Owner reviewed the brief's starting values before launch.";

const response = (over: Record<string, unknown> = {}) => ({
  rules: DEFAULT_CREDIT_RULES,
  defaults: DEFAULT_CREDIT_RULES,
  revision: 1,
  source: "db",
  updated_at: "2026-11-17T08:00:00.000Z",
  changed: true,
  changed_keys: ["higherCost"],
  ...over,
});

beforeEach(() => {
  adminFetch.mockReset();
});

describe("saveCreditRulesAction", () => {
  it("PUTs every rule, the expected revision and the reason", async () => {
    adminFetch.mockResolvedValueOnce(response());
    const result = await saveCreditRulesAction({
      rules: { ...DEFAULT_CREDIT_RULES, higherCost: 3 },
      expectedRevision: 0,
      reasonText: `  ${REASON}  `,
    });

    const [, opts] = adminFetch.mock.calls[0]! as [
      string,
      { method: string; body: { rules: Record<string, unknown>; expected_revision: number; reason_text: string } },
    ];
    expect(adminFetch.mock.calls[0]![0]).toBe("/admin/credit-rules");
    expect(opts.method).toBe("PUT");
    expect(opts.body.expected_revision).toBe(0);
    expect(opts.body.reason_text).toBe(REASON);
    expect(Object.keys(opts.body.rules)).toEqual([...CREDIT_RULE_KEYS]);
    expect(opts.body.rules.higherCost).toBe(3);

    expect(result).toMatchObject({
      ok: true,
      changed: true,
      changed_keys: ["higherCost"],
      revision: 1,
      source: "db",
      updated_at: "2026-11-17T08:00:00.000Z",
    });
  });

  it("a successful no-op is still success", async () => {
    adminFetch.mockResolvedValueOnce(response({ changed: false, changed_keys: [] }));
    const result = await saveCreditRulesAction({
      rules: DEFAULT_CREDIT_RULES,
      expectedRevision: 1,
      reasonText: REASON,
    });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.changed).toBe(false);
  });

  it("refuses a partial or out-of-bounds set before calling the API", async () => {
    const { welcomeCredits: _dropped, ...partial } = DEFAULT_CREDIT_RULES;
    const missing = await saveCreditRulesAction({
      rules: partial,
      expectedRevision: 0,
      reasonText: REASON,
    });
    expect(missing.ok).toBe(false);
    if (!missing.ok) expect(missing.kind).toBe("validation");

    const outOfBounds = await saveCreditRulesAction({
      rules: { ...DEFAULT_CREDIT_RULES, welcomeCredits: 101 },
      expectedRevision: 0,
      reasonText: REASON,
    });
    expect(outOfBounds.ok).toBe(false);
    if (!outOfBounds.ok) {
      expect(outOfBounds.fieldErrors?.welcomeCredits).toBe(
        "Enter a whole number from 0 to 100.",
      );
    }
    expect(adminFetch).not.toHaveBeenCalled();
  });

  it("refuses a short reason and a bad revision before calling the API", async () => {
    const short = await saveCreditRulesAction({
      rules: DEFAULT_CREDIT_RULES,
      expectedRevision: 0,
      reasonText: "short",
    });
    expect(short.ok).toBe(false);
    if (!short.ok) expect(short.fieldErrors?.reason).toBeTruthy();

    const revision = await saveCreditRulesAction({
      rules: DEFAULT_CREDIT_RULES,
      expectedRevision: -1,
      reasonText: REASON,
    });
    expect(revision.ok).toBe(false);
    expect(adminFetch).not.toHaveBeenCalled();
  });

  it("turns a 409 into the reload state", async () => {
    adminFetch.mockRejectedValueOnce(
      new FakeRequestError(409, "The credit rules were changed since you loaded them"),
    );
    const result = await saveCreditRulesAction({
      rules: DEFAULT_CREDIT_RULES,
      expectedRevision: 0,
      reasonText: REASON,
    });
    expect(result).toEqual({
      ok: false,
      kind: "stale",
      error: expect.stringContaining("Someone saved the credit rules"),
    });
  });

  it("maps a 400's issues onto the fields that caused them", async () => {
    adminFetch.mockRejectedValueOnce(
      new FakeRequestError(400, "Validation failed", {
        issues: [
          {
            path: "rules.higherCost",
            message: "higherCost must be at least standardCost",
          },
          { path: "reason_text", message: "Reason must be at least 15 characters" },
        ],
      }),
    );
    const result = await saveCreditRulesAction({
      rules: DEFAULT_CREDIT_RULES,
      expectedRevision: 0,
      reasonText: REASON,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.kind).toBe("validation");
      expect(result.fieldErrors?.higherCost).toBe(
        "The higher cost must be at least the standard cost.",
      );
      expect(result.fieldErrors?.reason).toBe("Use at least 15 characters.");
    }
  });

  it("collapses every other refusal to the catalogue's safe copy", async () => {
    adminFetch.mockRejectedValueOnce(new FakeRequestError(500, "internal detail"));
    const result = await saveCreditRulesAction({
      rules: DEFAULT_CREDIT_RULES,
      expectedRevision: 0,
      reasonText: REASON,
    });
    expect(result).toEqual({ ok: false, kind: "error", error: SERVICE_UNAVAILABLE });
  });
});
