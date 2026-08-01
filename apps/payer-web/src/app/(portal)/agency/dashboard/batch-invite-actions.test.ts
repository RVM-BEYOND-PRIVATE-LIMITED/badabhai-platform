import { describe, expect, it, vi, beforeEach } from "vitest";

/**
 * createInviteBatchAction tests (ADR-0022 batch minting). Covers the security-critical
 * behaviour:
 *  - VERTICAL authz: requireAgent() runs FIRST (an employer's notFound() short-circuits;
 *    the seam is never called);
 *  - CARDINALITY: the count is bounded [1,50] and must be a finite integer — 0, 51, 1.5,
 *    NaN, Infinity and a string-coerced value are all rejected WITHOUT calling the seam;
 *  - SHAPE: the body forwarded to the seam is exactly { count, campaign? } — no array, no
 *    per-invite element (an array-shaped input is what would turn this into bulk upload);
 *  - FACELESS: a campaign tag that looks like a phone/email is rejected at the boundary;
 *  - NEUTRAL failure: the seam's `{ ok: false }` (mint cap OR Redis fail-closed — the same
 *    backend 429, no leaked reason) AND any thrown error both map to ONE neutral error,
 *    never a fake success and never a partial claim;
 *  - a PARTIAL batch is reported honestly (exactly the links that came back).
 */

const requireAgent = vi.fn();
const createAgencyInviteBatch = vi.fn();

vi.mock("../../../../lib/auth/roles", () => ({ requireAgent: () => requireAgent() }));
vi.mock("../../../../lib/payer-api", () => ({
  createAgencyInviteBatch: (input: { count: number; campaign?: string }) =>
    createAgencyInviteBatch(input),
}));

const { createInviteBatchAction } = await import("./batch-invite-actions");

/** N opaque code/link pairs, shaped like the seam's success payload. */
function mintedBatch(n: number) {
  return {
    ok: true as const,
    invites: Array.from({ length: n }, (_, i) => ({
      code: `code${i}`.padEnd(12, "0"),
      link: `/i/${`code${i}`.padEnd(12, "0")}`,
    })),
  };
}

beforeEach(() => {
  requireAgent.mockReset().mockResolvedValue({ payerId: "p", role: "agent", displayLabel: "A" });
  createAgencyInviteBatch.mockReset();
});

describe("createInviteBatchAction — vertical authz", () => {
  // Parity with the single mint (2026-07-31): the batch screen shares
  // `looksLikeActionContextPii` with the backend DTO, so a NAME-shaped tag is rejected before
  // any mint. A batch multiplies this field's reach by up to 50 rows and 50 events.
  it("rejects a campaign tag that is a person's NAME, without minting", async () => {
    const res = await createInviteBatchAction({ count: 5, campaign: "Ramesh Kumar" });
    expect(res.ok).toBe(false);
  });

  it("calls requireAgent FIRST and does NOT mint when the role gate throws (employer)", async () => {
    requireAgent.mockRejectedValueOnce(new Error("NEXT_NOT_FOUND"));
    await expect(createInviteBatchAction({ count: 5 })).rejects.toThrow("NEXT_NOT_FOUND");
    expect(createAgencyInviteBatch).not.toHaveBeenCalled();
  });
});

describe("createInviteBatchAction — the count is a bounded cardinality", () => {
  const rejected: Array<[string, number]> = [
    ["zero", 0],
    ["over the 50 cap", 51],
    ["absurdly large", 1_000_000],
    ["negative", -1],
    ["fractional", 1.5],
    ["NaN", Number.NaN],
    ["Infinity", Number.POSITIVE_INFINITY],
  ];

  for (const [label, count] of rejected) {
    it(`rejects a ${label} count without minting`, async () => {
      const res = await createInviteBatchAction({ count });
      expect(res.ok).toBe(false);
      if (!res.ok) expect(res.error).toMatch(/whole number/i);
      expect(createAgencyInviteBatch).not.toHaveBeenCalled();
    });
  }

  it("rejects a string-coerced count without minting", async () => {
    const res = await createInviteBatchAction({ count: "50" as unknown as number });
    expect(res.ok).toBe(false);
    expect(createAgencyInviteBatch).not.toHaveBeenCalled();
  });

  it("accepts the bounds 1 and 50", async () => {
    createAgencyInviteBatch.mockResolvedValueOnce(mintedBatch(1));
    expect((await createInviteBatchAction({ count: 1 })).ok).toBe(true);
    createAgencyInviteBatch.mockResolvedValueOnce(mintedBatch(50));
    expect((await createInviteBatchAction({ count: 50 })).ok).toBe(true);
  });
});

