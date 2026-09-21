import { describe, expect, it, vi } from "vitest";

vi.mock("../../../lib/admin-http", async () => {
  const actual = await vi.importActual<Record<string, unknown>>("../../../lib/admin-http");
  return { ...actual, adminFetch: vi.fn() };
});

import { adminFetch, AdminRequestError } from "../../../lib/admin-http";
import { acceptInviteAction } from "./actions";
import {
  MALFORMED_LINK_ERROR,
  NEUTRAL_ACCEPT_ERROR,
  SERVICE_UNAVAILABLE_ERROR,
} from "./messages";

const TOKEN = "a".repeat(48);

/**
 * #1494 — redeeming an admin invite.
 *
 * The property that matters most is the NON-ORACLE: the API fuses invalid, expired and
 * already-used into one 401, and this action must not un-fuse them. A page that said
 * "already used" for one link and "invalid" for another would let anyone walk a list of
 * links and learn which admins had recently been invited.
 *
 * NO `beforeEach` RESET, deliberately. `mockReset` wipes the implementation each test
 * installs, which left a sync-throwing mock half-installed and had vitest reporting the
 * throw as an unhandled error; `mockClear` misbehaved the same way under this project's
 * config. Every test sets its own implementation, and the one call-count assertion is a
 * DELTA, so nothing here depends on execution order.
 */
describe("acceptInviteAction", () => {
  it("posts the token to the UNGUARDED route and reports the granted role", async () => {
    vi.mocked(adminFetch).mockImplementation(
      async () =>
        ({
          admin_id: "adm_1",
          role: "analyst",
          status: "active",
          next: "sign_in",
        }) as never,
    );

    const res = await acceptInviteAction({ token: TOKEN });

    expect(res).toEqual({ ok: true, role: "analyst" });
    const calls = vi.mocked(adminFetch).mock.calls;
    const [path, opts] = calls[calls.length - 1]!;
    expect(path).toBe("/admin/invites/accept");
    // `public: true` is load-bearing — there is no cookie to attach, and asking for one
    // would fail before the request ever left the server.
    expect((opts as { public?: boolean }).public).toBe(true);
    expect((opts as { body?: unknown }).body).toEqual({ token: TOKEN });
  });

  it("gives ONE neutral message for invalid, expired and already-used alike", async () => {
    vi.mocked(adminFetch).mockImplementation(() => {
      throw new AdminRequestError(401, "nope");
    });

    const res = await acceptInviteAction({ token: TOKEN });
    expect(res).toEqual({ ok: false, error: NEUTRAL_ACCEPT_ERROR });
  });

  it("never leaks the server's own wording on a 401", async () => {
    // If the API ever said "already redeemed", passing it through would rebuild the oracle.
    vi.mocked(adminFetch).mockImplementation(() => {
      throw new AdminRequestError(401, "invite already redeemed");
    });

    const res = await acceptInviteAction({ token: TOKEN });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).not.toContain("redeemed");
  });

  it("treats a 400 as a mangled link", async () => {
    vi.mocked(adminFetch).mockImplementation(() => {
      throw new AdminRequestError(400, "too short");
    });

    const res = await acceptInviteAction({ token: TOKEN });
    expect(res).toEqual({ ok: false, error: MALFORMED_LINK_ERROR });
  });

  it("rejects a wrong-length token WITHOUT spending a rate-limit slot", async () => {
    // The invitee may need that slot for the real link, so this must never reach the API.
    const before = vi.mocked(adminFetch).mock.calls.length;

    const res = await acceptInviteAction({ token: "short" });

    expect(res).toEqual({ ok: false, error: MALFORMED_LINK_ERROR });
    expect(vi.mocked(adminFetch).mock.calls.length).toBe(before);
  });

  it("says so plainly when the service is unreachable", async () => {
    // Honest, because it reveals nothing about whether the link was real.
    vi.mocked(adminFetch).mockImplementation(() => {
      throw new Error("ECONNREFUSED");
    });

    const res = await acceptInviteAction({ token: TOKEN });
    expect(res).toEqual({ ok: false, error: SERVICE_UNAVAILABLE_ERROR });
  });
});
