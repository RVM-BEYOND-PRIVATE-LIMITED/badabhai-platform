/**
 * Demand-side seed (BUG-2) — makes the employer/unlock loop SEEDABLE + PROVABLE.
 *
 * After a fresh deploy the demand-side tables are empty, so the unlock loop has
 * nothing to grant. This seed creates the minimal, clearly-SYNTHETIC, faceless
 * fixture the loop needs:
 *   1. a worker (encrypted phone via the SHARED crypto) + a worker_profile (so it
 *      ranks in the masked applicant feed) + a worker_consents row INCLUDING the
 *      `employer_sharing` purpose (so the unlock consent gate passes);
 *   2. one OPEN job_posting (the subject of the plan purchase);
 *   3. one CREDITED payer_credits row (so the unlock debit succeeds).
 *
 * GUARDED: refuses to run when NODE_ENV === "production" (mirrors seed.ts).
 * IDEMPOTENT: stable UUIDs + ON CONFLICT — re-runs are safe; payer credits are
 *   re-topped so a prior verify run (which spends one credit) doesn't drain it.
 * PRIVACY (CLAUDE.md §2 #2): the phone is SYNTHETIC and stored ONLY as an
 *   `encryptPii` ciphertext token + a peppered hash — never plaintext, never in an
 *   event. It uses the SAME crypto the API uses, so the reveal-path `decrypt` matches
 *   — run with the API's PII_ENCRYPTION_KEY + PII_HASH_PEPPER, or reveal fails closed.
 *
 *   pnpm db:seed:demand
 *   (DATABASE_URL / PII_ENCRYPTION_KEY / PII_HASH_PEPPER are read from the
 *    environment / repo-root .env, like the other seeds.)
 *
 * Run `db:seed:jobs` too: the /reach applicant feed ranks against the ADR-0009
 * `jobs` table, so a seeded job must exist for `feed.shown` to fire.
 */
import { config } from "dotenv";
import { createDbClient } from "./client";
import {
  workers,
  workerProfiles,
  workerConsents,
  jobPostings,
  payerCredits,
  payers,
  payerOrgs,
  payerMembers,
} from "./schema";
import { encryptPii, hashPhone } from "./crypto";

// Load the repo-root .env (CWD is packages/db when run via the package script).
config({ path: "../../.env" });

// Stable, clearly-SYNTHETIC ids (the "5eeded00" prefix flags them as seed rows).
// Stable so the same ids exist across environments + reseeds (the events spine
// carries them). Do NOT regenerate.
const WORKER_ID = "5eeded00-0001-4a00-8000-000000000001";
const PROFILE_ID = "5eeded00-0002-4a00-8000-000000000002";
const CONSENT_ID = "5eeded00-0003-4a00-8000-000000000003";
const PAYER_ID = "5eeded00-0004-4a00-8000-000000000004";
const CREDITS_ID = "5eeded00-0005-4a00-8000-000000000005";
const JOB_POSTING_ID = "5eeded00-0006-4a00-8000-000000000006";
const OPS_ACTOR_ID = "5eeded00-0007-4a00-8000-000000000007";
// ADR-0027 B5.x Inc 2: the seeded payer's SOLO org (root_payer_id = PAYER_ID) + its owner member.
// Stable ids so the payer_credits.org_id stamp is deterministic + the seed stays idempotent.
const ORG_ID = "5eeded00-0008-4a00-8000-000000000008";
const MEMBER_ID = "5eeded00-0009-4a00-8000-000000000009";

// SYNTHETIC payer identity (B2B PII → encrypted at rest, never plaintext / never evented).
const SYNTHETIC_PAYER_EMAIL = "seed-demand-payer@demand.test.invalid";
const SYNTHETIC_ORG_NAME = "SYNTHETIC — Demand Seed Employer (not a real company)";

// The cnc_operator job from seed-jobs.ts — aligns the worker's canonical trade so it
// ranks in that job's applicant feed (run db:seed:jobs first; used for /reach).
const SEED_JOB_ID = "a1f0c0de-0001-4a00-8000-000000000001";

// SYNTHETIC phone — never a real number. E.164-shaped.
const SYNTHETIC_PHONE = "+915550000001";
const STARTING_CREDITS = 25;

