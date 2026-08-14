import { expect } from "vitest";
import { randomUUID } from "node:crypto";

/**
 * Minted-payer-session test helper (ADR-0019, BL-18).
 *
 * Drives `POST /payer/test-login` — the payer analogue of the worker D-3 seam
 * (`POST /auth/test-login`) — to mint a real, Redis-backed {@link
 * import("../../../apps/api/src/payers/payer-session.service").PayerSessionService}
 * session. We do NOT hand-roll a JWT: a hand-signed token would lack the
 * `payer_session:<sid>` Redis record and `PayerAuthGuard.validateAndTouch` would reject it.
 *
 * WHY NOT THE OLD signup -> dev-OTP -> login/verify DANCE — that is what this helper used
 * to do, and it is DEAD: payer login is EMAIL OTP with NO dev echo at any boundary
 * (`PAYER_LOGIN_METHOD=email_otp` is real-only, ZeptoMail), so `POST /payer/signup` no
 * longer returns a `dev_otp` to verify with. `POST /payer/test-login`
 * ({@link import("../../../apps/api/src/payer-portal/payer-auth.controller").PayerAuthController})
 * is the seam built for exactly this (staging / e2e only):
 *
 *   - `PAYER_TEST_LOGIN_ENABLED` off (the default) -> a NEUTRAL 404, indistinguishable from
 *     a route that does not exist.
 *   - the `x-test-login-token` header must match the server's `PAYER_TEST_LOGIN_TOKEN`
 *     (>=32 chars; `assertPayerAuthConfig` refuses to BOOT otherwise, or if armed outside
 *     development/test/staging).
 *   - the email must be inside the reserved, unregistrable `@e2e.badabhai.invalid` domain
 *     ({@link import("../../../apps/api/src/payers/payer-test-login.guard").isSyntheticPayerEmail}) —
 *     anything else gets the SAME neutral 404, so a leaked token cannot impersonate a real
 *     payer even on a staging run with a live email provider.
 *
 * It reuses the ordinary account path (`createOrGet` + `ensureSoloOrg` + the free-tier
 * grant), so the minted session is a genuine `payers` row with a server-assigned id —
 * exactly what the unlock/credits/capacity spine keys on.
 *
 * ROLE: `PayerAuthService.testLogin` ALWAYS mints `role: "employer"` — the seam is not a
 * signup API and does not accept a role. `MintPayerSessionOptions.role` exists only for
 * call-site compatibility with suites that already say `{ role: "employer" }` explicitly;
 * anything else fails loudly here rather than silently minting the wrong role. An
 * "agent"-role synthetic session is not obtainable through this seam — escalate to the
 * Architect before a suite needs one.
 *
 * PRIVACY: the only "PII" a session needs is the synthetic login email, which is not a
 * real address (RFC 2606 `.invalid`) — no worker phone/name is ever involved here.
 */

export interface MintedPayerSession {
  /** Server-assigned opaque payer id (== the unlock/credit `payer_id`). */
  payerId: string;
  /** A valid `Authorization: Bearer <jwt>` token for this payer session. */
  token: string;
  /** The synthetic login email used (reserved `.invalid` domain — never a real address). */
  email: string;
  /** Always `employer` — see the ROLE note above. */
  role: string;
}

export interface MintPayerSessionOptions {
  /** Account role — the seam only ever mints `employer`; anything else throws. */
  role?: "employer" | "agent";
  /** Base URL of the running API (default `http://localhost:3001`). */
  apiUrl?: string;
}

/**
 * A decoded JSON response body. Every endpoint this helper drives returns a JSON object
 * (or nothing), so an index signature of `unknown` is the honest type: callers must narrow
 * or cast each field deliberately rather than inheriting `any`'s free pass.
 */
type JsonBody = Record<string, unknown> | null;

/** Minimal HTTP shape returned by {@link httpJson}. */
interface JsonResponse {
  status: number;
  json: JsonBody;
}

/** A JSON round-trip against the live API. */
async function httpJson(
  apiUrl: string,
  method: string,
  path: string,
  headers: Record<string, string>,
  body?: unknown,
): Promise<JsonResponse> {
  const res = await fetch(`${apiUrl}${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  return { status: res.status, json: text ? (JSON.parse(text) as JsonBody) : null };
}

/** Header carrying the payer test-login gate secret (mirrors PAYER_TEST_LOGIN_TOKEN_HEADER
 *  in `payer-test-login.guard.ts` — duplicated here rather than imported, same as every
 *  other e2e helper: this package never imports `apps/api` source). */
const PAYER_TEST_LOGIN_TOKEN_HEADER = "x-test-login-token";

/** The ONLY email domain the payer test-login seam will mint a session for (RFC 2606
 *  `.invalid`, mirrors `PAYER_TEST_LOGIN_DOMAIN` in `payer-test-login.guard.ts`). */
const PAYER_TEST_LOGIN_DOMAIN = "@e2e.badabhai.invalid";

/**
 * Mint a FRESH payer session over `POST /payer/test-login` and return a valid Bearer
 * session plus the server-assigned `payerId`. Use the returned `payerId` everywhere the
 * test needs to seed/own data (it is the id the session owns).
 *
 * Requires the API started with `PAYER_TEST_LOGIN_ENABLED=true` and a >=32-char
 * `PAYER_TEST_LOGIN_TOKEN`, and the SAME token set as `PAYER_TEST_LOGIN_TOKEN` on this
 * test runner's environment.
 */
export async function mintPayerSession(
  opts: MintPayerSessionOptions = {},
): Promise<MintedPayerSession> {
  const apiUrl = opts.apiUrl ?? process.env.E2E_API_URL ?? "http://localhost:3001";
  const role = opts.role ?? "employer";
  expect(
    role,
    'the payer test-login seam always mints role "employer" (PayerAuthService.testLogin ' +
      'hardcodes it) — an "agent" session cannot be minted via mintPayerSession',
  ).toBe("employer");

  const gateToken = process.env.PAYER_TEST_LOGIN_TOKEN ?? "";
  expect(
    gateToken,
    "set PAYER_TEST_LOGIN_TOKEN (>=32 chars, matching the running API's own " +
      "PAYER_TEST_LOGIN_TOKEN) — mintPayerSession mints via POST /payer/test-login",
  ).not.toBe("");

  // Unique, synthetic, per-run email inside the reserved domain — each mint is an
  // isolated new account (isSyntheticPayerEmail rejects anything outside this domain).
  const email = `e2e-payer-${randomUUID()}${PAYER_TEST_LOGIN_DOMAIN}`;

  const res = await httpJson(
    apiUrl,
    "POST",
    "/payer/test-login",
    { "content-type": "application/json", [PAYER_TEST_LOGIN_TOKEN_HEADER]: gateToken },
    { email },
  );
  // 404 = seam disabled (or a non-synthetic email, which cannot happen here); 401 = wrong/
  // missing token. Name both here instead of failing later on an undefined access_token.
  expect(
    res.status,
    "POST /payer/test-login must be armed for this suite: set PAYER_TEST_LOGIN_ENABLED=true " +
      "and a >=32-char PAYER_TEST_LOGIN_TOKEN on BOTH the API process and this test runner " +
      `(got ${res.status}: ${JSON.stringify(res.json)})`,
  ).toBe(200);

  const token = res.json?.access_token as string | undefined;
  const payerId = res.json?.payer_id as string | undefined;
  expect(token, "test-login must return an access_token").toBeTruthy();
  expect(payerId, "test-login must return the server-assigned payer_id").toBeTruthy();

  return { payerId: payerId!, token: token!, email, role: (res.json?.role as string) ?? role };
}
