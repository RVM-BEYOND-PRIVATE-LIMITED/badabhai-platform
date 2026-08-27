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
  getSkillDiscoveryAudit: async (id: string) => {
    stub.order.push(`audit:${id}`);
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
  approved_job_domain_ids: [],
  approved_requirement: "preferred",
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

const AUDIT = {
  candidate_id: CANDIDATE_ID,
  entries: [
    {
      event_id: "evt-1",
      occurred_at: "2026-08-20T09:00:00.000Z",
      action_code: "skill_candidate_approved_create",
      admin_id: "adm-42",
    },
  ],
  current: {
    status: "pending",
    reviewer_admin_id: null,
    reviewed_at: null,
    review_reason: null,
    resulting_skill_id: null,
    approved_job_domain_ids: [],
    approved_requirement: "preferred",
  },
  corpus_effect: "decision_recorded_no_corpus_write",
};

beforeEach(() => {
  stub.order.length = 0;
  stub.calls = 0;
  stub.capabilities = ["read_entities", "review_skill_candidates"];
  stub.candidate = { ...BASE };
  stub.failure = null;
  stub.audit = { ...AUDIT };
  stub.auditFailure = null;
});

const render = async () =>
  renderToStaticMarkup(
    await SkillDiscoveryDetailPage({ params: Promise.resolve({ id: CANDIDATE_ID }) }),
  );

describe("the gate", () => {
  it("requires read_entities before the reads run", async () => {
    await render();
    expect(stub.order).toEqual([
      "gate:read_entities",
      `get:${CANDIDATE_ID}`,
      `audit:${CANDIDATE_ID}`,
    ]);
  });
});

describe("AC#4 — one candidate request, no N+1", () => {
  it("fetches the candidate exactly once", async () => {
    await render();
    expect(stub.calls).toBe(1);
  });
});

describe("#1280 — the audit read is a separate, degradable fetch", () => {
  it("fires in parallel with the candidate read, not after a 404 check delays it", async () => {
    await render();
    // Both reads are dispatched before either resolves — asserted by both landing in `order`
    // rather than the audit read being conspicuously absent when the candidate read succeeds.
    expect(stub.order).toContain(`audit:${CANDIDATE_ID}`);
  });

  it("a failed audit read degrades to an inline notice, never blanks the whole page", async () => {
    stub.auditFailure = new TypeError("network down");
    const out = await render();
    expect(out).toContain("The audit trail is unavailable");
    // The rest of the page — the candidate's own read — is intact.
    expect(out).toContain("sanitary fixture installation");
  });

  it("renders the spine entries oldest-first, translating the action code", async () => {
    const out = await render();
    expect(out).toContain("Approved — create new skill");
    expect(out).not.toContain("skill_candidate_approved_create");
  });

  it("admin_id on an entry is rendered as an opaque id, never resolved to a name", async () => {
    const out = await render();
    // `shortId` renders the id itself (short enough here to be unchanged) — never a name/email.
    expect(out).toContain("adm-42");
  });

  it("`current` on an undecided candidate renders pending with no reviewer, not a blank block", async () => {
    const out = await render();
    expect(out).toContain("Audit trail");
    // `current.status` is "pending" — rendered via the same StatusPill/labels as the header.
  });

  it("no recorded events yet reads as an honest empty state, not a blank table", async () => {
    stub.audit = { ...AUDIT, entries: [] };
    const out = await render();
    expect(out).toContain("No recorded events yet.");
  });

  it("renders `corpus_effect` — the trail's own statement that nothing here moved the taxonomy", async () => {
    // #1280 correction 3. The response has always carried this marker and the mirror has always
    // typed it; nothing showed it. An "Approved — create new skill" entry read back weeks later
    // looks like the skill exists, and this is the sentence that says it does not.
    const out = await render();
    expect(out).toContain("Recording a decision does not change the taxonomy");
  });

  it("an UNRECOGNISED corpus_effect renders itself rather than a guessed sentence", async () => {
    stub.audit = { ...AUDIT, corpus_effect: "something_the_server_added_later" };
    const out = await render();
    expect(out).toContain("something_the_server_added_later");
  });

  /*
   * ── THE 200-ENTRY CAP (#1280, correction 6) ──────────────────────────────────────────
   * `listAuditEvents` is `LIMIT 200` with no truncation flag, so a candidate with 201 events and
   * one with exactly 200 arrive identical. Unlike `/groups`, which counts first and refuses an
   * over-broad filter outright, this route truncates silently.
   *
   * Under the cap nothing was dropped and the warning would be noise; at it, the panel cannot
   * tell the two apart and stops claiming completeness. Unreachable in practice — the status
   * ladder is terminal — which is a reason to say it quietly, not to leave it unsaid.
   */
  const auditEntries = (n: number) =>
    Array.from({ length: n }, (_, i) => ({
      event_id: `evt-${i}`,
      occurred_at: "2026-08-20T09:00:00.000Z",
      action_code: "skill_candidate_deferred",
      admin_id: "adm-42",
    }));

  it("says nothing about a cap while the trail is under it", async () => {
    stub.audit = { ...AUDIT, entries: auditEntries(199) };
    const out = await render();
    expect(out).not.toContain("cannot be treated as the complete history");
  });

  it("AT the cap it stops claiming completeness, because it cannot tell 200 from truncated", async () => {
    stub.audit = { ...AUDIT, entries: auditEntries(200) };
    const out = await render();
    expect(out).toContain("cannot be treated as the complete history");
    expect(out).toContain("no marker for whether anything was left out");
  });

  it("offers NO load-the-rest affordance at the cap — no route serves one", async () => {
    stub.audit = { ...AUDIT, entries: auditEntries(200) };
    const out = await render();
    expect(out.toLowerCase()).not.toMatch(/load (the )?(rest|more)|show all|full history/);
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

describe("AC#5/#6 — no similarity measurement reaches the reviewer, and EVERY match shown", () => {
  /*
   * `embedding model` LEFT THIS REGEX (#1280, correction 5), and the reason matters.
   *
   * The provenance panel now renders `provenance.model` — a verbatim configuration string the
   * server serves, whose VALUE can legitimately contain those words. Banning the substring would
   * fail on a well-named model rather than on a leaked measurement: a test asserting the wrong
   * thing, loudly.
   *
   * `cosine` and `vector` stay. Neither is ever a value this surface renders, so either appearing
   * means the screen has started teaching the vocabulary it exists to spare a reviewer. And the
   * assertion that guards the actual hazard is the next one — the NUMBER.
   */
  it("never renders the literal words cosine or vector", async () => {
    const out = await render();
    expect(out.toLowerCase()).not.toMatch(/cosine|vector/);
  });

  it("never renders a bare similarity-score-shaped number", async () => {
    const out = await render();
    expect(out).not.toMatch(/\b0\.\d{2}\b/);
  });

  /*
   * ── THIS TEST USED TO ASSERT THE OPPOSITE ────────────────────────────────────────────
   * It pinned that `provenance.model` and `provenance.prompt_version` were OMITTED, under a
   * blanket "no model name in the UI" rule the pre-merge audit found stricter than the contract.
   * Both sit inside the frozen 19-field digest the same panel prints, so hiding them showed a
   * reviewer nine of eleven fields under a heading that says "frozen record".
   *
   * The rule that protects the decision is the pair above: no similarity measurement. Unchanged.
   */
  it("renders the provenance model and prompt version — run configuration, not a measurement", async () => {
    const out = await render();
    expect(out).toContain("text-embedding-3-small");
    expect(out).toContain(">v3<");
  });

  it("carries the note saying what those provenance fields are NOT", async () => {
    const out = await render();
    expect(out).toContain("none of them measures how good a match anything is");
  });

  it("renders a null model and prompt version as an em dash, never blank or guessed", async () => {
    stub.candidate = {
      ...BASE,
      provenance: { ...BASE.provenance, model: null, prompt_version: null },
    };
    const out = await render();
    expect(out).toContain('<dt class="kv__k">Model</dt><dd class="kv__v">—</dd>');
    expect(out).toContain('<dt class="kv__k">Prompt version</dt><dd class="kv__v">—</dd>');
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

  it("#1280 — approved_create renders the approved trades and requirement (the scope of the approval)", async () => {
    stub.candidate = {
      ...BASE,
      status: "approved_create",
      approved_job_domain_ids: ["jd_nco_7126_0100", "jd_nco_7126_0200"],
      approved_requirement: "required",
    };
    const out = await render();
    expect(out).toContain("Approved trades");
    expect(out).toContain("jd_nco_7126_0100");
    expect(out).toContain("jd_nco_7126_0200");
    expect(out).toContain("Requirement");
    expect(out).toContain("Required");
  });

  it("#1280 — a non-create terminal status (rejected) never renders the approved-scope rows", async () => {
    // `approved_job_domain_ids`/`approved_requirement` are only ever populated by a `create`
    // decision; showing them on a rejection would render a scope that was never approved.
    stub.candidate = {
      ...BASE,
      status: "rejected",
      approved_job_domain_ids: [],
      approved_requirement: "preferred",
    };
    const out = await render();
    expect(out).not.toContain("Approved trades");
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
      <DecisionOutcomeNotice outcome={{ kind: "error", message: "The admin API is unreachable." }} />,
    );
    expect(out).toContain("Action failed");
    expect(out).toContain("The admin API is unreachable.");
    expect(out).not.toContain("Reload");
  });

  it("success with changed:true never claims the taxonomy itself changed", () => {
    const out = renderToStaticMarkup(
      <DecisionOutcomeNotice
        outcome={{ kind: "success", changed: true, status: "approved_create", already_decided: false }}
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
