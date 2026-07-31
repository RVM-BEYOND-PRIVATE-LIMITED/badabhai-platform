import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  jobPostingChatDraftWireSchema,
  jobPostingChatMessageInputSchema,
  jobPostingChatSessionListWireSchema,
  jobPostingChatTurnWireSchema,
  toJobPostingChatSessions,
  toJobPostingChatTurn,
  toJobPostingDraft,
  POSTING_VACANCY_BANDS,
} from "./contracts";

/**
 * AI JOB-POSTING CHAT seam tests (ADR-0035) — the five frozen payer-authed endpoints.
 *
 * These exercise the REAL HTTP transport (`payerFetch`) with a mocked `fetch` + a mocked
 * payer-JWT cookie, pinning the things that are NOT allowed to drift:
 *
 *  - TENANCY (XB-A): no request body EVER carries a `payer_id` — the identity rides ONLY
 *    the Bearer token from the server-held session cookie. The message body is EXACTLY
 *    `{ session_id, text }`; session-start and publish send an empty body.
 *  - ORG NAME (ADR-0035 §Decision 3 / rule A): the payer's company name is never asked in
 *    the chat, so `org_label` appears in NO request body and is NOT a field of the draft
 *    contract at all (unlike the manual `POST /payer/job-postings` create body).
 *  - VACANCY BANDING (ADR-0012 / rule B): the draft's `vacancy_band` is the BACKEND band
 *    enum; a raw integer count is rejected by the contract.
 *  - NEUTRALITY: an unknown OR not-owned session id returns the same neutral 404 → `null`
 *    (no cross-tenant existence oracle), matching the #349 hydration pattern.
 */

const TOKEN = "payer.jwt.token";
const SESSION_ID = "aaaa1111-0000-4000-8000-000000000001";
const POSTING_ID = "bbbb2222-0000-4000-8000-000000000002";

vi.mock("./auth/session-cookie", () => ({
  readApiToken: vi.fn(async () => TOKEN),
  API_TOKEN_COOKIE_NAME: "bb_payer_token",
  sessionCookieOptions: () => ({}),
}));
vi.mock("./auth", () => ({
  requirePayer: vi.fn(async () => ({
    payerId: "11111111-1111-4111-8111-111111111111",
    displayLabel: "Acme",
    role: "employer",
  })),
}));

const fetchMock = vi.fn();

beforeEach(() => {
  process.env.PAYER_API_URL = "http://api.test";
  process.env.PAYMENTS_ENABLE_REAL = "false";
  vi.stubGlobal("fetch", fetchMock);
  fetchMock.mockReset();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

/** A healthy engine-turn wire body (the shape both POST …/session and …/message return). */
function turnBody(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    session_id: SESSION_ID,
    status: "active",
    reply_text: "How many people do you need?",
    suggested_replies: ["Just 1", "2-5", "6-10"],
    draft: draftBody(),
    draft_ready: false,
    message_id: "cccc3333-0000-4000-8000-000000000003",
    ...over,
  };
}

function draftBody(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    role_title: "CNC Machinist",
    trade_key: "cnc_operator",
    skill_phrases: ["vmc", "fanuc"],
    location_label: "Pune, MH",
    vacancy_band: "6-10",
    pay_min: 20000,
    pay_max: 35000,
    shift: "night",
    benefits: ["PF", "canteen"],
    requirements: ["ITI"],
    description: "Two-shift CNC role, PPE provided.",
    confidence: 0.8,
    missing_fields: [],
    clarification_questions: [],
    ...over,
  };
}

function lastCall(): { url: string; init: RequestInit } {
  const calls = fetchMock.mock.calls as Array<[string, RequestInit]>;
  const call = calls[calls.length - 1];
  if (!call) throw new Error("fetch was never called");
  return { url: call[0], init: call[1] };
}

function bodyOf(init: RequestInit): Record<string, unknown> {
  return JSON.parse((init.body as string) ?? "{}") as Record<string, unknown>;
}

