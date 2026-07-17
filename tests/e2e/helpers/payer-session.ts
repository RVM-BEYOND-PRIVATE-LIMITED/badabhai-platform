import { expect } from "vitest";
import { randomUUID } from "node:crypto";

/**
 * Minted-payer-session test helper (ADR-0019 Phase 1, R16).
 *
 * Drives the REAL self-serve payer login over HTTP — signup → dev-OTP → login/verify —
 * so the Bearer it returns is minted by the real PayerSessionService (signed + backed by a
 * live Redis session record). We do NOT hand-roll a JWT: a hand-signed token would lack the
 * `payer_session:<sid>` Redis record and {@link PayerAuthGuard.validateAndTouch} would
 * reject it. Signup also CREATES the real `payers` row, so the returned `payerId` is a
 * genuine account; the unlock spine keys on it as the opaque `payer_id`.
 *
 * On `main` the self-serve disclosure surface is the `/payer/*` controller (PayerAuthGuard,
 * session-derived `payer_id`). The interim ops `/unlocks` + `/payers/:payerId/credits`
 * surface (InternalServiceGuard) still exists for ops-run support — tests seed credits
 * through it using the SERVER-ASSIGNED `payerId` this helper returns. A payer can never
 * choose its own id, so mint a session FIRST, then seed against the returned `payerId`.
 *
 * PRIVACY: the only PII a session needs is the payer's own login email (unavoidable — it is
 * the login identifier, B-R2 class, encrypted at rest in `payers`). We use a unique,
 * synthetic per-run email; no worker phone/name is ever involved here.
 */

export interface MintedPayerSession {
  /** Server-assigned opaque payer id (== the unlock/credit `payer_id`). */
  payerId: string;
  /** A valid `Authorization: Bearer <jwt>` token for this payer session. */
  token: string;
  /** The synthetic login email used (a payer's OWN email — the only allowed PII). */
  email: string;
  /** `employer | agent` role this account was created with. */
  role: string;
}

export interface MintPayerSessionOptions {
  /** Account role at signup (default `employer`). */
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

/** A JSON round-trip against the live API (no auth header by default). */
async function httpJson(
  apiUrl: string,
  method: string,
  path: string,
  body?: unknown,
): Promise<JsonResponse> {
  const res = await fetch(`${apiUrl}${path}`, {
    method,
    headers: { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  return { status: res.status, json: text ? (JSON.parse(text) as JsonBody) : null };
}

/**
 * Sign up + log in a FRESH payer over the real self-serve flow and return a valid Bearer
 * session plus the server-assigned `payerId`. Use the returned `payerId` everywhere the
 * test needs to seed/own data (it is the id the session owns).
 *
 * Requires the API to run with the default mock login channel (`PAYER_LOGIN_METHOD=
 * email_otp`) and `NODE_ENV` dev/test, so the one-time code is echoed back as `dev_otp`
 * (mirrors the worker mock-OTP path the e2e already relies on).
 */
export async function mintPayerSession(
  opts: MintPayerSessionOptions = {},
): Promise<MintedPayerSession> {
  const apiUrl = opts.apiUrl ?? process.env.E2E_API_URL ?? "http://localhost:3001";
  const role = opts.role ?? "employer";
  // Unique, synthetic, per-run email so each session is an isolated new account.
  const email = `e2e-payer-${randomUUID()}@example.test`;

  // 1. Signup: creates the real `payers` row (emits payer.created once) + issues a code.
  const signup = await httpJson(apiUrl, "POST", "/payer/signup", {
    role,
    email,
    org_name: "E2E Test Org",
  });
  expect(signup.status, `payer signup failed: ${JSON.stringify(signup.json)}`).toBe(200);
  const devOtp = signup.json?.dev_otp as string | undefined;
  expect(
    devOtp,
    "signup must echo dev_otp (API must run NODE_ENV=test/development + a mock login channel)",
  ).toBeTruthy();

  // 2. Verify the code → mint a real, revocable, signed payer session.
  const verify = await httpJson(apiUrl, "POST", "/payer/login/verify", {
    email,
    code: devOtp,
  });
  expect(verify.status, `payer login/verify failed: ${JSON.stringify(verify.json)}`).toBe(200);
  const token = verify.json?.access_token as string | undefined;
  const payerId = verify.json?.payer_id as string | undefined;
  expect(token, "login/verify must return an access_token").toBeTruthy();
  expect(payerId, "login/verify must return the server-assigned payer_id").toBeTruthy();

  return { payerId: payerId!, token: token!, email, role: verify.json?.role as string };
}
