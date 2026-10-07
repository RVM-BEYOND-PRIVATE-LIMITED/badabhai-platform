import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { navSections } from "../../app/(portal)/nav-model";

/**
 * ORG ROLE through the REAL seam (#2079): `GET /payer/me` → `currentSession()` → `requirePayer()`
 * → `getOrgRole()` / `requireOwner()`.
 *
 * Only the edges are stubbed — the network (`fetch`), the httpOnly cookie reader and Next's
 * control-flow throws. The transport (`payerFetch`), the wire schema (`payerMeWireSchema`), the
 * session mapping (`sessionFromMe`) and the gate are the production code, so these cases prove the
 * chain a real request walks, not a mock of it:
 *  - Owner vs Recruiter vs null vs an older API (no field) vs an unknown value — only an explicit
 *    `"owner"` from THIS read grants Owner; everything else is least privilege, never a sign-out;
 *  - a failed read fails closed (to /login), and never falls back to an earlier Owner answer;
 *  - a DEMOTED owner is refused on the very next request — the gate reads /me fresh each time;
 *  - the role never comes from the cookie: a forged `org_role` claim grants nothing, and a legacy
 *    token with no claim is not penalised;
 *  - the dev-only preview override cannot grant Owner outside dev;
 *  - the nav's Owner item (Team) follows the same read; Credits is offered to every member
 *    (owner ruling 2026-10-07).
 */

const NOT_FOUND = new Error("NEXT_NOT_FOUND");
const REDIRECT = new Error("NEXT_REDIRECT");
const notFound = vi.fn(() => {
  throw NOT_FOUND;
});
const redirect = vi.fn((_to: string) => {
  throw REDIRECT;
});
vi.mock("next/navigation", () => ({
  notFound: () => notFound(),
  redirect: (to: string) => redirect(to),
}));

/** The httpOnly cookie's value — the browser holds it and could rewrite it. */
let cookieToken: string | null = null;
vi.mock("./session-cookie", () => ({
  readApiToken: async () => cookieToken,
  API_TOKEN_COOKIE_NAME: "bb_payer_token",
  sessionCookieOptions: () => ({}),
}));
vi.mock("next/headers", () => ({
  cookies: async () => ({
    get: (name: string) =>
      name === "bb_payer_token" && cookieToken !== null ? { name, value: cookieToken } : undefined,
    set: () => undefined,
    delete: () => undefined,
  }),
}));

const fetchMock = vi.fn<(url: string, init?: RequestInit) => Promise<Response>>();

const { getOrgRole, requireOwner, requireRecruiter } = await import("./org-roles");
const { requirePayer } = await import("./index");
const { payerMeWireSchema, orgRoleWireSchema } = await import("../contracts");

const PAYER_ID = "11111111-1111-4111-8111-111111111111";
const ORG_ID = "99999999-9999-4999-8999-999999999999";

/** A JWT-SHAPED cookie value with an arbitrary payload and a signature payer-web cannot check. */
function unsignedJwt(payload: Record<string, unknown>): string {
  const part = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url");
  return `${part({ alg: "HS256", typ: "JWT" })}.${part(payload)}.not-a-real-signature`;
}
const BASE_CLAIMS = { sub: PAYER_ID, sid: "sid-1", typ: "payer", role: "employer" };
/** Minted before #2098 — carries no org claim. */
const LEGACY_TOKEN = unsignedJwt(BASE_CLAIMS);
/** A browser-edited cookie claiming Owner. */
const FORGED_OWNER_TOKEN = unsignedJwt({ ...BASE_CLAIMS, org_id: ORG_ID, org_role: "owner" });

/** A `GET /payer/me` body as the #2098 backend sends it; `over` replaces or adds keys. */
function meBody(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: PAYER_ID,
    role: "employer",
    status: "active",
    orgName: "Acme Tools",
    email: "owner@acme.example",
    phoneLast4: "4321",
    orgId: ORG_ID,
    orgRole: "owner",
    ...over,
  };
}
/** The same body from an API older than #2079 — the org keys are ABSENT, not null. */
function preOrgMeBody(): Record<string, unknown> {
  const { orgId: _orgId, orgRole: _orgRole, ...rest } = meBody();
  return rest;
}
function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}
function meCalls(): number {
  return fetchMock.mock.calls.filter(([url]) => url.endsWith("/payer/me")).length;
}

