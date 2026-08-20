import { describe, it, expect, beforeEach, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

/**
 * What the AI calls list actually RENDERS (migration 0083).
 *
 * ── WHY A RENDER TEST ───────────────────────────────────────────────────────────────────
 * `lib/ai-traces.test.ts` covers what is asked for and what is accepted; neither would notice
 * the three mistakes that matter here, because all three live in the markup:
 *
 *   1. a "Read" link offered to a session that cannot use it — a control that 403s, and worse,
 *      one that suggests this operator is a request away from a worker's words;
 *   2. a null character count rendered as `0`, which says "the request was empty" when the
 *      truth is "nothing was stored";
 *   3. a mock provider call painted like a real one, which is how TD81 kept staging looking
 *      healthy for weeks behind a mocked provider.
 *
 * The page is an async Server Component, so it is awaited into an element tree and rendered
 * with `renderToStaticMarkup` — the treatment the other render tests here use. Its server-only
 * seams are replaced: the capability gate, the data layer, and the client filter bar.
 */

const stub = vi.hoisted(() => {
  /** Stands in for `AdminRequestError`, whose `status` separates the two failure screens. */
  class RequestError extends Error {
    constructor(readonly status: number) {
      super(`the admin API returned ${status}`);
    }
  }
  return {
    RequestError,
    /** Gate and fetch in the order they happened — the gate must come first. */
    order: [] as string[],
    requests: [] as Array<Record<string, unknown>>,
    page: { items: [] as unknown[], nextCursor: null as string | null },
    failure: null as unknown,
    /** What `/admin/me` reported. Set per test; the REAL `can()` reads it. */
    capabilities: ["read_entities"] as string[],
  };
});

vi.mock("../../../lib/auth", () => ({
  requireCapability: async (capability: string) => {
    stub.order.push(`gate:${capability}`);
    return { adminId: "a-1", role: "ops_admin", capabilities: stub.capabilities };
  },
}));

vi.mock("../../../lib/admin-http", () => ({
  isAdminRequestError: (err: unknown) => err instanceof stub.RequestError,
}));

vi.mock("../../../lib/ai-traces", () => ({
  listAiTraces: async (filters: Record<string, unknown>) => {
    stub.order.push("fetch");
    stub.requests.push(filters);
    if (stub.failure) throw stub.failure;
    return stub.page;
  },
}));

// `useRouter` needs an app-router context this renderer does not provide. The bar is not what
// this file is about; it is stubbed so the page under test can render at all.
vi.mock("./filter-bar", () => ({ AiCallFilterBar: () => null }));

const { default: AiCallsPage } = await import("./page");

const WORKER_ID = "5eeded00-0001-4a00-8000-000000000001";
const SESSION_ID = "5e550000-0001-4a00-8000-000000000001";
const TRACE_ID = "aa000000-0001-4a00-8000-000000000001";

/** A successful worker interview turn: both halves stored, a real provider call. */
const OK_ROW = {
  id: TRACE_ID,
  ai_call_id: "cc000000-0001-4a00-8000-000000000001",
  worker_id: WORKER_ID,
  session_id: SESSION_ID,
  ai_job_id: null,
  correlation_id: "req-9fd0b09",
  task_type: "profiling_chat_turn",
  model_name: "gemini-2.5-flash",
  prompt_name: null,
  prompt_version: null,
  prompt_chars: 412,
  response_chars: 88,
  real_call: true,
  success: true,
  error_code: null,
  created_at: "2026-08-19T09:00:00.000Z",
};

/** A speech call the mock adapter answered and that failed: no prompt text, no reply. */
const FAILED_MOCK_ROW = {
  ...OK_ROW,
  id: "aa000000-0002-4a00-8000-000000000002",
  session_id: null,
  task_type: "stt_transcription",
  model_name: null,
  prompt_chars: null,
  response_chars: null,
  real_call: false,
  success: false,
  error_code: "stt_service_unreachable",
};

beforeEach(() => {
  stub.order.length = 0;
  stub.requests.length = 0;
  stub.page = { items: [], nextCursor: null };
  stub.failure = null;
  // The session the page's own gate now demands. It was `["read_entities"]` while both the
  // page and the API route sat on the read floor; the owner ruling puts the whole
  // `/admin/ai-traces` surface on `read_ai_traces`, and the default session here moves with it
  // or every case below would exercise a page that redirects.
  stub.capabilities = ["read_ai_traces"];
});

const render = async (searchParams: Record<string, string | string[] | undefined> = {}) =>
  renderToStaticMarkup(await AiCallsPage({ searchParams: Promise.resolve(searchParams) }));

describe("the gate", () => {
  it("requires read_ai_traces, and requires it BEFORE the read runs", async () => {
    // Order is the assertion. A gate that resolves after the rows are already in hand has
    // gated nothing — the data was fetched either way.
    await render();
    expect(stub.order).toEqual(["gate:read_ai_traces", "fetch"]);
  });

  it("does NOT gate on the read floor — the list is not an ordinary entity list", () => {
    // `read_entities` is the value a "make it consistent with Workers/Jobs/Credits" edit reaches
    // for, and it is the one value that is wrong: the API gates both legs of this surface on
    // `read_ai_traces`, so a page on the read floor would put three of four roles one click from
    // a 403 with nothing on screen to explain it. Asserted as an inequality on the ORDER trace,
    // so it fails on the gate the page actually asked for rather than on a source scan.
    expect(stub.order).not.toContain("gate:read_entities");
  });
});

describe("the request the page makes", () => {
  it("asks for one short page, unfiltered, by default", async () => {
    await render();
    expect(stub.requests[0]).toEqual({
      taskType: undefined,
      success: undefined,
      workerId: undefined,
      cursor: undefined,
      limit: 25,
    });
  });

  it("forwards every filter and the cursor from the URL", async () => {
    await render({
      taskType: "profile_extraction",
      success: "false",
      workerId: WORKER_ID,
      cursor: "Y3Vyc29y",
    });
    expect(stub.requests[0]).toEqual({
      taskType: "profile_extraction",
      success: "false",
      workerId: WORKER_ID,
      cursor: "Y3Vyc29y",
      limit: 25,
    });
  });

  it("forwards values the server will REFUSE rather than dropping them", async () => {
    // Dropping them would render the whole list under a URL claiming a filter — and an operator
    // reading every worker's calls under a heading that says one worker's would never know.
    await render({ taskType: "nope", workerId: "not-a-uuid", success: "maybe" });
    expect(stub.requests[0]!.taskType).toBe("nope");
    expect(stub.requests[0]!.workerId).toBe("not-a-uuid");
    expect(stub.requests[0]!.success).toBe("maybe");
  });

  it("takes the first value of a repeated parameter and trims it", async () => {
    await render({ taskType: ["profile_parse", "domain_match"], cursor: "  Y3Vyc29y  " });
    expect(stub.requests[0]!.taskType).toBe("profile_parse");
    expect(stub.requests[0]!.cursor).toBe("Y3Vyc29y");
  });

  it("treats a whitespace-only value as absent, not as an empty filter", async () => {
    await render({ workerId: "   " });
    expect(stub.requests[0]!.workerId).toBeUndefined();
  });
});

describe("a row", () => {
  beforeEach(() => {
    stub.page = { items: [OK_ROW], nextCursor: null };
  });

  it("dates the row relatively, with the absolute instant kept in the title", async () => {
    const out = await render();
    const stamped = out.match(/<time[^>]*datetime="([^"]+)"/i);
    expect(stamped?.[1]).toBe(OK_ROW.created_at);
    expect(out).toContain('title="2026-08-19 09:00:00Z"');
  });

  it("names the task and the model", async () => {
    const out = await render();
    expect(out).toContain("profiling chat turn");
    expect(out).toContain("gemini-2.5-flash");
  });

  it("says `model not labelled` rather than leaving the cell blank", async () => {
    // "We do not know which model" is a fact worth reading on a triage row, and a blank cell
    // is indistinguishable from a rendering bug.
    stub.page = { items: [FAILED_MOCK_ROW], nextCursor: null };
    const out = await render();
    expect(out).toContain("model not labelled");
  });

  it("shows the two character COUNTS, and never the text", async () => {
    const out = await render();
    expect(out).toContain(">412<");
    expect(out).toContain(">88<");
    expect(out).toContain('title="412 characters"');
  });

  it("renders a NULL count as a dash — never as zero", async () => {
    // The one that would be read wrong every time: `0` says the request was empty, while the
    // truth is that nothing was stored for that half at all (speech-to-text sends audio).
    stub.page = { items: [FAILED_MOCK_ROW], nextCursor: null };
    const out = await render();
    expect(out).toContain("Nothing was stored for the request of this call.");
    expect(out).toContain("Nothing was stored for the reply of this call.");
    expect(out).not.toContain(">0<");
  });

  it("paints a MOCK provider call as warn, and a real one as ok", async () => {
    // TD81: simulated work must never render in the same type as the real thing.
    const real = await render();
    expect(real).toContain(">real<");
    expect(real).toContain("A provider was really called for this.");

    stub.page = { items: [FAILED_MOCK_ROW], nextCursor: null };
    const mock = await render();
    expect(mock).toContain("pill--warn");
    expect(mock).toContain(">mock<");
    expect(mock).toContain("No provider was called — the mock adapter answered.");
  });

  it("tones a failure `bad` and names the error code in words", async () => {
    stub.page = { items: [FAILED_MOCK_ROW], nextCursor: null };
    const out = await render();
    expect(out).toContain("pill--bad");
    expect(out).toContain(">failed<");
    expect(out).toContain("Speech service unreachable");
    // …and keeps the raw code reachable, because that is what an operator greps a log for.
    expect(out).toContain('title="stt_service_unreachable"');
  });

  it("links the worker as an opaque id, and the call to its interview session", async () => {
    const out = await render();
    expect(out).toContain(`href="/workers/${WORKER_ID}"`);
    expect(out).toContain(`href="/workers/${WORKER_ID}/journey/${SESSION_ID}"`);
    expect(out).toContain("5eeded00…");
  });

  it("says `no session` rather than nothing when a call belongs to no interview", async () => {
    // A résumé generation is worker-owned with no chat session behind it. A blank cell would
    // read as a missing link rather than as a fact about the call.
    stub.page = { items: [FAILED_MOCK_ROW], nextCursor: null };
    const out = await render();
    expect(out).toContain("no session");
    expect(out).not.toContain("/journey/");
  });

  it("counts the page honestly and claims newest-first in the caption", async () => {
    stub.page = { items: [OK_ROW, FAILED_MOCK_ROW], nextCursor: null };
    const out = await render();
    expect(out).toContain("AI calls, newest first");
    expect(out).toContain("2 calls on this page.");
  });

  it("uses the singular for one row", async () => {
    expect(await render()).toContain("1 call on this page.");
  });
});

