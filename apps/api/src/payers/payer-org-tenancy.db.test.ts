import "reflect-metadata";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { NotFoundException } from "@nestjs/common";
import { loadServerConfig, type ServerConfig } from "@badabhai/config";
import { CREDIT_PACKS, createDbClient, type DbClient } from "@badabhai/db";
import { DEFAULT_MATCH_CONFIG } from "@badabhai/match-engine";
import type { RequestContext } from "../common/request-context";
import { PiiCryptoService } from "../common/pii-crypto.service";
import { EventsRepository } from "../events/events.repository";
import { EventsService } from "../events/events.service";
import { ConsentRepository } from "../consent/consent.repository";
import { WorkersRepository } from "../workers/workers.repository";
import { JobPostingsRepository } from "../job-postings/job-postings.repository";
import { JobPostingsService } from "../job-postings/job-postings.service";
import {
  PayerCreateJobPostingSchema,
  UpdateJobPostingSchema,
} from "../job-postings/job-postings.dto";
import { AgencyService } from "../agency/agency.service";
import { AgencyJobsRepository } from "../agency/agency-jobs.repository";
import { AgencyInvitesRepository } from "../agency/agency-invites.repository";
import { CreateAgencyJobSchema, UpdateAgencyJobSchema } from "../agency/agency.dto";
import { ReachRepository } from "../reach/reach.repository";
import { ReachService } from "../reach/reach.service";
import { MatchFeedRepository } from "../match/match-feed.repository";
import { MatchCandidatesService } from "../match/match-candidates.service";
import { PayerApplicantsService } from "../payer-portal/payer-applicants.service";
import { PayerApplicantInboxRepository } from "../payer-portal/payer-applicant-inbox.repository";
import { PayerApplicantInboxService } from "../payer-portal/payer-applicant-inbox.service";
import { PayerApplicantStagesRepository } from "../payer-portal/payer-applicant-stages.repository";
import { PayerApplicantStagesService } from "../payer-portal/payer-applicant-stages.service";
import { APPLICANT_NOT_FOUND } from "../payer-portal/payer-applicant-stage.dto";
import { UnlocksRepository } from "../unlocks/unlocks.repository";
import { UnlockService } from "../unlocks/unlocks.service";
import { PaymentGateway } from "../unlocks/payment-gateway";
import { PayerOrgMembersService } from "../payer-portal/payer-org-members.service";
import { PayersRepository } from "./payers.repository";
import { PayerOrgsRepository, type ResolvedOrg } from "./payer-orgs.repository";
import { PayerTenantScopeService } from "./payer-tenant-scope.service";

/**
 * ADR-0053 (PAY-DB-01) T0 — "A invites B; B sees A's postings + credits", AGAINST A REAL POSTGRES.
 *
 * Real services and repositories end to end: signup's data path (`createOrGet` + `ensureSoloOrg`),
 * the real invite (a capturing mailer hands the raw token back in-process, exactly what the mock
 * mailer withholds), the real accept with its §3.5 invariants, a real posting create, the mock
 * credit pack, and the real unlock chokepoint (consent gate, caps, atomic debit + grant) with the
 * real EventsService validating every event. Mode `on`.
 *
 * THE TEAM STORY IS `it.fails` — RED BY DESIGN IN PHASE 1. P1 ships the resolver, not the
 * predicates: every posting / credit / unlock read still filters on the caller's own payer id,
 * so B sees none of A's rows and the story fails at its FIRST tenancy assertion. The PR in which
 * P2a and P2b are both on `main` flips it to `it` (ORG_TENANCY_PLAN §1, §7).
 *
 * WHY THE `it.fails` CANNOT PASS FOR THE WRONG REASON. `it.fails` passes on ANY error, so
 * nothing the story depends on is left to it:
 *  - the ANCHOR's story runs first as an ordinary `it` through the SAME calls (list, credits,
 *    unlock, ledger), proving the harness, the fixtures and every service it builds work;
 *  - B's membership, and the resolver keying B to A in mode `on`, are asserted in an ordinary
 *    `it` before the story;
 *  - the story's first assertion is the tenancy one.
 * Flip the story to `it` locally and the failure names B's posting list (`expected [] to
 * include …`) — that is the evidence the red is the right red.
 *
 * Fixtures carry no PII: synthetic `@e2e.badabhai.invalid` emails encrypted by the real crypto,
 * `enc:`/`hash:` markers in the worker's NOT NULL phone columns, ids fresh per run, everything
 * deleted in afterAll.
 *
 * ── HOW TO RUN ────────────────────────────────────────────────────────────────
 *   RUN_DB_TESTS=1 pnpm --filter @badabhai/api exec vitest run payer-org-tenancy.db
 */

const RUN = process.env.RUN_DB_TESTS === "1";
const DATABASE_URL =
  process.env.E2E_DATABASE_URL ??
  process.env.DATABASE_URL ??
  "postgresql://badabhai:badabhai@localhost:5432/badabhai";

const TAG = randomUUID().slice(0, 8);
const CTX: RequestContext = { correlationId: randomUUID(), requestId: `tenancy-db-${TAG}` };
const EMAIL_A = `tenancy-a-${TAG}@e2e.badabhai.invalid`;
const EMAIL_B = `tenancy-b-${TAG}@e2e.badabhai.invalid`;
/** One worker for the anchor's control unlock, a different one for B's (no idempotent replay). */
const WORKER_FOR_A = randomUUID();
const WORKER_FOR_B = randomUUID();
const PACK = CREDIT_PACKS["pack_10"]!;

