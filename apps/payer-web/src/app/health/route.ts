/**
 * Liveness probe for the box container (GAP-XC-06, #920) — DevOps-owned infrastructure
 * surface, not a product page. Mirrors the shape of `apps/api`'s and `apps/ai-service`'s
 * own `/health` (both exempt from their respective auth middleware; this route needs no
 * such exemption because payer-web has no request-level auth middleware today).
 *
 * DELIBERATELY TRIVIAL AND UNAUTHENTICATED, on purpose:
 *  - No PII, no session read, no upstream call to `apps/api`. It answers ONE question —
 *    "is the Next.js server process up and routing requests?" — the same question
 *    `deploy-lightsail`'s health-gate loop (.github/workflows/ci.yml) asks of api/ai-service.
 *    Chaining an upstream API call here would make this route's health a function of a
 *    DIFFERENT service's health, which is exactly the TD81 failure class this repo's own
 *    deploy job exists to avoid (a health check must tell you about the thing it is
 *    checking, not paper over a dependency).
 *  - `force-dynamic` so this never gets statically optimized/cached by the Next build —
 *    every hit must actually reach the running server, not a build-time snapshot.
 */
export const dynamic = "force-dynamic";

export function GET(): Response {
  return new Response(JSON.stringify({ status: "ok" }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}
