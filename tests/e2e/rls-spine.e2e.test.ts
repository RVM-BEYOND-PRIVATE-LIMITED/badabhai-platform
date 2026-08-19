import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDbClient, schema, type DbClient } from "@badabhai/db";

/**
 * Spine-wide RLS + REVOKE regression (TD20).
 *
 * Proves the platform-wide PII/linkage lock: every application table denies the
 * PostgREST Data-API roles (anon / authenticated / service_role), so `worker_id`,
 * correlation ids, and the encrypted-PII linkage are unreachable with a Supabase
 * client key. `workers` was locked in 0003/0004; the next 13 in 0009; `jobs` +
 * `applications` in 0012 (created and locked in the same migration, ADR-0009).
 *
 * Two things make this a real guarantee (not a SELECT-only smoke test):
 *  1. NO-DRIFT: the static list below is reconciled against the LIVE public schema
 *     (`pg_tables`) AND the `schema` model count — so a new pgTable that ships without
 *     a lock FAILS this suite instead of being silently skipped by a stale list.
 *  2. REVOKE *ALL*: we assert `has_table_privilege` is false for SELECT *and*
 *     INSERT/UPDATE/DELETE — a table that revoked only SELECT but kept a write grant
 *     would pass a SELECT-only test; it fails here.
 * Plus a runtime cross-check (SET ROLE -> SELECT -> 42501) that a revoked grant yields
 * a real denial, and a backend-can-still-read sanity so the lock never breaks the app.
 *
 * DB-only (no API needed). Opt-in like the other e2e:
 *   1. docker compose up -d postgres
 *   2. create the Supabase-compatible roles (anon/authenticated/service_role)
 *   3. pnpm db:migrate
 *   4. RUN_E2E=1 pnpm --filter @badabhai/e2e test
 * CI does all of this in the `e2e` job (it pre-creates the roles + migrates).
 */

const RUN = process.env.RUN_E2E === "1";
const DATABASE_URL =
  process.env.E2E_DATABASE_URL ??
  process.env.DATABASE_URL ??
  "postgresql://badabhai:badabhai@localhost:5432/badabhai";

