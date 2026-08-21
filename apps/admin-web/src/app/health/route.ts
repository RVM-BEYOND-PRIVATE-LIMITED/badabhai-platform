/**
 * Liveness probe for the box container — DevOps-owned infrastructure surface, not a
 * product page. Mirrors `apps/payer-web`'s own `/health` byte-for-byte in behaviour, and
 * the shape of `apps/api`'s and `apps/ai-service`'s.
 *
 * DELIBERATELY TRIVIAL AND UNAUTHENTICATED, on purpose — and worth restating for THIS app,
 * because it is the ADMIN portal and "unauthenticated route in the admin portal" should
 * always draw a second look:
 *  - No PII, no session read, no upstream call to `apps/api`. It does NOT read the
 *    `bb_admin_token` cookie, does not touch `src/lib/auth/*`, and reveals nothing about
 *    whether any admin exists or is signed in. It answers ONE question — "is the Next.js
 *    server process up and routing requests?" — the same question `deploy-lightsail`'s
 *    health-gate loop (.github/workflows/ci.yml) asks of api / ai-service / payer-web.
 *    Chaining an upstream API call here would make this route's health a function of a
 *    DIFFERENT service's health, which is exactly the TD81 failure class this repo's own
 *    deploy job exists to avoid (a health check must tell you about the thing it is
 *    checking, not paper over a dependency).
 *  - It is reachable only from the box itself: nothing in the security group publishes
 *    admin-web, and no nginx server block routes to it. This route does not change that.
 *  - `force-dynamic` so this never gets statically optimized/cached by the Next build —
 *    every hit must actually reach the running server, not a build-time snapshot. This is
 *    load-bearing for `build` below: a statically optimized response would freeze whatever
 *    the value was at `next build` time, which is precisely the wrong answer.
 *
 * `build` (#965) — WHICH BUILD IS THIS? `status: "ok"` only ever answered "am I up?", so a
 * deploy that silently kept serving the previous image was indistinguishable from a good one
 * and we debugged code that was not running. The deploy pins immutable `sha-<short7>` ghcr
 * images, so the answer is knowable at image-build time; the Dockerfile's runtime stage takes
 * `ARG GIT_COMMIT_SHA` and promotes it to an `ENV`, and this handler reads it per request.
 * It is deliberately NOT a `NEXT_PUBLIC_*` value and takes no part in `next build`.
 *
 * A commit sha is public (it is in the repo, on every PR, and in the image tag). NOTHING else
 * goes in this response — no env dump, no config, no version of any dependency.
 */
export const dynamic = "force-dynamic";

/**
 * The running build id, or `"unknown"` — never absent, never null, never a throw.
 *
 * FAIL OPEN, deliberately. A GitHub Actions `build-args:` line that references a
 * secret/var which does not exist resolves to the EMPTY STRING, and a declared `ARG` is
 * not inert (Docker injects it into the environment), so the variable arrives
 * PRESENT-AND-EMPTY rather than absent. That exact mechanism broke payer-web's build once
 * already, via a zod schema that rejected "". So empty (and whitespace-only) is treated as
 * unset here rather than validated: a missing build id is an observability gap, and turning
 * it into a failed health check would turn that gap into an outage.
 *
 * BOUNDED to the same shape `apps/api`'s `resolveBuildId` and `apps/payer-web`'s own
 * `buildId` use, deliberately kept in step with both. This body is UNAUTHENTICATED:
 * without a bound, an operator-set env carrying control characters or a few KB of text
 * would be reflected verbatim to anyone who can reach `/health`. The bound is generous
 * enough (64 chars, sha/semver-ish) that it does not re-introduce the failure it guards
 * against — anything outside it is reported as `"unknown"`, the same answer as unset, and
 * still never an error.
 */
const BUILD_ID_SHAPE = /^[0-9A-Za-z][0-9A-Za-z._-]{0,63}$/;

function buildId(): string {
  const raw = (process.env.GIT_COMMIT_SHA ?? "").trim();
  return BUILD_ID_SHAPE.test(raw) ? raw : "unknown";
}

export function GET(): Response {
  // `status` and the 200 are consumed by the deploy job's health gate — neither the field
  // nor the status code may change here.
  return new Response(JSON.stringify({ status: "ok", build: buildId() }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}
