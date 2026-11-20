import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * #2984 §4 — the follow-up seam's transport contract.
 *
 * Pinned over the REAL `payerFetch`:
 *  - `GET /payer/unlock-outcomes/due` sends only `limit` / `cursor`, maps the faceless wire rows,
 *    and maps 404 → `off` (hide the control) while 429/5xx → `retry`.
 *  - `POST /payer/unlocks/:unlockId/outcome` sends ONLY `{ outcome }` (XB-A: no payer id), carries
 *    the caller's `Idempotency-Key` header, and maps the recorded answer back.
 */

const TOKEN = "payer.jwt.token";

vi.mock("./auth/session-cookie", () => ({
  readApiToken: vi.fn(async () => TOKEN),
  API_TOKEN_COOKIE_NAME: "bb_payer_token",
  sessionCookieOptions: () => ({}),
}));

const fetchMock = vi.fn();

beforeEach(() => {
  process.env.PAYER_API_URL = "http://api.test";
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

const UNLOCK_ID = "22222222-2222-4222-8222-222222222222";
const WORKER_ID = "44444444-4444-4444-8444-444444444444";

describe("getDueUnlockOutcomes — the due list", () => {
  it("GETs the paged route with the caller's limit/cursor, and maps the faceless rows", async () => {
    fetchMock.mockResolvedValue(
      jsonResponse({
        items: [
          {
            unlock_id: UNLOCK_ID,
            worker_id: WORKER_ID,
            granted_at: "2026-10-01T09:00:00.000Z",
            outcome: null,
          },
          {
            unlock_id: "33333333-3333-4333-8333-333333333333",
            worker_id: "55555555-5555-4555-8555-555555555555",
            granted_at: "2026-10-02T09:00:00.000Z",
            outcome: "still_talking",
          },
        ],
        nextCursor: "cursor-2",
      }),
    );
    const { getDueUnlockOutcomes } = await import("./payer-api");
    const result = await getDueUnlockOutcomes({ limit: 5, cursor: "cursor-1" });

    expect(result).toEqual({
      status: "ok",
      items: [
        {
          unlockId: UNLOCK_ID,
          workerId: WORKER_ID,
          grantedAt: "2026-10-01T09:00:00.000Z",
          outcome: null,
        },
        {
          unlockId: "33333333-3333-4333-8333-333333333333",
          workerId: "55555555-5555-4555-8555-555555555555",
          grantedAt: "2026-10-02T09:00:00.000Z",
          outcome: "still_talking",
        },
      ],
      nextCursor: "cursor-2",
    });

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("http://api.test/payer/unlock-outcomes/due?limit=5&cursor=cursor-1");
    expect(init.method ?? "GET").toBe("GET");
    expect(init.body).toBeUndefined();
    expect((init.headers as Record<string, string>).authorization).toBe(`Bearer ${TOKEN}`);
  });

  it("omits both query keys when the caller names none", async () => {
    fetchMock.mockResolvedValue(jsonResponse({ items: [], nextCursor: null }));
    const { getDueUnlockOutcomes } = await import("./payer-api");
    await getDueUnlockOutcomes();
    const [url] = fetchMock.mock.calls[0] as [string];
    expect(url).toBe("http://api.test/payer/unlock-outcomes/due");
  });

  it("maps a 404 to `off` — the switch is off, so the control hides", async () => {
    fetchMock.mockResolvedValue(jsonResponse({}, 404));
    const { getDueUnlockOutcomes } = await import("./payer-api");
    expect(await getDueUnlockOutcomes()).toEqual({ status: "off" });
  });

  it.each([429, 500, 503])("maps a %i to the retryable state", async (status) => {
    fetchMock.mockResolvedValue(jsonResponse({}, status));
    const { getDueUnlockOutcomes } = await import("./payer-api");
    expect(await getDueUnlockOutcomes()).toEqual({ status: "retry" });
  });

  it("maps an unparsable body to retry, never a partial list", async () => {
    fetchMock.mockResolvedValue(jsonResponse({ items: [{ unlock_id: "not-a-uuid" }] }));
    const { getDueUnlockOutcomes } = await import("./payer-api");
    expect(await getDueUnlockOutcomes()).toEqual({ status: "retry" });
  });
});

describe("recordUnlockOutcome — the answer", () => {
  it("POSTs only the outcome, with the Idempotency-Key header, and maps the answer back", async () => {
    fetchMock.mockResolvedValue(
      jsonResponse({
        unlock_id: UNLOCK_ID,
        worker_id: WORKER_ID,
        outcome: "hired",
        previous_outcome: "still_talking",
        answered_at: "2026-10-10T09:00:00.000Z",
        changed: true,
      }),
    );
    const { recordUnlockOutcome } = await import("./payer-api");
    const result = await recordUnlockOutcome({
      unlockId: UNLOCK_ID,
      outcome: "hired",
      idempotencyKey: "answer-key-1",
    });

    expect(result).toEqual({
      unlockId: UNLOCK_ID,
      workerId: WORKER_ID,
      outcome: "hired",
      previousOutcome: "still_talking",
      answeredAt: "2026-10-10T09:00:00.000Z",
      changed: true,
    });

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(`http://api.test/payer/unlocks/${UNLOCK_ID}/outcome`);
    expect(init.method).toBe("POST");
    const headers = init.headers as Record<string, string>;
    expect(headers.authorization).toBe(`Bearer ${TOKEN}`);
    expect(headers["Idempotency-Key"]).toBe("answer-key-1");
    const body = JSON.parse(init.body as string) as Record<string, unknown>;
    expect(body).toEqual({ outcome: "hired" });
    // XB-A: the session is the payer — no payer/worker/posting id rides along.
    expect(Object.keys(body)).toEqual(["outcome"]);
  });

  it("accepts a first answer (previous_outcome null) and a repeat (changed false)", async () => {
    fetchMock.mockResolvedValue(
      jsonResponse({
        unlock_id: UNLOCK_ID,
        worker_id: WORKER_ID,
        outcome: "still_talking",
        previous_outcome: null,
        answered_at: "2026-10-10T09:00:00.000Z",
        changed: true,
      }),
    );
    const { recordUnlockOutcome } = await import("./payer-api");
    const first = await recordUnlockOutcome({
      unlockId: UNLOCK_ID,
      outcome: "still_talking",
      idempotencyKey: "answer-key-2",
    });
    expect(first.previousOutcome).toBeNull();
    expect(first.changed).toBe(true);

    fetchMock.mockResolvedValueOnce(
      jsonResponse({
        unlock_id: UNLOCK_ID,
        worker_id: WORKER_ID,
        outcome: "still_talking",
        previous_outcome: "still_talking",
        answered_at: "2026-10-10T09:00:00.000Z",
        changed: false,
      }),
    );
    const repeat = await recordUnlockOutcome({
      unlockId: UNLOCK_ID,
      outcome: "still_talking",
      idempotencyKey: "answer-key-2",
    });
    expect(repeat.changed).toBe(false);
  });

  it("lets the transport's typed statuses through (the action maps them)", async () => {
    fetchMock.mockResolvedValue(jsonResponse({}, 404));
    const { recordUnlockOutcome } = await import("./payer-api");
    await expect(
      recordUnlockOutcome({
        unlockId: UNLOCK_ID,
        outcome: "not_hired",
        idempotencyKey: "answer-key-3",
      }),
    ).rejects.toBeInstanceOf(Error);
  });
});