// Drives the per-(role,table) cases (must be known synchronously at collect time).
// The "no drift vs the live schema" test below makes this list self-policing.
const LOCKED_TABLES = [
  "workers",
  "payers", // ADR-0019: payer/employer B2B PII (new class); RLS+FORCE+REVOKE in migration 0020
  "worker_consents",
  "worker_profiles",
  "chat_sessions",
  "voice_notes",
  "chat_messages",
  "generated_resumes",
  "events",
  "ai_jobs",
  "audit_logs",
  "profiles",
  "questions",
  "profile_questions",
  "worker_answers",
  "jobs",
  "applications",
  "unlocks",
  "payer_credits",
  "credit_ledger",
  "unlock_routing",
  "job_postings",
  "pricing_catalog",
  "posting_plans",
  "posting_boosts",
  "resume_disclosures",
  "payer_capacity",
  "invites", // ADR-0020: WhatsApp invite funnel (PII-free); RLS+FORCE+REVOKE in migration 0021
  "pace_states", // ADR-0021: pace supply-widening state (PII-free); RLS+FORCE+REVOKE in migration 0023
  "agency_invites", // ADR-0022: agency supply-attribution INTENT (faceless); invited_worker_id is a payer→worker handle → RLS+FORCE+REVOKE in migration 0025
  "admin_users", // ADR-0025: admin ops portal identity (admin-class PII = the admin's OWN encrypted email + authz state); RLS+FORCE+REVOKE in migration 0026
  "worker_flags", // ADR-0025 (ADMIN-3a): admin worker flag/unflag metadata (faceless — opaque worker/admin ids + reason CODE, joins back to identity); RLS+FORCE+REVOKE in migration 0027
  "worker_devices", // ADR-0026 Phase 2: trusted-device binding registry (device_hash = keyed HMAC, push_token = opaque non-PII token — never surfaced); RLS+FORCE+REVOKE in migration 0029
  "worker_credentials", // ADR-0026 Phase 2 (schema only; PIN backend = Phase 3): device-unlock pin_hash + throttle state (secret-derived credential); RLS+FORCE+REVOKE in migration 0029
  "payer_orgs", // ADR-0027 (B5.1): shared-org tenant root; org name = name_enc ciphertext; RLS+FORCE+REVOKE in migration 0035
  "payer_members", // ADR-0027 (B5.1): org membership; email_enc/email_hash (TD21) + invite_token_hash; RLS+FORCE+REVOKE in migration 0035
  "skill", // ADR-0030/TAX-1: canonical skill vocabulary (reference data); RLS+FORCE+REVOKE in migration 0037
  "skill_alias", // ADR-0030/TAX-1: embedded aliases + vector(768) (reference data); RLS+FORCE+REVOKE in migration 0037
  "job_domain", // 0066: generalized-profiling occupation catalog (ISCO-08/NCO-2015 reference data, PII-free); RLS+FORCE+REVOKE in migration 0066
  "job_domain_alias", // 0066: job-domain aliases + vector(768) for the RAG match (reference data, PII-free); RLS+FORCE+REVOKE in migration 0066
  "unresolved_phrase", // ADR-0030/TAX-1: below-floor growth queue — PSEUDONYMIZED phrase + count, NO worker_id; RLS+FORCE+REVOKE in migration 0037
  "push_deliveries", // ADR-0034: one row per (source event, device) push attempt — faceless (opaque event/device ids + status, NO worker_id and no copy); RLS+FORCE+REVOKE in migration 0045
  "agency_kyc", // ADR-0022 Amdt 2: agency financial KYC (PAN/bank ciphertext + keyed HMAC — high-sensitivity financial PII, ADR-0004 discipline); RLS+FORCE+REVOKE in migration 0048
  "agency_payout_accruals", // ADR-0022 Amdt 2: commission accrual ledger (PII-free ₹ + opaque ids; source_unlock_id is one hop from a worker); RLS+FORCE+REVOKE in migration 0048
  "agency_payout_requests", // ADR-0022 Amdt 2: mock payout requests (PII-free ₹ + ids + enum); RLS+FORCE+REVOKE in migration 0048
  "payer_job_posting_chat_sessions", // ADR-0035: payer-side job-posting chat container (opaque payer_id + jsonb state/draft, no PII); RLS+FORCE+REVOKE in migration 0050
  "payer_job_posting_chat_messages", // ADR-0035: payer-side chat transcript (body_text = payer-typed free text about a JOB — never to events/ai_jobs/logs); RLS+FORCE+REVOKE in migration 0050
  "payer_form_drafts", // ADR-0035: generic cross-device payer form-draft primitive (no consumer in that slice by design); RLS+FORCE+REVOKE in migration 0050
  // ── Matching V1 (migrations 0052–0058) ──────────────────────────────────────
  "skill_related", // 0052: TIER-2 skill adjacency (reference data — two closed-vocabulary ids); RLS+FORCE+REVOKE in migration 0052
  "worker_skill", // 0053: per-worker matchable inventory (opaque worker_id + closed vocabulary ids — the reach driver, joins back to identity); RLS+FORCE+REVOKE in migration 0053
  "worker_industry_tenure", // 0053: per-(worker, industry) calendar tenure (opaque worker_id + integer months); RLS+FORCE+REVOKE in migration 0053
  "job_reach", // 0055: materialized (posting, worker) reach set — PII-free but the densest worker-linkage table in the system; RLS+FORCE+REVOKE in migration 0055
  "match_config", // 0057: single-active-row rank-rule config (pricing_catalog clone — ops-editable, PII-free); RLS+FORCE+REVOKE in migration 0057
  "payment_orders", // 0058: payment intents — opaque payer/provider ids + ₹ integers, NO card/UPI/bank data; RLS+FORCE+REVOKE in migration 0058
  "referral_bonus_accruals", // 0058: one accrual per referred worker (two opaque worker ids + ₹); RLS+FORCE+REVOKE in migration 0058
  // ── B4 attribution (migration 0060) ─────────────────────────────────────────
  "referral_links", // 0060: the resolver primitive — `code` is a referral BEARER TOKEN (a client that could read it could claim any agent's commission); RLS+FORCE+REVOKE in migration 0060
  "referral_clicks", // 0060: click log + first-touch claim row — bearer `code` + click_hash (keyed HMAC over ip+UA, raw never stored) + a worker-attribution handle; RLS+FORCE+REVOKE in migration 0060
  // ── Question packs (migration 0069) ─────────────────────────────────────────
  // No worker data in any of these five — they hold reviewed interview copy and
  // occupation references. They are locked anyway because the posture in this database is
  // table-DEFAULT rather than opt-in: a reference table left readable by `anon` is how a
  // catalogue quietly becomes a public API. This is also the drift guard working as
  // designed — adding these tables without listing them here failed CI, which is exactly
  // what it is for.
  "profiling_family", // 0069: the pack owner (~200 rows); RLS+FORCE+REVOKE in migration 0069
  "profiling_family_binding", // 0069: family -> occupation-tree claim, six partial unique indexes; RLS+FORCE+REVOKE in migration 0069
  "question_pack", // 0069: versioned container, one active per (family, locale); RLS+FORCE+REVOKE in migration 0069
  "question_pack_item", // 0069: the question — prompt copy + ask_if/skip_if AST; RLS+FORCE+REVOKE in migration 0069
  "question_pack_option", // 0069: the chips — label_text IS the worker's answer of record; RLS+FORCE+REVOKE in migration 0069
  // ── OIE Phase 8 cutover (migration 0073) ────────────────────────────────────
  "worker_pack_answer", // 0073: the durable typed record of what a worker said, one row per (worker, pack, question_key) — WORKER-AUTHORED answer values, not reference data; RLS+FORCE+REVOKE in migration 0073
  // ── Voice profiling form (migration 0071) ───────────────────────────────────
  "worker_attributes", // 0071: the settled value of an `attribute`-kind answer (77% of the pack corpus had no destination before this) — trade facts keyed by an opaque worker_id, same class as worker_profiles; RLS+FORCE+REVOKE in migration 0071
  "profiling_voice_answer", // 0071: one row per recorded answer clip — opaque ids + question_key + status, NEVER a transcript (that stays on voice_notes); RLS+FORCE+REVOKE in migration 0071
  // ── Canonical Domain→Skill taxonomy (migration 0076) ────────────────────────
  // Listed late, and that is the finding rather than the fix: 0076 created these three
  // tables and landed on `main` without this list being updated. The drift guard below did
  // its job — it just had nothing to fail, because that commit bypassed `ci-required`. The
  // first change in the workstream to actually run CI is what surfaced it.
  "job_domain_skill", // 0076: the canonical trade -> skill materialization the employer's picker reads — reference data, PII-free (jd_*/skill_* ids, relevance, confidence); RLS+FORCE+REVOKE in migration 0076
  "worker_profile_skill", // 0076: per-worker extracted skills keyed by an opaque worker_id — same class as worker_skill; evidence_ref is an OPAQUE INTERNAL ID, never a quote or transcript fragment; RLS+FORCE+REVOKE in migration 0076
  "job_posting_skill", // 0076: the requirement an employer actually chose per posting — opaque posting id + closed-vocabulary skill id, PII-free; RLS+FORCE+REVOKE in migration 0076
  // ── AI cost attribution (migration 0077) ────────────────────────────────────
  "worker_ai_cost_totals", // 0077: per-worker running AI spend — opaque worker_id + ₹ + integer counts, no PII; the worker_id cascade IS the DSAR coverage; RLS+FORCE+REVOKE in migration 0077
  "session_ai_cost_totals", // 0077: per-profiling-session running AI spend — opaque session/worker ids + ₹ + counts, never a transcript; RLS+FORCE+REVOKE in migration 0077
  "platform_ai_cost_totals", // 0077: platform spend by (provider, task_type) — no worker linkage at all, locked anyway because the posture here is table-DEFAULT; RLS+FORCE+REVOKE in migration 0077
  // ── Worker app feedback (migration 0080) ────────────────────────────────────
  "worker_feedback", // 0080: worker-authored app feedback — the ONE table on this spine that may hold a worker's own free-text PII BY DESIGN, so a readable default here would leak personal prose across the whole worker base; DSAR erasure is the worker_id cascade; RLS+FORCE+REVOKE in migration 0080 (0081 adds screen_context, which inherits the table-level posture and re-applies nothing)
] as const;