/* ── 1. Tenancy + the frozen request bodies ─────────────────────────────────────── */

describe("startJobPostingChatSession — POST /payer/job-posting-chat/session", () => {
  it("POSTs an EMPTY body with the Bearer token (no payer_id, no org_label)", async () => {
    fetchMock.mockResolvedValue(jsonResponse(turnBody()));
    const { startJobPostingChatSession } = await import("./payer-api");
    const turn = await startJobPostingChatSession();

    const { url, init } = lastCall();
    expect(url).toBe("http://api.test/payer/job-posting-chat/session");
    expect(init.method).toBe("POST");
    expect((init.headers as Record<string, string>).authorization).toBe(`Bearer ${TOKEN}`);
    expect(Object.keys(bodyOf(init))).toEqual([]);
    expect(init.body as string).not.toMatch(/payer_id|org_label|org_name/);

    expect(turn.sessionId).toBe(SESSION_ID);
    expect(turn.suggestedReplies).toEqual(["Just 1", "2-5", "6-10"]);
  });
});

describe("sendJobPostingChatMessage — POST /payer/job-posting-chat/message", () => {
  it("sends EXACTLY { session_id, text } — never a payer_id, never an org label", async () => {
    fetchMock.mockResolvedValue(jsonResponse(turnBody({ draft_ready: true })));
    const { sendJobPostingChatMessage } = await import("./payer-api");
    const turn = await sendJobPostingChatMessage({ sessionId: SESSION_ID, text: "I need 6 people" });

    const { url, init } = lastCall();
    expect(url).toBe("http://api.test/payer/job-posting-chat/message");
    const body = bodyOf(init);
    expect(Object.keys(body).sort()).toEqual(["session_id", "text"]);
    expect(body.session_id).toBe(SESSION_ID);
    expect(body).not.toHaveProperty("payer_id");
    expect(body).not.toHaveProperty("org_label");
    expect(JSON.stringify(body)).not.toMatch(/payer_id|org_label/);

    expect(turn?.draftReady).toBe(true);
  });

  it("maps the neutral 404 (unknown OR not-owned) to null — no existence oracle", async () => {
    fetchMock.mockResolvedValue(jsonResponse({ message: "Not Found" }, 404));
    const { sendJobPostingChatMessage } = await import("./payer-api");
    await expect(
      sendJobPostingChatMessage({ sessionId: SESSION_ID, text: "hi" }),
    ).resolves.toBeNull();
  });
});

describe("getJobPostingChatSessions — GET /payer/job-posting-chat/sessions", () => {
  it("reads the caller's OWN sessions (Bearer only, no query/body tenancy) newest-first", async () => {
    fetchMock.mockResolvedValue(
      jsonResponse([
        {
          session_id: SESSION_ID,
          status: "active",
          draft_ready: false,
          role_title: "CNC Machinist",
          started_at: "2026-07-20T00:00:00.000Z",
          last_message_at: "2026-07-20T09:00:00.000Z",
          published_job_posting_id: null,
        },
        {
          session_id: "aaaa1111-0000-4000-8000-000000000009",
          status: "draft_ready",
          draft_ready: true,
          role_title: "Fitter",
          started_at: "2026-07-25T00:00:00.000Z",
          last_message_at: "2026-07-26T09:00:00.000Z",
          published_job_posting_id: null,
        },
      ]),
    );
    const { getJobPostingChatSessions } = await import("./payer-api");
    const sessions = await getJobPostingChatSessions();

    const { url, init } = lastCall();
    expect(url).toBe("http://api.test/payer/job-posting-chat/sessions");
    expect(init.method ?? "GET").toBe("GET");
    expect(init.body).toBeUndefined();
    // Most recently active first — the cross-device "continue where you left off" order.
    expect(sessions.map((s) => s.roleTitle)).toEqual(["Fitter", "CNC Machinist"]);
    expect(sessions[0]?.draftReady).toBe(true);
  });

  it("accepts BOTH list conventions: a bare array and { sessions: [...] }", () => {
    const row = {
      session_id: SESSION_ID,
      status: "active",
      started_at: "2026-07-20T00:00:00.000Z",
    };
    expect(
      toJobPostingChatSessions(jobPostingChatSessionListWireSchema.parse([row])),
    ).toHaveLength(1);
    expect(
      toJobPostingChatSessions(jobPostingChatSessionListWireSchema.parse({ sessions: [row] })),
    ).toHaveLength(1);
  });
});

