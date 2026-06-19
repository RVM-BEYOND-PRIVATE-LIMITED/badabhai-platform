/**
 * Demand-loop verifier (BUG-2) — drives the seeded demand loop against a running API
 * and asserts the events spine recorded every step. Turns "does the employer/unlock
 * loop work?" into one command, so it stops being a manual click-path.
 *
 * Deterministic; MOCK payments only (PAYMENTS_ENABLE_REAL stays false). The only DB
 * access is the read-only event assertion at the end; the loop itself goes through the
 * real HTTP API (so guards, consent, credits, and event emission are all exercised).
 *
 *   API_BASE_URL=https://<staging-api> \
 *   INTERNAL_SERVICE_TOKEN=<token> \
 *   DATABASE_URL=<staging-db> \
 *   pnpm db:verify:demand
 *
 * Prereqs: pnpm db:migrate → db:seed:jobs → db:seed:demand, and the API running
 * against the same DB with the SAME PII_ENCRYPTION_KEY/PEPPER the seed used.
 */
import { config } from "dotenv";
import { gte } from "drizzle-orm";
import { createDbClient } from "./client";
import { events } from "./schema";

config({ path: "../../.env" });

const API = process.env.API_BASE_URL ?? "http://localhost:3000";
const TOKEN = process.env.INTERNAL_SERVICE_TOKEN ?? "";

// Must match seed-demand.ts.
const WORKER_ID = "5eeded00-0001-4a00-8000-000000000001";
const PAYER_ID = "5eeded00-0004-4a00-8000-000000000004";
const JOB_POSTING_ID = "5eeded00-0006-4a00-8000-000000000006";
const SEED_JOB_ID = "a1f0c0de-0001-4a00-8000-000000000001";

// The events the demand loop MUST record end-to-end (all exist in the registry).
const REQUIRED = [
  "feed.shown",
  "job_posting.purchased",
  "payment.authorized",
  "payment.captured",
  "unlock.granted",
  "contact.revealed",
] as const;

type Json = Record<string, unknown>;

async function http(method: string, path: string, body?: Json): Promise<{ status: number; json: Json }> {
  const res = await fetch(`${API}${path}`, {
    method,
    headers: {
      "content-type": "application/json",
      // Required by /unlocks*; harmless on the unguarded plan/reach routes.
      "x-internal-service-token": TOKEN,
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  let json: Json = {};
  try {
    json = (await res.json()) as Json;
  } catch {
    // no/!json body
  }
  return { status: res.status, json };
}

async function main(): Promise<void> {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("[verify:demand] DATABASE_URL is not set");
  if (!TOKEN) throw new Error("[verify:demand] INTERNAL_SERVICE_TOKEN is not set (required for /unlocks).");

  const since = new Date();

  // [1] Purchase a posting plan → payment.authorized + payment.captured + job_posting.purchased.
  const plan = await http("POST", `/job-postings/${JOB_POSTING_ID}/plan`, { payer_id: PAYER_ID, tier: "standard" });
  console.log(`[1] plan       -> ${plan.status}`);

  // [2] View the masked applicant feed → one feed.shown per rendered row.
  const applicants = await http("GET", `/reach/jobs/${SEED_JOB_ID}/applicants`);
  console.log(`[2] applicants -> ${applicants.status}`);

  // [3] Unlock the synthetic worker → unlock.granted (after consent + credit gates).
  const unlock = await http("POST", "/unlocks", { payer_id: PAYER_ID, worker_id: WORKER_ID, job_id: SEED_JOB_ID });
  const unlockId = unlock.json["unlock_id"] as string | undefined;
  console.log(`[3] unlock     -> ${unlock.status} ok=${String(unlock.json["ok"])} unlock_id=${unlockId ?? "(neutral)"}`);
  if (!unlockId) {
    throw new Error(
      "[verify:demand] unlock returned the neutral body — check consent/credits/seed, " +
        "INTERNAL_SERVICE_TOKEN, and that the seed used the API's PII keys.",
    );
  }

  // [4] Reveal the routed contact → contact.revealed.
  const reveal = await http("POST", `/unlocks/${unlockId}/reveal`);
  console.log(`[4] reveal     -> ${reveal.status} channel=${String(reveal.json["channel"] ?? "(neutral)")}`);

  // Assert the spine recorded every required event since `since`.
  const { db, sql } = createDbClient(url, { max: 1 });
  try {
    const rows = await db.select({ name: events.eventName }).from(events).where(gte(events.createdAt, since));
    const seen = new Set(rows.map((r) => r.name));
    const missing = REQUIRED.filter((n) => !seen.has(n));
    if (missing.length > 0) {
      console.error(`[verify:demand] FAIL — missing events: ${missing.join(", ")}`);
      process.exit(1);
    }
    console.log(`[verify:demand] PASS — all demand-loop events recorded: ${REQUIRED.join(", ")}`);
  } finally {
    await sql.end({ timeout: 5 });
  }
}

main().catch((err) => {
  console.error("[verify:demand] failed:", err);
  process.exit(1);
});
