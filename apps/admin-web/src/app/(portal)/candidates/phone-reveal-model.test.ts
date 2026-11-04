import { describe, expect, it, vi } from "vitest";
import { RECORD_WORKER_ID } from "../../../../test/candidate-record";
import { narrowRevealOutcome, phoneHref, requestPhoneReveal } from "./phone-reveal-model";
import { REVEAL_FAILED, REVEAL_NOTE_REFUSED, REVEAL_UNAVAILABLE } from "./reveal-messages";

/**
 * A7 (#2577) — the drawer's phone reveal from the browser: a plain fetch to the same-origin route
 * (never a server action, which a Back or Forward would discard), JSON carrying only the reason
 * code and the explanation, and an answer narrowed so only the reveal's own sentences reach the
 * screen.
 */
const REASON = { category: "worker_support_callback", text: "Worker asked for a call back" };
const reply = (body: unknown, status = 200) =>
  vi.fn(async () => new Response(typeof body === "string" ? body : JSON.stringify(body), { status }));

describe("the request", () => {
  it("is the same-origin route, the id encoded", () => {
    expect(phoneHref(RECORD_WORKER_ID)).toBe(`/candidates/${RECORD_WORKER_ID}/phone`);
    expect(phoneHref("0b7f/../x")).toBe("/candidates/0b7f%2F..%2Fx/phone");
  });

  it("POSTs JSON — the reason code and the explanation, nothing else — never cached", async () => {
    const fetchImpl = reply({ ok: true, phone: "+919800000001" });
    await requestPhoneReveal(RECORD_WORKER_ID, REASON, fetchImpl as unknown as typeof fetch);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe(`/candidates/${RECORD_WORKER_ID}/phone`);
    expect(init).toMatchObject({
      method: "POST",
      cache: "no-store",
      headers: { accept: "application/json", "content-type": "application/json" },
    });
    expect(JSON.parse(init.body as string)).toEqual({
      reason_code: "worker_support_callback",
      note: "Worker asked for a call back",
    });
  });
});

describe("the answer", () => {
  it("the phone, from a 200", async () => {
    const fetchImpl = reply({ ok: true, phone: "+919800000001" });
    expect(await requestPhoneReveal(RECORD_WORKER_ID, REASON, fetchImpl as unknown as typeof fetch)).toEqual({
      ok: true,
      phone: "+919800000001",
    });
  });

  it("a refusal, in the route's own sentence", async () => {
    const fetchImpl = reply({ ok: false, error: REVEAL_UNAVAILABLE }, 404);
    expect(await requestPhoneReveal(RECORD_WORKER_ID, REASON, fetchImpl as unknown as typeof fetch)).toEqual({
      ok: false,
      error: REVEAL_UNAVAILABLE,
    });
  });

  it("a failed request is the honest failure, never a throw", async () => {
    const down = vi.fn(async () => {
      throw new TypeError("fetch failed");
    });
    expect(await requestPhoneReveal(RECORD_WORKER_ID, REASON, down as unknown as typeof fetch)).toEqual({
      ok: false,
      error: REVEAL_FAILED,
    });
  });

  it("an answer that is not JSON (a proxy's HTML page) is the honest failure", async () => {
    const html = reply("<html><body>502 Bad Gateway</body></html>", 502);
    expect(await requestPhoneReveal(RECORD_WORKER_ID, REASON, html as unknown as typeof fetch)).toEqual({
      ok: false,
      error: REVEAL_FAILED,
    });
  });
});

describe("narrowRevealOutcome — only the reveal's own words reach the screen", () => {
  it("keeps the phone and the reveal's own sentences", () => {
    expect(narrowRevealOutcome({ ok: true, phone: "+919800000001" })).toEqual({ ok: true, phone: "+919800000001" });
    expect(narrowRevealOutcome({ ok: false, error: REVEAL_NOTE_REFUSED })).toEqual({
      ok: false,
      error: REVEAL_NOTE_REFUSED,
    });
  });

  it("any other text is replaced — a proxy's, an intermediary's, the API's", () => {
    for (const error of ["no healthy upstream admin-api.internal:3001", "worker 0b7f has no phone", ""]) {
      expect(narrowRevealOutcome({ ok: false, error })).toEqual({ ok: false, error: REVEAL_FAILED });
    }
  });

  it("anything that is not the envelope is the honest failure", () => {
    for (const body of [null, "<html>", 42, {}, { ok: true }, { ok: true, phone: "" }, { ok: true, phone: 9 }, { ok: "yes" }]) {
      expect(narrowRevealOutcome(body), JSON.stringify(body)).toEqual({ ok: false, error: REVEAL_FAILED });
    }
  });
});