/**
 * ⚠ THE CAPABILITY-DERIVED COLUMN. `read_ai_traces` is super-admin-only and the link behind it
 * is the single most privileged read in the portal, so "who is offered it" is markup that must
 * be asserted rather than reviewed.
 */
/**
 * The Text column derives from `read_ai_traces` rather than from "we rendered, so we may".
 *
 * ⚠ THE WITHOUT-CAPABILITY CASES BELOW ARE NOT REACHABLE TODAY, and saying so is the point. The
 * page's own gate is `read_ai_traces`, so a session lacking it is redirected before any of this
 * renders. They are kept — with the capability set explicitly rather than inherited from the
 * default session — because the ONE ruling still open on this surface is whether the list
 * reopens to `read_entities` for ops triage (see `admin-ai-traces.controller.ts`). On the day it
 * does, the page gate loosens and this column's derivation is the only thing standing between an
 * ops_admin and a link to a 404. Deleting these would make that day a silent regression; keeping
 * them mislabelled as live coverage would be the other kind of lie.
 */
describe("the Text column moves with the session, not with the page gate", () => {
  beforeEach(() => {
    stub.page = { items: [OK_ROW], nextCursor: null };
  });

  it("offers the read to a session that holds read_ai_traces", async () => {
    stub.capabilities = ["read_entities", "read_ai_traces"];
    const out = await render();
    expect(out).toContain(`href="/ai-calls/${TRACE_ID}"`);
    expect(out).toContain("<th scope=\"col\">Text</th>");
  });

  it("offers NOTHING without it — drops the COLUMN, not just the link (dormant; see above)", async () => {
    // Dashes under a "Text" heading would state that these calls have no text stored, which is
    // the opposite of true and is exactly what the two counts beside them disprove. The Workers
    // roster makes the identical ruling about its Name column.
    stub.capabilities = ["read_entities"];
    const out = await render();
    expect(out).not.toContain(`href="/ai-calls/${TRACE_ID}"`);
    expect(out).not.toContain("<th scope=\"col\">Text</th>");
    // …and the row is otherwise intact.
    expect(out).toContain(`href="/workers/${WORKER_ID}"`);
    expect(out).toContain(">412<");
  });

  it("says which of the two screens the operator is on, in the page copy", async () => {
    stub.capabilities = ["read_entities"];
    const without = await render();
    expect(without).toContain("cannot be read from your role");

    stub.capabilities = ["read_entities", "read_ai_traces"];
    const with_ = await render();
    expect(with_).toContain("a separate read, capped and recorded");
  });
});

