import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * #2587 — a payer holding a TEMPORARY password cannot reach the portal until they set a new one;
 * email-code sign-in is unchanged. An INTEGRATION test: everything real but the network and the
 * cookie store.
 *
 * The REAL server actions → the REAL PayerAuth seam (lib/auth/http-provider.ts) → the REAL
 * transport (lib/payer-http.ts). Only `fetch` is faked — answering as backend #2628's code (not
 * only its description) answers: the route's `@HttpCode(200)`, the service's
 * `{status:"password_change_required"}`, the DTO's `new_password`, verify's `ConflictException`,
 * the validation pipe's issue paths — and `next/headers`' cookie store is a Map, the httpOnly jar
 * the browser would hold. The portal's own gate, `requirePayer()` (the (portal) layout's first
 * call), is then asked whether the payer is in.
 *
 * NOT the e2e test #2587's first acceptance criterion asks for. If #2628 changes before it merges,
 * this stays green. That e2e (tests/e2e, behind RUN_E2E) needs #2628 merged and a way for an e2e run
 * to issue a temporary password (there is no admin e2e seam today). Until then the criterion is open.
 *
 * Also locks the contract edges: FAIL CLOSED (no session without a non-empty `access_token`, and
 * never from a `password_change_required` body); the request bodies (no `new_password` on a first
 * attempt, the temporary password + `new_password` on the resend, never a `payer_id`); the API's
 * 400s mapped to inline copy; the code door's 409; neutral, password-free errors; nothing logged.
 */

const jar = new Map<string, string>();
const cookieSet = vi.fn((name: string, value: string, _options?: unknown) => {
  jar.set(name, value);
});
vi.mock("next/headers", () => ({
  cookies: async () => ({
    get: (name: string) => (jar.has(name) ? { name, value: jar.get(name)! } : undefined),
    set: (name: string, value: string, options?: unknown) => cookieSet(name, value, options),
    delete: (name: string) => void jar.delete(name),
  }),
}));
// The portal gate's redirect, made observable (Next's throws to unwind the render, as here).
vi.mock("next/navigation", () => ({
  redirect: (url: string) => {
    throw new Error(`REDIRECT:${url}`);
  },
}));

const fetchMock = vi.fn<(url: string, init?: RequestInit) => Promise<Response>>();

const { passwordSignInAction, setNewPasswordAction, verifyCodeAction } = await import("./actions");
const { payerAuth, requirePayer } = await import("../../lib/auth");
const { API_TOKEN_COOKIE_NAME } = await import("../../lib/auth/session-cookie");
const {
  ACCOUNT_SUSPENDED,
  NEUTRAL_VERIFY_ERROR,
  NEW_PASSWORD_UNAVAILABLE,
  PASSWORD_RATE_LIMITED,
  PASSWORD_SIGNIN_ERROR,
  PASSWORD_SIGNIN_UNAVAILABLE,
  TEMPORARY_PASSWORD_REQUIRED,
} = await import("./messages");
const { NEW_PASSWORD_ERRORS } = await import("./password-rules");

const API = "http://api.test";
const PAYER_ID = "22222222-2222-4222-8222-222222222222";
const LOGIN = "owner@example.com";
// The shape #2628 issues: 14 characters from an unambiguous alphabet.
const TEMPORARY = "Xk7mPq2rTn9wZa";
const CHOSEN = "my-own-pass-42";
const TOKEN = "payer.jwt.after-change";

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}
/** A refusal exactly as the API's exception filter nests a thrown HttpException. */
function apiError(status: number, error: Record<string, unknown>): Response {
  return json(
    { statusCode: status, error, requestId: "req-1", path: "/payer/login/password", timestamp: "2026-11-04T09:15:00.000Z" },
    status,
  );
}
const session = (accessToken = TOKEN) => ({
  access_token: accessToken,
  token_type: "Bearer",
  expires_in_seconds: 3600,
  payer_id: PAYER_ID,
  role: "employer",
  is_new_payer: false,
});
const CHANGE_REQUIRED = { status: "password_change_required" };
const ME = {
  id: PAYER_ID,
  role: "employer",
  status: "active",
  orgName: "Acme Manufacturing",
  email: LOGIN,
  phoneLast4: null,
  orgRole: "owner",
};

