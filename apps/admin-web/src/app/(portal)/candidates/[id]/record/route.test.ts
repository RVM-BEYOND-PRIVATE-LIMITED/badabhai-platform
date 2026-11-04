import { beforeEach, describe, expect, it, vi } from "vitest";
import { candidateRecord, RECORD_WORKER_ID } from "../../../../../../test/candidate-record";

/**
 * A7 (#2577) — `GET /candidates/<id>/record`, the same-origin read the drawer makes from the
 * browser: the record or a bare status, each with its HTTP status, never cached, and refused
 * before any read for a request the browser marks as from another site.
 */
const read = vi.hoisted(() => vi.fn());
vi.mock("../../../../../lib/candidate-detail", () => ({ readCandidateRecord: read }));

const { GET, dynamic } = await import("./route");

const call = (headers: Record<string, string> = { "sec-fetch-site": "same-origin" }, id = RECORD_WORKER_ID) =>
  GET(new Request(`http://admin.test/candidates/${id}/record`, { headers }), {
    params: Promise.resolve({ id }),
  });

beforeEach(() => read.mockReset());

describe("the record read", () => {
  it("answers the record with 200, never cached (it may carry a decrypted name)", async () => {
    const detail = candidateRecord();
    read.mockResolvedValue({ status: "ok", detail });
    const res = await call();
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(await res.json()).toEqual({ status: "ok", detail });
    expect(read).toHaveBeenCalledWith(RECORD_WORKER_ID);
  });

  it.each([
    ["not_found", 404],
    ["forbidden", 403],
    ["signed_out", 401],
    ["error", 502],
  ])("a %s read is that bare status with HTTP %i — never the API's own text", async (status, code) => {
    read.mockResolvedValue({ status });
    const res = await call();
    expect(res.status).toBe(code);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(await res.json()).toEqual({ status });
  });

  it("is rendered per request", () => {
    expect(dynamic).toBe("force-dynamic");
  });
});

describe("a request from another site is refused BEFORE any read", () => {
  it.each(["cross-site", "same-site"])("Sec-Fetch-Site: %s → 403, nothing read", async (site) => {
    const res = await call({ "sec-fetch-site": site });
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ status: "forbidden" });
    expect(read).not.toHaveBeenCalled();
  });

  it("same-origin, a typed-in address (none) and an older browser that sends nothing are read", async () => {
    read.mockResolvedValue({ status: "not_found" });
    await call({ "sec-fetch-site": "same-origin" });
    await call({ "sec-fetch-site": "none" });
    await call({});
    expect(read).toHaveBeenCalledTimes(3);
  });
});
