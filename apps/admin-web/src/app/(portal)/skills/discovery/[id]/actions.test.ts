import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * The Skill Discovery detail screen's Server Actions (#1260's `submitSkillDecisionAction`, and
 * #1280's `searchCanonicalSkillsAction`). Mocking shape mirrors `jobs/[id]/actions.test.ts`:
 * `adminFetch` is replaced with a spy, so what matters here is which request each action
 * actually builds and how it maps a response/error onto the outcome type the client renders.
 */

const adminFetch = vi.fn();

class FakeRequestError extends Error {
  status: number;
  body?: Record<string, unknown>;
  constructor(status: number, message: string, body?: Record<string, unknown>) {
    super(message);
    this.name = "AdminRequestError";
    this.status = status;
    this.body = body;
  }
}

vi.mock("../../../../../lib/admin-http", () => ({
  adminFetch: (...a: unknown[]) => adminFetch(...a),
  isAdminRequestError: (e: unknown) => e instanceof FakeRequestError,
  isAdminUnauthorized: () => false,
  isAdminForbidden: () => false,
}));

const { submitSkillDecisionAction, searchCanonicalSkillsAction } = await import("./actions");

beforeEach(() => {
  adminFetch.mockReset();
});

const REJECT_REQUEST = {
  decision: "reject" as const,
  expected_status: "pending" as const,
  review_reason: "not a real skill, leftover job-title prose describing a role, not work",
};

describe("submitSkillDecisionAction (#1260)", () => {
  it("client-errors before any network call when the reason is too short", async () => {
    const res = await submitSkillDecisionAction("c-1", { ...REJECT_REQUEST, review_reason: "short" });
    expect(res.kind).toBe("error");
    expect(adminFetch).not.toHaveBeenCalled();
  });

  it("POSTs to the decision route and reports success", async () => {
    adminFetch.mockResolvedValueOnce({
      target_id: "c-1",
      changed: true,
      status: "rejected",
      already_decided: false,
      corpus_effect: "decision_recorded_no_corpus_write",
      next_step: "awaiting_offline_corpus_chain",
    });
    const res = await submitSkillDecisionAction("c-1", REJECT_REQUEST);
    expect(adminFetch).toHaveBeenCalledWith(
      "/admin/skill-discovery/c-1/decision",
      expect.objectContaining({ method: "POST" }),
    );
    expect(res).toEqual({ kind: "success", changed: true, status: "rejected", already_decided: false });
  });

  it("a 409 with a real conflict body renders as a conflict, not a generic error", async () => {
    adminFetch.mockRejectedValueOnce(
      new FakeRequestError(409, "stale", {
        candidate_id: "c-1",
        conflict: "stale_expected_status",
        current_status: "approved_create",
        expected_status: "pending",
      }),
    );
    const res = await submitSkillDecisionAction("c-1", REJECT_REQUEST);
    expect(res).toEqual({
      kind: "conflict",
      info: {
        conflict: "stale_expected_status",
        current_status: "approved_create",
        expected_status: "pending",
      },
    });
  });

  it("a 409 whose body does not parse as a conflict falls back to a generic error, not a thrown exception", async () => {
    adminFetch.mockRejectedValueOnce(new FakeRequestError(409, "weird shape"));
    const res = await submitSkillDecisionAction("c-1", REJECT_REQUEST);
    expect(res.kind).toBe("error");
  });

  it("a 5xx collapses to the generic message, never the raw server text", async () => {
    adminFetch.mockRejectedValueOnce(new FakeRequestError(500, "stack trace leaked"));
    const res = await submitSkillDecisionAction("c-1", REJECT_REQUEST);
    expect(res.kind).toBe("error");
    if (res.kind === "error") expect(res.message).not.toContain("stack trace");
  });
});

describe("searchCanonicalSkillsAction (#1280)", () => {
  it("does not call the network for a query shorter than the server's floor", async () => {
    const res = await searchCanonicalSkillsAction("a");
    expect(adminFetch).not.toHaveBeenCalled();
    expect(res).toEqual({ kind: "success", skills: [], q: "a", truncated: false });
  });

  it("trims before checking the floor, and before dispatching", async () => {
    const res = await searchCanonicalSkillsAction("  a  ");
    expect(adminFetch).not.toHaveBeenCalled();
    expect(res).toEqual({ kind: "success", skills: [], q: "a", truncated: false });
  });

  it("hits GET /admin/skills?q= and echoes the trimmed query and truncated flag", async () => {
    adminFetch.mockResolvedValueOnce({
      skills: [
        {
          skill_id: "skill_arc_welding",
          label_en: "Arc Welding",
          status: "active",
          kind: "skill",
          mappable: true,
          not_mappable_reason: null,
        },
      ],
      q: "weld",
      truncated: true,
    });
    const res = await searchCanonicalSkillsAction("  weld  ");
    expect(adminFetch).toHaveBeenCalledWith(
      expect.stringContaining("/admin/skills?q=weld"),
      expect.anything(),
    );
    expect(res).toEqual({
      kind: "success",
      skills: [
        {
          skill_id: "skill_arc_welding",
          label_en: "Arc Welding",
          status: "active",
          kind: "skill",
          mappable: true,
          not_mappable_reason: null,
        },
      ],
      q: "weld",
      truncated: true,
    });
  });

  it("returns an ineligible skill rather than dropping it — the picker decides how to render it", async () => {
    adminFetch.mockResolvedValueOnce({
      skills: [
        {
          skill_id: "skill_old",
          label_en: "Old Skill",
          status: "deprecated",
          kind: "skill",
          mappable: false,
          not_mappable_reason: "Deprecated.",
        },
      ],
      q: "old",
      truncated: false,
    });
    const res = await searchCanonicalSkillsAction("old");
    expect(res.kind).toBe("success");
    if (res.kind === "success") {
      expect(res.skills).toHaveLength(1);
      expect(res.skills[0]!.mappable).toBe(false);
      expect(res.skills[0]!.not_mappable_reason).toBe("Deprecated.");
    }
  });

  it("a network failure surfaces as a generic error, never a thrown exception", async () => {
    adminFetch.mockRejectedValueOnce(new FakeRequestError(500, "boom"));
    const res = await searchCanonicalSkillsAction("weld");
    expect(res.kind).toBe("error");
  });
});
