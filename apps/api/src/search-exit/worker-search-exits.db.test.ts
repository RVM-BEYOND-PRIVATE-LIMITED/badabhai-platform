import "reflect-metadata";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { sql as dsql } from "drizzle-orm";
import { loadServerConfig, type ServerConfig } from "@badabhai/config";
import { createDbClient, type Database, type DbClient } from "@badabhai/db";
import { DEFAULT_MATCH_CONFIG } from "@badabhai/match-engine";
import { DEFAULT_CATALOG } from "@badabhai/pricing";

import { InstituteLinkRepository } from "../campus-link/institute-link.repository";
import { InstituteOpenGate } from "../campus-link/institute-open-gate.service";
import { CandidateSearchRepository } from "../candidates/candidate-search.repository";
import type { CandidatePoolQuery } from "../candidates/candidate-search.repository";
import { PiiCryptoService } from "../common/pii-crypto.service";
import type { RequestContext } from "../common/request-context";
import { ConsentRepository } from "../consent/consent.repository";
import { EventsRepository } from "../events/events.repository";
import { EventsService } from "../events/events.service";
import { feedMembershipStatement } from "../payer-portal/payer-applicant-stages.repository";
import { PayerOrgsRepository } from "../payers/payer-orgs.repository";
import { PayerTenantScopeService } from "../payers/payer-tenant-scope.service";
import type { TenantKey } from "../payers/payer-tenant-scope";
import { PayersRepository } from "../payers/payers.repository";
import { PaymentGateway } from "../unlocks/payment-gateway";
import { UnlockService } from "../unlocks/unlocks.service";
import { UnlocksRepository } from "../unlocks/unlocks.repository";
import { WorkersRepository } from "../workers/workers.repository";
import { appliedToTenantStatement, searchExitRefuses } from "./search-exit-gate";
import { SearchExitRepository } from "./search-exit.repository";
import { SearchExitService } from "./search-exit.service";

/**
 * #2753 item 6 — leaving company search (`worker_search_exits`, migration 0168) against a real
 * Postgres.
 *
 * The unit suites prove the service, the gate and the statement SAY the right thing. Only a database
 * proves:
 *  - the REAL search statement leaves a worker out once he has an exit row (the whole pool: the
 *    search's total, the card read and the city facet; and a granted RVM student out of his granted
 *    company's pool too), and includes him again after `visible: true`. With the switch off the same
 *    row hides nobody;
 *  - the PUT writes and deletes ONE row, keeps the first `hidden_at` on a repeat, emits one event per
 *    real change, and leaves every `worker_consents` row exactly as it was;
 *  - the unlock rule against real application rows: the tenant-wide applicant read is the twin of the
 *    applicant feeds' own membership (`feedMembershipStatement`), and `requestUnlock` (the real
 *    service) grants a company he applied to and answers an unrelated one the neutral body with no
 *    debit and no row;
 *  - erasure: `WorkersRepository.hardDelete` removes his exit (the FK cascade);
 *  - the `via` CHECK, and RLS forced with no grant to any client role.
 *
 * Fixtures carry no real PII: synthetic `enc:` / `hash:` markers and a made-up city.
 *
 * ── HOW TO RUN ────────────────────────────────────────────────────────────────
 *   RUN_DB_TESTS=1 pnpm --filter @badabhai/api exec vitest run worker-search-exits.db
 */

const RUN = process.env.RUN_DB_TESTS === "1";
const DATABASE_URL =
  process.env.E2E_DATABASE_URL ??
  process.env.DATABASE_URL ??
  "postgresql://badabhai:badabhai@localhost:5432/badabhai";

const TAG = randomUUID().slice(0, 8);
const id = () => randomUUID();
const CTX = { correlationId: id(), requestId: id() } as RequestContext;

const OPS = id();
const APPLIED_CO = id(); // owns POSTING (he applied) and AGENCY_JOB
const OTHER_CO = id(); // he never applied to it
const GRANT_CO = id(); // holds STUDENT's named-company search grant
const PAYERS = [APPLIED_CO, OTHER_CO, GRANT_CO];
const POSTING = id();
const AGENCY_JOB = id();

