import "server-only";
import type { z } from "zod";
import { payerServerConfig } from "./server-config";
import { readApiToken } from "./auth/session-cookie";

/**
 * SERVER-ONLY HTTP transport to the payer-authed NestJS endpoints (ADR-0019 LC-1).
 *
 * SECURITY:
 *  - The payer JWT is read from the httpOnly server cookie ({@link readApiToken}) and
 *    sent as `Authorization: Bearer <jwt>` — it NEVER touches the client bundle.
 *  - TENANCY (XB-A): the payer is the SESSION identity carried by that token. This
 *    transport NEVER sends a client-supplied `payer_id`; a body never carries one
 *    (the backend derives it from `req.payer.id`). Callers pass only worker/job ids.
 *  - Every response is parsed with a Zod schema (invariant #7, no `any`); a parse
 *    failure or a non-2xx throws so the page renders an honest error state.
 *
 * The API base URL is the SERVER-side `payerServerConfig().apiBaseUrl` — not a
 * `NEXT_PUBLIC_*` value — so the browser never learns the internal API origin.
 */

class PayerUnauthorizedError extends Error {
  constructor() {
    super("payer session expired or missing");
    this.name = "PayerUnauthorizedError";
  }
}

export function isPayerUnauthorized(err: unknown): boolean {
  return err instanceof PayerUnauthorizedError;
}

interface RequestOptions<T> {
  method?: "GET" | "POST" | "PATCH";
  /** Request body (JSON). NEVER include a payer_id — the session token carries it. */
  body?: unknown;
  /** Zod schema the response is validated against. */
  schema: z.ZodType<T>;
  /** When true, omit the Authorization header (public auth endpoints). */
  public?: boolean;
}

/** Low-level authed JSON call to the payer API. Throws on 401 / non-2xx / parse fail. */
export async function payerFetch<T>(path: string, opts: RequestOptions<T>): Promise<T> {
  const { apiBaseUrl } = payerServerConfig();
  const headers: Record<string, string> = { "content-type": "application/json" };

  if (!opts.public) {
    const token = await readApiToken();
    if (!token) throw new PayerUnauthorizedError();
    headers.authorization = `Bearer ${token}`;
  }

  const res = await fetch(`${apiBaseUrl}${path}`, {
    method: opts.method ?? "GET",
    headers,
    body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
    cache: "no-store",
  });

  if (res.status === 401) throw new PayerUnauthorizedError();
  if (!res.ok) {
    // Body may carry a deny reason — do NOT surface it (no-oracle / no PII). Class only.
    throw new Error(`payer API ${path} returned ${res.status}`);
  }

  // 204 / empty body (e.g. logout) → parse against an empty object.
  if (res.status === 204) return opts.schema.parse({});
  const text = await res.text();
  const json: unknown = text.length > 0 ? JSON.parse(text) : {};
  return opts.schema.parse(json);
}