describe("what this screen refuses to offer", () => {
  it("never renders the text of a call, whatever the session holds", async () => {
    // The list projection carries no prompt at all, so this is a guard against a future row
    // shape arriving with one and being rendered because a cell was added to match it.
    stub.capabilities = ["read_entities", "read_ai_traces"];
    stub.page = {
      items: [{ ...OK_ROW, prompt: "Mera naam Ramesh hai, 98765 43210" }],
      nextCursor: null,
    };
    const out = await render();
    expect(out).not.toContain("Ramesh");
    expect(out).not.toContain("98765");
  });

  it("states, on every render, that this is not every AI call", async () => {
    // Two systematic exclusions — a call that never reached a provider, and a call with no
    // worker to attribute it to — and every count made off this table is wrong without them.
    stub.page = { items: [OK_ROW], nextCursor: null };
    const out = await render();
    expect(out).toContain("This is not every AI call");
    expect(out).toContain("cannot be attributed to a worker also cannot be erased");
  });
});

describe("the empty states, which are three different claims", () => {
  it("unfiltered and empty: the mock posture explains it, and this is not a fault", async () => {
    // The claim that matters. On staging and every developer machine no provider is called at
    // all, so this table is permanently empty and the platform is working as configured.
    // Sending an operator to debug a healthy writer is the failure this copy exists to avoid.
    const out = await render();
    expect(out).toContain("No AI calls recorded yet");
    expect(out).toContain("mock adapter");
    expect(out).toContain("rather than a broken");
    // The posture is on the System screen, and that is where an operator has to look BEFORE
    // reading this screen as a fault. Offering only the event timeline would send them hunting
    // for a missing writer that is working exactly as the environment is configured.
    expect(out).toContain('href="/system"');
    expect(out).toContain("/events?eventName=ai.cost_recorded");
  });

  it("filtered and empty: says the FILTERS matched nothing, and warns how to read that", async () => {
    const out = await render({ taskType: "domain_match" });
    expect(out).toContain("No AI calls match these filters");
    expect(out).toContain("produce exactly the same empty screen");
    expect(out).not.toContain("No AI calls recorded yet");
  });

  it("deep-paged and empty: says THIS page is empty, not that nothing was ever recorded", async () => {
    // Rows behind a cursor disappear routinely: `ai_call_traces` cascades from `workers`, so an
    // account-deletion sweep between two requests empties the page an operator is standing on.
    const out = await render({ cursor: "Y3Vyc29y" });
    expect(out).toContain("Nothing further on this page");
    expect(out).toContain("Back to the newest");
    expect(out).not.toContain("No AI calls recorded yet");
  });

  it("deep-paged, filtered and empty: the way back KEEPS the filter", async () => {
    const out = await render({ taskType: "profile_parse", cursor: "Y3Vyc29y" });
    expect(out).toContain('href="/ai-calls?taskType=profile_parse"');
  });
});

