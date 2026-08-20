import { describe, it, expect, beforeEach, vi } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { renderToStaticMarkup } from "react-dom/server";

/**
 * What the AI call DETAIL screen actually renders — the most privileged surface in the portal.
 *
 * ── THE FOUR THINGS THIS FILE EXISTS TO HOLD ────────────────────────────────────────────
 *  1. THE NEUTRAL 404 STAYS NEUTRAL. The server returns the same 404 for a flag that is off, a
 *     trace that does not exist, an allowance that is spent and a fail-closed Redis error, on
 *     purpose. This page may not translate it into any one of them — not into "you do not have
 *     permission" (false in three of the four), not into "no such call" (false in three), and
 *     above all not into "the read is switched off", which is the exact question the neutral
 *     404 was built to refuse to answer. It must also not read as an error: nothing failed.
 *  2. A SESSION WITHOUT THE CAPABILITY MAKES NO REQUEST. On a route where every call is metered
 *     and audited, the request nobody had a right to make is the one worth not making.
 *  3. THE CAVEAT IS RENDERED, ABOVE THE WORDS IT IS ABOUT. `lib/ai-trace-view.test.ts` pins the
 *     sentence; nothing there would notice a page that computed it and never emitted it.
 *  4. AN UNDECRYPTABLE HALF IS NOT AN EMPTY ONE. Both arrive as `null` from the server, and
 *     reporting the first as the second tells an operator to stop looking at the moment they
 *     should escalate.
 */

const stub = vi.hoisted(() => {
  class RequestError extends Error {
    constructor(readonly status: number) {
      super(`the admin API returned ${status}`);
    }
  }
  class ForbiddenError extends Error {}
  return {
    RequestError,
    ForbiddenError,
    order: [] as string[],
    /** Every id this page actually asked the server for. Empty is an assertion in its own right. */
    asked: [] as string[],
    trace: null as unknown,
    failure: null as unknown,
    capabilities: ["read_entities", "read_ai_traces"] as string[],
  };
});

vi.mock("../../../../lib/auth", () => ({
  requireCapability: async (capability: string) => {
    stub.order.push(`gate:${capability}`);
    return { adminId: "a-1", role: "super_admin", capabilities: stub.capabilities };
  },
}));

vi.mock("../../../../lib/admin-http", () => ({
  isAdminRequestError: (err: unknown) => err instanceof stub.RequestError,
  isAdminForbidden: (err: unknown) => err instanceof stub.ForbiddenError,
}));

vi.mock("../../../../lib/ai-traces", () => ({
  getAiTrace: async (id: string) => {
    stub.order.push("fetch");
    stub.asked.push(id);
    if (stub.failure) throw stub.failure;
    return stub.trace;
  },
}));

const { default: AiCallDetailPage } = await import("./page");

const TRACE_ID = "aa000000-0001-4a00-8000-000000000001";
const WORKER_ID = "5eeded00-0001-4a00-8000-000000000001";
const SESSION_ID = "5e550000-0001-4a00-8000-000000000001";

/**
 * The worker's own words, in the shape they are actually stored in — a serialised request body
 * with the turn inside it. The name and the phone number are deliberate: this is precisely what
 * the screen shows and what every control on the route exists for, and a lorem-ipsum fixture
 * would let each assertion below pass while saying nothing about the case that matters.
 */
const PROMPT = '{"messages":[{"role":"user","text":"Mera naam Ramesh hai, 98765 43210"}]}';
const RESPONSE = '{"reply":"Theek hai Ramesh."}';

const TRACE = {
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
  prompt_chars: 74,
  response_chars: 29,
  real_call: true,
  success: true,
  error_code: null,
  created_at: "2026-08-19T09:00:00.000Z",
  prompt: PROMPT,
  response: RESPONSE,
};

beforeEach(() => {
  stub.order.length = 0;
  stub.asked.length = 0;
  stub.trace = TRACE;
  stub.failure = null;
  stub.capabilities = ["read_entities", "read_ai_traces"];
});

const render = async (id: string = TRACE_ID) =>
  renderToStaticMarkup(await AiCallDetailPage({ params: Promise.resolve({ id }) }));

describe("the gate", () => {
  it("requires read_entities BEFORE anything is read", async () => {
    await render();
    expect(stub.order).toEqual(["gate:read_entities", "fetch"]);
  });

  it("asks for exactly the id in the path, and nothing else", async () => {
    await render();
    expect(stub.asked).toEqual([TRACE_ID]);
  });
});