async function main(): Promise<void> {
  if (process.env.NODE_ENV === "production") {
    throw new Error("[seed:demand] refusing to seed synthetic fixtures in production.");
  }

  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("[seed:demand] DATABASE_URL is not set");

  const key = process.env.PII_ENCRYPTION_KEY;
  const pepper = process.env.PII_HASH_PEPPER;
  if (!key || !pepper) {
    throw new Error(
      "[seed:demand] PII_ENCRYPTION_KEY and PII_HASH_PEPPER must be set — and MUST match the " +
        "API's, or reveal's decrypt fails closed and contact.revealed never fires.",
    );
  }

  const now = new Date();
  const { db, sql } = createDbClient(url, { max: 1 });
  try {
    // 1) Worker — encrypted phone + peppered hash (THROUGH the shared crypto). No name.
    await db
      .insert(workers)
      .values({
        id: WORKER_ID,
        phoneE164: encryptPii(SYNTHETIC_PHONE, key), // AES-256-GCM ciphertext token
        phoneHash: hashPhone(SYNTHETIC_PHONE, pepper), // keyed HMAC (lookup/dedup)
        fullName: null, // no name even synthetic — keep it faceless
      })
      .onConflictDoNothing({ target: workers.id });

    // 2) Worker profile — so it appears (and ranks) in the masked applicant feed.
    //    reach reads the FULL worker_profiles pool (no status filter), so existence
    //    is enough; the canonical trade/role align it to the cnc_operator seed job.
    await db
      .insert(workerProfiles)
      .values({
        id: PROFILE_ID,
        workerId: WORKER_ID,
        canonicalTradeId: "cnc_operator",
        canonicalRoleId: "cnc_operator",
        confirmedAt: now,
      })
      .onConflictDoNothing({ target: workerProfiles.id });

    // 3) Consent INCLUDING employer_sharing — the unlock consent gate keys on this exact purpose.
    await db
      .insert(workerConsents)
      .values({
        id: CONSENT_ID,
        workerId: WORKER_ID,
        consentVersion: "seed-demand-v1",
        purposes: ["employer_sharing"],
        acceptedAt: now,
      })
      .onConflictDoNothing({ target: workerConsents.id });

    // 4) Open job_posting — the subject of the plan purchase (job_posting.purchased).
    await db
      .insert(jobPostings)
      .values({
        id: JOB_POSTING_ID,
        createdBy: OPS_ACTOR_ID, // opaque ops actor, no FK
        orgLabel: "SYNTHETIC — Demand Seed (not a real employer)",
        roleTitle: "CNC Operator — Demand Seed",
        locationLabel: "Pune (seed)",
        vacancyBand: "2-5",
        status: "open",
      })
      .onConflictDoNothing({ target: jobPostings.id });

    // 5) The payer identity + its SOLO org (ADR-0027 B5.x Inc 2). The wallet keys on org_id
    //    (NOT NULL from Inc 0's migration 0034), so the seeded credits below MUST carry the
    //    seeded payer's solo org id. We create the org foundation here (matching B5.1's solo-org
    //    shape: a payers row → a payer_orgs row with root_payer_id = the payer → an owner member)
    //    so org_id is available + is a REAL org. PII: the payer email/org name are SYNTHETIC and
    //    stored ONLY as ciphertext (never plaintext, never evented). All inserts idempotent.
    await db
      .insert(payers)
      .values({
        id: PAYER_ID,
        role: "employer",
        emailEnc: encryptPii(SYNTHETIC_PAYER_EMAIL, key),
        emailHash: hashPhone(SYNTHETIC_PAYER_EMAIL, pepper), // peppered HMAC lookup key
        orgNameEnc: encryptPii(SYNTHETIC_ORG_NAME, key),
        status: "active",
      })
      .onConflictDoNothing({ target: payers.id });

    await db
      .insert(payerOrgs)
      .values({
        id: ORG_ID,
        rootPayerId: PAYER_ID,
        nameEnc: encryptPii(SYNTHETIC_ORG_NAME, key),
        status: "active",
      })
      .onConflictDoNothing({ target: payerOrgs.id });

    await db
      .insert(payerMembers)
      .values({
        id: MEMBER_ID,
        orgId: ORG_ID,
        memberPayerId: PAYER_ID,
        emailEnc: encryptPii(SYNTHETIC_PAYER_EMAIL, key),
        emailHash: hashPhone(SYNTHETIC_PAYER_EMAIL, pepper),
        orgRole: "owner",
        status: "active",
        acceptedAt: now,
      })
      .onConflictDoNothing({ target: payerMembers.id });

    // 6) Credited payer_credits — so the unlock debit (balance >= 1) succeeds. Re-top on re-run
    //    so a prior verify (which spends one credit) doesn't drain the fixture. ADR-0027 B5.x
    //    Inc 2: stamps org_id (the wallet key) alongside payer_id (kept for ops/audit).
    await db
      .insert(payerCredits)
      .values({ id: CREDITS_ID, orgId: ORG_ID, payerId: PAYER_ID, balance: STARTING_CREDITS })
      .onConflictDoUpdate({
        // org_id is the SOLE wallet uniqueness (ADR-0027 Inc 6 — the old payer_id unique is
        // dropped in 0036), so the upsert arbiters on org_id.
        target: payerCredits.orgId,
        set: { balance: STARTING_CREDITS, updatedAt: now },
      });

    console.log("[seed:demand] synthetic demand fixture ready:");
    console.log(`  worker_id      = ${WORKER_ID}`);
    console.log(`  payer_id       = ${PAYER_ID}  (credits=${STARTING_CREDITS})`);
    console.log(`  job_posting_id = ${JOB_POSTING_ID}  (status=open)`);
    console.log(`  seed_job_id    = ${SEED_JOB_ID}  (run db:seed:jobs first; used for /reach applicants)`);
    console.log("Drive the loop with: pnpm db:verify:demand");
  } finally {
    await sql.end({ timeout: 5 });
  }
}

main().catch((err) => {
  console.error("[seed:demand] failed:", err);
  process.exit(1);
});
