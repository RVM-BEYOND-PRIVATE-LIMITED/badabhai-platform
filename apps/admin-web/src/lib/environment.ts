import "server-only";
import { z } from "zod";
import { adminFetch } from "./admin-http";

/**
 * WHICH ENVIRONMENT THIS CONSOLE IS OPERATING ON — the topbar's environment badge (A6, #2576).
 *
 * The source is the API's own public health probe, `GET /health → environment` (the API's
 * `NODE_ENV`: development · test · staging · production), not a label baked into this app: what
 * an operator needs to know before suspending someone is whose data the API behind the console
 * holds, and the portal's own `NODE_ENV` is "production" on every built box, staging included.
 *
 * Only `environment` is read. The probe's `checks` are the System page's business, and a parse
 * of this one field cannot be broken by a change to them.
 *
 * CACHED IN THE SERVER PROCESS — the one read in this app that is. The environment of the API a
 * box points at does not change while the box runs, it is not personal data, and the portal
 * layout renders on every full page load: without a cache every page would wait on a probe that
 * pings the database, Redis and the AI service. A good answer is kept 10 minutes; a failure
 * (the probe unreachable, or answering 503) only 30 seconds, so a recovered API shows within the
 * minute. It NEVER throws: no environment is "unknown", and the badge says so.
 */
const healthEnvironmentSchema = z.object({ environment: z.string().trim().min(1) });

const KEEP_ANSWER_MS = 10 * 60 * 1000;
const KEEP_FAILURE_MS = 30 * 1000;

let cached: { value: string | null; until: number } | null = null;
let inflight: Promise<string | null> | null = null;

/** The API's environment name, lower-cased, or null when the probe could not say. */
export async function getApiEnvironment(now: number = Date.now()): Promise<string | null> {
  if (cached && now < cached.until) return cached.value;
  // Concurrent page loads on a cold cache share one probe.
  inflight ??= adminFetch("/health", { schema: healthEnvironmentSchema, public: true })
    .then(({ environment }) => {
      const value = environment.toLowerCase();
      cached = { value, until: now + KEEP_ANSWER_MS };
      return value;
    })
    .catch(() => {
      cached = { value: null, until: now + KEEP_FAILURE_MS };
      return null;
    })
    .finally(() => {
      inflight = null;
    });
  return inflight;
}

/** Tests only: forget the cached answer. */
export function resetApiEnvironmentForTests(): void {
  cached = null;
  inflight = null;
}