describe("a session without read_ai_traces", () => {
  beforeEach(() => {
    stub.capabilities = ["read_entities"];
  });

  it("makes NO REQUEST AT ALL", async () => {
    // Not merely a hidden control. A fetch here would earn a 403 and spend a round trip to
    // learn what the session already said — on a route where every call is metered and logged.
    await render();
    expect(stub.asked).toEqual([]);
    expect(stub.order).toEqual(["gate:read_entities"]);
  });

  it("says plainly that the role cannot read the text, and points at the model", async () => {
    const out = await render();
    expect(out).toContain("Your role cannot read the text of an AI call");
    expect(out).toContain('href="/roles"');
    expect(out).toContain('href="/ai-calls"');
  });

  it("renders no part of the call, and no caveat about text it is not showing", async () => {
    const out = await render();
    expect(out).not.toContain("Ramesh");
    expect(out).not.toContain("Treat everything below as identifying");
  });
});

describe("the server says 403 — the session list and the guard disagree", () => {
  it("renders the same screen as a missing capability", async () => {
    stub.failure = new stub.ForbiddenError();
    const out = await render();
    expect(out).toContain("Your role cannot read the text of an AI call");
    expect(out).not.toContain("This call&#x27;s text is not available");
  });
});

describe("a malformed id", () => {
  it("says the id is wrong, which is the one thing that will fix it", async () => {
    // Distinguishable and worth distinguishing: the validation pipe rejects a non-uuid before
    // any of the route's controls are consulted, so this answer is available whatever the
    // feature's state and leaks nothing about it.
    stub.failure = new stub.RequestError(400);
    const out = await render("not-a-uuid");
    expect(out).toContain("That is not a call id");
    expect(out).not.toContain("This call&#x27;s text is not available");
  });
});

/**
 * ⚠ THE LOAD-BEARING GROUP. Every assertion here is about a sentence NOT being written.
 */
describe("the neutral 404", () => {
  beforeEach(() => {
    stub.failure = new stub.RequestError(404);
  });

  it("renders as `not available`, and says the ambiguity is deliberate", async () => {
    const out = await render();
    expect(out).toContain("This call&#x27;s text is not available");
    expect(out).toContain("not possible to tell which from here");
  });

  it("is NOT an error state", async () => {
    // `state--error` is the portal's "something broke" style, and nothing here broke. Painting
    // it red sends an operator to raise an incident against a working system.
    const out = await render();
    expect(out).not.toContain("state--error");
    expect(out).toContain("Nothing has failed");
  });

  it("never claims the operator lacks permission", async () => {
    // False in three of the four situations this one answer covers — and this page has already
    // established that the session HOLDS the capability, so it is false here in particular.
    const out = await render().then((s) => s.toLowerCase());
    for (const phrase of [
      "you do not have permission",
      "not permitted",
      "your role cannot",
      "denied",
      "forbidden",
      "unauthorised",
      "unauthorized",
    ]) {
      expect(out, `the neutral 404 must not say "${phrase}"`).not.toContain(phrase);
    }
  });

  it("never asserts which of the situations applies", async () => {
    // The three wrong answers, each of which would be a lie in most of the cases it covers —
    // and the third would answer the exact question the neutral 404 refuses.
    const out = await render().then((s) => s.toLowerCase());
    for (const phrase of [
      "does not exist",
      "no such call",
      "has been deleted",
      "is switched off",
      "is disabled",
      "is turned off",
      "you have used up",
    ]) {
      expect(out, `the neutral 404 must not assert "${phrase}"`).not.toContain(phrase);
    }
  });

  it("offers the way back rather than a retry that would spend another read", async () => {
    const out = await render();
    expect(out).toContain("Back to AI calls");
    expect(out).not.toContain(">Retry<");
  });
});