// The three network-reachable PostgREST roles Supabase ships.
const CLIENT_ROLES = ["anon", "authenticated", "service_role"] as const;
// REVOKE ALL must strip every DML privilege, not just SELECT.
const DML = ["SELECT", "INSERT", "UPDATE", "DELETE"] as const;

describe.skipIf(!RUN)("Spine RLS + REVOKE — every table denies the Data-API roles (TD20)", () => {
  let client!: DbClient;

  beforeAll(async () => {
    client = createDbClient(DATABASE_URL);

    // Guard the signal: a missing/misconfigured client role must fail LOUDLY here, not
    // surface as a confusing per-table error. (We intentionally do NOT assert
    // !rolbypassrls — Supabase's service_role legitimately has BYPASSRLS; REVOKE still
    // denies it, since BYPASSRLS skips RLS policies, not table grants.)
    for (const role of CLIENT_ROLES) {
      const rows = await client.sql.unsafe(
        `SELECT rolsuper FROM pg_roles WHERE rolname = '${role}'`,
      );
      expect(rows.length, `client role "${role}" must exist`).toBe(1);
      expect(rows[0]!.rolsuper, `client role "${role}" must not be superuser`).toBe(false);
    }
  });

  afterAll(async () => {
    await client?.sql.end({ timeout: 5 });
  });

  // No-drift: the locked-table list must equal the LIVE set of public tables AND the
  // `schema` model. A future table added without being locked + listed fails here.
  it("LOCKED_TABLES matches the live public schema and the model (no drift)", async () => {
    const rows = await client.sql.unsafe(
      `SELECT tablename FROM pg_tables WHERE schemaname = 'public'`,
    );
    const live = new Set(rows.map((r) => r.tablename as string));
    expect(new Set(LOCKED_TABLES)).toEqual(live); // every public table is covered, none extra
    expect(live.size).toBe(Object.keys(schema).length); // and the DB matches the Drizzle model
  });

  // Sanity: the backend connection (postgres/BYPASSRLS — superuser in CI) can still read
  // every table. Proves the lock denies CLIENTS without breaking the app's own reads.
  it("the backend connection can still read every locked table", async () => {
    for (const table of LOCKED_TABLES) {
      await expect(client.sql.unsafe(`SELECT 1 FROM "${table}" LIMIT 1`)).resolves.toBeDefined();
    }
  });

  // The guarantee: each client role holds NO DML privilege on each table (proves REVOKE ALL).
  // One `it` per (role, table) so a single missing/partial lock is pinpointed.
  for (const role of CLIENT_ROLES) {
    for (const table of LOCKED_TABLES) {
      it(`${role} has no SELECT/INSERT/UPDATE/DELETE on ${table} (REVOKE ALL)`, async () => {
        for (const priv of DML) {
          const rows = await client.sql.unsafe(
            `SELECT has_table_privilege('${role}', 'public.${table}', '${priv}') AS has`,
          );
          expect(rows[0]!.has, `${role} must NOT have ${priv} on ${table}`).toBe(false);
        }
      });
    }
  }

  // Runtime cross-check: the revoked grant produces a real 42501 at query time, not just
  // a false has_table_privilege bit. Representative table; SET LOCAL ROLE + SELECT share
  // one connection inside a txn.
  it("a revoked role gets a real 42501 at query time (events, anon)", async () => {
    let code: string | undefined;
    try {
      await client.sql.begin(async (sql) => {
        await sql.unsafe(`SET LOCAL ROLE "anon"`);
        await sql.unsafe(`SELECT 1 FROM "events" LIMIT 1`);
      });
    } catch (err) {
      code = (err as { code?: string }).code;
    }
    expect(code).toBe("42501"); // insufficient_privilege
  });
});