describe.skipIf(!RUN)(
  "ADR-0053 T0 — A invites B; B sees A's postings + credits (Postgres, mode on)",
  () => {
    let client!: DbClient;
    let config!: ServerConfig;
    let payers!: PayersRepository;
    let tenancy!: PayerTenantScopeService;
    let members!: PayerOrgMembersService;
    let postings!: JobPostingsService;
    let unlocks!: UnlockService;
    let gateway!: PaymentGateway;

    let payerA = "";
    let payerB = "";
    let orgOfA!: ResolvedOrg;
    let memberIdOfB = "";
    let postingOfA = "";
    const acceptUrls: string[] = [];

    /** The signup data path: create the account, found its solo org, verify it (active). */
    async function signUp(email: string): Promise<string> {
      const { id } = await payers.createOrGet({
        role: "employer",
        email,
        orgName: `Tenancy ${TAG}`,
        phone: undefined,
      });
      await new PayerOrgsRepository(client.db).ensureSoloOrg(id);
      await payers.activate(id);
      return id;
    }

    beforeAll(async () => {
      client = createDbClient(DATABASE_URL, { max: 3 });
      config = loadServerConfig({
        NODE_ENV: "test",
        PAYER_ORG_TENANCY_MODE: "on",
        // No latency padding: the deny path's timing is not what this suite measures.
        UNLOCK_LATENCY_TARGET_MS: "0",
      });
      const pii = new PiiCryptoService(config);
      const events = new EventsService(new EventsRepository(client.db), config);
      const orgs = new PayerOrgsRepository(client.db);
      payers = new PayersRepository(client.db, pii);
      tenancy = new PayerTenantScopeService(config, orgs);
      members = new PayerOrgMembersService(orgs, pii, events, payers, config, {
        send: async ({ acceptUrl }: { email: string; acceptUrl: string }) => {
          acceptUrls.push(acceptUrl);
        },
      });
      postings = new JobPostingsService(
        new JobPostingsRepository(client.db),
        events,
        {} as never, // AiService — no skill phrases, so canonicalization returns before any call
        {} as never, // AiCostRecorder — likewise
        {} as never, // AiTraceRecorder — likewise
        {} as never, // PublishReachService — a draft never materializes reach
        {} as never, // MatchSkillsService — no match_skill_ids on this create
        tenancy,
      );
      const unlocksRepo = new UnlocksRepository(client.db);
      gateway = new PaymentGateway(unlocksRepo, config, {} as never, {} as never);
      unlocks = new UnlockService(
        unlocksRepo,
        new ConsentRepository(client.db),
        new WorkersRepository(client.db),
        pii,
        gateway,
        events,
        config,
        { add: async () => undefined } as never, // the referral-bonus queue (post-commit, not measured)
        {} as never, // MatchConfigService — read only on the signup free-tier grant
        payers,
      );

      // A and B sign up; each founds a solo org.
      payerA = await signUp(EMAIL_A);
      payerB = await signUp(EMAIL_B);
      const resolvedA = await tenancy.resolveActingOrg(payerA);
      if (!resolvedA) throw new Error("fixture: A has no org after signup");
      orgOfA = resolvedA;

      // A invites B (owner of their own solo org); B accepts with the token the mailer captured.
      await members.invite(orgOfA, payerA, { email: EMAIL_B, org_role: "recruiter" }, CTX);
      const token = new URL(acceptUrls.at(-1)!).searchParams.get("token");
      if (!token) throw new Error("fixture: the invite carried no accept token");
      memberIdOfB = (await members.accept(payerB, { token }, CTX)).member_id;

      // A creates a posting and buys a (mock) credit pack.
      // Fixed text, never the random TAG: a run of hex digits can read as a phone number and
      // trip the posting's contact screen, which would make this fixture flaky.
      const dto = PayerCreateJobPostingSchema.parse({
        org_label: "Tenancy Org",
        role_title: "CNC Turner",
        vacancy_band: "1",
      });
      postingOfA = (await postings.createForPayer(payerA, dto, CTX)).id;
      await gateway.purchasePackMock(payerA, PACK);

      // Two consented workers (employer_sharing), no PII.
      for (const worker of [WORKER_FOR_A, WORKER_FOR_B]) {
        await client.sql`
        INSERT INTO workers (id, phone_e164, phone_hash, status)
        VALUES (${worker}::uuid, ${`enc:tenancy-${TAG}-${worker}`}, ${`hash:tenancy-${TAG}-${worker}`}, 'active')`;
        await client.sql`
        INSERT INTO worker_consents (worker_id, consent_version, purposes, accepted_at)
        VALUES (${worker}::uuid, '2026-06-01', ${JSON.stringify(["profiling", "employer_sharing"])}::jsonb, now())`;
      }
    }, 60_000);

    afterAll(async () => {
      if (!client) return;
      const ids = [payerA, payerB].filter(Boolean);
      const { sql } = client;
      await sql`DELETE FROM unlocks WHERE payer_id = ANY(${ids}::uuid[])`;
      await sql`DELETE FROM credit_ledger WHERE payer_id = ANY(${ids}::uuid[])`;
      await sql`DELETE FROM payer_credits WHERE payer_id = ANY(${ids}::uuid[])`;
      await sql`DELETE FROM job_postings WHERE payer_id = ANY(${ids}::uuid[]) OR created_by = ANY(${ids}::uuid[])`;
      await sql`DELETE FROM events WHERE correlation_id = ${CTX.correlationId}::uuid`;
      await sql`DELETE FROM workers WHERE id = ANY(${[WORKER_FOR_A, WORKER_FOR_B]}::uuid[])`;
      await sql`DELETE FROM payer_orgs WHERE root_payer_id = ANY(${ids}::uuid[])`;
      await sql`DELETE FROM payers WHERE id = ANY(${ids}::uuid[])`;
      await sql.end({ timeout: 5 });
    });

    it("control: the ANCHOR, through the same calls, sees its posting and credits, and its unlock debits its wallet", async () => {
      // Every call the team story makes, made by A. If this fails the harness is broken, and the
      // `it.fails` below would be passing for the wrong reason.
      const list = await postings.listForPayer(payerA, {});
      expect(list.map((p) => p.id)).toContain(postingOfA);
      expect((await unlocks.getCredits(payerA)).balance).toBe(PACK.credits);

      const grant = await unlocks.requestUnlock(
        { payerId: payerA, workerId: WORKER_FOR_A, jobId: null },
        CTX,
      );
      expect(grant).toMatchObject({ ok: true, status: "granted" });
      expect((await unlocks.getCredits(payerA)).balance).toBe(PACK.credits - 1);
      const own = await unlocks.listByPayer(payerA);
      expect(own.unlocks.map((u) => u.worker_id)).toContain(WORKER_FOR_A);
    });

    it("setup: B is an ACTIVE member of A's org, and mode `on` keys B to A (the resolver, shipped in P1)", async () => {
      // Proven here, outside the `it.fails`, so the story below can only fail on a predicate.
      const scope = await tenancy.resolve(payerB);
      expect(scope).toMatchObject({
        actorPayerId: payerB,
        tenantKey: payerA,
        orgId: orgOfA.orgId,
        orgRole: "recruiter",
        mode: "on",
      });
      const [row] = await client.sql`
      SELECT status, member_payer_id FROM payer_members WHERE id = ${memberIdOfB}::uuid`;
      expect(row).toMatchObject({ status: "active", member_payer_id: payerB });
    });

    // RED IN PHASE 1 (ADR-0053 / ORG_TENANCY_PLAN §2.5). Flip to `it` in the PR that lands the
    // second of P2a (postings) and P2b (money).
    it.fails(
      "T0: B sees A's posting and A's credits, spends A's wallet, A sees B's unlock — and removal takes it all away",
      async () => {
        // 1. B lists postings and finds A's posting. ← THE FIRST TENANCY ASSERTION (fails in P1).
        const listB = await postings.listForPayer(payerB, {});
        expect(listB.map((p) => p.id)).toContain(postingOfA);

        // 2. B's credits are the org wallet: A's balance.
        const walletBefore = (await unlocks.getCredits(payerA)).balance;
        expect((await unlocks.getCredits(payerB)).balance).toBe(walletBefore);

        // 3. B unlocks a worker: A's wallet is debited, and A sees B's unlock.
        const grant = await unlocks.requestUnlock(
          { payerId: payerB, workerId: WORKER_FOR_B, jobId: null },
          CTX,
        );
        expect(grant).toMatchObject({ ok: true, status: "granted" });
        expect((await unlocks.getCredits(payerA)).balance).toBe(walletBefore - 1);
        const seenByA = await unlocks.listByPayer(payerA);
        expect(seenByA.unlocks.map((u) => u.worker_id)).toContain(WORKER_FOR_B);

        // 4. A removes B. On the next call B sees none of A's rows.
        await members.remove(orgOfA, payerA, memberIdOfB, CTX);
        expect((await postings.listForPayer(payerB, {})).map((p) => p.id)).not.toContain(
          postingOfA,
        );
        expect((await unlocks.getCredits(payerB)).balance).toBe(0);
        expect((await unlocks.listByPayer(payerB)).unlocks).toEqual([]);
      },
    );
  },
);

