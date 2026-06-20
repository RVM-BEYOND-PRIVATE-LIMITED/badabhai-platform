/**
 * CLIENT-SIDE payer session store.
 *
 * The ONLY credential this app holds is the authenticated payer's own Bearer
 * token (minted by POST /payer/login/verify, rolled by the API via the
 * `x-session-token` response header). It is persisted in `localStorage` only —
 * never sent to any origin other than the configured API, never logged, and
 * never a server secret.
 *
 * Tenant isolation is enforced SERVER-SIDE (PayerAuthGuard + assertPayerOwns):
 * we keep the payer's own id alongside the token purely so the dashboard can
 * call its own `GET /payers/:id/credits` path WITHOUT ever letting the user
 * type another payer's id.
 */

const TOKEN_KEY = "bb.payer.token";
const PAYER_KEY = "bb.payer.identity";

/** Minimal identity persisted next to the token (no PII beyond the login email is stored). */
export interface PayerIdentity {
  payerId: string;
  role: string;
  email: string;
}

const hasWindow = (): boolean => typeof window !== "undefined";

export function getToken(): string | null {
  if (!hasWindow()) return null;
  return window.localStorage.getItem(TOKEN_KEY);
}

export function setToken(token: string): void {
  if (!hasWindow()) return;
  window.localStorage.setItem(TOKEN_KEY, token);
}

export function getIdentity(): PayerIdentity | null {
  if (!hasWindow()) return null;
  const raw = window.localStorage.getItem(PAYER_KEY);
  if (!raw) return null;
  try {
    return JSON.parse(raw) as PayerIdentity;
  } catch {
    return null;
  }
}

export function setSession(token: string, identity: PayerIdentity): void {
  if (!hasWindow()) return;
  window.localStorage.setItem(TOKEN_KEY, token);
  window.localStorage.setItem(PAYER_KEY, JSON.stringify(identity));
}

export function clearSession(): void {
  if (!hasWindow()) return;
  window.localStorage.removeItem(TOKEN_KEY);
  window.localStorage.removeItem(PAYER_KEY);
}