describe("getJobPostingChatTranscript — GET …/sessions/:id/messages", () => {
  it("hydrates the transcript and maps direction → who said it", async () => {
    fetchMock.mockResolvedValue(
      jsonResponse({
        session_id: SESSION_ID,
        status: "active",
        draft: draftBody(),
        draft_ready: false,
        suggested_replies: ["Day", "Night"],
        messages: [
          {
            id: "dddd4444-0000-4000-8000-000000000004",
            direction: "outbound",
            message_type: "text",
            body_text: "What role are you hiring for?",
            created_at: "2026-07-20T00:00:00.000Z",
          },
          {
            id: "dddd4444-0000-4000-8000-000000000005",
            direction: "inbound",
            message_type: "text",
            body_text: "CNC operators",
            created_at: "2026-07-20T00:01:00.000Z",
          },
        ],
      }),
    );
    const { getJobPostingChatTranscript } = await import("./payer-api");
    const transcript = await getJobPostingChatTranscript(SESSION_ID);

    expect(lastCall().url).toBe(
      `http://api.test/payer/job-posting-chat/sessions/${SESSION_ID}/messages`,
    );
    expect(transcript?.messages.map((m) => m.role)).toEqual(["assistant", "payer"]);
    expect(transcript?.messages[1]?.text).toBe("CNC operators");
    expect(transcript?.draft?.vacancyBand).toBe("6-10");
  });

  it("maps the neutral 404 to null", async () => {
    fetchMock.mockResolvedValue(jsonResponse({ message: "Not Found" }, 404));
    const { getJobPostingChatTranscript } = await import("./payer-api");
    await expect(getJobPostingChatTranscript(SESSION_ID)).resolves.toBeNull();
  });
});

describe("publishJobPostingChatSession — POST …/sessions/:id/publish", () => {
  it("POSTs an EMPTY body (the org name is auto-filled server-side) and returns the posting id", async () => {
    fetchMock.mockResolvedValue(
      jsonResponse({ session_id: SESSION_ID, status: "published", job_posting_id: POSTING_ID }),
    );
    const { publishJobPostingChatSession } = await import("./payer-api");
    const res = await publishJobPostingChatSession(SESSION_ID);

    const { url, init } = lastCall();
    expect(url).toBe(`http://api.test/payer/job-posting-chat/sessions/${SESSION_ID}/publish`);
    expect(init.method).toBe("POST");
    // UNLIKE the manual create body, publish sends NO org_label — the server decrypts
    // payers.orgNameEnc itself, so the company name never crosses the chat/LLM boundary.
    expect(Object.keys(bodyOf(init))).toEqual([]);
    expect(init.body as string).not.toMatch(/org_label|payer_id/);

    expect(res).toEqual({ jobPostingId: POSTING_ID });
  });

  it("maps the neutral 404 to null", async () => {
    fetchMock.mockResolvedValue(jsonResponse({ message: "Not Found" }, 404));
    const { publishJobPostingChatSession } = await import("./payer-api");
    await expect(publishJobPostingChatSession(SESSION_ID)).resolves.toBeNull();
  });
});

/* ── 2. The draft contract — the two design rules, enforced by the schema ───────── */

const parseDraft = (raw: Record<string, unknown>) =>
  toJobPostingDraft(jobPostingChatDraftWireSchema.parse(raw));