/**
 * The two invite-rule reads, EVALUATED (review L3). `anchorsTeamOrg` (rule A2) and
 * `findAnchorRole` (rule A3) are unit-tested against fakes; whether their WHERE clauses say what
 * the rules mean — an invited row has no member id yet, a removed row no longer counts, a payer
 * who joined someone else's team anchors nothing — is a property of Postgres evaluating them.
 */
describe.skipIf(!RUN)("ADR-0053 §3.5 — the accept-rule reads against Postgres", () => {
  let client!: DbClient;
  let orgs!: PayerOrgsRepository;
  let payers!: PayersRepository;
  const created: string[] = [];
  const RULE_TAG = randomUUID().slice(0, 8);

  /** A payer with their solo org (the signup data path). */
  async function payer(label: string, role: "employer" | "agent" = "employer"): Promise<string> {
    const { id } = await payers.createOrGet({
      role,
      email: `rules-${label}-${RULE_TAG}@e2e.badabhai.invalid`,
      orgName: "Rules Org",
      phone: undefined,
    });
    await orgs.ensureSoloOrg(id);
    created.push(id);
    return id;
  }

  async function orgOf(anchor: string): Promise<string> {
    const [row] = await client.sql`SELECT id FROM payer_orgs WHERE root_payer_id = ${anchor}::uuid`;
    return String(row!.id);
  }

  /** A member row in `anchor`'s org, written exactly as invite / accept / remove leave it. */
  async function memberRow(
    anchor: string,
    status: "invited" | "active" | "removed",
    memberPayerId: string | null,
  ): Promise<void> {
    await client.sql`
      INSERT INTO payer_members (org_id, member_payer_id, email_enc, email_hash, org_role, status,
                                 invited_at, accepted_at, removed_at)
      VALUES (${await orgOf(anchor)}::uuid, ${memberPayerId}, 'enc:rules', ${`hash:rules-${randomUUID()}`},
              'recruiter', ${status}::text, now(),
              CASE WHEN ${status}::text = 'invited' THEN NULL ELSE now() END,
              CASE WHEN ${status}::text = 'removed' THEN now() ELSE NULL END)`;
  }

  beforeAll(async () => {
    client = createDbClient(DATABASE_URL, { max: 2 });
    const config = loadServerConfig({ NODE_ENV: "test" });
    orgs = new PayerOrgsRepository(client.db);
    payers = new PayersRepository(client.db, new PiiCryptoService(config));
  });

  afterAll(async () => {
    if (!client) return;
    await client.sql`DELETE FROM payer_orgs WHERE root_payer_id = ANY(${created}::uuid[])`;
    await client.sql`DELETE FROM payers WHERE id = ANY(${created}::uuid[])`;
    await client.sql.end({ timeout: 5 });
  });

  it("A2: a founder whose org has only an INVITED member (no member id yet) anchors a team", async () => {
    const founder = await payer("invited-founder");
    expect(await orgs.anchorsTeamOrg(founder)).toBe(false); // the solo owner row alone is not a team
    await memberRow(founder, "invited", null);
    expect(await orgs.anchorsTeamOrg(founder)).toBe(true);
  });

  it("A2: a founder whose only other member was REMOVED does not anchor a team", async () => {
    const founder = await payer("removed-founder");
    const former = await payer("removed-member");
    await memberRow(founder, "removed", former);
    expect(await orgs.anchorsTeamOrg(founder)).toBe(false);
  });

  it("A2: a payer who JOINED someone else's team anchors nothing (their own org is solo)", async () => {
    const founder = await payer("host-founder");
    const joiner = await payer("joiner");
    await memberRow(founder, "active", joiner);
    expect(await orgs.anchorsTeamOrg(joiner)).toBe(false);
    expect(await orgs.anchorsTeamOrg(founder)).toBe(true);
  });

  it("A3: the founder's role is read from payers; an unknown org reads null (refused, fail closed)", async () => {
    const employer = await payer("role-employer", "employer");
    const agent = await payer("role-agent", "agent");
    expect(await orgs.findAnchorRole(await orgOf(employer))).toBe("employer");
    expect(await orgs.findAnchorRole(await orgOf(agent))).toBe("agent");
    expect(await orgs.findAnchorRole(randomUUID())).toBeNull();
  });
});