describe("the successful read", () => {
  it("renders both halves VERBATIM — this is what the screen is for", async () => {
    const out = await render();
    expect(out).toContain("Mera naam Ramesh hai, 98765 43210");
    expect(out).toContain("Theek hai Ramesh.");
    // In the wrapping code block, not the nowrap one: a serialised body on a single line is a
    // transcript nobody can read without dragging a scrollbar for a screen and a half.
    expect(out).toContain('class="code code--wrap"');
  });

  it("renders the caveat ABOVE the words, every time", async () => {
    const out = await render();
    expect(out).toContain("Read this as the worker&#x27;s own words.");
    expect(out).toContain("Treat everything below as identifying");
    expect(out.indexOf("Treat everything below as identifying")).toBeLessThan(
      out.indexOf("Mera naam Ramesh"),
    );
  });

  it("states the controls that exist, including that this read is already recorded", async () => {
    const out = await render();
    expect(out).toContain("encrypted in the database");
    expect(out).toContain("no search over it and no export");
    expect(out).toContain("before anything is decrypted");
  });

  it("promises nothing about identity having been removed", async () => {
    // The defect class this whole surface is guarded against: a tooltip once told an operator
    // "every id is replaced" while an Aadhaar number sat on the screen.
    const out = await render().then((s) => s.toLowerCase());
    for (const claim of [
      "are removed",
      "is removed",
      "are replaced",
      "is replaced",
      "are redacted",
      "is redacted",
      "anonymised",
      "anonymized",
      "safe to share",
      "contains no",
    ]) {
      expect(out, `the detail screen must not claim "${claim}"`).not.toContain(claim);
    }
  });

  it("shows the call's scalars, and links the worker and the session", async () => {
    const out = await render();
    expect(out).toContain("gemini-2.5-flash");
    expect(out).toContain(`href="/workers/${WORKER_ID}"`);
    expect(out).toContain(`href="/workers/${WORKER_ID}/journey/${SESSION_ID}"`);
    expect(out).toContain('href="/events?correlationId=req-9fd0b09"');
  });

  it("explains the NULL prompt template rather than dashing it", async () => {
    // A bare em dash would read as "no template was used". One was; this app is simply never
    // told which, and naming the reason is the difference between a bug report and understanding.
    const out = await render();
    expect(out).toContain("the AI service does not report which template it used back to this API");
  });
});

describe("the three states of one half of a call", () => {
  it("a stored half renders its text", async () => {
    expect(await render()).toContain("Theek hai Ramesh.");
  });

  it("null text with NO length says nothing was ever stored — and is not an error", async () => {
    // Speech-to-text sends audio and has no request text; a call that failed before answering
    // has no reply. Both are ordinary.
    stub.trace = { ...TRACE, prompt: null, prompt_chars: null };
    const out = await render();
    expect(out).toContain("Nothing was stored here");
    expect(out).toContain("speech-to-text sends audio");
    expect(out).not.toContain("Stored, but it could not be read back");
  });

  it("null text WITH a length says it was stored and did not come back", async () => {
    // The distinction the server cannot make and this page can: the writer derives the length
    // and the ciphertext from the same value, so a recorded length is proof text was written.
    // Reporting a key-rotation failure as an empty field stops the operator escalating.
    stub.trace = { ...TRACE, prompt: null };
    const out = await render();
    expect(out).toContain("Stored, but it could not be read back");
    expect(out).toContain("74 characters were recorded");
    expect(out).toContain("key it was written under has since been retired");
    // …and the metadata above it is explicitly unaffected, so the screen is still useful.
    expect(out).toContain("gemini-2.5-flash");
  });

  it("a length of ZERO still reads as stored, not as absent", async () => {
    stub.trace = { ...TRACE, response: null, response_chars: 0 };
    const out = await render();
    expect(out).toContain("Stored, but it could not be read back");
  });
});

/**
 * `globals.css` carries its own scar for this: a className rendered with NO RULE behind it
 * "passed every gate while rendering wrong", because nothing in the toolchain links a class name
 * to a stylesheet. Here the consequence is a stored request body — one serialised line, tens of
 * thousands of characters — laid out under `.code`'s `overflow-x: auto`, i.e. a transcript
 * readable only by dragging a horizontal scrollbar for a screen and a half per sentence, during
 * the incident it was opened for.
 */
describe("the code block really does wrap", () => {
  const dir = new URL(".", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1");
  const css = readFileSync(join(dir, "../../../globals.css"), "utf8");

  const ruleFor = (selector: string) => {
    const start = css.indexOf(selector);
    expect(start, `no rule declares \`${selector}\``).toBeGreaterThan(-1);
    return css.slice(start, css.indexOf("}", start));
  };

  it("undoes the horizontal scroll `.code` sets, and breaks anywhere", () => {
    // Matched WITH its brace. Without it the lookup is a prefix search and renaming the rule to
    // `.code--wrapped` — exactly the bug this asserts against — would still match.
    const rule = ruleFor(".code--wrap {");
    expect(rule).toMatch(/white-space:\s*pre-wrap/);
    expect(rule).toMatch(/overflow-wrap:\s*anywhere/);
    expect(rule).toMatch(/overflow-x:\s*hidden/);
  });

  it("bounds the height and SCROLLS it — nothing is clipped away", () => {
    // A 40 000-character body would otherwise push every scrap of metadata off the screen and
    // leave no way back to the row it describes. `auto`, never `hidden`: every character stays
    // reachable, which is the same ruling `.cell--message` makes about a worker's complaint.
    const rule = ruleFor(".code--wrap {");
    expect(rule).toMatch(/max-block-size:\s*\d+vh/);
    expect(rule).toMatch(/overflow-y:\s*auto/);
  });
});
