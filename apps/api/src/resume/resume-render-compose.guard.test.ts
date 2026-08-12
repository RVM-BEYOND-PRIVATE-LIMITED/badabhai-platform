import { describe, expect, it } from "vitest";
import {
  BASE_COMPOSE_PATH,
  STAGING_COMPOSE_PATH,
  environmentOfFile,
} from "../common/testing/compose-env";

/**
 * THE RESUME RENDER GATE MUST BE REACHABLE FROM THE BOX (#793).
 *
 * WHAT #793 WAS. The worker app, in release against the deployed base URL, loaded chat, jobs,
 * profile and auth — and failed on resume download and photo upload. The client was ruled out:
 * both flows use ABSOLUTE, server-minted Supabase signed URLs, so the API base URL never touches
 * them. The report predicted the shape of the answer exactly ("a 409 on `/resume/:id/download`
 * means render pending/disabled, not a storage-cred issue"), and that is what it was:
 * `RESUME_RENDER_ENABLED` was the hard literal `"false"` in the staging overlay.
 *
 * WHY A LITERAL IS THE BUG AND NOT MERELY A DEFAULT. A compose `environment:` entry with a
 * literal value BEATS the box's shell/.env. So `export RESUME_RENDER_ENABLED=true` on the box
 * changed nothing, no error named the cause, and `/health` was green throughout. This is the
 * fourth instance of one class — `VOICE_NOTES_BUCKET` (asymmetric), `WORKER_PHOTOS_BUCKET`
 * (#794, undeclared), `AI_ENABLE_REAL_CALLS` (#798, literal), now this one — which is what
 * makes it worth a parser rather than a review habit.
 *
 * WHAT THIS ASSERTS, AND WHAT IT DELIBERATELY DOES NOT. It asserts the FORM (settable from the
 * box) and the DIRECTION (off until someone arms it), because those are different decisions and
 * #793 is only about the first. It does NOT assert that any credential is set: keys are
 * box-supplied and never committed, so a test demanding one would fail on `main` forever.
 */

/** The `${VAR:-default}` form: a committed default the BOX can still override, both ways. */
function overridableDefault(name: string, value: string): string {
  return `\${${name}:-${value}}`;
}

describe("docker-compose.staging.yml — the resume render gate (#793)", () => {
  const api = environmentOfFile(STAGING_COMPOSE_PATH, "api");

  it("parses the api environment (guards the parser itself, not the rule)", () => {
    // Without this, a parser that silently found nothing would make every assertion below pass
    // vacuously and this guard would report green while asserting nothing at all. Both canaries
    // are literals fixed by the deploy's own topology, not by any render decision.
    expect(api.get("NODE_ENV")).toBe("production");
    expect(api.get("AI_SERVICE_URL")).toBe("http://ai-service:8000");
  });

  it("RESUME_RENDER_ENABLED is a substitution, NEVER a bare literal", () => {
    // The regression this file is named for. A literal here — `"false"` OR `"true"` — silently
    // wins over the box env in BOTH directions: it re-breaks the arming procedure #793 asked
    // for, and once armed it would remove the emergency OFF switch, making a rollback a code
    // change and a rebuild rather than an export and a re-deploy.
    expect(
      api.get("RESUME_RENDER_ENABLED"),
      "a literal value cannot be overridden on the box — this is what #793 reported",
    ).toMatch(/^\$\{RESUME_RENDER_ENABLED:-(true|false)\}$/);
  });

  it("uses `:-` so an EMPTY export falls back to the default", () => {
    // `-` (unset only) would let an empty export through, and empty is not a legal
    // `booleanFromString` input. The deploy's secrets bridge makes this concrete: an UNSET
    // GitHub secret expands to "" and is exported anyway.
    expect(api.get("RESUME_RENDER_ENABLED")).toContain(":-");
  });

  it("defaults to OFF — storage is box-supplied and may not be there yet", () => {
    // THE ASSERTION ABOVE DELIBERATELY ACCEPTS EITHER DIRECTION, because what it is about is
    // the SUBSTITUTION FORM. The direction is a separate decision and gets its own assertion.
    //
    // Off is the honest default while SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY are `:-` empty
    // pass-throughs: render armed against unconfigured storage boots green and 503s at the
    // first render. Arming belongs in the same act that supplies the creds, which is exactly
    // what the substitution form above now permits.
    expect(api.get("RESUME_RENDER_ENABLED")).toBe(
      overridableDefault("RESUME_RENDER_ENABLED", "false"),
    );
  });

  it("the storage creds the render needs are DECLARED, so the box can supply them", () => {
    // Declared is not set. What matters is that a name exists at all: compose forwards ONLY the
    // names a service's `environment:` block declares, so an undeclared one cannot be supplied
    // from the box no matter what the operator exports. This is the half of #793's ask 1 that
    // lives in this repo; the values themselves are a box action.
    expect(api.get("SUPABASE_URL")).toBe("${SUPABASE_URL:-}");
    expect(api.get("SUPABASE_SERVICE_ROLE_KEY")).toBe("${SUPABASE_SERVICE_ROLE_KEY:-}");
  });

  it("RESUMES_BUCKET is inherited from the base file rather than restated here", () => {
    // NOT A GAP, and worth pinning so nobody 'fixes' it: the deploy composes
    // `-f docker-compose.yml -f docker-compose.staging.yml`, which MERGES the two
    // `environment:` maps key by key. The base file's `${RESUMES_BUCKET:-worker-resumes}` is
    // therefore already in the container AND already box-overridable. Restating it here would
    // add a second place to change one value.
    expect(api.has("RESUMES_BUCKET")).toBe(false);
    expect(environmentOfFile(BASE_COMPOSE_PATH, "api").get("RESUMES_BUCKET")).toBe(
      overridableDefault("RESUMES_BUCKET", "worker-resumes"),
    );
  });
});