/**
 * ADR-0053 P2a (PAY-DB-01) — T2 for postings, agency jobs, the per-posting applicant lists, the
 * Candidates inbox and the saved board, AGAINST A REAL POSTGRES, in BOTH modes over the SAME rows.
 *
 * Two teams and two outsiders, every one a real payer with the solo org signup founds:
 *  - employers: A anchors a team, B is A's active recruiter, C is an outsider;
 *  - agencies:  G anchors a team, H is G's active recruiter, I is an outsider.
 * The memberships are the rows a successful accept writes (seeded directly, as T0-HTTP does).
 * Every service is the REAL one over the real repositories; only the resolver's mode differs
 * between the `on` and `off` sets.
 *
 *  - `on`: a teammate reads, writes and lists the org's rows exactly as the anchor does; a write
 *    stamps the TENANT on the row and the acting LOGIN as `created_by` / the event actor; an
 *    outsider gets the same neutral 404 an unknown id gets (no oracle).
 *  - `off`: today's behaviour, byte for byte — the teammate is their own tenant and sees none of
 *    the anchor's rows.
 *
 * Fixtures carry no PII: synthetic `@e2e.badabhai.invalid` emails encrypted by the real crypto,
 * `enc:`/`hash:` markers in the worker phone columns, ids fresh per run, all deleted afterwards.
 */
