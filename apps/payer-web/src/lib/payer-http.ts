import "server-only";
import type { z } from "zod";
import { payerServerConfig } from "./server-config";
import { readApiToken } from "./auth/session-cookie";
import {
  PayerConflictError,
  PayerValidationError,
  PriceMismatchError,
  type ApiFieldIssue,
} from "./payer-errors";

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
  method?: "GET" | "POST" | "PATCH" | "DELETE";
  /** Request body (JSON). NEVER include a payer_id — the session token carries it. */
  body?: unknown;
  /**
   * Zod schema the response is validated against. Its INPUT side is `unknown` on purpose: the
   * transport parses untyped JSON, so only the schema's OUTPUT (`T`) matters here — and a schema
   * that degrades a field (e.g. `.catch(null)`) legitimately accepts any input for it.
   */
  schema: z.ZodType<T, z.ZodTypeDef, unknown>;
  /** When true, omit the Authorization header (public auth endpoints). */
  public?: boolean;
  /**
   * Optional `Idempotency-Key` for a MUTATING purchase (POST /payer/credits, /payer/capacity,
   * /payer/job-postings/:id/quota-topup — #1046/#1148/#2085). When present the SAME key across
   * a re-tap makes the backend charge ONCE and replay the first result; a second in-flight
   * duplicate answers 409 with no renderable figure.
   * PII-free (a random UUID minted per purchase). Absent ⇒ the header is OMITTED and the call
   * behaves exactly as before (backward compatible — the header is optional by design).
   */
  idempotencyKey?: string;
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

  // Per-purchase idempotency (#1046/#1148). The key is minted CLIENT-side (per purchase intent)
  // and threaded through the server action + seam to here — it is NOT regenerated server-side,
  // so a retry of the same tap carries the same key and the backend dedupes it.
  if (opts.idempotencyKey) headers["Idempotency-Key"] = opts.idempotencyKey;

  const res = await fetch(`${apiBaseUrl}${path}`, {
    method: opts.method ?? "GET",
    headers,
    body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
    cache: "no-store",
  });

  if (res.status === 401) throw new PayerUnauthorizedError();
  if (!res.ok) {
    // A 400 is the ONE status whose body is a safe, structured refusal: the shared
    // ZodValidationPipe (and the chat publish) return `error.issues[]` naming the
    // FIELD and a static reason — never the offending value. Capture it so a form
    // can show the refused field inline; anything else stays a class-only error
    // (no-oracle / no PII, unchanged).
    if (res.status === 400) {
      const issues = await readFieldIssues(res);
      if (issues.length > 0) throw new PayerValidationError(path, issues);
    }
    // A 409 is read too (#2085): a `price_mismatch` must reach the payer as "the price
    // changed", and must never be read as a purchase seam's other 409s. Nothing from the
    // body is rendered except the API's current price.
    if (res.status === 409) throw await readConflict(path, res);
    // Body may carry a deny reason — do NOT surface it (no-oracle / no PII). Class only.
    throw new Error(`payer API ${path} returned ${res.status}`);
  }

  // 204 / empty body (e.g. logout) → parse against an empty object.
  if (res.status === 204) return opts.schema.parse({});
  const text = await res.text();
  const json: unknown = text.length > 0 ? JSON.parse(text) : {};
  return opts.schema.parse(json);
}

/**
 * Classify a 409 body, defensively. The API's exception filter nests the thrown payload under
 * `error` (`{ statusCode, error: { reason, message, current_price_inr, … }, requestId, … }`); a
 * flat body is accepted too. `reason: "price_mismatch"` → {@link PriceMismatchError}; anything
 * else (including an unreadable body) → {@link PayerConflictError}, whose message is the
 * historic `returned 409` shape.
 */
async function readConflict(path: string, res: Response): Promise<Error> {
  let fields: Record<string, unknown> = {};
  try {
    const body: unknown = await res.json();
    if (typeof body === "object" && body !== null) {
      const nested = (body as { error?: unknown }).error;
      fields = (typeof nested === "object" && nested !== null ? nested : body) as Record<
        string,
        unknown
      >;
    }
  } catch {
    fields = {};
  }
  if (fields.reason === "price_mismatch") {
    const current = fields.current_price_inr;
    const usable = typeof current === "number" && Number.isInteger(current) && current >= 0;
    return new PriceMismatchError(path, usable ? current : null);
  }
  return new PayerConflictError(path, typeof fields.message === "string" ? fields.message : null);
}

/**
 * Extract `issues: [{ path, message }]` from a 400 body, defensively.
 *
 * The Nest exception filter wraps the pipe's payload as `{ error: { message, issues } }`;
 * both that nesting and a flat `{ issues }` are accepted so a filter change degrades to
 * the old class-only error rather than a parse crash. A malformed body yields `[]`.
 */
async function readFieldIssues(res: Response): Promise<ApiFieldIssue[]> {
  try {
    const body: unknown = await res.json();
    const record = body as { error?: { issues?: unknown }; issues?: unknown };
    const raw = record.error?.issues ?? record.issues;
    if (!Array.isArray(raw)) return [];
    const issues: ApiFieldIssue[] = [];
    for (const item of raw) {
      if (typeof item !== "object" || item === null) continue;
      const { path, message } = item as { path?: unknown; message?: unknown };
      if (typeof message !== "string" || message.length === 0) continue;
      issues.push({ path: typeof path === "string" ? path : "", message });
    }
    return issues;
  } catch {
    return [];
  }
}
