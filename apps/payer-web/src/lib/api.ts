/**
 * Thin payer API client (browser-only).
 *
 * Wires to the REAL self-serve payer surface:
 *   - POST /payer/signup        (role-aware account create + login code)
 *   - POST /payer/login/request (login code for an existing account)
 *   - POST /payer/login/verify  (mint a payer session)
 *   - POST /payer/logout        (revoke the session)
 *   - GET  /payers/:id/credits  (own credit balance — :id is the SESSION payer)
 *   - GET  /unlocks             (own unlocks)
 *
 * ROLLING TOKEN: every authenticated response is read for an `x-session-token`
 * header (set by PayerAuthGuard past the session half-life). When present we
 * REPLACE the stored token so the client always carries the freshest one.
 *
 * SECURITY: the Bearer token is the payer's OWN session credential, held client-
 * side only (see `session.ts`). No server secret is ever sent. The client never
 * supplies another payer's id — the dashboard derives `:payerId` from the
 * session identity, and server-side `assertPayerOwns` is the real chokepoint.
 */
import { API_BASE_URL } from "./config";
import { getToken, setToken } from "./session";

/** Mirrors apps/api .../payer-auth.dto.ts response shapes. */
export type PayerRole = "employer" | "agent";

export interface PayerAuthCodeResponse {
  status: "code_sent";
  resend_in_seconds: number;
  /** dev/test only on a mock channel — never present in staging/prod. */
  dev_otp?: string;
}

export interface PayerSessionResponse {
  access_token: string;
  token_type: "Bearer";
  expires_in_seconds: number;
  payer_id: string;
  role: PayerRole;
  is_new_payer: boolean;
}

/** GET /payers/:id/credits — PII-free (ids + amount only). */
export interface CreditsResponse {
  payer_id: string;
  balance: number;
}

/** GET /unlocks — PII-free projection (no phone/name/handle). */
export interface UnlockProjection {
  id: string;
  payer_id: string;
  worker_id: string;
  job_id: string | null;
  status: string;
  granted_at: string | null;
  expires_at: string | null;
  [key: string]: unknown;
}

export interface UnlocksResponse {
  unlocks: UnlockProjection[];
}

export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

interface RequestOptions {
  method?: "GET" | "POST";
  body?: unknown;
  /** Attach the stored Bearer token + honour the rolling `x-session-token`. */
  authed?: boolean;
}

async function request<T>(path: string, opts: RequestOptions = {}): Promise<T> {
  const { method = "GET", body, authed = false } = opts;

  const headers: Record<string, string> = { Accept: "application/json" };
  if (body !== undefined) headers["Content-Type"] = "application/json";

  if (authed) {
    const token = getToken();
    if (!token) throw new ApiError("Not signed in", 401);
    headers.Authorization = `Bearer ${token}`;
  }

  let res: Response;
  try {
    res = await fetch(`${API_BASE_URL}${path}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      cache: "no-store",
    });
  } catch {
    // Network/CORS/backend-down — keep the UI honest, never crash.
    throw new ApiError("Cannot reach the API. Is it running?", 0);
  }

  // ROLLING TOKEN: replace the stored token with any freshly-minted one.
  const rolled = res.headers.get("x-session-token");
  if (rolled) setToken(rolled);

  if (res.status === 204) return undefined as T;

  const text = await res.text();
  const data = text ? safeJson(text) : undefined;

  if (!res.ok) {
    const msg =
      (data && typeof data === "object" && "message" in data
        ? String((data as { message: unknown }).message)
        : null) ?? `Request failed (${res.status})`;
    throw new ApiError(msg, res.status);
  }

  return data as T;
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

// ---- Public auth surface (no token) ---------------------------------------

export function signup(input: {
  role: PayerRole;
  email: string;
  org_name: string;
  phone?: string;
}): Promise<PayerAuthCodeResponse> {
  return request<PayerAuthCodeResponse>("/payer/signup", { method: "POST", body: input });
}

export function requestLogin(email: string): Promise<PayerAuthCodeResponse> {
  return request<PayerAuthCodeResponse>("/payer/login/request", {
    method: "POST",
    body: { email },
  });
}

export function verifyLogin(email: string, code: string): Promise<PayerSessionResponse> {
  return request<PayerSessionResponse>("/payer/login/verify", {
    method: "POST",
    body: { email, code },
  });
}

// ---- Authenticated surface (Bearer token; server enforces tenant isolation) -

export function logout(): Promise<void> {
  return request<void>("/payer/logout", { method: "POST", authed: true });
}

/** Own credit balance. `payerId` MUST be the session payer's id (never user input). */
export function getOwnCredits(payerId: string): Promise<CreditsResponse> {
  return request<CreditsResponse>(`/payers/${encodeURIComponent(payerId)}/credits`, {
    authed: true,
  });
}

export function getOwnUnlocks(): Promise<UnlocksResponse> {
  return request<UnlocksResponse>("/unlocks", { authed: true });
}