describe("the worker narrowing", () => {
  /** A row belonging to somebody ELSE, so the banner is the only thing that can name the filter. */
  const OTHERS_ROW = {
    ...OK_ROW,
    id: "aa000000-0003-4a00-8000-000000000003",
    worker_id: "abcde000-0002-4a00-8000-000000000002",
  };

  it("says WHICH worker is being shown, and offers the way back out", async () => {
    stub.page = { items: [OTHERS_ROW], nextCursor: null };
    const out = await render({ workerId: WORKER_ID });
    expect(out).toContain("Showing only the calls made for worker");
    expect(out).toContain("5eeded00…");
    expect(out).toContain("Show every worker");
  });

  it("does NOT claim to be showing a worker's calls when nothing was fetched", async () => {
    // "Showing only worker X" over a refusal is a sentence about a list that does not exist,
    // and the empty screen under it would be read as an answer about that worker.
    stub.failure = new stub.RequestError(400);
    const refused = await render({ workerId: "not-a-uuid" });
    expect(refused).toContain("The server rejected this request");
    expect(refused).not.toContain("Showing only the calls made for worker");
  });

  it("pages WITHOUT losing the narrowing", async () => {
    stub.page = { items: [OTHERS_ROW], nextCursor: "bmV4dA" };
    const out = await render({ workerId: WORKER_ID });
    expect(out).toContain(`href="/ai-calls?workerId=${WORKER_ID}&amp;cursor=bmV4dA"`);
  });

  it("percent-encodes the id it puts back into a path", async () => {
    stub.page = { items: [OTHERS_ROW], nextCursor: null };
    const out = await render({ workerId: "a#b" });
    expect(out).toContain('href="/workers/a%23b"');
  });
});