describe.skipIf(!RUN)(
  "ADR-0053 P2a — postings, agency jobs, applicant lists, inbox and board follow the TENANT (Postgres)",
  () => {
    const P2A_TAG = randomUUID().slice(0, 8);
    const P2A_CTX: RequestContext = {
      correlationId: randomUUID(),
      requestId: `tenancy-p2a-${P2A_TAG}`,
    };
    let client!: DbClient;
    const payerIds: string[] = [];
    const ids = { A: "", B: "", C: "", G: "", H: "", I: "" };
    /** Company postings: PA (A's, applied to), PL (A's, for the lifecycle cases). */
    let PA = "";
    let PL = "";
    /** Agency jobs: JG (G's, applied to), JL (G's, for the lifecycle cases). */
    let JG = "";
    let JL = "";
    const W1 = randomUUID(); // applied to PA (a company posting)
    const W2 = randomUUID(); // applied to JG (an agency job; needs a profile row)

    type Services = ReturnType<typeof servicesFor>;
    let on!: Services;
    let off!: Services;

    function servicesFor(config: ServerConfig) {
      const events = new EventsService(new EventsRepository(client.db), config);
      const tenancy = new PayerTenantScopeService(config, new PayerOrgsRepository(client.db));
      const postings = new JobPostingsService(
        new JobPostingsRepository(client.db),
        events,
        {} as never, // AiService — no skill phrases, so canonicalization returns before any call
        {} as never, // AiCostRecorder — likewise
        {} as never, // AiTraceRecorder — likewise
        { materialize: async () => undefined } as never, // a publish materializes nothing here
        {} as never, // MatchSkillsService — no match_skill_ids
        tenancy,
      );
      const agency = new AgencyService(
        new AgencyJobsRepository(client.db),
        new AgencyInvitesRepository(client.db),
        new ConsentRepository(client.db),
        events,
        {} as never, // MatchSkillsService — no match_skill_ids
        tenancy,
      );
      const reach = new ReachService(new ReachRepository(client.db), events, {} as never);
      const candidates = new MatchCandidatesService(new MatchFeedRepository(client.db), {
        get: async () => DEFAULT_MATCH_CONFIG,
      } as never);
      const stagesFlag = { PAYER_APPLICANT_STAGES_ENABLED: true };
      const stages = new PayerApplicantStagesService(
        new PayerApplicantStagesRepository(client.db),
        events,
        stagesFlag,
        tenancy,
      );
      const applicants = new PayerApplicantsService(reach, postings, candidates, stages, tenancy);
      const inbox = new PayerApplicantInboxService(
        new PayerApplicantInboxRepository(client.db),
        reach,
        candidates,
        stagesFlag,
        tenancy,
      );
      return { postings, agency, applicants, inbox, stages };
    }

    async function signUp(label: string, role: "employer" | "agent"): Promise<string> {
      const config = loadServerConfig({ NODE_ENV: "test" });
      const repo = new PayersRepository(client.db, new PiiCryptoService(config));
      const { id } = await repo.createOrGet({
        role,
        email: `tenancy-p2a-${label}-${P2A_TAG}@e2e.badabhai.invalid`,
        orgName: `Tenancy P2a ${P2A_TAG}`,
        phone: undefined,
      });
      await new PayerOrgsRepository(client.db).ensureSoloOrg(id);
      await repo.activate(id);
      payerIds.push(id);
      return id;
    }

    /** What a successful accept writes: `member`, an active recruiter in `anchor`'s org. */
    async function joinTeam(anchor: string, member: string): Promise<void> {
      await client.sql`
        INSERT INTO payer_members (org_id, member_payer_id, email_enc, email_hash, org_role, status,
                                   invited_by, invited_at, accepted_at)
        SELECT o.id, m.id, m.email_enc, m.email_hash, 'recruiter', 'active', ${anchor}::uuid, now(), now()
        FROM payer_orgs o, payers m
        WHERE o.root_payer_id = ${anchor}::uuid AND m.id = ${member}::uuid`;
    }

    const postingDto = () =>
      PayerCreateJobPostingSchema.parse({
        org_label: "Tenancy Org",
        role_title: "CNC Turner",
        vacancy_band: "1",
      });
    const agencyJobDto = () =>
      CreateAgencyJobSchema.parse({
        trade_key: "cnc_operator",
        title: "CNC Operator",
        city: "Pune",
      });

    /** The 404 a request gets, or a failure if it resolved. */
    async function notFound(work: Promise<unknown>): Promise<unknown> {
      const err = await work.then(
        () => new Error("expected a 404, the request resolved"),
        (e: unknown) => e,
      );
      expect(err).toBeInstanceOf(NotFoundException);
      return (err as NotFoundException).getResponse();
    }

    async function eventsOf(subjectId: string, eventName: string) {
      return client.sql<{ actor_id: string; payload: Record<string, unknown> }[]>`
        SELECT actor_id, payload FROM events
        WHERE correlation_id = ${P2A_CTX.correlationId}::uuid
          AND subject_id = ${subjectId} AND event_name = ${eventName}
        ORDER BY occurred_at`;
    }

    beforeAll(async () => {
      client = createDbClient(DATABASE_URL, { max: 3 });
      on = servicesFor(
        loadServerConfig({
          NODE_ENV: "test",
          PAYER_ORG_TENANCY_MODE: "on",
          UNLOCK_LATENCY_TARGET_MS: "0",
        }),
      );
      off = servicesFor(
        loadServerConfig({
          NODE_ENV: "test",
          PAYER_ORG_TENANCY_MODE: "off",
          UNLOCK_LATENCY_TARGET_MS: "0",
        }),
      );

      ids.A = await signUp("a", "employer");
      ids.B = await signUp("b", "employer");
      ids.C = await signUp("c", "employer");
      ids.G = await signUp("g", "agent");
      ids.H = await signUp("h", "agent");
      ids.I = await signUp("i", "agent");
      await joinTeam(ids.A, ids.B);
      await joinTeam(ids.G, ids.H);

      // The anchors' rows. An anchor is its own tenant in BOTH modes (solo identity).
      PA = (await off.postings.createForPayer(ids.A, postingDto(), P2A_CTX)).id;
      PL = (await off.postings.createForPayer(ids.A, postingDto(), P2A_CTX)).id;
      JG = (await off.agency.createJob(ids.G, agencyJobDto(), P2A_CTX)).id;
      JL = (await off.agency.createJob(ids.G, agencyJobDto(), P2A_CTX)).id;

      // One applicant per source; W2 needs the profile row the agency list ranks from.
      for (const [worker, label] of [
        [W1, "w1"],
        [W2, "w2"],
      ] as const) {
        await client.sql`
          INSERT INTO workers (id, phone_e164, phone_hash, status)
          VALUES (${worker}::uuid, ${`enc:p2a-${P2A_TAG}-${label}`}, ${`hash:p2a-${P2A_TAG}-${label}`}, 'active')`;
      }
      await client.sql`
        INSERT INTO worker_profiles (worker_id, profile_status, canonical_role_id, canonical_trade_id,
                                     experience, location_preference, availability)
        VALUES (${W2}::uuid, 'extracted', 'vmc_operator', 'cnc_vmc',
                ${JSON.stringify({ total_years: 3 })}::jsonb,
                ${JSON.stringify({ preferred_cities: ["pune"] })}::jsonb,
                ${JSON.stringify({ status: "immediate" })}::jsonb)`;
      await client.sql`
        INSERT INTO applications (id, worker_id, job_id, job_posting_id, action, source_surface,
                                  match_tier, engine_version)
        VALUES (${randomUUID()}::uuid, ${W1}::uuid, NULL, ${PA}::uuid, 'applied', 'feed', 1, 'v1.0'),
               (${randomUUID()}::uuid, ${W2}::uuid, ${JG}::uuid, NULL, 'applied', 'feed', NULL, NULL)`;
    }, 60_000);

    afterAll(async () => {
      if (!client) return;
      const { sql } = client;
      const workers = [W1, W2];
      await sql`DELETE FROM payer_applicant_stages WHERE worker_id = ANY(${workers}::uuid[])`;
      await sql`DELETE FROM applications WHERE worker_id = ANY(${workers}::uuid[])`;
      await sql`DELETE FROM worker_profiles WHERE worker_id = ANY(${workers}::uuid[])`;
      await sql`DELETE FROM workers WHERE id = ANY(${workers}::uuid[])`;
      await sql`DELETE FROM events WHERE correlation_id = ${P2A_CTX.correlationId}::uuid`;
      await sql`DELETE FROM job_postings WHERE payer_id = ANY(${payerIds}::uuid[]) OR created_by = ANY(${payerIds}::uuid[])`;
      await sql`DELETE FROM jobs WHERE payer_id = ANY(${payerIds}::uuid[])`;
      await sql`DELETE FROM payer_orgs WHERE root_payer_id = ANY(${payerIds}::uuid[])`;
      await sql`DELETE FROM payers WHERE id = ANY(${payerIds}::uuid[])`;
      await sql.end({ timeout: 5 });
    });

    it("setup: `on` keys each teammate to their anchor and each outsider to themself; `off` keys everyone to themself", async () => {
      const tenancyOn = new PayerTenantScopeService(
        loadServerConfig({ NODE_ENV: "test", PAYER_ORG_TENANCY_MODE: "on" }),
        new PayerOrgsRepository(client.db),
      );
      const tenancyOff = new PayerTenantScopeService(
        loadServerConfig({ NODE_ENV: "test", PAYER_ORG_TENANCY_MODE: "off" }),
        new PayerOrgsRepository(client.db),
      );
      for (const [actor, onKey] of [
        [ids.A, ids.A],
        [ids.B, ids.A],
        [ids.C, ids.C],
        [ids.G, ids.G],
        [ids.H, ids.G],
        [ids.I, ids.I],
      ] as const) {
        expect((await tenancyOn.resolve(actor)).tenantKey).toBe(onKey);
        expect((await tenancyOff.resolve(actor)).tenantKey).toBe(actor);
      }
    });

    describe("mode on", () => {
      it("company postings: a teammate's create is the ORG's row — payer_id = the anchor, created_by = the login, event actor = the login", async () => {
        const created = await on.postings.createForPayer(ids.B, postingDto(), P2A_CTX);
        expect(created).toMatchObject({ payer_id: ids.A, created_by: ids.B });
        const [row] = await client.sql<{ payer_id: string; created_by: string }[]>`
          SELECT payer_id, created_by FROM job_postings WHERE id = ${created.id}::uuid`;
        expect(row).toEqual({ payer_id: ids.A, created_by: ids.B });
        const [evt] = await eventsOf(created.id, "job_posting.created");
        expect(evt).toMatchObject({ actor_id: ids.B, payload: { created_by: ids.B } });
        // The anchor sees the teammate's posting; the outsider does not.
        expect((await on.postings.listForPayer(ids.A, {})).map((p) => p.id)).toContain(created.id);
        expect((await on.postings.listForPayer(ids.C, {})).map((p) => p.id)).not.toContain(
          created.id,
        );
      });

      it("company postings: the teammate lists and reads the anchor's postings; the outsider lists none", async () => {
        const listB = (await on.postings.listForPayer(ids.B, {})).map((p) => p.id);
        expect(listB).toEqual(expect.arrayContaining([PA, PL]));
        expect((await on.postings.getOneForPayer(PA, ids.B)).id).toBe(PA);
        const listC = (await on.postings.listForPayer(ids.C, {})).map((p) => p.id);
        expect(listC).not.toContain(PA);
        expect(listC).not.toContain(PL);
      });

      it("company postings: the teammate edits, publishes, pauses, resumes and closes the anchor's posting, as the login", async () => {
        await on.postings.updateForPayer(
          PL,
          ids.B,
          UpdateJobPostingSchema.parse({ role_title: "VMC Operator" }),
          P2A_CTX,
        );
        await on.postings.updateForPayer(
          PL,
          ids.B,
          UpdateJobPostingSchema.parse({ status: "open" }),
          P2A_CTX,
        );
        expect((await on.postings.pauseForPayer(PL, ids.B, P2A_CTX)).status).toBe("paused");
        expect((await on.postings.resumeForPayer(PL, ids.B, P2A_CTX)).status).toBe("open");
        expect((await on.postings.closeForPayer(PL, ids.B, P2A_CTX)).status).toBe("closed");
        for (const name of [
          "job_posting.updated",
          "job_posting.paused",
          "job_posting.resumed",
          "job_posting.closed",
        ]) {
          const evts = await eventsOf(PL, name);
          expect(evts.length, name).toBeGreaterThan(0);
          for (const e of evts) expect(e.actor_id, name).toBe(ids.B);
        }
        // The row is still the anchor's.
        const [row] = await client.sql<{ payer_id: string }[]>`
          SELECT payer_id FROM job_postings WHERE id = ${PL}::uuid`;
        expect(row!.payer_id).toBe(ids.A);
      });

      it("company postings: the outsider gets the SAME 404 for the anchor's posting as for an unknown id, on every route", async () => {
        const unknown = randomUUID();
        const update = UpdateJobPostingSchema.parse({ role_title: "Fitter" });
        for (const [label, call] of [
          ["get", (id: string) => on.postings.getOneForPayer(id, ids.C)],
          ["update", (id: string) => on.postings.updateForPayer(id, ids.C, update, P2A_CTX)],
          ["close", (id: string) => on.postings.closeForPayer(id, ids.C, P2A_CTX)],
          ["pause", (id: string) => on.postings.pauseForPayer(id, ids.C, P2A_CTX)],
          ["resume", (id: string) => on.postings.resumeForPayer(id, ids.C, P2A_CTX)],
        ] as const) {
          expect(await notFound(call(PA)), label).toEqual(await notFound(call(unknown)));
        }
        const [row] = await client.sql<{ role_title: string; status: string }[]>`
          SELECT role_title, status FROM job_postings WHERE id = ${PA}::uuid`;
        expect(row).toEqual({ role_title: "CNC Turner", status: "draft" });
      });

      it("agency jobs: a teammate's create is the ORG's job — jobs.payer_id and job.created's payer_id = the anchor, actor = the login", async () => {
        const created = await on.agency.createJob(ids.H, agencyJobDto(), P2A_CTX);
        const [row] = await client.sql<{ payer_id: string }[]>`
          SELECT payer_id FROM jobs WHERE id = ${created.id}::uuid`;
        expect(row!.payer_id).toBe(ids.G);
        const [evt] = await eventsOf(created.id, "job.created");
        expect(evt).toMatchObject({ actor_id: ids.H, payload: { payer_id: ids.G } });
        expect((await on.agency.listOwnJobs(ids.G)).map((j) => j.id)).toContain(created.id);
        expect((await on.agency.listOwnJobs(ids.H)).map((j) => j.id)).toEqual(
          expect.arrayContaining([JG, JL, created.id]),
        );
        expect((await on.agency.listOwnJobs(ids.I)).map((j) => j.id)).toEqual([]);
      });

      it("agency jobs: the teammate edits, pauses, resumes and closes the anchor's job; the payload names the anchor, the actor the login", async () => {
        expect((await on.agency.getOwnJob(ids.H, JL)).id).toBe(JL);
        await on.agency.updateJob(
          ids.H,
          JL,
          UpdateAgencyJobSchema.parse({ title: "VMC Operator" }),
          P2A_CTX,
        );
        expect((await on.agency.pauseJob(ids.H, JL, P2A_CTX)).status).toBe("paused");
        expect((await on.agency.resumeJob(ids.H, JL, P2A_CTX)).status).toBe("open");
        expect((await on.agency.closeJob(ids.H, JL, P2A_CTX)).status).toBe("closed");
        for (const name of ["job.updated", "job.closed"]) {
          const evts = await eventsOf(JL, name);
          expect(evts.length, name).toBeGreaterThan(0);
          for (const e of evts) {
            expect(e.actor_id, name).toBe(ids.H);
            expect(e.payload.payer_id, name).toBe(ids.G);
          }
        }
      });

      it("agency jobs: the outsider gets the SAME 404 for the anchor's job as for an unknown id, on every route", async () => {
        const unknown = randomUUID();
        const update = UpdateAgencyJobSchema.parse({ title: "Fitter" });
        for (const [label, call] of [
          ["get", (id: string) => on.agency.getOwnJob(ids.I, id)],
          ["update", (id: string) => on.agency.updateJob(ids.I, id, update, P2A_CTX)],
          ["close", (id: string) => on.agency.closeJob(ids.I, id, P2A_CTX)],
          ["pause", (id: string) => on.agency.pauseJob(ids.I, id, P2A_CTX)],
          ["resume", (id: string) => on.agency.resumeJob(ids.I, id, P2A_CTX)],
        ] as const) {
          expect(await notFound(call(JG)), label).toEqual(await notFound(call(unknown)));
        }
      });

      it("applicant lists: the teammate's list for an org posting / job IS the anchor's; the outsider's is the unknown-id 404", async () => {
        const unknown = randomUUID();
        for (const [anchor, member, outsider, ref] of [
          [ids.A, ids.B, ids.C, PA],
          [ids.G, ids.H, ids.I, JG],
        ] as const) {
          const asAnchor = await on.applicants.listForOwned(ref, anchor, P2A_CTX);
          expect(asAnchor.applicants.length, ref).toBe(1);
          expect(await on.applicants.listForOwned(ref, member, P2A_CTX)).toEqual(asAnchor);
          const foreign = await notFound(on.applicants.listForOwned(ref, outsider, P2A_CTX));
          expect(foreign).toEqual(
            await notFound(on.applicants.listForOwned(unknown, outsider, P2A_CTX)),
          );
          expect(foreign).toMatchObject({ message: APPLICANT_NOT_FOUND });
        }
        // The agency list's feed.shown names the LOGIN that looked, never the tenant.
        const shown = await client.sql<{ actor_id: string }[]>`
          SELECT actor_id FROM events
          WHERE correlation_id = ${P2A_CTX.correlationId}::uuid AND event_name = 'feed.shown'
            AND subject_id = ${W2}`;
        expect(new Set(shown.map((e) => e.actor_id))).toEqual(new Set([ids.G, ids.H]));
      });

      it("the Candidates inbox: the teammate's inbox IS the anchor's; the outsider's is empty", async () => {
        const query = { limit: 50 } as const;
        for (const [anchor, member, outsider] of [
          [ids.A, ids.B, ids.C],
          [ids.G, ids.H, ids.I],
        ] as const) {
          const asAnchor = await on.inbox.list(anchor, query, P2A_CTX);
          expect(asAnchor.applicants.length).toBe(1);
          expect(await on.inbox.list(member, query, P2A_CTX)).toEqual(asAnchor);
          expect((await on.inbox.list(outsider, query, P2A_CTX)).applicants).toEqual([]);
        }
      });

      it("the saved board: the teammate moves an applicant on the anchor's posting (actor = the login); the anchor sees it; the outsider gets the 404", async () => {
        await on.stages.setStage(ids.B, PA, W1, "shortlist", P2A_CTX);
        const [row] = await client.sql<{ stage: string; actor_payer_id: string }[]>`
          SELECT stage, actor_payer_id FROM payer_applicant_stages
          WHERE posting_id = ${PA}::uuid AND worker_id = ${W1}::uuid`;
        expect(row).toEqual({ stage: "shortlist", actor_payer_id: ids.B });
        const [evt] = await eventsOf(W1, "payer.applicant_stage_changed");
        expect(evt!.actor_id).toBe(ids.B);
        const seenByA = (await on.applicants.listForOwned(PA, ids.A, P2A_CTX)) as {
          applicants: { workerId: string; stage: string }[];
        };
        expect(seenByA.applicants).toEqual([
          expect.objectContaining({ workerId: W1, stage: "shortlist" }),
        ]);
        // One board per org: the teammate's own list reads it back, and so does the inbox.
        expect(await on.applicants.listForOwned(PA, ids.B, P2A_CTX)).toEqual(seenByA);
        const inboxB = await on.inbox.list(ids.B, { limit: 50 }, P2A_CTX);
        expect(inboxB.applicants).toEqual([
          expect.objectContaining({ workerId: W1, stage: "shortlist" }),
        ]);
        const foreign = await notFound(on.stages.setStage(ids.C, PA, W1, "passed", P2A_CTX));
        expect(foreign).toMatchObject({ message: APPLICANT_NOT_FOUND });
      });

      // Security review of PR #2167, L2: the outsider's FILTERED reads are no oracle either.
      it("the outsider's inbox filtered to the anchor's posting is the same empty page as for an unknown posting", async () => {
        const empty = { applicants: [], nextCursor: null };
        const foreign = await on.inbox.list(ids.C, { limit: 50, postingId: PA }, P2A_CTX);
        const unknown = await on.inbox.list(ids.C, { limit: 50, postingId: randomUUID() }, P2A_CTX);
        expect(foreign).toEqual(empty);
        expect(unknown).toEqual(empty);
        // Not vacuous: the same filter is a real row for the org (the teammate sees W1).
        const asB = await on.inbox.list(ids.B, { limit: 50, postingId: PA }, P2A_CTX);
        expect(asB.applicants.map((r) => r.workerId)).toEqual([W1]);
      });

      it("the outsider's inbox filtered by a stage the org's board holds is empty, as for any stage", async () => {
        const empty = { applicants: [], nextCursor: null };
        for (const stage of ["shortlist", "passed", "new"] as const) {
          expect(await on.inbox.list(ids.C, { limit: 50, stage }, P2A_CTX), stage).toEqual(empty);
        }
        // Not vacuous: the org's board holds W1 at `shortlist` (the previous case moved him).
        const asB = await on.inbox.list(ids.B, { limit: 50, stage: "shortlist" }, P2A_CTX);
        expect(asB.applicants.map((r) => r.workerId)).toEqual([W1]);
      });

      it("the outsider's stage PUT on the anchor's posting is BYTE-equal to the unknown-posting one", async () => {
        const foreign = await on.stages
          .setStage(ids.C, PA, W1, "passed", P2A_CTX)
          .catch((e: unknown) => e);
        const unknown = await on.stages
          .setStage(ids.C, randomUUID(), W1, "passed", P2A_CTX)
          .catch((e: unknown) => e);
        for (const err of [foreign, unknown]) expect(err).toBeInstanceOf(NotFoundException);
        const body = (e: unknown) => {
          const ex = e as NotFoundException;
          return JSON.stringify({ status: ex.getStatus(), body: ex.getResponse() });
        };
        expect(body(foreign)).toBe(body(unknown));
        const [row] = await client.sql<{ stage: string }[]>`
          SELECT stage FROM payer_applicant_stages
          WHERE posting_id = ${PA}::uuid AND worker_id = ${W1}::uuid`;
        expect(row!.stage).toBe("shortlist"); // the outsider changed nothing
      });
    });

    describe("mode off — today's behaviour exactly: the teammate is their own tenant", () => {
      it("company postings: the teammate lists none of the anchor's postings, reads them as 404, and a create is stamped with the login", async () => {
        const listB = (await off.postings.listForPayer(ids.B, {})).map((p) => p.id);
        expect(listB).not.toContain(PA);
        expect(listB).not.toContain(PL);
        expect(await notFound(off.postings.getOneForPayer(PA, ids.B))).toEqual(
          await notFound(off.postings.getOneForPayer(randomUUID(), ids.B)),
        );
        const created = await off.postings.createForPayer(ids.B, postingDto(), P2A_CTX);
        expect(created).toMatchObject({ payer_id: ids.B, created_by: ids.B });
        expect((await off.postings.listForPayer(ids.A, {})).map((p) => p.id)).not.toContain(
          created.id,
        );
      });

      it("agency jobs: the teammate lists none of the anchor's jobs and reads them as 404; a create is stamped with the login", async () => {
        const listH = (await off.agency.listOwnJobs(ids.H)).map((j) => j.id);
        expect(listH).not.toContain(JG);
        await notFound(off.agency.getOwnJob(ids.H, JG));
        const created = await off.agency.createJob(ids.H, agencyJobDto(), P2A_CTX);
        const [row] = await client.sql<{ payer_id: string }[]>`
          SELECT payer_id FROM jobs WHERE id = ${created.id}::uuid`;
        expect(row!.payer_id).toBe(ids.H);
      });

      it("applicant lists, inbox and board: the teammate gets the anchor's ids as 404 / an empty inbox", async () => {
        for (const [member, ref] of [
          [ids.B, PA],
          [ids.H, JG],
        ] as const) {
          expect(await notFound(off.applicants.listForOwned(ref, member, P2A_CTX))).toMatchObject({
            message: APPLICANT_NOT_FOUND,
          });
          expect((await off.inbox.list(member, { limit: 50 }, P2A_CTX)).applicants).toEqual([]);
        }
        await notFound(off.stages.setStage(ids.B, PA, W1, "passed", P2A_CTX));
        // …while the anchor's own view is unchanged by the mode.
        expect((await off.inbox.list(ids.A, { limit: 50 }, P2A_CTX)).applicants).toHaveLength(1);
      });
    });
  },
);
