import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * LIVE org-member seam (ADR-0027 / B5.5) — wired to the payer org API. Exercises the REAL
 * transport (`payerFetch`) with a mocked `fetch` + a mocked payer-JWT cookie, asserting:
 *  - TENANCY (XB-A): NO request body ever carries a `payer_id` / `org_id` — the identity + org
 *    ride ONLY the Bearer token from the server session.
 *  - Faceless: the list maps the server-MASKED email through unchanged (never a raw address).
 *  - The right method/path per operation; a non-2xx maps to a NEUTRAL failure (no leak).
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

function okJson(body: unknown) {
  return { ok: true, status: 200, text: async () => JSON.stringify(body) };
}
function fail(status: number) {
  return { ok: false, status, text: async () => "" };
}
function lastCall() {
  const [url, init] = fetchMock.mock.calls.at(-1)!;
  const body = init.body ? JSON.parse(init.body) : undefined;
  return { url: String(url), method: init.method as string, body };
}

const WIRE_MEMBER = {
  member_id: "mem-1",
  org_role: "recruiter",
  status: "invited",
  email_masked: "h•••@acme.example",
  invited_at: "2026-07-01T00:00:00.000Z",
  is_self: false,
};

describe("listOrgMembers — masked, XB-A", () => {
  it("GETs /payer/org/members and maps the masked view (no raw email)", async () => {
    fetchMock.mockResolvedValueOnce(
      okJson([WIRE_MEMBER, { ...WIRE_MEMBER, member_id: "mem-self", is_self: true, status: "active", org_role: "owner" }]),
    );
    const { listOrgMembers } = await import("./org-members");
    const out = await listOrgMembers();
    const call = lastCall();
    expect(call.method ?? "GET").toBe("GET");
    expect(call.url).toBe("http://api.test/payer/org/members");
    expect(out[0]).toEqual({
      memberId: "mem-1",
      orgRole: "recruiter",
      status: "invited",
      emailMasked: "h•••@acme.example",
      invitedAt: "2026-07-01T00:00:00.000Z",
      isSelf: false,
    });
    expect(out[1]!.isSelf).toBe(true);
  });
});

describe("inviteOrgMember — recruiter-only, XB-A body", () => {
  it("POSTs the email + org_role=recruiter and NEVER a payer_id/org_id", async () => {
    fetchMock.mockResolvedValueOnce(okJson(WIRE_MEMBER));
    const { inviteOrgMember } = await import("./org-members");
    const res = await inviteOrgMember({ email: "hire@acme.example" });
    const call = lastCall();
    expect(call.method).toBe("POST");
    expect(call.url).toBe("http://api.test/payer/org/members");
    expect(call.body).toEqual({ email: "hire@acme.example", org_role: "recruiter" });
    expect(call.body).not.toHaveProperty("payer_id");
    expect(call.body).not.toHaveProperty("org_id");
    expect(res.ok).toBe(true);
  });

  it("maps a non-2xx to a NEUTRAL failure (no status/body leak)", async () => {
    fetchMock.mockResolvedValueOnce(fail(409));
    const { inviteOrgMember } = await import("./org-members");
    const res = await inviteOrgMember({ email: "hire@acme.example" });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).not.toMatch(/409/);
  });
});

describe("removeOrgMember — DELETE by opaque id", () => {
  it("DELETEs /payer/org/members/:id with no body", async () => {
    fetchMock.mockResolvedValueOnce(okJson({ member_id: "mem-1", status: "removed" }));
    const { removeOrgMember } = await import("./org-members");
    const res = await removeOrgMember({ memberId: "mem-1" });
    const call = lastCall();
    expect(call.method).toBe("DELETE");
    expect(call.url).toBe("http://api.test/payer/org/members/mem-1");
    expect(call.body).toBeUndefined();
    expect(res.ok).toBe(true);
  });
});

describe("acceptOrgInvite — token-only, XB-A", () => {
  it("POSTs the token to /payer/org/invites/accept and never a payer_id", async () => {
    fetchMock.mockResolvedValueOnce(okJson({ ...WIRE_MEMBER, status: "active", is_self: true }));
    const { acceptOrgInvite } = await import("./org-members");
    const res = await acceptOrgInvite({ token: "tok-raw-0123456789abcdef" });
    const call = lastCall();
    expect(call.method).toBe("POST");
    expect(call.url).toBe("http://api.test/payer/org/invites/accept");
    expect(call.body).toEqual({ token: "tok-raw-0123456789abcdef" });
    expect(call.body).not.toHaveProperty("payer_id");
    expect(res.ok).toBe(true);
  });

  it("maps an invalid/expired token to a NEUTRAL failure", async () => {
    fetchMock.mockResolvedValueOnce(fail(404));
    const { acceptOrgInvite } = await import("./org-members");
    const res = await acceptOrgInvite({ token: "tok-raw-0123456789abcdef" });
    expect(res.ok).toBe(false);
  });
});