const HIDER = id(); // consented, wants a skill; applied to POSTING; leaves search
const AGENT = id(); // applied to AGENCY_JOB, has a worker_profiles row
const NOPROF = id(); // applied to AGENCY_JOB, no worker_profiles row (not on the agency list)
const SKIPPER = id(); // skipped POSTING
const STUDENT = id(); // an active RVM student granted to GRANT_CO
const ERASED = id(); // erased while out of search
const WORKERS = [HIDER, AGENT, NOPROF, SKIPPER, STUDENT, ERASED];
const CITY = `Exitpur ${TAG}`;
const TURNER = "mskill_cnc_turner";
const MFG = "ind_industrial_manufacturing";

function query(over: Partial<CandidatePoolQuery> = {}): CandidatePoolQuery {
  return {
    skillIds: [],
    relatedSkillIds: [],
    experience: null,
    industryId: null,
    industryExperience: null,
    city: null,
    tierFloorMonths: 36,
    strict: false,
    after: null,
    limit: 1,
    ...over,
  };
}

describe.skipIf(!RUN)("worker_search_exits against Postgres (#2753 item 6, migration 0168)", () => {
  let client!: DbClient;
  let config!: ServerConfig;
  let on!: CandidateSearchRepository;
  let off!: CandidateSearchRepository;
  let exits!: SearchExitService;
  let unlocks!: UnlockService;

  beforeAll(async () => {
    client = createDbClient(DATABASE_URL, { max: 4 });
    config = loadServerConfig({
      NODE_ENV: "test",
      UNLOCK_LATENCY_TARGET_MS: "0",
      SEARCH_EXIT_ENABLED: "true",
    });
    const pii = new PiiCryptoService(config);
    const events = new EventsService(new EventsRepository(client.db), config);
    on = new CandidateSearchRepository(client.db, config);
    off = new CandidateSearchRepository(client.db);
    exits = new SearchExitService(new SearchExitRepository(client.db), events, config);
    const unlocksRepo = new UnlocksRepository(client.db);
    const gateway = new PaymentGateway(
      unlocksRepo,
      config,
      {
        getActiveCatalog: async () => ({
          catalog: DEFAULT_CATALOG,
          revision: 1,
          source: "db" as const,
        }),
      } as never,
      { isLive: false, keyId: null, createOrder: async () => undefined } as never,
    );
    unlocks = new UnlockService(
      unlocksRepo,
      new ConsentRepository(client.db),
      new WorkersRepository(client.db),
      pii,
      gateway,
      events,
      config,
      { add: async () => undefined } as never, // the referral-bonus queue (post-commit)
      { get: async () => DEFAULT_MATCH_CONFIG } as never,
      new PayersRepository(client.db, pii),
      new PayerTenantScopeService(config, new PayerOrgsRepository(client.db)),
      // The real institute gate on this database (only STUDENT is linked, and nobody unlocks him).
      new InstituteOpenGate(new InstituteLinkRepository(client.db), {} as never),
    );
    await seed(client);
  }, 60_000);

  afterAll(async () => {
    if (!client) return;
    const { sql } = client;
    try {
      await sql`DELETE FROM events WHERE correlation_id = ${CTX.correlationId}::uuid`;
      await sql`DELETE FROM credit_ledger WHERE payer_id = ANY(${PAYERS}::uuid[])`;
      await sql`DELETE FROM unlocks WHERE payer_id = ANY(${PAYERS}::uuid[])`;
      await sql`DELETE FROM payer_credits WHERE payer_id = ANY(${PAYERS}::uuid[])`;
      await sql`DELETE FROM institute_search_grants WHERE worker_id = ANY(${WORKERS}::uuid[])`;
      await sql`DELETE FROM worker_institute_links WHERE worker_id = ANY(${WORKERS}::uuid[])`;
      // Exits, consents, skills, profiles and applications all cascade from workers.
      await sql`DELETE FROM workers WHERE id = ANY(${WORKERS}::uuid[])`;
      await sql`DELETE FROM job_postings WHERE id = ${POSTING}::uuid`;
      await sql`DELETE FROM jobs WHERE id = ${AGENCY_JOB}::uuid`;
      await sql`DELETE FROM payers WHERE id = ANY(${PAYERS}::uuid[])`;
    } finally {
      await sql.end({ timeout: 5 });
    }
  });

  const exitRows = (workerId: string) =>
    client.sql<{ via: string; hidden_at: Date | string }[]>`
      SELECT via, hidden_at FROM worker_search_exits WHERE worker_id = ${workerId}::uuid`;
  const consentRows = (workerId: string) =>
    client.sql`
      SELECT id, consent_version, purposes, accepted_at, revoked_at FROM worker_consents
      WHERE worker_id = ${workerId}::uuid ORDER BY accepted_at, id`;
  const total = async (repo: CandidateSearchRepository) =>
    (await repo.searchPool(query())).counts.total;
  const balance = async (payerId: string) => {
    const [row] = await client.sql<{ balance: number }[]>`
      SELECT balance FROM payer_credits WHERE payer_id = ${payerId}::uuid`;
    return Number(row?.balance ?? 0);
  };

  it("the fixture is real: the table exists, he is in the pool, and nobody has an exit yet", async () => {
    const [reg] = await client.sql<{ t: string | null }[]>`
      SELECT to_regclass('public.worker_search_exits')::text AS t`;
    expect(reg!.t).toBe("worker_search_exits");
    for (const w of WORKERS) expect(await exitRows(w)).toEqual([]);
    expect(await on.findCardRow(HIDER)).toMatchObject({ workerId: HIDER, currentCity: CITY });
    expect(await on.listPoolCities()).toContain(CITY);
    const granted = await on.searchPool(
      query({ tenant: GRANT_CO as TenantKey, onlyWorkerId: STUDENT }),
    );
    expect(granted.rows.map((r) => r.workerId)).toEqual([STUDENT]);
  });

  it("leaving: ONE row, via worker, consent untouched; the real search leaves him out everywhere", async () => {
    const consentsBefore = await consentRows(HIDER);
    expect(consentsBefore).toHaveLength(1);
    const totalBefore = await total(on);

    const out = await exits.setVisibility(HIDER, false, "worker", CTX);
    expect(out.visible).toBe(false);
    const [row, ...rest] = await exitRows(HIDER);
    expect(rest).toEqual([]);
    expect(row!.via).toBe("worker");
    expect(out.hidden_since).toBe(new Date(row!.hidden_at).toISOString());

    // The whole pool: the search's total, the admin card read and the city facet.
    expect(await total(on)).toBe(totalBefore - 1);
    expect(await on.findCardRow(HIDER)).toBeNull();
    expect(await on.listPoolCities()).not.toContain(CITY);
    // With the switch off the same row hides nobody: off is today.
    expect(await off.findCardRow(HIDER)).toMatchObject({ workerId: HIDER });
    expect(await total(off)).toBe(totalBefore);

    // Not a consent change: every consent row exactly as it was.
    expect(await consentRows(HIDER)).toEqual(consentsBefore);
  });

  it("a repeat leave keeps the FIRST hidden_at and emits nothing new", async () => {
    const [first] = await exitRows(HIDER);
    const again = await exits.setVisibility(HIDER, false, "monthly_check", CTX);
    expect(again.hidden_since).toBe(new Date(first!.hidden_at).toISOString());
    expect(await exitRows(HIDER)).toEqual([first]);
    expect(await exits.visibilityFor(HIDER)).toEqual(again);
  });

  it("a granted RVM student who left search is out of his granted company's pool too", async () => {
    await exits.setVisibility(STUDENT, false, "worker", CTX);
    const granted = await on.searchPool(
      query({ tenant: GRANT_CO as TenantKey, onlyWorkerId: STUDENT }),
    );
    expect(granted.rows).toEqual([]);
    const today = await off.searchPool(
      query({ tenant: GRANT_CO as TenantKey, onlyWorkerId: STUDENT }),
    );
    expect(today.rows.map((r) => r.workerId)).toEqual([STUDENT]);
    await exits.setVisibility(STUDENT, true, "worker", CTX);
    const back = await on.searchPool(
      query({ tenant: GRANT_CO as TenantKey, onlyWorkerId: STUDENT }),
    );
    expect(back.rows.map((r) => r.workerId)).toEqual([STUDENT]);
  });

  it("the tenant-wide applicant read is the TWIN of the applicant feeds' own membership", async () => {
    const memberOfFeed = async (workerId: string) => {
      const viaPosting = await client.db.execute(
        feedMembershipStatement({ postingKind: "company_posting", postingId: POSTING, workerId }),
      );
      const viaJob = await client.db.execute(
        feedMembershipStatement({ postingKind: "agency_job", postingId: AGENCY_JOB, workerId }),
      );
      return [...viaPosting, ...viaJob].length > 0;
    };
    const tenantWide = async (workerId: string, tenant: string) =>
      [...(await client.db.execute(appliedToTenantStatement(workerId, tenant as TenantKey)))]
        .length > 0;
    const expected: Record<string, boolean> = {
      [HIDER]: true, // applied to the company posting
      [AGENT]: true, // applied to the agency job, has a profile
      [NOPROF]: false, // applied to the agency job, but not on its list (no profile)
      [SKIPPER]: false, // a skip is not an application
      [STUDENT]: false, // never applied
    };
    for (const [workerId, member] of Object.entries(expected)) {
      expect(await memberOfFeed(workerId), workerId).toBe(member);
      expect(await tenantWide(workerId, APPLIED_CO), workerId).toBe(member);
      expect(await tenantWide(workerId, OTHER_CO), workerId).toBe(false);
    }
  });

  it("the unlock rule on a real transaction: hidden opens only for a company he applied to", async () => {
    for (const w of [AGENT, NOPROF, SKIPPER]) await exits.setVisibility(w, false, "worker", CTX);
    const refuses = (workerId: string, tenant: string, cfg: ServerConfig = config) =>
      client.db.transaction((tx) =>
        searchExitRefuses(tx as unknown as Database, cfg, workerId, tenant as TenantKey),
      );
    expect(await refuses(HIDER, APPLIED_CO)).toBe(false);
    expect(await refuses(HIDER, OTHER_CO)).toBe(true);
    expect(await refuses(AGENT, APPLIED_CO)).toBe(false);
    expect(await refuses(NOPROF, APPLIED_CO)).toBe(true);
    expect(await refuses(SKIPPER, APPLIED_CO)).toBe(true);
    // In search: nobody is refused by this rule.
    expect(await refuses(STUDENT, OTHER_CO)).toBe(false);
    // Off: nobody is refused, and nothing is read (a missing table would not matter).
    const offCfg = { ...config, SEARCH_EXIT_ENABLED: false } as ServerConfig;
    expect(await refuses(HIDER, OTHER_CO, offCfg)).toBe(false);
    for (const w of [AGENT, NOPROF, SKIPPER]) await exits.setVisibility(w, true, "worker", CTX);
  });

  it("requestUnlock (the real service): a company he applied to is granted; an unrelated one gets the neutral body, no debit, no row", async () => {
    expect((await exitRows(HIDER)).length).toBe(1);
    const otherBefore = await balance(OTHER_CO);
    const refused = await unlocks.requestUnlock(
      { payerId: OTHER_CO, workerId: HIDER, jobId: null },
      CTX,
    );
    expect(refused).toEqual({ status: "unavailable" });
    expect(await balance(OTHER_CO)).toBe(otherBefore);
    const [none] = await client.sql<{ n: number }[]>`
      SELECT count(*)::int AS n FROM unlocks
      WHERE payer_id = ${OTHER_CO}::uuid AND worker_id = ${HIDER}::uuid`;
    expect(none!.n).toBe(0);
    const [denied] = await client.sql<{ payload: Record<string, unknown> }[]>`
      SELECT payload FROM events
      WHERE correlation_id = ${CTX.correlationId}::uuid AND event_name = 'unlock.denied'
        AND payload->>'payer_id' = ${OTHER_CO}`;
    expect(denied!.payload).toMatchObject({
      unlock_id: null,
      worker_id: HIDER,
      reason: "no_consent",
    });

    const appliedBefore = await balance(APPLIED_CO);
    const granted = await unlocks.requestUnlock(
      { payerId: APPLIED_CO, workerId: HIDER, jobId: null },
      CTX,
    );
    expect(granted).toMatchObject({ ok: true, status: "granted" });
    expect(await balance(APPLIED_CO)).toBe(appliedBefore - 1);
  });

  it("coming back: the row deleted, one event each way, and the unrelated company can open him again", async () => {
    expect(await exits.setVisibility(HIDER, true, "worker", CTX)).toEqual({
      visible: true,
      hidden_since: null,
    });
    expect(await exitRows(HIDER)).toEqual([]);
    expect(await on.findCardRow(HIDER)).toMatchObject({ workerId: HIDER });
    expect(await on.listPoolCities()).toContain(CITY);

    const changes = await client.sql<{ payload: Record<string, unknown> }[]>`
      SELECT payload FROM events
      WHERE correlation_id = ${CTX.correlationId}::uuid
        AND event_name = 'worker.search_visibility_changed'
        AND payload->>'worker_id' = ${HIDER}
      ORDER BY created_at, id`;
    expect(changes.map((c) => c.payload)).toEqual([
      { worker_id: HIDER, visible: false, via: "worker" },
      { worker_id: HIDER, visible: true, via: "worker" },
    ]);

    const reopened = await unlocks.requestUnlock(
      { payerId: OTHER_CO, workerId: HIDER, jobId: null },
      CTX,
    );
    expect(reopened).toMatchObject({ ok: true, status: "granted" });
  });

  it("erasure: hardDelete removes his exit (ON DELETE CASCADE)", async () => {
    await exits.setVisibility(ERASED, false, "worker", CTX);
    expect(await exitRows(ERASED)).toHaveLength(1);
    expect(await new WorkersRepository(client.db).hardDelete(ERASED)).toBe(true);
    expect(await exitRows(ERASED)).toEqual([]);
  });

  it("the CHECK refuses a via outside the closed set; the primary key refuses a second row", async () => {
    const insert = (workerId: string, via: string) =>
      client.sql`INSERT INTO worker_search_exits (worker_id, via) VALUES (${workerId}::uuid, ${via})`.catch(
        (e: unknown) => e,
      );
    expect(((await insert(SKIPPER, "admin")) as { code?: string }).code).toBe("23514");
    expect(((await insert(SKIPPER, "Worker")) as { code?: string }).code).toBe("23514");
    await insert(SKIPPER, "monthly_check");
    expect(((await insert(SKIPPER, "worker")) as { code?: string }).code).toBe("23505");
    await client.sql`DELETE FROM worker_search_exits WHERE worker_id = ${SKIPPER}::uuid`;
  });

  it("RLS is ENABLED and FORCED, with no policy, and no client role holds any privilege", async () => {
    const [rls] = await client.sql<{ enabled: boolean; forced: boolean }[]>`
      SELECT relrowsecurity AS enabled, relforcerowsecurity AS forced
        FROM pg_class WHERE oid = 'public.worker_search_exits'::regclass`;
    expect(rls).toEqual({ enabled: true, forced: true });
    const [policies] = await client.sql<{ n: number }[]>`
      SELECT count(*)::int AS n FROM pg_policies WHERE tablename = 'worker_search_exits'`;
    expect(policies!.n).toBe(0);
    const [publicGrants] = await client.sql<{ n: number }[]>`
      SELECT count(*)::int AS n FROM information_schema.role_table_grants
      WHERE table_name = 'worker_search_exits' AND grantee = 'PUBLIC'`;
    expect(publicGrants!.n).toBe(0);
    const roles = await client.sql<{ rolname: string }[]>`
      SELECT rolname FROM pg_roles WHERE rolname IN ('anon', 'authenticated', 'service_role')`;
    expect(roles.map((r) => r.rolname).sort()).toEqual(["anon", "authenticated", "service_role"]);
    for (const { rolname } of roles) {
      for (const priv of ["SELECT", "INSERT", "UPDATE", "DELETE"]) {
        const [row] = await client.db.execute<{ has: boolean }>(
          dsql`SELECT has_table_privilege(${rolname}, 'public.worker_search_exits', ${priv}) AS has`,
        );
        expect(row!.has, `${rolname} ${priv}`).toBe(false);
      }
    }
  });

  async function seed(c: DbClient): Promise<void> {
    const { sql } = c;
    await sql`
      INSERT INTO skill (skill_id, label_en, domain_id, source, status, kind, industry_id)
      VALUES (${TURNER}, 'CNC Turner', 'cnc-machining', 'rvm', 'active', 'match_skill', ${MFG})
      ON CONFLICT (skill_id) DO NOTHING`;
    for (const [i, p] of PAYERS.entries()) {
      await sql`
        INSERT INTO payers (id, role, email_enc, email_hash, org_name_enc, status)
        VALUES (${p}::uuid, 'employer', ${`enc:exit-${TAG}-${i}`}, ${`hash:exit-${TAG}-${i}`},
                ${`enc:exit-co-${TAG}-${i}`}, 'active')`;
      await sql`INSERT INTO payer_credits (payer_id, balance) VALUES (${p}::uuid, 5)`;
      await sql`INSERT INTO credit_ledger (payer_id, delta, reason) VALUES (${p}::uuid, 5, 'grant')`;
    }
    await sql`
      INSERT INTO job_postings (id, created_by, payer_id, org_label, role_title, vacancy_band, status,
                                match_skill_ids, reach_skill_ids, published_at)
      VALUES (${POSTING}::uuid, ${OPS}::uuid, ${APPLIED_CO}::uuid, 'Exit Fixture', ${`Exit posting ${TAG}`},
              '1', 'open', ${JSON.stringify([TURNER])}::jsonb, ${JSON.stringify([TURNER])}::jsonb, now())`;
    await sql`
      INSERT INTO jobs (id, trade_key, title, city, status, payer_id, min_experience_years, pay_min, pay_max)
      VALUES (${AGENCY_JOB}::uuid, 'cnc_vmc', ${`Exit agency job ${TAG}`}, 'pune', 'open',
              ${APPLIED_CO}::uuid, 1, 18000, 30000)`;
    for (const [i, w] of WORKERS.entries()) {
      await sql`
        INSERT INTO workers (id, phone_e164, phone_hash, status, current_city)
        VALUES (${w}::uuid, ${`enc:exit-${TAG}-w${i}`}, ${`hash:exit-${TAG}-w${i}`}, 'active',
                ${w === HIDER ? CITY : null})`;
      await sql`
        INSERT INTO worker_consents (worker_id, consent_version, purposes, accepted_at)
        VALUES (${w}::uuid, 'test', ${JSON.stringify(["profiling", "employer_sharing"])}::jsonb,
                now() - interval '1 day')`;
      await sql`
        INSERT INTO worker_skill (worker_id, skill_id, industry_id, months_bucketed, wants, source)
        VALUES (${w}::uuid, ${TURNER}, ${MFG}, 24, true, 'ops')`;
    }
    for (const w of [HIDER, AGENT, SKIPPER]) {
      await sql`
        INSERT INTO worker_profiles (worker_id, profile_status, canonical_role_id, canonical_trade_id,
                                     experience, location_preference, availability)
        VALUES (${w}::uuid, 'extracted', 'vmc_operator', 'cnc_vmc',
                ${JSON.stringify({ total_years: 3 })}::jsonb,
                ${JSON.stringify({ preferred_cities: ["pune"] })}::jsonb,
                ${JSON.stringify({ status: "immediate" })}::jsonb)`;
    }
    const decisions: [string, string | null, string | null, "applied" | "skipped"][] = [
      [HIDER, null, POSTING, "applied"],
      [AGENT, AGENCY_JOB, null, "applied"],
      [NOPROF, AGENCY_JOB, null, "applied"],
      [SKIPPER, null, POSTING, "skipped"],
    ];
    for (const [w, jobId, postingId, action] of decisions) {
      await sql`
        INSERT INTO applications (id, worker_id, job_id, job_posting_id, action, source_surface,
                                  match_tier, engine_version)
        VALUES (${id()}::uuid, ${w}::uuid, ${jobId}::uuid, ${postingId}::uuid, ${action}, 'feed',
                ${postingId ? 1 : null}, ${postingId ? "v1.0" : null})`;
    }
    // STUDENT: an active RVM student (out of the BadaBhai pool) whom GRANT_CO holds a live grant for.
    await sql`
      INSERT INTO worker_institute_links
        (worker_id, institute_code, student_ref, status, course, branch, linked_at, synced_at)
      VALUES (${STUDENT}::uuid, 'rvm', ${id()}, 'active', 'Diploma in CNC', 'Nashik', now(), now())`;
    await sql`
      INSERT INTO institute_search_grants
        (institute_code, grant_ref, payer_id, worker_id, consent_ref, skill_id, industry_id)
      VALUES ('rvm', ${`grant-${TAG}-exit`}, ${GRANT_CO}::uuid, ${STUDENT}::uuid,
              ${`consent-${TAG}-exit`}, ${TURNER}, ${MFG})`;
  }
});
