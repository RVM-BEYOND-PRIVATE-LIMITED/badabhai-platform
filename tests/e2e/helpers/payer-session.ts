import { expect } from "vitest";
import { randomUUID } from "node:crypto";

/**
 * Minted-payer-session test helper (R16 / LC-1, ADR-0019 Phase 1).
 *
 * The canonical `/unlocks` + `/payers/:payerId/credits` surface is now behind
 * {@link import("../../../apps/api/src/payers/payer-auth.guard").PayerAuthGuard}: every
 * action is bound to the AUTHENTICATED session payer (`req.payer.id`) — the body/query no
 * longer carries `payer_id`, and the `/payers/:payerId/credits` path param is asserted to
 * equal the session payer (`assertPayerOwns`, XB-A). The interim `InternalServiceGuard`
 * (shared-secret + a body/param `payer_id`) is GONE from this surface.
 *
 * This helper drives the REAL self-serve payer login over HTTP — signup → dev-OTP →
 * login/verify — so the Bearer it returns is minted by the REAL
 * {@link import("../../../apps/api/src/payers/payer-session.service").PayerSessionService}
 * (signed + backed by a live Redis session record). We do NOT hand-roll a divergent JWT:
 * a hand-signed token would lack the `payer_session:<sid>` Redis record and the guard
 * (`validateAndTouch`) would reject it. Signup also CREATES the real `payers` row, so the
 * returned `payerId` is a genuine account; the unlock spine keys on it as the opaque
 * `payer_id` (no FK — schema.ts §768, "faceless-rails" ref), so nothing else is needed.
 *
 * The `payerId` is SERVER-ASSIGNED at signup (a payer can never choose its own id). Tests
 * therefore mint a session FIRST, then seed credits/data against the returned `payerId` —
 * which is exactly the id the credits route will assert the session owns.
 *
 * PRIVACY: the only PII a session needs is the payer's own login email (unavoidable — it
 * is the login identifier, B-R2 class, encrypted at rest in `payers`). We use a unique,
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

/** Minimal HTTP shape returned by {@link httpJson}. */
interface JsonResponse {
  status: number;
  json: any;
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
  return { status: res.status, json: text ? JSON.parse(text) : null };
}

/**
 * Sign up + log in a FRESH payer over the real self-serve flow and return a valid Bearer
 * session plus the server-assigned `payerId`. Use the returned `payerId` everywhere the
 * test previously passed a body/param `payer_id` (it is the id the session owns).
 *
 * Requires the API to be running with the default mock login channel
 * (`PAYER_LOGIN_METHOD=email_otp`) and `NODE_ENV` dev/test, so the one-time code is echoed
 * back as `dev_otp` (mirrors the worker mock-OTP path the e2e already relies on).
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

  return { payerId: payerId!, token: token!, email, role: verify.json.role as string };
}