beforeEach(() => {
  process.env.PAYER_API_URL = "http://api.test";
  vi.stubGlobal("fetch", fetchMock);
  fetchMock.mockReset();
  notFound.mockClear();
  redirect.mockClear();
  cookieToken = LEGACY_TOKEN;
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe("GET /payer/me orgRole decides the Owner gate (#2079)", () => {
  it("an Owner passes requireOwner — in PRODUCTION, with no dev override in play", async () => {
    vi.stubEnv("NODE_ENV", "production");
    fetchMock.mockResolvedValueOnce(json(meBody({ orgRole: "owner" })));

    const session = await requireOwner();

    expect(session.orgRole).toBe("owner");
    expect(getOrgRole(session)).toBe("owner");
    expect(notFound).not.toHaveBeenCalled();
    // The role came from the authenticated self read, carried by the cookie's Bearer token.
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe("http://api.test/payer/me");
    expect(new Headers(init?.headers).get("authorization")).toBe(`Bearer ${LEGACY_TOKEN}`);
  });

  it("a Recruiter gets the NEUTRAL 404", async () => {
    vi.stubEnv("NODE_ENV", "production");
    fetchMock.mockResolvedValueOnce(json(meBody({ orgRole: "recruiter" })));

    await expect(requireOwner()).rejects.toBe(NOT_FOUND);
    expect(notFound).toHaveBeenCalledOnce();
  });

  it("orgRole null (no active membership) is least privilege — still signed in, 404 for Owner pages", async () => {
    vi.stubEnv("NODE_ENV", "production");
    fetchMock.mockImplementation(async () => json(meBody({ orgId: null, orgRole: null })));

    const session = await requirePayer();
    expect(session.orgRole).toBeNull();
    expect(getOrgRole(session)).toBe("recruiter");
    await expect(requireOwner()).rejects.toBe(NOT_FOUND);
    // A member area still admits them — least privilege is Recruiter, not "locked out".
    await expect(requireRecruiter()).resolves.toMatchObject({ payerId: PAYER_ID });
    expect(redirect).not.toHaveBeenCalled();
  });

  it("an API older than #2079 (no orgId/orgRole keys) still parses — signed in, Recruiter", async () => {
    vi.stubEnv("NODE_ENV", "production");
    fetchMock.mockImplementation(async () => json(preOrgMeBody()));

    const session = await requirePayer();
    expect(session.payerId).toBe(PAYER_ID);
    expect(getOrgRole(session)).toBe("recruiter");
    await expect(requireOwner()).rejects.toBe(NOT_FOUND);
    expect(redirect).not.toHaveBeenCalled();
  });

  it("an orgRole OUTSIDE the enum is least privilege — it costs Owner rights, never the session", async () => {
    vi.stubEnv("NODE_ENV", "production");
    fetchMock.mockImplementation(async () => json(meBody({ orgRole: "admin" })));

    const session = await requirePayer();
    expect(session.orgRole).toBeNull();
    expect(getOrgRole(session)).toBe("recruiter");
    await expect(requireOwner()).rejects.toBe(NOT_FOUND);
    expect(redirect).not.toHaveBeenCalled();
  });

  it("a FAILED /me read fails closed to /login — and never reuses an earlier Owner answer", async () => {
    vi.stubEnv("NODE_ENV", "production");
    fetchMock
      .mockResolvedValueOnce(json(meBody({ orgRole: "owner" })))
      .mockResolvedValueOnce(json({ message: "upstream down" }, 503));

    await expect(requireOwner()).resolves.toMatchObject({ orgRole: "owner" });
    await expect(requireOwner()).rejects.toBe(REDIRECT);
    expect(redirect).toHaveBeenCalledWith("/login");
    expect(meCalls()).toBe(2);
  });

  it("a DEMOTED owner is refused on the very next request — the gate reads /me fresh every time", async () => {
    vi.stubEnv("NODE_ENV", "production");
    fetchMock
      .mockResolvedValueOnce(json(meBody({ orgRole: "owner" })))
      .mockResolvedValueOnce(json(meBody({ orgRole: "recruiter" })));

    await expect(requireOwner()).resolves.toMatchObject({ orgRole: "owner" });
    // Same cookie, same session id — only the membership changed server-side.
    await expect(requireOwner()).rejects.toBe(NOT_FOUND);
    expect(meCalls()).toBe(2);
  });
});

describe("the org role never comes from the cookie's JWT claim", () => {
  it("a FORGED org_role=owner claim grants nothing when /me says Recruiter", async () => {
    vi.stubEnv("NODE_ENV", "production");
    cookieToken = FORGED_OWNER_TOKEN;
    fetchMock.mockResolvedValueOnce(json(meBody({ orgRole: "recruiter" })));

    await expect(requireOwner()).rejects.toBe(NOT_FOUND);
    // The token is only ever FORWARDED to the API (which verifies its signature) — never trusted.
    const [, init] = fetchMock.mock.calls[0]!;
    expect(new Headers(init?.headers).get("authorization")).toBe(`Bearer ${FORGED_OWNER_TOKEN}`);
  });

  it("a LEGACY token with no org claim is not penalised — /me owner still grants Owner", async () => {
    vi.stubEnv("NODE_ENV", "production");
    cookieToken = LEGACY_TOKEN;
    fetchMock.mockResolvedValueOnce(json(meBody({ orgRole: "owner" })));

    await expect(requireOwner()).resolves.toMatchObject({ orgRole: "owner" });
  });
});

describe("dev-only preview override (PAYER_DEV_ORG_ROLE) — unchanged", () => {
  it("outside dev it cannot grant Owner to a /me Recruiter", async () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("PAYER_DEV_ORG_ROLE", "owner");
    fetchMock.mockResolvedValueOnce(json(meBody({ orgRole: "recruiter" })));

    await expect(requireOwner()).rejects.toBe(NOT_FOUND);
  });

  it("in dev/test it still previews either role over the real one", async () => {
    // vitest runs NODE_ENV=test (isDevEnv true).
    vi.stubEnv("PAYER_DEV_ORG_ROLE", "owner");
    fetchMock.mockResolvedValueOnce(json(meBody({ orgRole: "recruiter" })));
    await expect(requireOwner()).resolves.toMatchObject({ orgRole: "recruiter" });

    vi.stubEnv("PAYER_DEV_ORG_ROLE", "recruiter");
    fetchMock.mockResolvedValueOnce(json(meBody({ orgRole: "owner" })));
    await expect(requireOwner()).rejects.toBe(NOT_FOUND);
  });
});

describe("the nav's Owner item (Team) follows the same read (affordance, not authz)", () => {
  async function railHrefs(orgRole: string): Promise<string[]> {
    fetchMock.mockResolvedValueOnce(json(meBody({ orgRole })));
    const session = await requirePayer();
    return navSections({
      isAgency: false,
      isOwner: getOrgRole(session) === "owner",
      agencyPortalEnabled: true,
    }).flatMap((s) => s.items.map((i) => i.href));
  }

  it("a /me Owner is offered Team; a /me Recruiter is not — both are offered Credits", async () => {
    vi.stubEnv("NODE_ENV", "production");
    const owner = await railHrefs("owner");
    expect(owner).toContain("/credits");
    expect(owner).toContain("/team");

    const recruiter = await railHrefs("recruiter");
    expect(recruiter).toContain("/credits");
    expect(recruiter).not.toContain("/team");
  });
});

describe("payerMeWireSchema — orgId/orgRole (#2079 contract)", () => {
  it("mirrors the backend OrgRole enum exactly", () => {
    expect(orgRoleWireSchema.options).toEqual(["owner", "recruiter"]);
  });

  it("parses owner / recruiter / null, and an ABSENT pair as undefined (older API)", () => {
    expect(payerMeWireSchema.parse(meBody({ orgRole: "owner" })).orgRole).toBe("owner");
    expect(payerMeWireSchema.parse(meBody({ orgRole: "recruiter" })).orgRole).toBe("recruiter");
    const none = payerMeWireSchema.parse(meBody({ orgId: null, orgRole: null }));
    expect([none.orgId, none.orgRole]).toEqual([null, null]);
    const older = payerMeWireSchema.parse(preOrgMeBody());
    expect([older.orgId, older.orgRole]).toEqual([undefined, undefined]);
  });

  it("degrades a malformed orgId / unknown orgRole to null without failing the read", () => {
    const parsed = payerMeWireSchema.parse(meBody({ orgId: "not-a-uuid", orgRole: "OWNER" }));
    expect(parsed.orgId).toBeNull();
    expect(parsed.orgRole).toBeNull();
    expect(parsed.id).toBe(PAYER_ID); // the rest of the self read is intact
  });
});
