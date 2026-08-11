import type { Request, Response, NextFunction } from "express";

/**
 * Baseline HTTP security headers for the API (PAY-SEC-08).
 *
 * WHY NOT helmet: it is not a dependency of this repo, and adding one to satisfy ~20 lines of
 * static headers costs a lockfile change, a supply-chain surface, and a `pnpm audit` obligation
 * for something we can state explicitly and review in one screen. Explicit also means the values
 * are chosen for THIS surface rather than inherited from a general-purpose default.
 *
 * This API serves JSON to a first-party portal and to service callers. It renders no HTML, embeds
 * no third-party content, and is never framed — so the policy can be maximally restrictive:
 *
 *  - `Content-Security-Policy: default-src 'none'; frame-ancestors 'none'` — a JSON API has no
 *    legitimate subresource of any kind. This is the strong one: even if a response were somehow
 *    coerced into being interpreted as HTML, it can load nothing.
 *  - `X-Content-Type-Options: nosniff` — stops a browser second-guessing `application/json`,
 *    the precondition for most JSON-as-script attacks.
 *  - `X-Frame-Options: DENY` — legacy companion to `frame-ancestors` for older browsers.
 *  - `Referrer-Policy: no-referrer` — API URLs carry ids in the path; never leak them onward.
 *  - `Cross-Origin-Resource-Policy: same-site` — blocks opportunistic cross-origin embedding.
 *  - `X-Permitted-Cross-Domain-Policies: none` — kills the Flash/PDF crossdomain.xml vector.
 *
 * DELIBERATELY NOT SET HERE:
 *  - `Strict-Transport-Security`. TLS terminates at the edge, not in this process. Emitting HSTS
 *    from behind a proxy is how a misconfigured local/staging deployment poisons a developer's
 *    browser for the whole domain. It belongs on the TLS terminator, and is recorded as such.
 *  - CORS — already owned by `resolveCorsOrigins` in main.ts; two sources of truth would be worse
 *    than one.
 *
 * `x-powered-by` is removed rather than overwritten: absent is strictly better than decorative.
 */
export function securityHeadersMiddleware(_req: Request, res: Response, next: NextFunction): void {
  res.removeHeader("X-Powered-By");
  res.setHeader("Content-Security-Policy", "default-src 'none'; frame-ancestors 'none'");
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("X-Frame-Options", "DENY");
  res.setHeader("Referrer-Policy", "no-referrer");
  res.setHeader("Cross-Origin-Resource-Policy", "same-site");
  res.setHeader("X-Permitted-Cross-Domain-Policies", "none");
  next();
}