describe("the two failures, which are different claims", () => {
  it("a 400 is the operator's URL, not our outage — and offers the undo", async () => {
    stub.failure = new stub.RequestError(400);
    const out = await render({ taskType: "nope" });
    expect(out).toContain("The server rejected this request");
    expect(out).toContain("Clear filters");
    expect(out).not.toContain("AI calls are unavailable");
  });

  it("a 400 with nothing in the URL offers NO action — there is nothing to undo", async () => {
    stub.failure = new stub.RequestError(400);
    const out = await render();
    expect(out).toContain("The server rejected this request");
    expect(out).not.toContain("state__actions");
  });

  it("anything else is our fault and says so, retrying the SAME query", async () => {
    stub.failure = new TypeError("fetch failed");
    const out = await render({ taskType: "profile_parse", cursor: "Y3Vyc29y" });
    expect(out).toContain("AI calls are unavailable");
    expect(out).toContain('href="/ai-calls?taskType=profile_parse&amp;cursor=Y3Vyc29y"');
    expect(out).not.toContain("The server rejected this request");
  });
});

describe("paging", () => {
  it("carries the filters, and only the newest cursor, into the next page", async () => {
    stub.page = { items: [OK_ROW], nextCursor: "bmV4dA" };
    const out = await render({ taskType: "profile_parse", cursor: "Y3Vyc29y" });
    expect(out).toContain('href="/ai-calls?taskType=profile_parse&amp;cursor=bmV4dA"');
    expect(out).not.toContain("cursor=Y3Vyc29y");
  });

  it("renders no pager on the last page", async () => {
    stub.page = { items: [OK_ROW], nextCursor: null };
    expect(await render()).not.toContain("Next page");
  });
});