const callUrl = (n: number) => fetchMock.mock.calls[n]![0];
const callInit = (n: number) => fetchMock.mock.calls[n]![1]!;
const callBody = (n: number) => JSON.parse(String(callInit(n).body)) as Record<string, unknown>;

beforeAll(() => {
  // Read once and cached by the server config — set before the first request of this file.
  vi.stubEnv("PAYER_API_URL", API);
});
beforeEach(() => {
  vi.stubGlobal("fetch", fetchMock);
  fetchMock.mockReset();
  cookieSet.mockClear();
  jar.clear();
});
afterEach(() => {
  vi.unstubAllGlobals();
});

describe("#2587 — a temporary password cannot reach the portal until a new one is set", () => {
  it("the temporary password is right, yet NO session: no cookie, and the portal gate sends the payer to /login", async () => {
    fetchMock.mockResolvedValueOnce(json(CHANGE_REQUIRED));

    const first = await passwordSignInAction({ identifier: LOGIN, password: TEMPORARY });

    expect(first).toEqual({ ok: false, outcome: "change_required" });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(callUrl(0)).toBe(`${API}/payer/login/password`);
    expect(callInit(0).method).toBe("POST");
    // A first attempt never carries `new_password` — and never a payer id.
    expect(callBody(0)).toEqual({ identifier: LOGIN, password: TEMPORARY });
    // Public door: no bearer rides it.
    expect((callInit(0).headers as Record<string, string>).authorization).toBeUndefined();

    expect(cookieSet).not.toHaveBeenCalled();
    expect(jar.has(API_TOKEN_COOKIE_NAME)).toBe(false);
    await expect(payerAuth().currentSession()).resolves.toBeNull();
    await expect(requirePayer()).rejects.toThrow("REDIRECT:/login");
    // Without a token the gate has nothing to ask the API.
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("ONLY the resend with new_password signs in — then the portal gate lets the payer in", async () => {
    fetchMock.mockResolvedValueOnce(json(CHANGE_REQUIRED));
    await passwordSignInAction({ identifier: LOGIN, password: TEMPORARY });
    expect(cookieSet).not.toHaveBeenCalled();

    fetchMock.mockResolvedValueOnce(json(session()));
    const second = await setNewPasswordAction({
      identifier: LOGIN,
      temporaryPassword: TEMPORARY,
      newPassword: CHOSEN,
    });

    expect(second).toEqual({ ok: true, isNewPayer: false });
    expect(callUrl(1)).toBe(`${API}/payer/login/password`);
    // The resend: the TEMPORARY password as `password`, its replacement as `new_password`.
    expect(callBody(1)).toEqual({ identifier: LOGIN, password: TEMPORARY, new_password: CHOSEN });
    expect(cookieSet).toHaveBeenCalledTimes(1);
    const [name, value, options] = cookieSet.mock.calls[0]!;
    expect(name).toBe(API_TOKEN_COOKIE_NAME);
    expect(value).toBe(TOKEN);
    expect(options).toMatchObject({ httpOnly: true, sameSite: "lax", path: "/", maxAge: 3600 });

    fetchMock.mockResolvedValueOnce(json(ME));
    const me = await requirePayer();
    expect(me.payerId).toBe(PAYER_ID);
    expect(callUrl(2)).toBe(`${API}/payer/me`);
    expect((callInit(2).headers as Record<string, string>).authorization).toBe(`Bearer ${TOKEN}`);
  });

  it("the password door opens the session EXACTLY as the code door does (same cookie, same options)", async () => {
    fetchMock.mockResolvedValueOnce(json(session("code-door-token")));
    expect(await verifyCodeAction({ email: LOGIN, code: "123456" })).toEqual({
      ok: true,
      isNewPayer: false,
    });
    fetchMock.mockResolvedValueOnce(json(session("password-door-token")));
    expect(await passwordSignInAction({ identifier: LOGIN, password: "Settled-pass-9" })).toEqual({
      ok: true,
      isNewPayer: false,
    });

    const [codeCall, passwordCall] = cookieSet.mock.calls;
    expect(codeCall![0]).toBe(API_TOKEN_COOKIE_NAME);
    expect(passwordCall![0]).toBe(API_TOKEN_COOKIE_NAME);
    expect(passwordCall![2]).toEqual(codeCall![2]);
    expect(jar.get(API_TOKEN_COOKIE_NAME)).toBe("password-door-token");
  });
});

describe("FAIL CLOSED — nothing but a real session answer opens a session", () => {
  it("a change request that ALSO carries a token is still no session", async () => {
    fetchMock.mockResolvedValueOnce(json({ ...session(), ...CHANGE_REQUIRED }));
    expect(await passwordSignInAction({ identifier: LOGIN, password: TEMPORARY })).toEqual({
      ok: false,
      outcome: "change_required",
    });
    expect(cookieSet).not.toHaveBeenCalled();
  });

  it("an empty access_token is no session — at the password door and at the code door", async () => {
    fetchMock.mockResolvedValueOnce(json(session("")));
    expect(await passwordSignInAction({ identifier: LOGIN, password: "Settled-pass-9" })).toEqual({
      ok: false,
      outcome: "refused",
      error: PASSWORD_SIGNIN_UNAVAILABLE,
    });
    fetchMock.mockResolvedValueOnce(json(session("")));
    expect(await verifyCodeAction({ email: LOGIN, code: "123456" })).toEqual({
      ok: false,
      error: NEUTRAL_VERIFY_ERROR,
    });
    expect(cookieSet).not.toHaveBeenCalled();
  });

  it("a body that is neither a session nor a change request is no session", async () => {
    fetchMock.mockResolvedValueOnce(json({ status: "ok" }));
    const res = await passwordSignInAction({ identifier: LOGIN, password: "Settled-pass-9" });
    expect(res).toEqual({ ok: false, outcome: "refused", error: PASSWORD_SIGNIN_UNAVAILABLE });
    expect(cookieSet).not.toHaveBeenCalled();
  });

  it("a resend answered with password_change_required AGAIN stays on the step, signed out", async () => {
    fetchMock.mockResolvedValueOnce(json(CHANGE_REQUIRED));
    const res = await setNewPasswordAction({
      identifier: LOGIN,
      temporaryPassword: TEMPORARY,
      newPassword: CHOSEN,
    });
    expect(res).toEqual({ ok: false, outcome: "refused", error: NEW_PASSWORD_UNAVAILABLE });
    expect(cookieSet).not.toHaveBeenCalled();
  });
});

describe("the change step — the API's refusals", () => {
  it.each([
    ["Password must be at least 8 characters", NEW_PASSWORD_ERRORS.too_short],
    ["Password must be at most 128 characters", NEW_PASSWORD_ERRORS.too_long],
    ["Password must include at least one letter and one digit", NEW_PASSWORD_ERRORS.letter_and_digit],
    ["Password is on a deny list", NEW_PASSWORD_ERRORS.other],
  ])("the policy refusal %j lands inline, even for a value the client mirror accepted", async (message, copy) => {
    fetchMock.mockResolvedValueOnce(
      apiError(400, { message: "Validation failed", issues: [{ path: "new_password", message }] }),
    );
    const res = await setNewPasswordAction({
      identifier: LOGIN,
      temporaryPassword: TEMPORARY,
      newPassword: CHOSEN,
    });
    expect(res).toEqual({ ok: false, outcome: "new_password_rejected", error: copy });
    expect(cookieSet).not.toHaveBeenCalled();
  });

  it("'Choose a new password - it cannot be the temporary one' (a 400 with no field issues) lands inline", async () => {
    fetchMock.mockResolvedValueOnce(
      apiError(400, {
        statusCode: 400,
        message: "Choose a new password - it cannot be the temporary one",
        error: "Bad Request",
      }),
    );
    const res = await setNewPasswordAction({
      identifier: LOGIN,
      temporaryPassword: TEMPORARY,
      newPassword: CHOSEN,
    });
    expect(res).toEqual({
      ok: false,
      outcome: "new_password_rejected",
      error: NEW_PASSWORD_ERRORS.same_as_temporary,
    });
  });

  it("a 401 on the resend: the temporary password no longer works — back to sign-in, neutrally", async () => {
    fetchMock.mockResolvedValueOnce(
      apiError(401, { statusCode: 401, message: "Incorrect identifier or password", error: "Unauthorized" }),
    );
    const res = await setNewPasswordAction({
      identifier: LOGIN,
      temporaryPassword: TEMPORARY,
      newPassword: CHOSEN,
    });
    expect(res).toEqual({
      ok: false,
      outcome: "temporary_password_rejected",
      error: PASSWORD_SIGNIN_ERROR,
    });
    expect(cookieSet).not.toHaveBeenCalled();
  });

  it("the mirror stops a value the API would refuse before any request (the API stays the authority)", async () => {
    const same = await setNewPasswordAction({
      identifier: LOGIN,
      temporaryPassword: TEMPORARY,
      newPassword: TEMPORARY,
    });
    expect(same).toEqual({
      ok: false,
      outcome: "new_password_rejected",
      error: NEW_PASSWORD_ERRORS.same_as_temporary,
    });
    const short = await setNewPasswordAction({
      identifier: LOGIN,
      temporaryPassword: TEMPORARY,
      newPassword: "abc1",
    });
    expect(short).toEqual({ ok: false, outcome: "new_password_rejected", error: NEW_PASSWORD_ERRORS.too_short });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("the code door (#2628 409) — and an API without #2628", () => {
  it("a 409 on verify opens NO session and points the payer at password sign-in", async () => {
    fetchMock.mockResolvedValueOnce(
      apiError(409, { statusCode: 409, message: "Password change required", error: "Conflict" }),
    );
    const res = await verifyCodeAction({ email: LOGIN, code: "123456" });
    expect(res).toEqual({ ok: false, error: TEMPORARY_PASSWORD_REQUIRED, usePassword: true });
    expect(cookieSet).not.toHaveBeenCalled();
    await expect(requirePayer()).rejects.toThrow("REDIRECT:/login");
  });

  it("without #2628 nothing changes: a password session signs in at once; a refused code is the neutral error", async () => {
    fetchMock.mockResolvedValueOnce(json(session()));
    expect(await passwordSignInAction({ identifier: LOGIN, password: "Settled-pass-9" })).toEqual({
      ok: true,
      isNewPayer: false,
    });
    expect(callBody(0)).not.toHaveProperty("new_password");

    fetchMock.mockResolvedValueOnce(
      apiError(401, { statusCode: 401, message: "Incorrect or expired code", error: "Unauthorized" }),
    );
    const refused = await verifyCodeAction({ email: LOGIN, code: "123456" });
    expect(refused).toEqual({ ok: false, error: NEUTRAL_VERIFY_ERROR });
    expect(refused).not.toHaveProperty("usePassword");
  });
});

describe("password sign-in — neutral errors, read from the status", () => {
  it.each([
    [401, PASSWORD_SIGNIN_ERROR],
    [400, PASSWORD_SIGNIN_ERROR],
    [403, ACCOUNT_SUSPENDED],
    [429, PASSWORD_RATE_LIMITED],
    [500, PASSWORD_SIGNIN_UNAVAILABLE],
    [503, PASSWORD_SIGNIN_UNAVAILABLE],
  ])("%i → its copy, and never the password or the API's text", async (status, copy) => {
    fetchMock.mockResolvedValueOnce(
      apiError(status, { statusCode: status, message: "deny reason the payer must never see" }),
    );
    const res = await passwordSignInAction({ identifier: LOGIN, password: TEMPORARY });
    expect(res).toEqual({ ok: false, outcome: "refused", error: copy });
    expect(JSON.stringify(res)).not.toContain(TEMPORARY);
    expect(JSON.stringify(res)).not.toContain("deny reason");
    expect(cookieSet).not.toHaveBeenCalled();
  });

  it("a network failure is the retryable error, not a crash", async () => {
    fetchMock.mockRejectedValueOnce(new TypeError("fetch failed"));
    expect(await passwordSignInAction({ identifier: LOGIN, password: TEMPORARY })).toEqual({
      ok: false,
      outcome: "refused",
      error: PASSWORD_SIGNIN_UNAVAILABLE,
    });
  });

  it("input the API's DTO would refuse never leaves the server — the same neutral miss", async () => {
    for (const input of [
      { identifier: "   ", password: TEMPORARY },
      { identifier: LOGIN, password: "" },
      { identifier: LOGIN, password: "x".repeat(129) },
      { identifier: "x".repeat(321), password: TEMPORARY },
    ]) {
      expect(await passwordSignInAction(input)).toEqual({
        ok: false,
        outcome: "refused",
        error: PASSWORD_SIGNIN_ERROR,
      });
    }
    // A Server Action is a public endpoint: a non-string argument is refused the same way.
    expect(
      await passwordSignInAction({ identifier: 42, password: [] } as unknown as {
        identifier: string;
        password: string;
      }),
    ).toEqual({ ok: false, outcome: "refused", error: PASSWORD_SIGNIN_ERROR });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("the login ID is sent as the API matches it: an Indian mobile as E.164, a name as typed", async () => {
    // A Response body reads once: a fresh one per request.
    fetchMock.mockImplementation(async () => json(session()));
    await passwordSignInAction({ identifier: " 98765 43210 ", password: "Settled-pass-9" });
    await passwordSignInAction({ identifier: "Acme Manufacturing", password: "Settled-pass-9" });
    expect(callBody(0).identifier).toBe("+919876543210");
    expect(callBody(1).identifier).toBe("Acme Manufacturing");
  });
});

describe("the passwords are never logged", () => {
  it("a whole journey — change required, refusals, the change — writes neither password anywhere", async () => {
    const spies = (["log", "info", "warn", "error", "debug"] as const).map((m) =>
      vi.spyOn(console, m).mockImplementation(() => {}),
    );
    try {
      fetchMock
        .mockResolvedValueOnce(json(CHANGE_REQUIRED))
        .mockResolvedValueOnce(
          apiError(400, { message: "Validation failed", issues: [{ path: "new_password", message: "Password must be at least 8 characters" }] }),
        )
        .mockRejectedValueOnce(new TypeError("fetch failed"))
        .mockResolvedValueOnce(json(session()));
      await passwordSignInAction({ identifier: LOGIN, password: TEMPORARY });
      await setNewPasswordAction({ identifier: LOGIN, temporaryPassword: TEMPORARY, newPassword: CHOSEN });
      await setNewPasswordAction({ identifier: LOGIN, temporaryPassword: TEMPORARY, newPassword: CHOSEN });
      await setNewPasswordAction({ identifier: LOGIN, temporaryPassword: TEMPORARY, newPassword: CHOSEN });

      const written = spies.flatMap((s) => s.mock.calls).map((args) => args.map(String).join(" "));
      for (const line of written) {
        expect(line).not.toContain(TEMPORARY);
        expect(line).not.toContain(CHOSEN);
      }
    } finally {
      for (const s of spies) s.mockRestore();
    }
  });
});
