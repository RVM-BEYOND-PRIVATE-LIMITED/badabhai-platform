import { sql, type SQL } from "drizzle-orm";

/**
 * #2752 — a `workers` row the Campus link created that its student has never signed in to: still
 * `pending`, with an `institute` origin. It is a placeholder for a person who has not used
 * BadaBhai, not a sign-up, so the onboarding funnel, the per-worker journey and the dashboard's
 * worker totals leave it out until his first worker-app sign-in activates it (and emits
 * `worker.created`). A legacy `pending` row without that origin is counted exactly as before.
 *
 * Written over the unaliased `workers` table, for the admin reads that select from it directly.
 * The references are QUALIFIED by hand: Drizzle may render an interpolated column without its
 * table, and inside the subquery a bare column would bind to `worker_origins` instead.
 */
export const awaitingFirstSignIn: SQL = sql`("workers"."status" = 'pending' AND EXISTS (
  SELECT 1 FROM worker_origins o
  WHERE o.worker_id = "workers"."id" AND o.kind = 'institute'
))`;

/** Every worker except {@link awaitingFirstSignIn}: the admin population of real sign-ups. */
export const signedUpWorker: SQL = sql`NOT ${awaitingFirstSignIn}`;
