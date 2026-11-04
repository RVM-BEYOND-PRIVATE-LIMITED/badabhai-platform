import { describe, it, expect, beforeEach, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { SECTION, childTags } from "../../../../../../../test/panel-markup";

/**
 * One interview session, reached under a worker — and the notice it posts when the session
 * belongs to SOMEONE ELSE than the worker in the address.
 *
 * The notice used to say "the breadcrumb above is not [that session's]". The crumb names no
 * worker at all (it hides ids); what points at the address's worker is the BACK LINK, so that is
 * what the notice names (sweep AW-31).
 *
 * The panels below the header have their own tests; they are stubbed here.
 */
const stub = vi.hoisted(() => ({ session: null as Record<string, unknown> | null }));

vi.mock("../../../../../../lib/auth", () => ({
  requireCapability: async () => ({
    adminId: "a-1",
    role: "ops_admin",
    capabilities: ["read_entities"],
  }),
}));
vi.mock("../../../../../../lib/admin-http", () => ({ isAdminRequestError: () => false }));
vi.mock("../../../../../../lib/journey", () => ({ getChatSession: async () => stub.session }));
vi.mock("../../../../../../components/caveat-list", () => ({ CaveatList: () => null }));
vi.mock("../../../../../../components/stuck-panel", () => ({ StuckPanel: () => null }));
vi.mock("../../../../../../components/voice-attempts", () => ({ VoiceAttempts: () => null }));

const { default: ChatSessionDetailPage } = await import("./page");

const URL_WORKER = "5eeded00-0001-4a00-8000-000000000001";
const OTHER_WORKER = "abcde000-0002-4a00-8000-000000000002";
const SESSION_ID = "0f0b7a2a-2f3a-4a1e-9a1e-0f0b7a2a2f3a";

const SESSION = {
  id: SESSION_ID,
  worker_id: URL_WORKER,
  status: "ended",
  abandoned: false,
  started_at: "2026-08-18T11:40:00.000Z",
  ended_at: "2026-08-18T11:58:00.000Z",
  last_message_at: "2026-08-18T11:57:00.000Z",
  idle_seconds: 60,
  message_count: 14,
  answer_count: 0,
  pack_id: null,
  pack_version: null,
  caveats: [],
  stuck: {},
  answers: [],
  voice_answers: [],
  ai_jobs: [],
  ai_cost: null,
};

beforeEach(() => {
  stub.session = { ...SESSION };
});

const render = async () =>
  renderToStaticMarkup(
    await ChatSessionDetailPage({
      params: Promise.resolve({ id: URL_WORKER, sessionId: SESSION_ID }),
    }),
  );

describe("a session that belongs to another worker", () => {
  beforeEach(() => {
    stub.session = { ...SESSION, worker_id: OTHER_WORKER };
  });

  it("says so, linking the worker it really belongs to", async () => {
    const out = await render();
    expect(out).toContain("not to the worker in this URL");
    expect(out).toContain(`href="/candidates/${OTHER_WORKER}/journey"`);
  });

  it("names the BACK LINK as the part that points elsewhere — not the breadcrumb", async () => {
    const out = await render();
    expect(out).toContain("the back link above is not.");
    expect(out).not.toContain("breadcrumb");
    // …and that back link really is the one pointing at the address's worker.
    expect(out).toContain(`<a class="backlink" href="/candidates/${URL_WORKER}/journey">`);
  });
});

describe("a session that belongs to the worker in the address", () => {
  it("posts no notice", async () => {
    const out = await render();
    expect(out).not.toContain("not to the worker in this URL");
  });
});

describe("what this session cost (A1, #2571)", () => {
  const ROOT = '<section class="panel" aria-labelledby="session-cost">';
  const JOB_ID = "a1b0c000-0003-4a00-8000-000000000003";

  beforeEach(() => {
    stub.session = {
      ...SESSION,
      ai_cost: {
        total_cost_inr: "0.012300",
        call_count: 3,
        real_call_count: 3,
        first_recorded_at: "2026-08-18T11:41:00.000Z",
        updated_at: "2026-08-18T11:58:00.000Z",
      },
      ai_jobs: [
        {
          id: JOB_ID,
          job_type: "profile_extraction",
          status: "completed",
          model_name: "gemini-2.5-flash",
          real_call: true,
          input_tokens: 900,
          output_tokens: 334,
          total_tokens: 1234,
          cost_inr: 0.0123,
          has_error: false,
          created_at: "2026-08-18T11:57:00.000Z",
          updated_at: "2026-08-18T11:58:00.000Z",
        },
      ],
    };
  });

  it("stacks the cost and the extraction jobs as sibling sections", async () => {
    // Siblings, so `.panel__section + .panel__section` sets 24px and a hairline between them.
    expect(childTags(await render(), ROOT)).toEqual([
      '<div class="panel__head">',
      SECTION,
      SECTION,
    ]);
  });

  it("titles the jobs with a section heading that the table still names itself by", async () => {
    const out = await render();
    expect(out).toContain(
      '<h3 class="panel__section-title" id="session-jobs">Extraction jobs</h3>',
    );
    expect(out).toContain('<table class="table" aria-labelledby="session-jobs">');
  });

  it("sets a job's ₹ cost in the UI face, keeping mono for the job's id", async () => {
    const out = await render();
    expect(out).toContain('<td class="table__meta ui-num" title="₹0.0123">');
    expect(out).toContain(`<th class="table__rowhead mono" scope="row" title="${JOB_ID}">`);
  });
});
