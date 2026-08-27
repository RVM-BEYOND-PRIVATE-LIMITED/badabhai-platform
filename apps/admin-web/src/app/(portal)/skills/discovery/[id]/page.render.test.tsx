import { describe, it, expect, beforeEach, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type * as DecisionPanelModule from "./decision-panel";

/**
 * What one skill candidate's review screen actually RENDERS (#1260).
 *
 * `lib/skill-discovery.test.ts` and `lib/skill-discovery-vocabulary.test.ts` cover the request
 * and pure-logic layers; this covers what a reviewer sees, including the states that only
 * exist server-side (terminal, deferred, capability-denied, 404) and the one that only exists
 * after a client submission (409 conflict) — the latter via `DecisionOutcomeNotice`, a pure
 * presentational component taking the outcome as a PROP, exactly the device
 * `admin-action-result-banner.render.test.tsx` uses for the same reason: this app's vitest
 * environment is `node`, with no jsdom, so a click cannot be simulated — see
 * `AdminActionButton`'s own test file. `SkillDecisionPanel` itself calls `useRouter()`, which
 * needs an app-router context this renderer does not provide (the same reason
 * `workers/[id]/page.render.test.tsx` stubs `WorkerDetailHeader`), so it is stubbed to `null`
 * here while `DecisionOutcomeNotice` — which takes no hooks — is imported for real underneath
 * that same mock.
 */

const stub = vi.hoisted(() => {
  class RequestError extends Error {
    constructor(readonly status: number) {
      super(`the admin API returned ${status}`);
    }
  }
  return {
    RequestError,
    order: [] as string[],
    calls: 0,
    capabilities: ["read_entities", "review_skill_candidates"] as string[],
    candidate: null as Record<string, unknown> | null,
    failure: null as unknown,
    audit: null as Record<string, unknown> | null,
    auditFailure: null as unknown,
    auditCalls: 0,
  };
});

vi.mock("../../../../../lib/auth", () => ({
  requireCapability: async (capability: string) => {
    stub.order.push(`gate:${capability}`);
    return { adminId: "a-1", role: "ops_admin", capabilities: stub.capabilities };
  },
}));

vi.mock("../../../../../lib/admin-http", () => ({
  isAdminRequestError: (err: unknown) => err instanceof stub.RequestError,
}));

vi.mock("../../../../../lib/skill-discovery", () => ({
  getSkillDiscoveryCandidate: async (id: string) => {
    stub.order.push(`get:${id}`);
    stub.calls += 1;
    if (stub.failure) throw stub.failure;
    return stub.candidate;
  },
  getSkillCandidateAudit: async (id: string) => {
    stub.order.push(`audit:${id}`);
    stub.auditCalls += 1;
    if (stub.auditFailure) throw stub.auditFailure;
    return stub.audit;
  },
}));

vi.mock("./decision-panel", async () => {
  const actual = await vi.importActual<typeof DecisionPanelModule>("./decision-panel");
  return { ...actual, SkillDecisionPanel: () => null };
});

const { default: SkillDiscoveryDetailPage } = await import("./page");
const { DecisionOutcomeNotice } = await import("./decision-panel");

const CANDIDATE_ID = "c0000000-0001-4a00-8000-000000000001";

const BASE = {
  approved_job_domain_ids: [] as string[],
  approved_requirement: "preferred",
  id: CANDIDATE_ID,
  run_id: "sdr_20260826T000000Z_a1b2c3",
  cluster_key: "sanitary-fixture-installation",
  normalized_phrase: "sanitary fixture installation",
  proposed_skill_name: "Sanitary Fixture Installation",
  phrase_class: "OCCUPATION_WITH_SKILL_EVIDENCE",
  phrase_class_label: "A job title with a modifier that names actual work.",
  trade_family: "Plumbers and Pipe Fitters",
  source_alias_count: 4,
  source_domain_count: 1,
  proposed_action: "create",
  confidence_band: "high",
  status: "pending",
  review_tier: "direct",
  has_strong_match: true,
  related_skill_count: 2,
  reviewer_admin_id: null,
  reviewed_at: null,
  resulting_skill_id: null,
  created_at: "2026-08-26T09:00:00.000Z",
  updated_at: "2026-08-26T09:00:00.000Z",
  proposed_description: "Operation and fitting of sanitary fixtures.",
  rationale: "An occupation title whose modifier names the work.",
  sources: [
    {
      source_type: "job_domain_alias",
      source_id: "jda-1",
      original_text: "sanitary fitting",
      normalized_text: "sanitary fitting",
      job_domain_id: "jd_nco_7126_0100",
    },
  ],
  source_type_counts: [{ key: "job_domain_alias", count: 1 }],
  related_skills: [
    {
      skill_id: "skill_plumbing",
      skill_label: "Plumbing",
      relation: "surface_form_shared",
      relation_label: "This phrase is already listed as another name for this skill.",
      strength: "strong",
      strength_label: "Looks like the same thing.",
      evidence: "This phrase is already listed as another name for this skill.",
      rank: 1,
    },
    {
      skill_id: "skill_drain_laying",
      skill_label: "Drain Laying",
      relation: "high_token_overlap",
      relation_label: "Shares most of its meaningful words with this skill.",
      strength: "weak",
      strength_label: "Possibly related — worth a look, not a match.",
      evidence: "Shares most of its meaningful words with this skill.",
      rank: 2,
    },
  ],
  suggested_aliases: ["sanitary fitting", "sanitary installer"],
  review_reason: null,
  provenance: {
    run_id: "sdr_20260826T000000Z_a1b2c3",
    cluster_key: "sanitary-fixture-installation",
    classifier_rule: "occupation_with_modifier",
    phrase_class: "OCCUPATION_WITH_SKILL_EVIDENCE",
    occupation_heads: ["fitter"],
    evidence_tokens: ["sanitary", "fixture"],
    embedding_status: "not_required",
    model: "text-embedding-3-small",
    prompt_version: "v3",
    corpus_fingerprint: "cf_abc123",
    provenance_digest: "d41d8cd98f00b204e9800998ecf8427e",
  },
};

/**
 * The audit response, as the SPINE plus the row.
 *
 * `current` is always present — an undecided candidate has one whose fields are null, never an
 * absent block, because "nothing has happened yet" and "the row is gone" must not be the same
 * response.
 */
const AUDIT_UNDECIDED = {
  candidate_id: CANDIDATE_ID,
  entries: [],
  current: {
    status: "needs_review",
    reviewer_admin_id: null,
    reviewed_at: null,
    review_reason: null,
    resulting_skill_id: null,
    approved_job_domain_ids: [],
    approved_requirement: "preferred",
  },
  corpus_effect: "decision_recorded_no_corpus_write",
};

const AUDIT_DECIDED = {
  ...AUDIT_UNDECIDED,
  entries: [
    {
      event_id: "e0000000-0001-4a00-8000-000000000001",
      occurred_at: "2026-08-27T09:00:00.000Z",
      action_code: "skill_candidate_approved_create",
      admin_id: "a-1",
    },
  ],
  current: {
    status: "approved_create",
    reviewer_admin_id: "a-1",
    reviewed_at: "2026-08-27T09:00:00.000Z",
    review_reason: "Sanitary fixture installation is a distinct competency from plumbing.",
    resulting_skill_id: null,
    approved_job_domain_ids: ["jd_nco_7126_0100", "jd_nco_7411_0100"],
    approved_requirement: "required",
  },
};

beforeEach(() => {
  stub.order.length = 0;
  stub.calls = 0;
  stub.auditCalls = 0;
  stub.capabilities = ["read_entities", "review_skill_candidates"];
  stub.candidate = { ...BASE };
  stub.failure = null;
  stub.audit = { ...AUDIT_UNDECIDED };
  stub.auditFailure = null;
});

const render = async () =>
  renderToStaticMarkup(
    await SkillDiscoveryDetailPage({ params: Promise.resolve({ id: CANDIDATE_ID }) }),
  );

describe("the gate", () => {
  it("requires read_entities before either read runs", async () => {
    await render();
    // The candidate first, then its audit trail: a 404 on the candidate is a not-found for the
    // whole screen, and there is no point asking for the history of a row that does not exist.
    expect(stub.order).toEqual([
      "gate:read_entities",
      `get:${CANDIDATE_ID}`,
      `audit:${CANDIDATE_ID}`,
    ]);
  });

  it("does not ask for the audit trail at all when the candidate is not found", async () => {
    stub.failure = new stub.RequestError(404);
    await expect(render()).rejects.toThrow();
    expect(stub.auditCalls).toBe(0);
  });
});

describe("AC#4 — one request, no N+1", () => {
  it("fetches the candidate exactly once", async () => {
    await render();
    expect(stub.calls).toBe(1);
  });
});

describe("404 / 400 — both read as not-found", () => {
  async function catchThrown(id: string): Promise<unknown> {
    try {
      await SkillDiscoveryDetailPage({ params: Promise.resolve({ id }) });
    } catch (err) {
      return err;
    }
    throw new Error("expected the page to throw");
  }

  it("a 404 throws Next's not-found signal", async () => {
    stub.failure = new stub.RequestError(404);
    const err = await catchThrown(CANDIDATE_ID);
    expect((err as { digest?: string }).digest).toContain("NEXT_HTTP_ERROR_FALLBACK;404");
  });

  it("a 400 (malformed id) reads the same as not-found", async () => {
    stub.failure = new stub.RequestError(400);
    const err = await catchThrown("not-a-uuid");
    expect((err as { digest?: string }).digest).toContain("NEXT_HTTP_ERROR_FALLBACK;404");
  });

  it("anything else is a real failure and is NOT swallowed into not-found", async () => {
    stub.failure = new TypeError("network down");
    const err = await catchThrown(CANDIDATE_ID);
    expect((err as Error).message).toBe("network down");
    expect((err as { digest?: string }).digest).toBeUndefined();
  });
});

describe("AC#5/#6 — no score, vector, cosine or embedding model name, and EVERY match shown", () => {
  it("never renders the literal words cosine, vector, or embedding model", async () => {
    const out = await render();
    expect(out.toLowerCase()).not.toMatch(/cosine|vector|embedding model/);
  });

  it("never renders a bare similarity-score-shaped number", async () => {
    const out = await render();
    expect(out).not.toMatch(/\b0\.\d{2}\b/);
  });

  it("omits the provenance model name and prompt version, even though the response carries them", async () => {
    const out = await render();
    expect(out).not.toContain("text-embedding-3-small");
    expect(out).not.toContain("v3");
  });

  it("renders BOTH the strong and the weak match — never just the top one", async () => {
    const out = await render();
    expect(out).toContain("Plumbing");
    expect(out).toContain("Drain Laying");
  });

  it("labels the weak match as context, visually subordinate (table__meta)", async () => {
    const out = await render();
    const weakRow = out.slice(out.indexOf("Drain Laying") - 300, out.indexOf("Drain Laying") + 50);
    expect(weakRow).toContain("table__meta");
  });

  it("translates the relation code into the sentence, never the raw code", async () => {
    const out = await render();
    expect(out).toContain("This phrase is already listed as another name for this skill.");
    expect(out).not.toContain("surface_form_shared");
  });
});

describe("terminal candidates — a record, with no decision controls", () => {
  it("approved_create renders the record and no decision panel heading", async () => {
    stub.candidate = {
      ...BASE,
      status: "approved_create",
      reviewer_admin_id: "adm-42",
      reviewed_at: "2026-08-26T10:00:00.000Z",
      review_reason: "clean occupation-with-skill-evidence case, corroborated by 12 domains",
    };
    const out = await render();
    expect(out).toContain("Decision record");
    expect(out).toContain("This candidate is terminal");
    expect(out).toContain("adm-42");
    expect(out).toContain("clean occupation-with-skill-evidence case");
    expect(out).not.toContain('id="sd-decision"');
    expect(out).not.toContain("Ask an ops admin or super admin");
  });

  it("a null resulting_skill_id on approved_create reads as not-yet-backfilled, not a dash", async () => {
    stub.candidate = { ...BASE, status: "approved_create", resulting_skill_id: null };
    const out = await render();
    expect(out).toContain("not yet backfilled");
  });

  it("rejected with a null resulting_skill_id reads as a plain dash, not 'not yet backfilled'", async () => {
    stub.candidate = { ...BASE, status: "rejected", resulting_skill_id: null };
    const out = await render();
    expect(out).not.toContain("not yet backfilled");
  });

  it("terminal renders even for an admin who COULD decide — terminal always wins over both other branches", async () => {
    stub.capabilities = ["read_entities", "review_skill_candidates"];
    stub.candidate = { ...BASE, status: "rejected" };
    const out = await render();
    expect(out).toContain("Decision record");
    expect(out).not.toContain("Ask an ops admin or super admin");
  });
});

describe("deferred — re-openable, shows the prior reason and reviewer", () => {
  it("renders the held banner AND still offers the decision panel to a capable admin", async () => {
    stub.candidate = {
      ...BASE,
      status: "deferred",
      reviewer_admin_id: "adm-9",
      reviewed_at: "2026-08-25T10:00:00.000Z",
      review_reason: "needs a second opinion on the trade-family split",
    };
    const out = await render();
    expect(out).toContain("On hold");
    expect(out).toContain("needs a second opinion on the trade-family split");
  });
});

describe("capability-denied — the queue is readable, the decision controls are absent", () => {
  it("an admin with only read_entities sees the record but no decision panel", async () => {
    stub.capabilities = ["read_entities"];
    stub.candidate = { ...BASE, status: "pending" };
    const out = await render();
    expect(out).toContain("Ask an ops admin or super admin");
    // and the read itself is intact — this is not a broken/error state
    expect(out).toContain("sanitary fixture installation");
  });

  it("an admin WITH review_skill_candidates does NOT see the capability-denied notice", async () => {
    stub.capabilities = ["read_entities", "review_skill_candidates"];
    stub.candidate = { ...BASE, status: "pending" };
    const out = await render();
    expect(out).not.toContain("Ask an ops admin or super admin");
  });
});

describe("409 conflict — DecisionOutcomeNotice renders the code's meaning and a reload, never a silent retry", () => {
  it("stale_expected_status", () => {
    const out = renderToStaticMarkup(
      <DecisionOutcomeNotice
        outcome={{
          kind: "conflict",
          info: {
            conflict: "stale_expected_status",
            current_status: "approved_create",
            expected_status: "pending",
          },
        }}
      />,
    );
    expect(out).toContain("Somebody moved this candidate since you loaded it");
    expect(out).toContain(">Reload<");
    expect(out).not.toMatch(/auto.?retry/i);
  });

  it("already_decided", () => {
    const out = renderToStaticMarkup(
      <DecisionOutcomeNotice
        outcome={{
          kind: "conflict",
          info: {
            conflict: "already_decided",
            current_status: "rejected",
            expected_status: "pending",
          },
        }}
      />,
    );
    expect(out).toContain("This candidate is terminal");
    expect(out).toContain(">Reload<");
  });

  it("illegal_transition", () => {
    const out = renderToStaticMarkup(
      <DecisionOutcomeNotice
        outcome={{
          kind: "conflict",
          info: {
            conflict: "illegal_transition",
            current_status: "needs_review",
            expected_status: "pending",
          },
        }}
      />,
    );
    // `renderToStaticMarkup` HTML-escapes the apostrophe as `&#x27;`.
    expect(out).toContain("not allowed from the candidate&#x27;s current status");
    expect(out).toContain(">Reload<");
  });

  it("a generic error renders as a failure, distinct from a conflict", () => {
    const out = renderToStaticMarkup(
      <DecisionOutcomeNotice
        outcome={{ kind: "error", message: "The admin API is unreachable." }}
      />,
    );
    expect(out).toContain("Action failed");
    expect(out).toContain("The admin API is unreachable.");
    expect(out).not.toContain("Reload");
  });

  it("success with changed:true never claims the taxonomy itself changed", () => {
    const out = renderToStaticMarkup(
      <DecisionOutcomeNotice
        outcome={{
          kind: "success",
          changed: true,
          status: "approved_create",
          already_decided: false,
        }}
      />,
    );
    expect(out).toContain("Decision recorded");
    expect(out).not.toContain("skill created");
    expect(out).toContain("offline corpus chain");
  });

  it("success with changed:false — an idempotent resubmit — reads as a non-error", () => {
    const out = renderToStaticMarkup(
      <DecisionOutcomeNotice
        outcome={{ kind: "success", changed: false, status: "rejected", already_decided: true }}
      />,
    );
    expect(out).toContain("No change");
    expect(out).not.toContain("Action failed");
  });
});

describe("the audit trail comes from the audit route, and is never assembled here", () => {
  it("renders each spine entry with what was RECORDED, not the button that was pressed", async () => {
    stub.audit = { ...AUDIT_DECIDED };
    const out = await render();
    // `alias` on the wire becomes `skill_candidate_approved_map` in the spine, deliberately, so
    // an auditor reconciling the two needs no translation table. The label must not undo that.
    expect(out).toContain("Approved as a new skill");
    expect(out).toContain("a-1");
  });

  it("renders an unrecognised action code AS ITSELF, never a guessed sentence", async () => {
    stub.audit = {
      ...AUDIT_DECIDED,
      entries: [{ ...AUDIT_DECIDED.entries[0], action_code: "skill_candidate_something_new" }],
    };
    const out = await render();
    expect(out).toContain("skill_candidate_something_new");
  });

  it("an empty spine says nothing has happened — which is not the same as a failed read", async () => {
    stub.audit = { ...AUDIT_UNDECIDED };
    const out = await render();
    expect(out).toContain("No decision has been recorded against this candidate yet");
    expect(out).not.toContain("could not be loaded");
  });

  it("a FAILED audit read says so, and makes no claim about the history", async () => {
    stub.auditFailure = new TypeError("network down");
    const out = await render();
    expect(out).toContain("The audit trail could not be loaded");
    expect(out).toContain("not an empty history");
    // The rest of the review screen survives it — the reviewer still came here to decide.
    expect(out).toContain("sanitary fixture installation");
  });

  it("says the spine is value-free, so nobody reads a missing reason as a lost one", async () => {
    const out = await render();
    expect(out).toContain("carry no values");
  });

  it("the reviewer stays an OPAQUE id — this screen resolves no names", async () => {
    stub.audit = { ...AUDIT_DECIDED };
    const out = await render();
    expect(out).not.toContain("@");
  });
});

describe("the reviewer's trade judgement is rendered where a decision is shown", () => {
  it("lists the trades and how they need it, on the audit record", async () => {
    stub.audit = { ...AUDIT_DECIDED };
    const out = await render();
    expect(out).toContain("jd_nco_7126_0100");
    expect(out).toContain("jd_nco_7411_0100");
    expect(out).toContain("Required for those trades");
    expect(out).toContain("Trades named by the reviewer");
  });

  it("explains WHY a human had to name them", async () => {
    stub.audit = { ...AUDIT_DECIDED };
    const out = await render();
    expect(out).toContain("corpus gate refuses one");
  });

  it("an empty list renders as an em dash, never as the word none", async () => {
    // Every non-create decision has an empty list. "None" would read as a reviewer having
    // deliberately chosen no trades, which is a different — and impossible — claim.
    stub.audit = {
      ...AUDIT_DECIDED,
      current: { ...AUDIT_DECIDED.current, approved_job_domain_ids: [], status: "rejected" },
    };
    const out = await render();
    expect(out).not.toContain("Required for those trades");
    expect(out).not.toMatch(/Trades named by the reviewer<\/dt><dd[^>]*>none/i);
  });

  it("shows them on the terminal decision record too, beside the decision itself", async () => {
    stub.candidate = {
      ...BASE,
      status: "approved_create",
      reviewer_admin_id: "a-1",
      reviewed_at: "2026-08-27T09:00:00.000Z",
      review_reason: "A distinct competency.",
      approved_job_domain_ids: ["jd_nco_7126_0100"],
      approved_requirement: "preferred",
    };
    const out = await render();
    expect(out).toContain("Decision record");
    expect(out).toContain("jd_nco_7126_0100");
    expect(out).toContain("Preferred for those trades");
  });
});