describe("the draft contract — rules A + B are structural, not conventional", () => {
  it("has NO org/company-name field, and drops one if a backend ever sent it", () => {
    const parsed = parseDraft({
      ...draftBody(),
      org_label: "Acme Manufacturing",
      org_name: "Acme Manufacturing",
    }) as unknown as Record<string, unknown>;
    for (const k of ["orgLabel", "org_label", "orgName", "org_name", "companyName"]) {
      expect(parsed).not.toHaveProperty(k);
    }
    expect(JSON.stringify(parsed)).not.toMatch(/Acme/);
  });

  it("accepts every ADR-0012 band and REJECTS a raw vacancy integer", () => {
    for (const band of POSTING_VACANCY_BANDS) {
      expect(parseDraft(draftBody({ vacancy_band: band })).vacancyBand).toBe(band);
    }
    expect(
      jobPostingChatDraftWireSchema.safeParse(draftBody({ vacancy_band: 6 })).success,
    ).toBe(false);
    expect(
      jobPostingChatDraftWireSchema.safeParse(draftBody({ vacancy_band: "6" })).success,
    ).toBe(false);
  });

  it("defaults every field so a sparse early-conversation draft still parses", () => {
    const draft = parseDraft({});
    expect(draft.roleTitle).toBeNull();
    expect(draft.vacancyBand).toBeNull();
    expect(draft.skillPhrases).toEqual([]);
    expect(draft.missingFields).toEqual([]);
  });
});

describe("the engine turn contract", () => {
  it("carries the DETERMINISTIC engine's readiness + suggestions (never inferred client-side)", () => {
    const turn = toJobPostingChatTurn(
      jobPostingChatTurnWireSchema.parse(turnBody({ draft_ready: true, status: "draft_ready" })),
    );
    expect(turn.draftReady).toBe(true);
    expect(turn.status).toBe("draft_ready");
    expect(turn.suggestedReplies.length).toBeGreaterThan(0);
  });

  it("tolerates a minimal turn (no draft yet, no suggestions)", () => {
    const turn = toJobPostingChatTurn(
      jobPostingChatTurnWireSchema.parse({
        session_id: SESSION_ID,
        reply_text: "What role are you hiring for?",
      }),
    );
    expect(turn.draft).toBeNull();
    expect(turn.draftReady).toBe(false);
    expect(turn.suggestedReplies).toEqual([]);
  });
});

/* ── 3. The Server Action's input authority (what the client screen mirrors) ────── */

describe("jobPostingChatMessageInputSchema — the server-side turn screen", () => {
  const ok = { sessionId: SESSION_ID, text: "I need 6 CNC operators in Pune" };

  it("accepts a normal job answer", () => {
    expect(jobPostingChatMessageInputSchema.safeParse(ok).success).toBe(true);
  });

  it("screens an OBVIOUS phone/email (the same looksLikePii heuristic as the manual form)", () => {
    expect(
      jobPostingChatMessageInputSchema.safeParse({ ...ok, text: "call me on 98765 43210" }).success,
    ).toBe(false);
    expect(
      jobPostingChatMessageInputSchema.safeParse({ ...ok, text: "email hr@acme.co" }).success,
    ).toBe(false);
  });

  it("rejects an empty / over-long turn and a non-uuid session id", () => {
    expect(jobPostingChatMessageInputSchema.safeParse({ ...ok, text: "   " }).success).toBe(false);
    expect(
      jobPostingChatMessageInputSchema.safeParse({ ...ok, text: "a".repeat(2001) }).success,
    ).toBe(false);
    expect(
      jobPostingChatMessageInputSchema.safeParse({ ...ok, sessionId: "not-a-uuid" }).success,
    ).toBe(false);
  });

  it("has no payer_id / org field to smuggle one through (XB-A + rule A)", () => {
    const parsed = jobPostingChatMessageInputSchema.parse({
      ...ok,
      payer_id: "11111111-1111-4111-8111-111111111111",
      org_label: "Acme Manufacturing",
    }) as Record<string, unknown>;
    expect(Object.keys(parsed).sort()).toEqual(["sessionId", "text"]);
  });
});
