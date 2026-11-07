import { beforeEach, describe, expect, it, vi } from "vitest";
import { RECORD_WORKER_ID } from "../../../../../../../test/candidate-record";

/**
 * A7 (#2577) — the drawer's account-action route (#2562): the action names the API path and its
 * closed reason code, the operator supplies only the explanation, and a cross-site or non-JSON
 * request never reaches the API.
 */
const account = vi.hoisted(() => ({ run: vi.fn() }));
vi.mock("../../../../../../lib/candidate-account", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    performWorkerAccountAction: account.run,
  };
});

const { POST } = await import("./route");

const call = (action: string, body: unknown, headers: Record<string, string> = {}) =>
  POST(
    new Request(`http://admin.test/candidates/${RECORD_WORKER_ID}/account/${action}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "sec-fetch-site": "same-origin",
        origin: "http://admin.test",
        host: "admin.test",
        ...headers,
      },
      body: JSON.stringify(body),
    }),
    { params: Promise.resolve({ id: RECORD_WORKER_ID, action }) },
  );

const REASON = "The worker called support and asked us to end the old sessions.";

beforeEach(() => account.run.mockReset());

describe("a governed account action", () => {
  it("maps sign-out-all to its API action and reason, and returns the result", async () => {
    account.run.mockResolvedValue({ target_id: RECORD_WORKER_ID, changed: true });
    const res = await call("sign-out-all", { reason_text: REASON });
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(await res.json()).toMatchObject({ ok: true, result: { changed: true } });
    expect(account.run).toHaveBeenCalledWith(RECORD_WORKER_ID, "sign-out-all", REASON);
  });

  it("refuses an action this page does not offer, before the API", async () => {
    const res = await call("delete-everything", { reason_text: REASON });
    expect(res.status).toBe(400);
    expect(account.run).not.toHaveBeenCalled();
  });

  it("refuses a short reason and a cross-site request", async () => {
    expect((await call("pin-reset", { reason_text: "short" })).status).toBe(400);
    expect(
      (await call("pin-reset", { reason_text: REASON }, { "sec-fetch-site": "cross-site" })).status,
    ).toBe(403);
    expect(account.run).not.toHaveBeenCalled();
  });
});
