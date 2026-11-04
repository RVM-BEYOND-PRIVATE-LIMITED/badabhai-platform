import { beforeEach, describe, expect, it, vi } from "vitest";
import { RECORD_WORKER_ID } from "../../../../test/candidate-record";
import {
  REVEAL_BAD_ID,
  REVEAL_FAILED,
  REVEAL_FORBIDDEN,
  REVEAL_NOTE_REFUSED,
  REVEAL_NO_REASON,
  REVEAL_REFUSED,
  REVEAL_SIGNED_OUT,
  REVEAL_UNAVAILABLE,
} from "./reveal-messages";

/**
 * A7 (#2577) — the drawer's phone reveal: the EXISTING reason-gated
 * `POST /admin/workers/:id/reveal-contact` (ADR-0025 Decision 4). What it sends (the closed reason
 * code and the note, never an actor id), what it returns (the phone, nowhere else), and how it
 * fails — with ONE neutral sentence for every 404, so the drawer is no oracle either.
 */
const http = vi.hoisted(() => {
  class AdminUnauthorizedError extends Error {}
  class AdminForbiddenError extends Error {}
  class AdminRequestError extends Error {
    constructor(
      readonly status: number,
      message: string,
      readonly body?: Record<string, unknown>,
    ) {
      super(message);
    }
  }
  return { AdminUnauthorizedError, AdminForbiddenError, AdminRequestError, adminFetch: vi.fn() };
});
vi.mock("../../../lib/admin-http", () => ({
  adminFetch: http.adminFetch,
  isAdminUnauthorized: (e: unknown) => e instanceof http.AdminUnauthorizedError,
  isAdminForbidden: (e: unknown) => e instanceof http.AdminForbiddenError,
  isAdminRequestError: (e: unknown) => e instanceof http.AdminRequestError,
}));

const { revealCandidatePhoneAction } = await import("./actions");

const NOTE = "Worker asked us to call back about a job";

beforeEach(() => http.adminFetch.mockReset());

describe("the reveal request", () => {
  it("POSTs the closed reason code and the trimmed note to the worker's reveal route — no actor id", async () => {
    http.adminFetch.mockResolvedValue({ worker_id: RECORD_WORKER_ID, phone: "+919800000001" });
    await revealCandidatePhoneAction(RECORD_WORKER_ID, "worker_support_callback", `  ${NOTE}  `);
    expect(http.adminFetch).toHaveBeenCalledTimes(1);
    const [path, opts] = http.adminFetch.mock.calls[0]!;
    expect(path).toBe(`/admin/workers/${RECORD_WORKER_ID}/reveal-contact`);
    expect(opts).toMatchObject({ method: "POST" });
    expect(opts.body).toEqual({ reason_code: "worker_support_callback", note: NOTE });
    expect(opts.schema).toBeDefined();
  });

  it("returns the phone — the only place it exists", async () => {
    http.adminFetch.mockResolvedValue({ worker_id: RECORD_WORKER_ID, phone: "+919800000001" });
    expect(await revealCandidatePhoneAction(RECORD_WORKER_ID, "dispute_resolution", NOTE)).toEqual({
      ok: true,
      phone: "+919800000001",
    });
  });

  it("sends nothing for an id that is not a worker id, or a reason outside the closed list", async () => {
    expect(await revealCandidatePhoneAction("Ramesh Kumar", "dispute_resolution", NOTE)).toEqual({
      ok: false,
      error: REVEAL_BAD_ID,
    });
    expect(await revealCandidatePhoneAction(RECORD_WORKER_ID, "curiosity", NOTE)).toEqual({
      ok: false,
      error: REVEAL_NO_REASON,
    });
    expect(http.adminFetch).not.toHaveBeenCalled();
  });
});

describe("a refused reveal", () => {
  it("EVERY 404 is the same one sentence — off, over the cap, unknown worker: the server does not say", async () => {
    for (const message of ["Not found", "reveal disabled", "cap exceeded"]) {
      http.adminFetch.mockRejectedValueOnce(new http.AdminRequestError(404, message));
      const out = await revealCandidatePhoneAction(RECORD_WORKER_ID, "safety_escalation", NOTE);
      expect(out).toEqual({ ok: false, error: REVEAL_UNAVAILABLE });
    }
  });

  it("a 400 naming the note says how to fix the note; any other 400 says the request was refused", async () => {
    http.adminFetch.mockRejectedValueOnce(
      new http.AdminRequestError(400, "Validation failed", {
        message: "Validation failed",
        issues: [{ path: "note", message: "note must not contain a phone number" }],
      }),
    );
    expect(await revealCandidatePhoneAction(RECORD_WORKER_ID, "safety_escalation", NOTE)).toEqual({
      ok: false,
      error: REVEAL_NOTE_REFUSED,
    });
    http.adminFetch.mockRejectedValueOnce(
      new http.AdminRequestError(400, "Validation failed", { issues: [{ path: "reason_code" }] }),
    );
    expect(await revealCandidatePhoneAction(RECORD_WORKER_ID, "safety_escalation", NOTE)).toEqual({
      ok: false,
      error: REVEAL_REFUSED,
    });
  });

  it.each([
    ["a role without reveal_pii (403)", () => new http.AdminForbiddenError(), REVEAL_FORBIDDEN],
    ["a session that ended (401)", () => new http.AdminUnauthorizedError(), REVEAL_SIGNED_OUT],
    ["a fault on our side (5xx)", () => new http.AdminRequestError(503, "upstream detail"), REVEAL_FAILED],
    ["an unreachable API", () => new http.AdminRequestError(0, "unreachable"), REVEAL_FAILED],
  ])("%s", async (_what, err, error) => {
    http.adminFetch.mockRejectedValueOnce(err());
    expect(await revealCandidatePhoneAction(RECORD_WORKER_ID, "safety_escalation", NOTE)).toEqual({
      ok: false,
      error,
    });
  });

  it("never echoes the API's own text back to the screen", async () => {
    http.adminFetch.mockRejectedValueOnce(new http.AdminRequestError(404, "worker 0b7f has no phone"));
    const out = await revealCandidatePhoneAction(RECORD_WORKER_ID, "safety_escalation", NOTE);
    expect(JSON.stringify(out)).not.toContain("0b7f");
  });
});
