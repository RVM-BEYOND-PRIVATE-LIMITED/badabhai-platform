import { beforeEach, describe, expect, it, vi } from "vitest";
import { RECORD_WORKER_ID } from "../../../../../../test/candidate-record";

/**
 * A7 (#2577) — the drawer's correction routes: same-origin, JSON, one fact per POST, a reason of
 * 15–500 characters, and reason history on the GET. The API holds the role and the correction
 * rules; these tests pin the portal's forwarding contract.
 */
const correction = vi.hoisted(() => ({
  create: vi.fn(),
  read: vi.fn(),
}));
vi.mock("../../../../../lib/candidate-corrections", () => ({
  createCandidateCorrection: correction.create,
  readCorrectionHistory: correction.read,
}));

const { GET, POST } = await import("./route");

const json = (body: unknown, headers: Record<string, string> = {}) =>
  new Request(`http://admin.test/candidates/${RECORD_WORKER_ID}/corrections`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "sec-fetch-site": "same-origin",
      origin: "http://admin.test",
      host: "admin.test",
      ...headers,
    },
    body: JSON.stringify(body),
  });
const call = (request: Request) =>
  POST(request, { params: Promise.resolve({ id: RECORD_WORKER_ID }) });

const REASON = "The worker called support and asked for this correction.";

beforeEach(() => {
  correction.create.mockReset();
  correction.read.mockReset();
});

describe("POST a correction", () => {
  it("forwards ONE fact and the operator's reason, and never caches the answer", async () => {
    correction.create.mockResolvedValue({
      worker_id: RECORD_WORKER_ID,
      fact_key: "current_city",
      override_id: "ov-1",
      changed: true,
    });
    const res = await call(
      json({
        fact_key: "current_city",
        value: "Pune",
        reason_code: "worker_request",
        reason_text: REASON,
      }),
    );
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(await res.json()).toEqual({
      ok: true,
      result: {
        worker_id: RECORD_WORKER_ID,
        fact_key: "current_city",
        override_id: "ov-1",
        changed: true,
      },
    });
    expect(correction.create).toHaveBeenCalledWith(RECORD_WORKER_ID, "current_city", "Pune", {
      reason_code: "worker_request",
      reason_text: REASON,
    });
  });

  it("refuses a reason shorter than 15 characters before it reaches the API", async () => {
    const res = await call(
      json({
        fact_key: "current_city",
        value: "Pune",
        reason_code: "worker_request",
        reason_text: "too short",
      }),
    );
    expect(res.status).toBe(400);
    expect(correction.create).not.toHaveBeenCalled();
  });

  it("refuses a request from another site, and one that is not JSON", async () => {
    const crossSite = await call(
      json(
        {
          fact_key: "current_city",
          value: "Pune",
          reason_code: "worker_request",
          reason_text: REASON,
        },
        {
          "sec-fetch-site": "cross-site",
        },
      ),
    );
    expect(crossSite.status).toBe(403);
    expect(correction.create).not.toHaveBeenCalled();

    const notJson = await call(
      new Request(`http://admin.test/candidates/${RECORD_WORKER_ID}/corrections`, {
        method: "POST",
        headers: { "sec-fetch-site": "same-origin", "content-type": "text/plain" },
        body: "{}",
      }),
    );
    expect(notJson.status).toBe(415);
    expect(correction.create).not.toHaveBeenCalled();
  });
});

describe("GET the reason history", () => {
  it("answers the parsed history, never cached", async () => {
    correction.read.mockResolvedValue({
      worker_id: RECORD_WORKER_ID,
      items: [
        {
          override_id: "ov-1",
          fact_key: "current_city",
          admin_id: "admin-1",
          reason_code: "worker_request",
          reason_text: REASON,
          created_at: "2026-11-06T10:00:00.000Z",
          superseded_at: null,
          superseded_by_id: null,
          live: true,
        },
      ],
    });
    const res = await GET(
      new Request(`http://admin.test/candidates/${RECORD_WORKER_ID}/corrections`, {
        headers: { "sec-fetch-site": "same-origin" },
      }),
      { params: Promise.resolve({ id: RECORD_WORKER_ID }) },
    );
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(await res.json()).toMatchObject({ ok: true, history: { worker_id: RECORD_WORKER_ID } });
  });

  it("refuses a cross-site history read (reason text is editor-only)", async () => {
    const res = await GET(
      new Request(`http://admin.test/candidates/${RECORD_WORKER_ID}/corrections`, {
        headers: { "sec-fetch-site": "cross-site" },
      }),
      { params: Promise.resolve({ id: RECORD_WORKER_ID }) },
    );
    expect(res.status).toBe(403);
    expect(correction.read).not.toHaveBeenCalled();
  });
});