describe("createInviteBatchAction — the forwarded body is cardinality-shaped", () => {
  it("sends EXACTLY { count, campaign } — no array-typed value anywhere", async () => {
    createAgencyInviteBatch.mockResolvedValueOnce(mintedBatch(3));
    await createInviteBatchAction({ count: 3, campaign: "diwali-drive" });
    const body = createAgencyInviteBatch.mock.calls[0]![0] as Record<string, unknown>;
    expect(Object.keys(body).sort()).toEqual(["campaign", "count"]);
    for (const value of Object.values(body)) expect(Array.isArray(value)).toBe(false);
    expect(body).toEqual({ count: 3, campaign: "diwali-drive" });
  });

  it("drops an unknown per-invite key rather than forwarding it (no list ever reaches the seam)", async () => {
    createAgencyInviteBatch.mockResolvedValueOnce(mintedBatch(2));
    await createInviteBatchAction({
      count: 2,
      // A hostile/extra caller field: the action reads only `count` + `campaign`.
      labels: ["ramesh", "sunita"],
    } as unknown as { count: number });
    const body = createAgencyInviteBatch.mock.calls[0]![0] as Record<string, unknown>;
    expect(body).not.toHaveProperty("labels");
    expect(Object.keys(body).sort()).toEqual(["campaign", "count"]);
  });
});

describe("createInviteBatchAction — faceless campaign screen", () => {
  it("rejects a campaign tag containing a phone, without minting", async () => {
    const res = await createInviteBatchAction({ count: 5, campaign: "call +91 98123 45678" });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toMatch(/non-PII/i);
    expect(createAgencyInviteBatch).not.toHaveBeenCalled();
  });

  it("rejects a campaign tag containing an email, without minting", async () => {
    const res = await createInviteBatchAction({ count: 5, campaign: "ping ramesh@example.com" });
    expect(res.ok).toBe(false);
    expect(createAgencyInviteBatch).not.toHaveBeenCalled();
  });

  it("accepts a clean non-PII tag", async () => {
    createAgencyInviteBatch.mockResolvedValueOnce(mintedBatch(4));
    const res = await createInviteBatchAction({ count: 4, campaign: "pune-gate-2" });
    expect(res.ok).toBe(true);
    expect(createAgencyInviteBatch).toHaveBeenCalledWith({ count: 4, campaign: "pune-gate-2" });
  });
});

describe("createInviteBatchAction — neutral failure (no fake success, no leaked reason)", () => {
  it("maps the seam's { ok:false } (cap OR fail-closed) to ONE neutral error", async () => {
    createAgencyInviteBatch.mockResolvedValueOnce({ ok: false });
    const res = await createInviteBatchAction({ count: 10, campaign: "diwali-drive" });
    expect(res).toEqual({
      ok: false,
      error: expect.stringContaining("Could not create invite links"),
    });
  });

  it("maps a thrown seam error to the SAME neutral error", async () => {
    createAgencyInviteBatch.mockRejectedValueOnce(new Error("boom"));
    const res = await createInviteBatchAction({ count: 10 });
    expect(res).toEqual({
      ok: false,
      error: expect.stringContaining("Could not create invite links"),
    });
  });

  it("treats an EMPTY invite list as a failure, never a fake success", async () => {
    createAgencyInviteBatch.mockResolvedValueOnce({ ok: true, invites: [] });
    const res = await createInviteBatchAction({ count: 10 });
    expect(res.ok).toBe(false);
  });

  it("never leaks the underlying error text", async () => {
    createAgencyInviteBatch.mockRejectedValueOnce(new Error("duplicate key agency_invites_code_uq"));
    const res = await createInviteBatchAction({ count: 10 });
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.error).not.toMatch(/duplicate key/i);
      expect(res.error).not.toMatch(/agency_invites/i);
    }
  });
});

describe("createInviteBatchAction — happy path returns opaque codes only", () => {
  it("returns exactly the code/link pairs from the seam (no PII anywhere)", async () => {
    createAgencyInviteBatch.mockResolvedValueOnce({
      ok: true,
      invites: [
        { code: "abc123def456", link: "/i/abc123def456" },
        { code: "0123456789ab", link: "/i/0123456789ab" },
      ],
    });
    const res = await createInviteBatchAction({ count: 2 });
    expect(res).toEqual({
      ok: true,
      invites: [
        { code: "abc123def456", link: "/i/abc123def456" },
        { code: "0123456789ab", link: "/i/0123456789ab" },
      ],
    });
  });

  it("reports a PARTIAL batch honestly — the links that came back, not the count asked for", async () => {
    createAgencyInviteBatch.mockResolvedValueOnce(mintedBatch(26));
    const res = await createInviteBatchAction({ count: 50 });
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.invites).toHaveLength(26);
  });
});
