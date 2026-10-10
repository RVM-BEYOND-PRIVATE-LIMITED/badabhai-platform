import "reflect-metadata";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ConflictException, NotFoundException } from "@nestjs/common";
import { loadServerConfig, type ServerConfig } from "@badabhai/config";
import { CREDIT_PACKS, createDbClient, type DbClient } from "@badabhai/db";
import { DEFAULT_MATCH_CONFIG } from "@badabhai/match-engine";
import { DEFAULT_CATALOG, parseCatalog } from "@badabhai/pricing";
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
import { AgencyKycRepository } from "../agency/agency-kyc.repository";
import { AgencyKycService } from "../agency/agency-kyc.service";
import { AgencyPayoutRepository } from "../agency/agency-payout.repository";
import { AgencyPayoutService } from "../agency/agency-payout.service";
import { AgencyWorkersRepository } from "../agency/agency-workers.repository";
import { AgencyWorkersService } from "../agency/agency-workers.service";
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
import {
  INVITE_NOT_ACCEPTABLE_MESSAGE,
  INVITE_NOT_SENDABLE_MESSAGE,
  PayerOrgMembersService,
} from "../payer-portal/payer-org-members.service";
import { PayerPostingPlansService } from "../payer-portal/payer-posting-plans.service";
import { PostingPlansRepository } from "../posting-plans/posting-plans.repository";
import { PostingPlansService } from "../posting-plans/posting-plans.service";
import { PayersRepository } from "./payers.repository";
import { PayerAccountService } from "./payer-account.service";
import { PayerOrgsRepository, type ResolvedOrg } from "./payer-orgs.repository";
import { PayerTenantScopeService } from "./payer-tenant-scope.service";
import { signCheckoutForTest } from "../unlocks/razorpay-signature";
import { RelayRepository } from "../relay/relay.repository";
import { RelayService } from "../relay/relay.service";
import { ResumeDisclosureRepository } from "../disclosures/resume-disclosure.repository";
import { ResumeDisclosureService } from "../disclosures/resume-disclosure.service";

/**
 * ADR-0053 (PAY-DB-01) T0 — "A invites B; B sees A's postings + credits", AGAINST A REAL POSTGRES.
 *
 * Real services and repositories end to end: signup's data path (`createOrGet` + `ensureSoloOrg`),
 * the real invite (a capturing mailer hands the raw token back in-process, exactly what the mock
 * mailer withholds), the real accept with its §3.5 invariants, a real posting create, the mock
 * credit pack, and the real unlock chokepoint (consent gate, caps, atomic debit + grant) with the
 * real EventsService validating every event. Mode `on`.
 *
 * THE TEAM STORY IS GREEN SINCE P2b. It landed as `it.fails` in P1 (resolver, no predicates:
 * B saw none of A's rows and the story failed at its FIRST tenancy assertion) and was flipped to
 * `it` in the PR that put the second of P2a (postings, #2167) and P2b (money) on `main`
 * (ORG_TENANCY_PLAN §1, §7). That flip is the evidence T0 can observe the fix.
 *
 * The harness stays split so a failure names the right cause:
 *  - the ANCHOR's story runs first as an ordinary `it` through the SAME calls (list, credits,
 *    unlock, ledger), proving the harness, the fixtures and every service it builds work;
 *  - B's membership, and the resolver keying B to A in mode `on`, are asserted in an ordinary
 *    `it` before the story;
 *  - the story's first assertion is the tenancy one.
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

    /** The postings `actor`'s tenant lists — resolved the way every payer route resolves it. */
    const listFor = async (actor: string) => postings.listInScope(await tenancy.resolve(actor), {});

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
        tenancy,
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
      // The wallet key comes from the resolver, as in production (A is a solo anchor: itself).
      await gateway.purchasePackMock((await tenancy.resolve(payerA)).tenantKey, PACK);

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
      // Every call the team story makes, made by A. If this fails the harness is broken, not the
      // tenancy the team story below asserts.
      const list = await listFor(payerA);
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
      // Proven here, outside the story, so the story below can only fail on a predicate.
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

    it("O-10 (P3): GET /payer/me tells B to post under A's org name in `on`, and under B's own in `off`", async () => {
      const events = new EventsService(new EventsRepository(client.db), config);
      const accountOn = new PayerAccountService(payers, events, tenancy);
      // A renames their org through the real PATCH, so A's and B's names differ.
      await accountOn.updateOwnAccount(payerA, { orgName: "Anchor Works" }, CTX);

      const meB = await accountOn.getOwnAccount(payerB);
      expect(meB).toMatchObject({ orgName: `Tenancy ${TAG}`, postingOrgName: "Anchor Works" });
      expect((await accountOn.getOwnAccount(payerA)).postingOrgName).toBe("Anchor Works");

      const offConfig = loadServerConfig({ NODE_ENV: "test", PAYER_ORG_TENANCY_MODE: "off" });
      const tenancyOff = new PayerTenantScopeService(offConfig, new PayerOrgsRepository(client.db));
      const meBOff = await new PayerAccountService(payers, events, tenancyOff).getOwnAccount(
        payerB,
      );
      expect(meBOff.postingOrgName).toBe(`Tenancy ${TAG}`);
    });

    // RED IN P1 as `it.fails`; GREEN since P2b landed beside P2a (ORG_TENANCY_PLAN §1, §2.5).
    it("T0: B sees A's posting and A's credits, spends A's wallet, A sees B's unlock — and removal takes it all away", async () => {
      // 1. B lists postings and finds A's posting. ← THE FIRST TENANCY ASSERTION (failed in P1).
      const listB = await listFor(payerB);
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
      expect((await listFor(payerB)).map((p) => p.id)).not.toContain(postingOfA);
      expect((await unlocks.getCredits(payerB)).balance).toBe(0);
      expect((await unlocks.listByPayer(payerB)).unlocks).toEqual([]);
    });
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
 * Risk R65 (ORG_TENANCY_PLAN §5 item 5) — the invite rules A1/A2 hold under CONCURRENCY, against a
 * real Postgres. A1/A2 are check-then-write; the fix runs the reads and the write in one
 * transaction that first takes the membership lock (the accepter's `payers` row on accept, the
 * inviting org's anchor's row on invite).
 *
 * Each racer is a REAL `PayerOrgMembersService` on its OWN connection pool (two pools, so two
 * transactions genuinely overlap; one pipelined pool could fake the serialisation). The race is
 * forced, not hoped for: each racer's WRITE (`acceptInvite` / `inviteMember`) waits at a
 * rendezvous until both racers have reached their write or `HOLD_MS` has passed. Without the lock
 * both racers pass their checks, meet there, and both write — the breach. With the lock the second
 * racer queues on the row lock, never reaches its write while the first holds it, and after the
 * first commits its checks see the new membership and refuse. Seen failing with the lock calls
 * removed (PR body, mutation evidence).
 *
 * Fixtures carry no PII: synthetic `@e2e.badabhai.invalid` emails encrypted by the real crypto,
 * ids fresh per run, everything deleted in afterAll.
 */
describe.skipIf(!RUN)("ADR-0053 R65 — the accept rules hold under concurrency (Postgres)", () => {
  const RACE_TAG = randomUUID().slice(0, 8);
  const RACE_CTX: RequestContext = { correlationId: randomUUID(), requestId: `r65-${RACE_TAG}` };
  /** How long a racer waits at its write for the other; far longer than an uncontended accept. */
  const HOLD_MS = 750;
  const created: string[] = [];
  const tokens: string[] = [];
  const clients: DbClient[] = [];
  let config!: ServerConfig;

  interface Racer {
    readonly orgs: PayerOrgsRepository;
    readonly members: PayerOrgMembersService;
    readonly payers: PayersRepository;
    readonly sql: DbClient["sql"];
  }

  /** A full members stack on its OWN pool. */
  function racer(): Racer {
    const client = createDbClient(DATABASE_URL, { max: 3 });
    clients.push(client);
    const pii = new PiiCryptoService(config);
    const orgs = new PayerOrgsRepository(client.db);
    const payers = new PayersRepository(client.db, pii);
    const events = new EventsService(new EventsRepository(client.db), config);
    const members = new PayerOrgMembersService(orgs, pii, events, payers, config, {
      send: async ({ acceptUrl }: { email: string; acceptUrl: string }) => {
        tokens.push(new URL(acceptUrl).searchParams.get("token") ?? "");
      },
    });
    return { orgs, members, payers, sql: client.sql };
  }

  interface Rendezvous {
    readonly wait: () => Promise<void>;
    /** How many racers reached their write. With the lock in place, only ever ONE. */
    readonly arrived: () => number;
  }

  /** Holds each arrival until `parties` have arrived or `ms` passes, whichever is first. */
  function rendezvous(parties: number, ms: number): Rendezvous {
    let arrived = 0;
    let release!: () => void;
    const all = new Promise<void>((resolve) => (release = resolve));
    return {
      wait: async () => {
        arrived += 1;
        if (arrived >= parties) release();
        await Promise.race([all, new Promise<void>((resolve) => setTimeout(resolve, ms))]);
      },
      arrived: () => arrived,
    };
  }

  /** Make `method` on `repo` stop at the rendezvous before it writes, then run the real one. */
  function holdBeforeWrite(
    repo: PayerOrgsRepository,
    method: "acceptInvite" | "inviteMember",
    gate: Rendezvous,
  ): void {
    const real = repo[method].bind(repo) as (...args: unknown[]) => Promise<unknown>;
    (repo as unknown as Record<string, unknown>)[method] = async (...args: unknown[]) => {
      await gate.wait();
      return real(...args);
    };
  }

  let a!: Racer;
  let b!: Racer;

  /** A payer with their solo org, verified (the signup data path). */
  async function payer(label: string): Promise<{ id: string; email: string }> {
    const email = `r65-${label}-${RACE_TAG}@e2e.badabhai.invalid`;
    const { id } = await a.payers.createOrGet({
      role: "employer",
      email,
      orgName: "R65 Org",
      phone: undefined,
    });
    await a.orgs.ensureSoloOrg(id);
    await a.payers.activate(id);
    created.push(id);
    return { id, email };
  }

  async function soloOrgOf(anchor: string): Promise<ResolvedOrg> {
    const [row] = await a.sql`SELECT id FROM payer_orgs WHERE root_payer_id = ${anchor}::uuid`;
    return { orgId: String(row!.id), orgRole: "owner" };
  }

  /** `inviter` (owner of their solo org) invites `email`; returns the captured raw token. */
  async function inviteFrom(inviter: string, email: string): Promise<string> {
    const org = await soloOrgOf(inviter);
    await a.members.invite(org, inviter, { email, org_role: "recruiter" }, RACE_CTX);
    return tokens.at(-1)!;
  }

  /** Active memberships of `payerId` in orgs someone ELSE anchors (census C2's unit). */
  async function teamMemberships(payerId: string): Promise<number> {
    const [row] = await a.sql`
      SELECT count(*)::int AS n FROM payer_members pm JOIN payer_orgs po ON po.id = pm.org_id
      WHERE pm.member_payer_id = ${payerId}::uuid AND pm.status = 'active'
        AND po.root_payer_id <> pm.member_payer_id`;
    return Number(row!.n);
  }

  /** Non-removed members of `anchor`'s org other than the anchor (A2's "anchors a team"). */
  async function othersInOrgOf(anchor: string): Promise<number> {
    const [row] = await a.sql`
      SELECT count(*)::int AS n FROM payer_members pm JOIN payer_orgs po ON po.id = pm.org_id
      WHERE po.root_payer_id = ${anchor}::uuid AND pm.status <> 'removed'
        AND pm.member_payer_id IS DISTINCT FROM po.root_payer_id`;
    return Number(row!.n);
  }

  /** The neutral 409 body of a rejected racer. */
  function conflictBody(outcome: PromiseSettledResult<unknown>): string {
    expect(outcome.status).toBe("rejected");
    const reason = (outcome as PromiseRejectedResult).reason as unknown;
    expect(reason).toBeInstanceOf(ConflictException);
    return JSON.stringify((reason as ConflictException).getResponse());
  }

  beforeAll(() => {
    config = loadServerConfig({ NODE_ENV: "test", PAYER_ORG_TENANCY_MODE: "on" });
    a = racer();
    b = racer();
  });

  afterAll(async () => {
    const [first] = clients;
    if (first) {
      await first.sql`DELETE FROM events WHERE correlation_id = ${RACE_CTX.correlationId}::uuid`;
      await first.sql`DELETE FROM payer_orgs WHERE root_payer_id = ANY(${created}::uuid[])`;
      await first.sql`DELETE FROM payers WHERE id = ANY(${created}::uuid[])`;
    }
    for (const client of clients) await client.sql.end({ timeout: 5 });
  });

  it("A1: two simultaneous accepts by ONE payer (two orgs' invites) — exactly one lands; the other is the neutral 409 and keeps its token", async () => {
    const x = await payer("a1-x");
    const y = await payer("a1-y");
    const p = await payer("a1-p");
    const tokenX = await inviteFrom(x.id, p.email);
    const tokenY = await inviteFrom(y.id, p.email);

    const gate = rendezvous(2, HOLD_MS);
    holdBeforeWrite(a.orgs, "acceptInvite", gate);
    holdBeforeWrite(b.orgs, "acceptInvite", gate);
    const results = await Promise.allSettled([
      a.members.accept(p.id, { token: tokenX }, RACE_CTX),
      b.members.accept(p.id, { token: tokenY }, RACE_CTX),
    ]);

    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    const loser = results.find((r) => r.status === "rejected")!;
    expect(conflictBody(loser)).toContain(INVITE_NOT_ACCEPTABLE_MESSAGE);
    // The breach census C2 counts is absent: ONE active team membership.
    expect(await teamMemberships(p.id)).toBe(1);
    // The second racer queued on the lock and was refused before its write.
    expect(gate.arrived()).toBe(1);
    // The refused invite is still pending (a refusal consumes no token).
    const [pending] = await a.sql`
      SELECT count(*)::int AS n FROM payer_members
      WHERE email_hash = (SELECT email_hash FROM payers WHERE id = ${p.id}::uuid)
        AND status = 'invited'`;
    expect(Number(pending!.n)).toBe(1);
  });

  it("A2: an anchor accepting another org's invite while inviting someone into their OWN org — exactly one lands", async () => {
    const x = await payer("a2-x");
    const p = await payer("a2-p");
    const q = await payer("a2-q");
    const tokenX = await inviteFrom(x.id, p.email);
    const orgOfP = await soloOrgOf(p.id);

    const gate = rendezvous(2, HOLD_MS);
    holdBeforeWrite(a.orgs, "acceptInvite", gate);
    holdBeforeWrite(b.orgs, "inviteMember", gate);
    const [accept, invite] = await Promise.allSettled([
      a.members.accept(p.id, { token: tokenX }, RACE_CTX),
      b.members.invite(orgOfP, p.id, { email: q.email, org_role: "recruiter" }, RACE_CTX),
    ]);

    expect([accept, invite].filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(gate.arrived()).toBe(1);
    if (accept.status === "fulfilled") {
      // The accept won: under the anchor's lock the invite saw P now sits in X's team.
      expect(conflictBody(invite)).toContain(INVITE_NOT_SENDABLE_MESSAGE);
      expect(await teamMemberships(p.id)).toBe(1);
      expect(await othersInOrgOf(p.id)).toBe(0);
    } else {
      // The invite won: P now anchors a team, so A2 refused the accept.
      expect(conflictBody(accept)).toContain(INVITE_NOT_ACCEPTABLE_MESSAGE);
      expect(await teamMemberships(p.id)).toBe(0);
      expect(await othersInOrgOf(p.id)).toBe(1);
    }
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
      /** The postings `actor`'s tenant lists / reads, through the resolver every route uses. */
      const listOf = async (actor: string) =>
        postings.listInScope(await tenancy.resolve(actor), {});
      const getOf = async (id: string, actor: string) =>
        postings.getOneInScope(id, await tenancy.resolve(actor));
      return { postings, agency, applicants, inbox, stages, listOf, getOf };
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
        expect((await on.listOf(ids.A)).map((p) => p.id)).toContain(created.id);
        expect((await on.listOf(ids.C)).map((p) => p.id)).not.toContain(created.id);
      });

      it("company postings: the teammate lists and reads the anchor's postings; the outsider lists none", async () => {
        const listB = (await on.listOf(ids.B)).map((p) => p.id);
        expect(listB).toEqual(expect.arrayContaining([PA, PL]));
        expect((await on.getOf(PA, ids.B)).id).toBe(PA);
        const listC = (await on.listOf(ids.C)).map((p) => p.id);
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
          ["get", (id: string) => on.getOf(id, ids.C)],
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
        const listB = (await off.listOf(ids.B)).map((p) => p.id);
        expect(listB).not.toContain(PA);
        expect(listB).not.toContain(PL);
        expect(await notFound(off.getOf(PA, ids.B))).toEqual(
          await notFound(off.getOf(randomUUID(), ids.B)),
        );
        const created = await off.postings.createForPayer(ids.B, postingDto(), P2A_CTX);
        expect(created).toMatchObject({ payer_id: ids.B, created_by: ids.B });
        expect((await off.listOf(ids.A)).map((p) => p.id)).not.toContain(created.id);
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

/**
 * ADR-0053 P2c (PAY-DB-01) — T2 + T7 for plans, boosts, quota top-ups, capacity and coupons,
 * AGAINST A REAL POSTGRES, in BOTH modes, through the payer routes' one seam
 * (`PayerPostingPlansService`) and the real `PostingPlansService` / repository.
 *
 * Payers (each a real payer with the solo org signup founds; memberships seeded as an accept
 * writes them):
 *  - A anchors a team, B is A's active recruiter, C is an outsider;
 *  - D anchors a second team, E is D's recruiter — the concurrency case's org, so its counts are
 *    its own.
 *
 *  - `on`: a teammate's plan / boost / top-up / capacity on the org's posting is stamped with the
 *    TENANT key and counted against the org's ONE allowance; every event's actor is the acting
 *    login and its payload `payer_id` the org; an outsider gets the same 404 an unknown id gets;
 *    a coupon's per-payer limit is per org (O-4); two members buying at once serialize on the
 *    org's capacity lock.
 *  - `off`: today's behaviour — the teammate is their own tenant.
 *
 * No money moves (PAYMENTS_ENABLE_REAL is off): each purchase writes its receipt row, nothing
 * else. Fixtures carry no PII; everything is deleted afterwards.
 */
describe.skipIf(!RUN)(
  "ADR-0053 P2c — plans, boosts, quota top-ups, capacity and coupons follow the TENANT (Postgres)",
  () => {
    const P2C_TAG = randomUUID().slice(0, 8);
    const P2C_CTX: RequestContext = {
      correlationId: randomUUID(),
      requestId: `tenancy-p2c-${P2C_TAG}`,
    };
    /** Per-run coupons, so a redemption from another run can never count (codes are lowercase). */
    const COUPON = `org_${P2C_TAG}`;
    const COUPON_2 = `org2_${P2C_TAG}`;
    const coupon = (code: string) => ({
      code,
      scope: { productCode: "job_posting" },
      kind: "percent" as const,
      value: 10,
      from: "2026-01-01T00:00:00.000Z",
      until: "2099-01-01T00:00:00.000Z",
      totalUsageCap: 100,
      perPayerLimit: 1,
    });
    const CATALOG = parseCatalog({
      ...DEFAULT_CATALOG,
      coupons: [coupon(COUPON), coupon(COUPON_2)],
    });
    let client!: DbClient;
    const payerIds: string[] = [];
    const ids = { A: "", B: "", C: "", D: "", E: "" };
    /** PA, PB: A's postings. PC: C's. PD: D's four postings for the concurrency case. */
    let PA = "";
    let PB = "";
    let PC = "";
    const PD: string[] = [];

    type Services = ReturnType<typeof servicesFor>;
    let on!: Services;
    let onEnforced!: Services;
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
        { materialize: async () => undefined } as never, // a draft never materializes reach
        {} as never, // MatchSkillsService — no match_skill_ids
        tenancy,
      );
      const plans = new PostingPlansService(
        new PostingPlansRepository(client.db),
        events,
        // The catalog is fixed here (the per-run coupon); pricing is not what this suite measures.
        {
          getActiveCatalog: async () => ({ catalog: CATALOG, revision: 1, source: "db" }),
        } as never,
        config,
        // The boost supply gate is off (floor 0), so no reach count is read.
        { get: async () => ({ ...DEFAULT_MATCH_CONFIG, boostSupplyFloor: 0 }) } as never,
        {} as never, // WorkerSkillsRepository — unread with the gate off
        tenancy,
      );
      // P2b — the posting reads also carry their résumé-download counts (real repository).
      const disclosures = new ResumeDisclosureService(
        new ResumeDisclosureRepository(client.db),
        {} as never, // ConsentRepository — no disclosure is requested in this block
        {} as never, // WorkersRepository
        {} as never, // PiiCryptoService
        {} as never, // ResumeRenderer
        {} as never, // StorageService
        {} as never, // WorkerAttributesRepository
        {} as never, // WorkerEmploymentRepository
        {} as never, // WorkerQualificationsRepository
        {} as never, // WorkerOccupationsRepository
        events,
        config,
        tenancy,
      );
      const postingPlans = new PayerPostingPlansService(postings, plans, disclosures, tenancy);
      return { postings, plans, postingPlans };
    }

    async function signUp(label: string): Promise<string> {
      const config = loadServerConfig({ NODE_ENV: "test" });
      const repo = new PayersRepository(client.db, new PiiCryptoService(config));
      const { id } = await repo.createOrGet({
        role: "employer",
        email: `tenancy-p2c-${label}-${P2C_TAG}@e2e.badabhai.invalid`,
        orgName: `Tenancy P2c ${P2C_TAG}`,
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

    async function eventsOf(subjectId: string, eventName: string) {
      return client.sql<{ actor_id: string; payload: Record<string, unknown> }[]>`
        SELECT actor_id, payload FROM events
        WHERE correlation_id = ${P2C_CTX.correlationId}::uuid
          AND subject_id = ${subjectId} AND event_name = ${eventName}
        ORDER BY occurred_at`;
    }

    async function plansOwnedBy(payerId: string) {
      return client.sql<{ id: string; status: string; job_posting_id: string }[]>`
        SELECT id, status, job_posting_id FROM posting_plans WHERE payer_id = ${payerId}::uuid`;
    }

    beforeAll(async () => {
      // Enough connections for the concurrent buys: each holds one while it waits on the lock,
      // and the post-commit emits take another.
      client = createDbClient(DATABASE_URL, { max: 10 });
      const base = { NODE_ENV: "test", UNLOCK_LATENCY_TARGET_MS: "0" };
      on = servicesFor(loadServerConfig({ ...base, PAYER_ORG_TENANCY_MODE: "on" }));
      off = servicesFor(loadServerConfig({ ...base, PAYER_ORG_TENANCY_MODE: "off" }));
      // ADR-0016 enforcement ON with the default allowance of 1, for the concurrency case.
      onEnforced = servicesFor(
        loadServerConfig({
          ...base,
          PAYER_ORG_TENANCY_MODE: "on",
          CAPACITY_ENFORCEMENT_ENABLED: "true",
          CAPACITY_DEFAULT_MAX_ACTIVE_VACANCIES: "1",
        }),
      );

      ids.A = await signUp("a");
      ids.B = await signUp("b");
      ids.C = await signUp("c");
      ids.D = await signUp("d");
      ids.E = await signUp("e");
      await joinTeam(ids.A, ids.B);
      await joinTeam(ids.D, ids.E);

      // An anchor is its own tenant in BOTH modes (solo identity).
      PA = (await off.postings.createForPayer(ids.A, postingDto(), P2C_CTX)).id;
      PB = (await off.postings.createForPayer(ids.A, postingDto(), P2C_CTX)).id;
      PC = (await off.postings.createForPayer(ids.C, postingDto(), P2C_CTX)).id;
      for (let i = 0; i < 4; i += 1) {
        PD.push((await off.postings.createForPayer(ids.D, postingDto(), P2C_CTX)).id);
      }
    }, 60_000);

    afterAll(async () => {
      if (!client) return;
      const { sql } = client;
      await sql`DELETE FROM posting_boosts WHERE payer_id = ANY(${payerIds}::uuid[])`;
      await sql`DELETE FROM posting_plans WHERE payer_id = ANY(${payerIds}::uuid[])`;
      await sql`DELETE FROM payer_capacity WHERE payer_id = ANY(${payerIds}::uuid[])`;
      await sql`DELETE FROM events WHERE correlation_id = ${P2C_CTX.correlationId}::uuid`;
      await sql`DELETE FROM job_postings WHERE payer_id = ANY(${payerIds}::uuid[]) OR created_by = ANY(${payerIds}::uuid[])`;
      await sql`DELETE FROM payer_orgs WHERE root_payer_id = ANY(${payerIds}::uuid[])`;
      await sql`DELETE FROM payers WHERE id = ANY(${payerIds}::uuid[])`;
      await sql.end({ timeout: 5 });
    });

    describe("mode on", () => {
      it("plans: a teammate's plan on the org's posting is the ORG's row; the events name the teammate as actor, the org as payer", async () => {
        const owned = await on.postingPlans.forOwnedPosting(PA, ids.B);
        const { plan } = await owned.buyPlan({ tier: "standard" }, P2C_CTX);
        const [row] = await client.sql<{ payer_id: string }[]>`
          SELECT payer_id FROM posting_plans WHERE id = ${plan.id}::uuid`;
        expect(row).toEqual({ payer_id: ids.A });
        for (const name of ["payment.authorized", "payment.captured", "job_posting.purchased"]) {
          const [evt] = await eventsOf(PA, name);
          expect(evt, name).toMatchObject({ actor_id: ids.B, payload: { payer_id: ids.A } });
        }
        // The anchor's read of its posting carries the teammate's plan, and so does the teammate's.
        for (const reader of [ids.A, ids.B]) {
          const { stats } = await on.postingPlans.getOneWithStats(PA, reader);
          expect(stats, reader).toMatchObject({
            plan_tier: "standard",
            applicant_visibility_quota: 10,
          });
        }
        const listed = await on.postingPlans.listWithStats(ids.B, {});
        expect(listed.find((r) => r.posting.id === PA)?.stats.plan_tier).toBe("standard");
      });

      it("quota top-up: the teammate tops up the ORG's plan — the anchor's plan row carries it", async () => {
        const [plan] = await plansOwnedBy(ids.A);
        const owned = await on.postingPlans.forOwnedPosting(PA, ids.B);
        const { plan: topped } = await owned.topUpQuota({ tier: "topup_10" }, P2C_CTX);
        expect(topped.id).toBe(plan!.id);
        const [row] = await client.sql<{ quota_topup_count: number; payer_id: string }[]>`
          SELECT quota_topup_count, payer_id FROM posting_plans WHERE id = ${plan!.id}::uuid`;
        expect(row).toEqual({ quota_topup_count: 10, payer_id: ids.A });
        const [evt] = await eventsOf(plan!.id, "posting_plan.quota_topped");
        expect(evt).toMatchObject({ actor_id: ids.B, payload: { payer_id: ids.A } });
        const { stats } = await on.postingPlans.getOneWithStats(PA, ids.A);
        expect(stats.applicant_visibility_quota).toBe(20);
      });

      it("boosts: the teammate's boost is the ORG's receipt; job_posting.boosted names the teammate and the org", async () => {
        const owned = await on.postingPlans.forOwnedPosting(PA, ids.B);
        const { boost } = await owned.buyBoost({ tier: "boost_7" }, P2C_CTX);
        const [row] = await client.sql<{ payer_id: string }[]>`
          SELECT payer_id FROM posting_boosts WHERE id = ${boost.id}::uuid`;
        expect(row).toEqual({ payer_id: ids.A });
        const [evt] = await eventsOf(PA, "job_posting.boosted");
        expect(evt).toMatchObject({ actor_id: ids.B, payload: { payer_id: ids.A } });
        expect((await on.postingPlans.getOneWithStats(PA, ids.A)).stats.boosted).toBe(true);
      });

      it("an outsider gets the SAME 404 for the org's posting as for an unknown id, and writes nothing", async () => {
        const responseOf = async (work: Promise<unknown>) => {
          const err = await work.then(
            () => new Error("expected a 404, the request resolved"),
            (e: unknown) => e,
          );
          expect(err).toBeInstanceOf(NotFoundException);
          return (err as NotFoundException).getResponse();
        };
        const foreign = await responseOf(on.postingPlans.forOwnedPosting(PA, ids.C));
        const unknown = await responseOf(on.postingPlans.forOwnedPosting(randomUUID(), ids.C));
        expect(foreign).toEqual(unknown);
        expect(await responseOf(on.postingPlans.getOneWithStats(PA, ids.C))).toEqual(unknown);
        const [written] = await client.sql<{ n: number }[]>`
          SELECT (SELECT count(*) FROM posting_plans WHERE payer_id = ${ids.C}::uuid)
               + (SELECT count(*) FROM posting_boosts WHERE payer_id = ${ids.C}::uuid) AS n`;
        expect(Number(written!.n)).toBe(0);
      });

      it("capacity: the teammate's purchase raises the ORG's one allowance; both read it, with the org's live count; payer_id echoes each caller", async () => {
        const bought = await on.plans.buyCapacity(ids.B, { tier: "cap_5" }, P2C_CTX);
        expect(bought).toMatchObject({ payer_id: ids.B, max_active_vacancies: 5 });
        const rows = await client.sql<{ payer_id: string; max_active_vacancies: number }[]>`
          SELECT payer_id, max_active_vacancies FROM payer_capacity
          WHERE payer_id = ANY(${[ids.A, ids.B]}::uuid[])`;
        expect(rows).toEqual([{ payer_id: ids.A, max_active_vacancies: 5 }]);
        const [evt] = await eventsOf(ids.A, "capacity.purchased");
        expect(evt).toMatchObject({ actor_id: ids.B, payload: { payer_id: ids.A } });

        const active = (await plansOwnedBy(ids.A)).filter((p) => p.status === "active").length;
        expect(active).toBeGreaterThan(0);
        for (const reader of [ids.A, ids.B]) {
          expect(await on.plans.getCapacity(reader), reader).toMatchObject({
            payer_id: reader,
            max_active_vacancies: 5,
            active_plan_count: active,
            source_tier: "cap_5",
          });
        }
      });

      it("coupons (O-4): the per-payer limit is per ORG — once the anchor has redeemed, the teammate cannot; another org still can", async () => {
        const buy = async (posting: string, actor: string, coupon: string) =>
          (await on.postingPlans.forOwnedPosting(posting, actor)).buyPlan(
            { tier: "standard", coupon },
            P2C_CTX,
          );
        const viaA = await buy(PB, ids.A, COUPON);
        expect(viaA.quote.couponApplied).toBe(COUPON);

        // The teammate is the same org: its limit of 1 is spent, though the teammate never used it.
        const viaB = await buy(PB, ids.B, COUPON);
        expect(viaB.quote.couponApplied).toBeNull();
        expect(viaB.quote.finalInr).toBe(1000);

        // Another org is untouched by it.
        const viaC = await buy(PC, ids.C, COUPON);
        expect(viaC.quote.couponApplied).toBe(COUPON);
      });

      it("coupons (O-4): a teammate's redemption is stamped with the ORG (actor = the teammate), so it spends the anchor's limit too", async () => {
        const buy = async (actor: string) =>
          (await on.postingPlans.forOwnedPosting(PB, actor)).buyPlan(
            { tier: "standard", coupon: COUPON_2 },
            P2C_CTX,
          );
        expect((await buy(ids.B)).quote.couponApplied).toBe(COUPON_2);
        const redeemed = await client.sql<{ actor_id: string; payload: Record<string, unknown> }[]>`
          SELECT actor_id, payload FROM events
          WHERE event_name = 'coupon.redeemed' AND payload ->> 'coupon_code' = ${COUPON_2}`;
        expect(redeemed).toEqual([
          expect.objectContaining({
            actor_id: ids.B,
            payload: expect.objectContaining({ payer_id: ids.A }),
          }),
        ]);
        expect((await buy(ids.A)).quote.couponApplied).toBeNull();
      });

      it("concurrency: the anchor and a teammate buying at once serialize on the ORG's capacity lock — exactly the allowance goes active", async () => {
        // D's org has no capacity row: the default allowance (1) applies; enforcement is ON.
        const buyers = [ids.D, ids.E, ids.D, ids.E];
        await Promise.all(
          buyers.map(async (actor, i) =>
            (await onEnforced.postingPlans.forOwnedPosting(PD[i]!, actor)).buyPlan(
              { tier: "standard" },
              P2C_CTX,
            ),
          ),
        );
        const plans = await plansOwnedBy(ids.D);
        expect(plans).toHaveLength(4);
        expect(plans.filter((p) => p.status === "active")).toHaveLength(1);
        expect(plans.filter((p) => p.status === "paused")).toHaveLength(3);
        expect(await plansOwnedBy(ids.E)).toEqual([]);
      });
    });

    describe("mode off — today's behaviour exactly: the teammate is their own tenant", () => {
      it("the purchase seam 404s the anchor's posting for the teammate, as today; the anchor buys as before", async () => {
        await expect(off.postingPlans.forOwnedPosting(PA, ids.B)).rejects.toBeInstanceOf(
          NotFoundException,
        );
        const owned = await off.postingPlans.forOwnedPosting(PB, ids.A);
        const { plan } = await owned.buyPlan({ tier: "standard" }, P2C_CTX);
        expect(plan.payerId).toBe(ids.A);
      });

      it("capacity and coupons are the teammate's own: their own allowance row, their own redemption count", async () => {
        const bought = await off.plans.buyCapacity(ids.B, { tier: "cap_15" }, P2C_CTX);
        expect(bought).toMatchObject({ payer_id: ids.B, max_active_vacancies: 15 });
        const rows = await client.sql<{ payer_id: string; max_active_vacancies: number }[]>`
          SELECT payer_id, max_active_vacancies FROM payer_capacity
          WHERE payer_id = ANY(${[ids.A, ids.B]}::uuid[]) ORDER BY max_active_vacancies`;
        expect(rows).toEqual([
          { payer_id: ids.A, max_active_vacancies: 5 },
          { payer_id: ids.B, max_active_vacancies: 15 },
        ]);
        expect(await off.plans.getCapacity(ids.B)).toMatchObject({
          payer_id: ids.B,
          max_active_vacancies: 15,
          active_plan_count: 0,
        });

        // The org spent the coupon in `on`; off, the teammate's count is their own (zero).
        const ownPosting = (await off.postings.createForPayer(ids.B, postingDto(), P2C_CTX)).id;
        const own = await (
          await off.postingPlans.forOwnedPosting(ownPosting, ids.B)
        ).buyPlan({ tier: "standard", coupon: COUPON }, P2C_CTX);
        expect(own.plan.payerId).toBe(ids.B);
        expect(own.quote.couponApplied).toBe(COUPON);
        const [evt] = await eventsOf(ids.B, "coupon.redeemed");
        expect(evt).toMatchObject({ actor_id: ids.B, payload: { payer_id: ids.B } });
      });
    });
  },
);

/**
 * ADR-0053 P2d (PAY-DB-01) — T2 for the agency supply side: invites, the referrals funnel, the
 * referred-worker list, KYC, earnings and payouts, AGAINST A REAL POSTGRES, in BOTH modes over the
 * SAME rows.
 *
 * Agencies: G anchors a team, H is G's active recruiter, I is an outsider — every one a real
 * `agent` payer with the solo org signup founds; H's membership is the row a successful accept
 * writes. Every service is the REAL one over the real repositories; only the resolver's mode
 * differs between the `on` and `off` sets.
 *
 *  - `on`: a teammate's invite is the ORG's (`inviter_payer_id` = the anchor, the actor = the
 *    login), so the worker it refers appears in the org's list under the org's handle and the
 *    unlock on him earns for the org; KYC, the accruals and the payout request are one set of
 *    rows keyed by the anchor. Who may reach KYC / earnings / payouts is the route's owner-only
 *    gate (agency-payouts-owner-only.test.ts) — here the owner drives them.
 *  - `off`: today's behaviour, byte for byte — the teammate's invite is their own, and the
 *    anchor's reads return exactly what they return in `on` (solo identity).
 *
 * Fixtures carry no PII: synthetic `@e2e.badabhai.invalid` emails, `enc:`/`hash:` markers in the
 * worker phone columns, a synthetic PAN, ids fresh per run, all deleted afterwards.
 */
describe.skipIf(!RUN)(
  "ADR-0053 P2d — agency invites, referred workers, KYC, earnings and payouts follow the TENANT (Postgres)",
  () => {
    const P2D_TAG = randomUUID().slice(0, 8);
    const P2D_CTX: RequestContext = {
      correlationId: randomUUID(),
      requestId: `tenancy-p2d-${P2D_TAG}`,
    };
    let client!: DbClient;
    const payerIds: string[] = [];
    const ids = { G: "", H: "", I: "" };
    const W1 = randomUUID(); // referred by H's invite under `on` (the org's), consented
    const W2 = randomUUID(); // referred by H's invite under `off` (H's own), consented
    const W3 = randomUUID(); // referred by the OUTSIDER's own invite, consented
    const UNLOCK_W1 = randomUUID();
    const UNLOCK_W3 = randomUUID();
    let codeForW1 = "";

    type Services = ReturnType<typeof servicesFor>;
    let on!: Services;
    let off!: Services;

    function servicesFor(config: ServerConfig) {
      const pii = new PiiCryptoService(config);
      const events = new EventsService(new EventsRepository(client.db), config);
      const tenancy = new PayerTenantScopeService(config, new PayerOrgsRepository(client.db));
      const agency = new AgencyService(
        new AgencyJobsRepository(client.db),
        new AgencyInvitesRepository(client.db),
        new ConsentRepository(client.db),
        events,
        {} as never, // MatchSkillsService — no agency job is created here
        tenancy,
      );
      const kyc = new AgencyKycService(
        new AgencyKycRepository(client.db),
        pii,
        events,
        new PayersRepository(client.db, pii),
      );
      const payouts = new AgencyPayoutService(
        new AgencyPayoutRepository(client.db),
        kyc,
        events,
        config,
      );
      const workers = new AgencyWorkersService(
        new AgencyWorkersRepository(client.db),
        pii,
        tenancy,
      );
      // The money routes' services take the scope their owner gate resolved (ONE resolution per
      // request); `scope(actor)` is that resolution, through the same real resolver.
      const scope = (actor: string) => tenancy.resolve(actor);
      return { agency, kyc, payouts, workers, pii, scope };
    }

    async function signUp(label: string): Promise<string> {
      const config = loadServerConfig({ NODE_ENV: "test" });
      const repo = new PayersRepository(client.db, new PiiCryptoService(config));
      const { id } = await repo.createOrGet({
        role: "agent",
        email: `tenancy-p2d-${label}-${P2D_TAG}@e2e.badabhai.invalid`,
        orgName: `Tenancy P2d ${P2D_TAG}`,
        phone: undefined,
      });
      await new PayerOrgsRepository(client.db).ensureSoloOrg(id);
      await repo.activate(id);
      payerIds.push(id);
      return id;
    }

    async function joinTeam(anchor: string, member: string): Promise<void> {
      await client.sql`
        INSERT INTO payer_members (org_id, member_payer_id, email_enc, email_hash, org_role, status,
                                   invited_by, invited_at, accepted_at)
        SELECT o.id, m.id, m.email_enc, m.email_hash, 'recruiter', 'active', ${anchor}::uuid, now(), now()
        FROM payer_orgs o, payers m
        WHERE o.root_payer_id = ${anchor}::uuid AND m.id = ${member}::uuid`;
    }

    async function inviteOwner(inviteId: string): Promise<string> {
      const [row] = await client.sql<{ inviter_payer_id: string }[]>`
        SELECT inviter_payer_id FROM agency_invites WHERE id = ${inviteId}::uuid`;
      return row!.inviter_payer_id;
    }

    async function eventsNamed(eventName: string, subjectId: string) {
      return client.sql<{ actor_id: string | null; payload: Record<string, unknown> }[]>`
        SELECT actor_id, payload FROM events
        WHERE event_name = ${eventName} AND subject_id = ${subjectId}::uuid
        ORDER BY occurred_at`;
    }

    const kycDto = (n: string) => ({
      pan: `PANP2D${P2D_TAG}${n}`,
      bank_account: "123456789012",
      ifsc: "HDFC0001234",
      account_holder_name: "Tenancy Test Holder",
    });

    beforeAll(async () => {
      client = createDbClient(DATABASE_URL, { max: 3 });
      const base = {
        NODE_ENV: "test",
        UNLOCK_LATENCY_TARGET_MS: "0",
        // The payout surface is exercised end to end: the flag on, and a 10-rupee threshold so
        // ONE accrual (25% of 40) is requestable.
        AGENCY_PAYOUTS_ENABLED: "true",
        AGENCY_PAYOUT_MIN_THRESHOLD_INR: "10",
      };
      on = servicesFor(loadServerConfig({ ...base, PAYER_ORG_TENANCY_MODE: "on" }));
      off = servicesFor(loadServerConfig({ ...base, PAYER_ORG_TENANCY_MODE: "off" }));

      ids.G = await signUp("g");
      ids.H = await signUp("h");
      ids.I = await signUp("i");
      await joinTeam(ids.G, ids.H);

      for (const [worker, label] of [
        [W1, "w1"],
        [W2, "w2"],
        [W3, "w3"],
      ] as const) {
        await client.sql`
          INSERT INTO workers (id, phone_e164, phone_hash, status)
          VALUES (${worker}::uuid, ${`enc:p2d-${P2D_TAG}-${label}`}, ${`hash:p2d-${P2D_TAG}-${label}`}, 'active')`;
        await client.sql`
          INSERT INTO worker_consents (worker_id, consent_version, purposes, accepted_at)
          VALUES (${worker}::uuid, '2026-06-01',
                  ${JSON.stringify(["profiling", "agent_activity_visibility"])}::jsonb, now())`;
      }
    }, 60_000);

    afterAll(async () => {
      if (!client) return;
      const { sql } = client;
      const workers = [W1, W2, W3];
      const inviteIds = (
        await sql<{ id: string }[]>`
          SELECT id FROM agency_invites WHERE inviter_payer_id = ANY(${payerIds}::uuid[])`
      ).map((r) => r.id);
      const requestIds = (
        await sql<{ id: string }[]>`
          SELECT id FROM agency_payout_requests WHERE agency_payer_id = ANY(${payerIds}::uuid[])`
      ).map((r) => r.id);
      await sql`
        DELETE FROM events
        WHERE correlation_id = ${P2D_CTX.correlationId}::uuid
           OR subject_id = ANY(${[...payerIds, ...inviteIds, ...requestIds, UNLOCK_W1, UNLOCK_W3]}::uuid[])`;
      await sql`DELETE FROM agency_payout_accruals WHERE agency_payer_id = ANY(${payerIds}::uuid[])`;
      await sql`DELETE FROM agency_payout_requests WHERE agency_payer_id = ANY(${payerIds}::uuid[])`;
      await sql`DELETE FROM agency_kyc WHERE payer_id = ANY(${payerIds}::uuid[])`;
      await sql`DELETE FROM agency_invites WHERE inviter_payer_id = ANY(${payerIds}::uuid[])`;
      await sql`DELETE FROM unlocks WHERE worker_id = ANY(${workers}::uuid[])`;
      await sql`DELETE FROM workers WHERE id = ANY(${workers}::uuid[])`;
      await sql`DELETE FROM payer_orgs WHERE root_payer_id = ANY(${payerIds}::uuid[])`;
      await sql`DELETE FROM payers WHERE id = ANY(${payerIds}::uuid[])`;
      await sql.end({ timeout: 5 });
    });

    describe("mode on", () => {
      it("invites: a teammate's mint is the ORG's row — inviter_payer_id = the anchor; the event names the anchor as owner, the login as actor", async () => {
        const mint = await on.agency.createInvite(ids.H, { campaign: "p2d" }, P2D_CTX);
        codeForW1 = mint.code;
        expect(await inviteOwner(mint.agency_invite_id)).toBe(ids.G);
        const [evt] = await eventsNamed("agency_invite.created", mint.agency_invite_id);
        expect(evt).toMatchObject({ actor_id: ids.H, payload: { inviter_payer_id: ids.G } });

        const { invites } = await on.agency.createInviteBatch(ids.H, 5, {}, P2D_CTX);
        expect(invites).toHaveLength(5);
        for (const i of invites) expect(await inviteOwner(i.agency_invite_id)).toBe(ids.G);
      });

      it("referrals funnel: the teammate's funnel IS the anchor's (6 created, above the k-anon floor); the outsider's is empty", async () => {
        const asG = await on.agency.referralsSummary(ids.G);
        expect(asG).toMatchObject({ created: 6, clicked: 0, accepted: 0 });
        expect(await on.agency.referralsSummary(ids.H)).toEqual(asG);
        expect(await on.agency.referralsSummary(ids.I)).toMatchObject({
          created: 0,
          clicked: 0,
          accepted: 0,
        });
      });

      it("referred workers: the man H's invite brought in is in the ORG's list, under the ORG's handle; the outsider sees nobody", async () => {
        expect(await on.agency.attributeWorkerToInvite(codeForW1, W1)).toEqual({ ok: true });
        const asG = await on.workers.listReferred(ids.G);
        expect(asG.workers).toHaveLength(1);
        expect(asG.workers[0]!.ref).toBe(on.pii.hmac(`agency_worker:${ids.G}:${W1}`).slice(0, 16));
        expect(await on.workers.listReferred(ids.H)).toEqual(asG);
        expect((await on.workers.listReferred(ids.I)).workers).toEqual([]);
      });

      it("KYC: ONE org row keyed by the anchor; the outsider reads not_submitted", async () => {
        const view = await on.kyc.submit(await on.scope(ids.G), kycDto("g"));
        expect(view).toMatchObject({ status: "pending" });
        const rows = await client.sql<{ payer_id: string }[]>`
          SELECT payer_id FROM agency_kyc WHERE payer_id = ANY(${[ids.G, ids.H]}::uuid[])`;
        expect(rows.map((r) => r.payer_id)).toEqual([ids.G]);
        const [evt] = await eventsNamed("agency_kyc.submitted", ids.G);
        expect(evt).toMatchObject({ actor_id: ids.G, payload: { payer_id: ids.G } });
        expect(await on.kyc.getOwnView(await on.scope(ids.G))).toMatchObject({ status: "pending" });
        expect(await on.kyc.getOwnView(await on.scope(ids.I))).toMatchObject({
          status: "not_submitted",
        });
      });

      it("earnings + payout: the unlock on the teammate-referred man earns for the ORG; the request claims it under the anchor and never the outsider's", async () => {
        expect(await on.kyc.verify(ids.G)).toEqual({ ok: true });
        // The outsider has a referral of its own: W3, through its own invite.
        const mintOfI = await on.agency.createInvite(ids.I, {}, P2D_CTX);
        expect(await on.agency.attributeWorkerToInvite(mintOfI.code, W3)).toEqual({ ok: true });
        // Paying parties unlock W1 (the org's referral) and W3 (the outsider's), after each was
        // attributed (granted inside the 90-day window).
        await client.sql`
          INSERT INTO unlocks (id, payer_id, worker_id, status, granted_at)
          VALUES (${UNLOCK_W1}::uuid, ${randomUUID()}::uuid, ${W1}::uuid, 'granted', now()),
                 (${UNLOCK_W3}::uuid, ${randomUUID()}::uuid, ${W3}::uuid, 'granted', now())`;

        // The outsider asks FIRST, while neither accrual exists: an accrual join that lost its
        // tenant predicate would hand the org's unlock to the outsider here (20, not 10).
        expect(await on.payouts.getEarnings(await on.scope(ids.I))).toMatchObject({
          totalAccruedInr: 10,
          accrualCount: 1,
        });
        const earnings = await on.payouts.getEarnings(await on.scope(ids.G));
        expect(earnings).toMatchObject({
          totalAccruedInr: 10,
          requestableInr: 10,
          accrualCount: 1,
          kycStatus: "verified",
          canRequest: true,
        });
        const [accrual] = await client.sql<{ agency_payer_id: string }[]>`
          SELECT agency_payer_id FROM agency_payout_accruals WHERE source_unlock_id = ${UNLOCK_W1}::uuid`;
        expect(accrual!.agency_payer_id).toBe(ids.G);
        const [accrualOfI] = await client.sql<{ agency_payer_id: string }[]>`
          SELECT agency_payer_id FROM agency_payout_accruals WHERE source_unlock_id = ${UNLOCK_W3}::uuid`;
        expect(accrualOfI!.agency_payer_id).toBe(ids.I);

        const out = await on.payouts.requestPayout(await on.scope(ids.G));
        expect(out).toMatchObject({ ok: true, amountInr: 10, accrualCount: 1 });
        const requestId = (out as { requestId: string }).requestId;
        const [req] = await client.sql<{ agency_payer_id: string }[]>`
          SELECT agency_payer_id FROM agency_payout_requests WHERE id = ${requestId}::uuid`;
        expect(req!.agency_payer_id).toBe(ids.G);
        const [evt] = await eventsNamed("agency_payout.requested", requestId);
        expect(evt).toMatchObject({ actor_id: ids.G, payload: { agency_payer_id: ids.G } });

        expect((await on.payouts.listRequests(await on.scope(ids.G))).map((r) => r.id)).toEqual([
          requestId,
        ]);
        expect(await on.payouts.listRequests(await on.scope(ids.I))).toEqual([]);
        // The org's claim took only its own accrual: the outsider's is still unclaimed.
        expect(await on.payouts.getEarnings(await on.scope(ids.I))).toMatchObject({
          totalAccruedInr: 10,
          requestableInr: 10,
          inRequestInr: 0,
          kycStatus: "not_submitted",
        });
      });
    });

    describe("mode off — today's behaviour exactly: the teammate is their own tenant", () => {
      it("invites: the teammate's mint is stamped with, and evented as, the login; it joins no org funnel", async () => {
        const mint = await off.agency.createInvite(ids.H, {}, P2D_CTX);
        expect(await inviteOwner(mint.agency_invite_id)).toBe(ids.H);
        const [evt] = await eventsNamed("agency_invite.created", mint.agency_invite_id);
        expect(evt).toMatchObject({ actor_id: ids.H, payload: { inviter_payer_id: ids.H } });
        // The anchor's funnel is the 6 org invites (5 still `created`, W1's now `accepted` and
        // floored to 0), unchanged by H's own; H's own (1) floors to 0.
        expect(await off.agency.referralsSummary(ids.G)).toMatchObject({ created: 5, accepted: 0 });
        expect(await off.agency.referralsSummary(ids.H)).toMatchObject({ created: 0 });
        expect(await off.agency.attributeWorkerToInvite(mint.code, W2)).toEqual({ ok: true });
      });

      it("referred workers: the teammate sees only the man THEIR invite brought in; the anchor's list and handles are what `on` serves", async () => {
        const asH = await off.workers.listReferred(ids.H);
        expect(asH.workers.map((w) => w.ref)).toEqual([
          off.pii.hmac(`agency_worker:${ids.H}:${W2}`).slice(0, 16),
        ]);
        expect(await off.workers.listReferred(ids.G)).toEqual(await on.workers.listReferred(ids.G));
      });

      it("KYC, earnings and payouts: the anchor reads exactly what `on` serves; the teammate reads only their own (nothing)", async () => {
        expect(await off.kyc.getOwnView(await off.scope(ids.G))).toEqual(
          await on.kyc.getOwnView(await on.scope(ids.G)),
        );
        expect(await off.payouts.listRequests(await off.scope(ids.G))).toEqual(
          await on.payouts.listRequests(await on.scope(ids.G)),
        );
        expect(await off.payouts.getEarnings(await off.scope(ids.G))).toEqual(
          await on.payouts.getEarnings(await on.scope(ids.G)),
        );
        expect(await off.kyc.getOwnView(await off.scope(ids.H))).toMatchObject({
          status: "not_submitted",
        });
        expect(await off.payouts.listRequests(await off.scope(ids.H))).toEqual([]);
        expect(await off.payouts.getEarnings(await off.scope(ids.H))).toMatchObject({
          totalAccruedInr: 0,
          kycStatus: "not_submitted",
        });
      });
    });
  },
);

/**
 * ADR-0053 Phase 2b — ONE ORG WALLET, against a real Postgres (plan §3.2 T6, §7 T7).
 *
 * The money properties that only Postgres can prove: the wallet row lock that serialises two
 * members' concurrent debits, the ledger reconciling per `payer_id` after mixed-member activity,
 * an order stamped at intent and settled (webhook and verify) into the wallet it names, the
 * unique (payer_id, worker_id) grant converging a teammate onto the org's existing unlock, and
 * the worker-protection cap counting distinct ORGS. Every story runs through the real services,
 * repositories and EventsService (payload validation included), in mode `on`, with the same
 * calls in mode `off` as the control where the two must differ.
 *
 * Fixtures: B buys a PERSONAL pack before joining A's org (owner ruling O-2: it stays B's and out
 * of view), so every "the org wallet paid" assertion is discriminating — had B's own wallet been
 * used, it had the credits to succeed. Synthetic `@e2e.badabhai.invalid` payers, `enc:`/`hash:`
 * worker markers, ids fresh per run, everything deleted in afterAll.
 */
describe.skipIf(!RUN)(
  "ADR-0053 P2b — one org wallet: unlocks, ledger, orders, disclosures, relay (Postgres)",
  () => {
    const W_TAG = randomUUID().slice(0, 8);
    const W_CTX: RequestContext = {
      correlationId: randomUUID(),
      requestId: `tenancy-p2b-${W_TAG}`,
    };
    const KEY_SECRET = "rzp_test_key_secret_p2b";

    let client!: DbClient;
    let pii!: PiiCryptoService;
    let payers!: PayersRepository;
    let orgsRepo!: PayerOrgsRepository;
    let members!: PayerOrgMembersService;
    let on!: {
      unlocks: UnlockService;
      tenancy: PayerTenantScopeService;
      disclosures: ResumeDisclosureService;
      relay: RelayService;
      postings: JobPostingsService;
    };
    let off!: {
      unlocks: UnlockService;
      tenancy: PayerTenantScopeService;
      disclosures: ResumeDisclosureService;
      relay: RelayService;
      postings: JobPostingsService;
    };
    /** A's company posting — the page the postings list counts downloads for. */
    let postingOfA = "";
    /** An org unlock B revealed, and the relay handle B kept, while still a member. */
    let keptOrgUnlockId = "";
    let keptHandle = "";

    const payerIds: string[] = [];
    const workerIds: string[] = [];
    const acceptUrls: string[] = [];
    let A = ""; // anchor of the org
    let B = ""; // active recruiter in A's org, with a personal pre-team balance
    let C = ""; // solo outsider
    let D = ""; // solo, for the cap story
    let orgOfA!: ResolvedOrg;
    let memberIdOfB = "";
    let bPersonal = 0;

    async function signUp(label: string): Promise<string> {
      const { id } = await payers.createOrGet({
        role: "employer",
        email: `p2b-${label}-${W_TAG}@e2e.badabhai.invalid`,
        orgName: `P2b ${W_TAG}`,
        phone: undefined,
      });
      await orgsRepo.ensureSoloOrg(id);
      await payers.activate(id);
      payerIds.push(id);
      return id;
    }

    /**
     * A consented worker — both employer purposes, so the relay ladder can open too. The phone is
     * a reserved synthetic number (`+9100000…`, unassignable) ENCRYPTED by the real crypto: the
     * reveal decrypts it once to wire the relay, and a marker string would fail that decrypt.
     */
    async function worker(
      purposes: string[] = ["profiling", "employer_sharing", "employer_messaging"],
    ): Promise<string> {
      const id = randomUUID();
      const phone = `+9100000${String(workerIds.length).padStart(5, "0")}`;
      await client.sql`
      INSERT INTO workers (id, phone_e164, phone_hash, status)
      VALUES (${id}::uuid, ${pii.encrypt(phone)}, ${`hash:p2b-${W_TAG}-${id}`}, 'active')`;
      await client.sql`
      INSERT INTO worker_consents (worker_id, consent_version, purposes, accepted_at)
      VALUES (${id}::uuid, '2026-06-01', ${JSON.stringify(purposes)}::jsonb, now())`;
      workerIds.push(id);
      return id;
    }

    async function balanceOf(payerId: string): Promise<number> {
      const [row] =
        await client.sql`SELECT balance FROM payer_credits WHERE payer_id = ${payerId}::uuid`;
      return Number(row?.balance ?? 0);
    }

    /** ADR-0053 §6: `payer_credits.balance = Σ credit_ledger.delta` per `payer_id`. */
    async function expectReconciled(payerId: string): Promise<void> {
      const [row] = await client.sql`
      SELECT coalesce((SELECT balance FROM payer_credits WHERE payer_id = ${payerId}::uuid), 0)::int AS balance,
             coalesce((SELECT sum(delta) FROM credit_ledger WHERE payer_id = ${payerId}::uuid), 0)::int AS ledger`;
      expect(Number(row?.ledger), `ledger of ${payerId}`).toBe(Number(row?.balance));
    }

    /** A credited wallet with its ledger line, exactly as an ops grant writes it (reconciled). */
    async function grantCredits(payerId: string, credits: number): Promise<void> {
      await client.sql`
      INSERT INTO payer_credits (payer_id, balance) VALUES (${payerId}::uuid, ${credits})
      ON CONFLICT (payer_id) DO UPDATE SET balance = payer_credits.balance + ${credits}`;
      await client.sql`
      INSERT INTO credit_ledger (payer_id, delta, reason) VALUES (${payerId}::uuid, ${credits}, 'grant')`;
    }

    async function eventOf(
      name: string,
      key: string,
      value: string,
    ): Promise<{ actor_id: string; payload: Record<string, unknown> }> {
      const [row] = await client.sql`
      SELECT actor_id, payload FROM events
      WHERE correlation_id = ${W_CTX.correlationId}::uuid AND event_name = ${name}
        AND payload->>${key} = ${value}
      ORDER BY created_at DESC LIMIT 1`;
      expect(row, `${name} with ${key}=${value}`).toBeDefined();
      return { actor_id: String(row!.actor_id), payload: row!.payload as Record<string, unknown> };
    }

    /** The real services for one mode, sharing the database, the crypto and the event spine. */
    function build(config: ServerConfig, pii: PiiCryptoService, events: EventsService) {
      const tenancy = new PayerTenantScopeService(config, orgsRepo);
      const repo = new UnlocksRepository(client.db);
      const pricing = {
        getActiveCatalog: async () => ({
          catalog: DEFAULT_CATALOG,
          revision: 1,
          source: "db" as const,
        }),
      };
      const razorpay = {
        isLive: true,
        keyId: "rzp_test_p2b",
        createOrder: async ({ amountInr }: { amountInr: number }) => ({
          orderId: `order_${randomUUID().replace(/-/g, "").slice(0, 14)}`,
          amountPaise: amountInr * 100,
          currency: "INR",
        }),
      };
      const gateway = new PaymentGateway(repo, config, pricing as never, razorpay as never);
      const unlocks = new UnlockService(
        repo,
        new ConsentRepository(client.db),
        new WorkersRepository(client.db),
        pii,
        gateway,
        events,
        config,
        { add: async () => undefined } as never,
        { get: async () => DEFAULT_MATCH_CONFIG } as never,
        payers,
        tenancy,
      );
      const disclosures = new ResumeDisclosureService(
        new ResumeDisclosureRepository(client.db),
        new ConsentRepository(client.db),
        new WorkersRepository(client.db),
        pii,
        {} as never, // ResumeRenderer — the deny path renders nothing
        {} as never, // StorageService — likewise
        {} as never,
        {} as never,
        {} as never,
        {} as never,
        events,
        config,
        tenancy,
      );
      const relay = new RelayService(new RelayRepository(client.db), unlocks, events, tenancy);
      const postings = new JobPostingsService(
        new JobPostingsRepository(client.db),
        events,
        {} as never, // AiService — no skill phrases, so canonicalization returns before any call
        {} as never, // AiCostRecorder — likewise
        {} as never, // AiTraceRecorder — likewise
        {} as never, // PublishReachService — a draft never materializes reach
        {} as never, // MatchSkillsService — no match_skill_ids on this create
        tenancy,
      );
      return { unlocks, tenancy, disclosures, relay, postings };
    }

    beforeAll(async () => {
      client = createDbClient(DATABASE_URL, { max: 6 });
      const base = {
        NODE_ENV: "test",
        UNLOCK_LATENCY_TARGET_MS: "0",
        // T7: a cap of TWO distinct payers per worker per week makes the org-vs-login count visible.
        UNLOCK_MAX_PAYERS_PER_WORKER_PER_WEEK: "2",
        PAYMENTS_ENABLE_REAL: "true",
        PAYMENTS_PROVIDER_KEY: "rzp_test_p2b",
        PAYMENTS_PROVIDER_SECRET: KEY_SECRET,
        RAZORPAY_WEBHOOK_SECRET: "whsec_p2b",
      };
      const cfgOn = loadServerConfig({ ...base, PAYER_ORG_TENANCY_MODE: "on" });
      const cfgOff = loadServerConfig({ ...base, PAYER_ORG_TENANCY_MODE: "off" });
      pii = new PiiCryptoService(cfgOn);
      const events = new EventsService(new EventsRepository(client.db), cfgOn);
      payers = new PayersRepository(client.db, pii);
      orgsRepo = new PayerOrgsRepository(client.db);
      members = new PayerOrgMembersService(orgsRepo, pii, events, payers, cfgOn, {
        send: async ({ acceptUrl }: { email: string; acceptUrl: string }) => {
          acceptUrls.push(acceptUrl);
        },
      });
      on = build(cfgOn, pii, events);
      off = build(cfgOff, pii, events);

      A = await signUp("a");
      B = await signUp("b");
      C = await signUp("c");
      D = await signUp("d");

      // B buys a PERSONAL pack while still solo (O-2: it stays B's own wallet after joining).
      bPersonal = (await on.unlocks.purchaseCredits(B, "pack_50", W_CTX))!.balance;
      expect(bPersonal).toBe(50);

      // A invites B; B accepts (the real invite + accept, A1–A3 included).
      const resolvedA = await on.tenancy.resolveActingOrg(A);
      if (!resolvedA) throw new Error("fixture: A has no org");
      orgOfA = resolvedA;
      await members.invite(
        orgOfA,
        A,
        { email: `p2b-b-${W_TAG}@e2e.badabhai.invalid`, org_role: "recruiter" },
        W_CTX,
      );
      const token = new URL(acceptUrls.at(-1)!).searchParams.get("token");
      if (!token) throw new Error("fixture: no accept token");
      memberIdOfB = (await members.accept(B, { token }, W_CTX)).member_id;

      // The org wallet (A's existing row) and the outsiders' own wallets.
      await on.unlocks.purchaseCredits(A, "pack_50", W_CTX);
      await on.unlocks.purchaseCredits(C, "pack_50", W_CTX);
      await on.unlocks.purchaseCredits(D, "pack_50", W_CTX);

      // A's company posting (fixed text — a hex TAG can trip the posting's contact screen).
      const dto = PayerCreateJobPostingSchema.parse({
        org_label: "Tenancy Org",
        role_title: "CNC Turner",
        vacancy_band: "1",
      });
      postingOfA = (await on.postings.createForPayer(A, dto, W_CTX)).id;
    }, 90_000);

    afterAll(async () => {
      if (!client) return;
      const { sql } = client;
      await sql`DELETE FROM resume_disclosures WHERE payer_id = ANY(${payerIds}::uuid[])`;
      await sql`DELETE FROM unlocks WHERE payer_id = ANY(${payerIds}::uuid[])`;
      await sql`DELETE FROM payment_orders WHERE payer_id = ANY(${payerIds}::uuid[])`;
      await sql`DELETE FROM credit_ledger WHERE payer_id = ANY(${payerIds}::uuid[])`;
      await sql`DELETE FROM payer_credits WHERE payer_id = ANY(${payerIds}::uuid[])`;
      await sql`DELETE FROM events WHERE correlation_id = ${W_CTX.correlationId}::uuid`;
      await sql`DELETE FROM workers WHERE id = ANY(${workerIds}::uuid[])`;
      await sql`DELETE FROM job_postings WHERE payer_id = ANY(${payerIds}::uuid[]) OR created_by = ANY(${payerIds}::uuid[])`;
      await sql`DELETE FROM payer_orgs WHERE root_payer_id = ANY(${payerIds}::uuid[])`;
      await sql`DELETE FROM payers WHERE id = ANY(${payerIds}::uuid[])`;
      await sql.end({ timeout: 5 });
    });

    it("setup: mode `on` keys B to A, `off` keys B to B — and B's personal pre-team wallet exists", async () => {
      expect((await on.tenancy.resolve(B)).tenantKey).toBe(A);
      expect((await off.tenancy.resolve(B)).tenantKey).toBe(B);
      expect(await balanceOf(B)).toBe(50);
    });

    it("O-1/O-2: a teammate reads the ORG wallet, never their personal balance; `off` reads their own", async () => {
      const org = await balanceOf(A);
      expect(org).toBeGreaterThan(0);
      expect(await on.unlocks.getCredits(B)).toEqual({ payer_id: B, balance: org });
      expect((await off.unlocks.getCredits(B)).balance).toBe(bPersonal);
      // The outsider sees only their own.
      expect((await on.unlocks.getCredits(C)).balance).toBe(await balanceOf(C));
    });

    it("a teammate's purchase credits the ORG wallet; every wallet still reconciles (Σ ledger = balance)", async () => {
      const before = await balanceOf(A);
      const out = await on.unlocks.purchaseCredits(B, "pack_50", W_CTX);
      expect(out).toMatchObject({ payer_id: B, balance: before + 50, credits: 50 });
      expect(await balanceOf(A)).toBe(before + 50);
      expect(await balanceOf(B)).toBe(bPersonal);
      for (const p of [A, B, C, D]) await expectReconciled(p);
      // The teammate's own ledger view is the org's.
      const ledger = await on.unlocks.getCreditLedger(B, 50);
      expect(ledger.payer_id).toBe(B);
      expect(ledger.ledger.reduce((s, l) => s + l.delta, 0)).toBe(await balanceOf(A));
    });

    it("a teammate's unlock spends the ORG wallet; the anchor sees it; the outsider does not; events name actor + org", async () => {
      const w = await worker();
      const orgBefore = await balanceOf(A);
      const grant = await on.unlocks.requestUnlock(
        { payerId: B, workerId: w, jobId: null },
        W_CTX,
        "payer_owned",
      );
      expect(grant).toMatchObject({ ok: true, status: "granted" });
      const unlockId = (grant as { unlock_id: string }).unlock_id;

      expect(await balanceOf(A)).toBe(orgBefore - 1);
      expect(await balanceOf(B)).toBe(bPersonal);
      const [row] = await client.sql`SELECT payer_id FROM unlocks WHERE id = ${unlockId}::uuid`;
      expect(String(row?.payer_id)).toBe(A);

      expect((await on.unlocks.listOwnForPayer(A)).unlocks.map((u) => u.unlock_id)).toContain(
        unlockId,
      );
      expect((await on.unlocks.listOwnForPayer(B)).unlocks.map((u) => u.unlock_id)).toContain(
        unlockId,
      );
      expect((await on.unlocks.listOwnForPayer(C)).unlocks.map((u) => u.unlock_id)).not.toContain(
        unlockId,
      );

      const granted = await eventOf("unlock.granted", "unlock_id", unlockId);
      expect(granted.actor_id).toBe(B);
      expect(granted.payload.payer_id).toBe(A);
      for (const p of [A, B]) await expectReconciled(p);
    });

    it("T6: the ORG already holds the worker — a teammate gets the org's grant back and is charged nothing", async () => {
      const w = await worker();
      const first = await on.unlocks.requestUnlock({ payerId: A, workerId: w, jobId: null }, W_CTX);
      const orgAfterFirst = await balanceOf(A);
      const again = await on.unlocks.requestUnlock({ payerId: B, workerId: w, jobId: null }, W_CTX);
      expect((again as { unlock_id: string }).unlock_id).toBe(
        (first as { unlock_id: string }).unlock_id,
      );
      expect(await balanceOf(A)).toBe(orgAfterFirst);
      expect(await balanceOf(B)).toBe(bPersonal);
      const [count] =
        await client.sql`SELECT count(*)::int AS n FROM unlocks WHERE worker_id = ${w}::uuid`;
      expect(Number(count?.n)).toBe(1);
    });

    it("a teammate may reveal the ORG's unlock and use its relay thread; an outsider gets the neutral body", async () => {
      const w = await worker();
      const grant = await on.unlocks.requestUnlock({ payerId: A, workerId: w, jobId: null }, W_CTX);
      const unlockId = (grant as { unlock_id: string }).unlock_id;

      const revealed = await on.unlocks.reveal(unlockId, W_CTX, B);
      expect(revealed).toMatchObject({ channel: "in_app_relay" });
      const handle = (revealed as { relay_handle: string }).relay_handle;
      keptOrgUnlockId = unlockId;
      keptHandle = handle;
      expect(await on.unlocks.reveal(unlockId, W_CTX, C)).toEqual({ status: "unavailable" });
      // `off`: B is not A's org — the same reveal is the neutral body.
      expect(await off.unlocks.reveal(unlockId, W_CTX, B)).toEqual({ status: "unavailable" });

      expect(await on.relay.readThreadForPayer(B, handle)).toEqual({ messages: [] });
      expect(await on.relay.readThreadForPayer(C, handle)).toEqual({ status: "unavailable" });

      const event = await eventOf("contact.revealed", "unlock_id", unlockId);
      expect(event.actor_id).toBe(B);
      expect(event.payload.payer_id).toBe(A);
    });

    it("T6: two members spending CONCURRENTLY serialize on the one org wallet row — exactly one wins, never overdrawn", async () => {
      // A fresh org whose wallet holds exactly ONE credit, and a teammate whose own wallet holds
      // plenty: had either debit hit the teammate's personal wallet, both would succeed.
      const A2 = await signUp("a2");
      const B2 = await signUp("b2");
      await grantCredits(B2, 10);
      const org2 = await on.tenancy.resolveActingOrg(A2);
      await members.invite(
        org2!,
        A2,
        { email: `p2b-b2-${W_TAG}@e2e.badabhai.invalid`, org_role: "recruiter" },
        W_CTX,
      );
      const token = new URL(acceptUrls.at(-1)!).searchParams.get("token")!;
      await members.accept(B2, { token }, W_CTX);
      await grantCredits(A2, 1);

      const [w1, w2] = [await worker(), await worker()];
      const results = await Promise.all([
        on.unlocks.requestUnlock({ payerId: A2, workerId: w1, jobId: null }, W_CTX),
        on.unlocks.requestUnlock({ payerId: B2, workerId: w2, jobId: null }, W_CTX),
      ]);
      expect(results.filter((r) => (r as { ok?: boolean }).ok === true)).toHaveLength(1);
      expect(
        results.filter((r) => (r as { status?: string }).status === "unavailable"),
      ).toHaveLength(1);
      expect(await balanceOf(A2)).toBe(0);
      expect(await balanceOf(B2)).toBe(10);
      await expectReconciled(A2);
      await expectReconciled(B2);
    });

    it("T7 (O-3): the worker cap counts distinct ORGS in `on` — distinct LOGINS in `off`", async () => {
      // Cap = 2 distinct payers per worker per week (config above). The TEAMMATE unlocks first, so
      // the count depends on what the grant was stamped with: had B's row carried B's own id, A's
      // request would write a second row and C would already be the third payer.
      const w = await worker();
      expect(
        await on.unlocks.requestUnlock({ payerId: B, workerId: w, jobId: null }, W_CTX),
      ).toMatchObject({ ok: true });
      expect(
        await on.unlocks.requestUnlock({ payerId: A, workerId: w, jobId: null }, W_CTX),
      ).toMatchObject({ ok: true }); // the org's grant
      expect(
        await on.unlocks.requestUnlock({ payerId: C, workerId: w, jobId: null }, W_CTX),
      ).toMatchObject({ ok: true }); // org #2
      expect(
        await on.unlocks.requestUnlock({ payerId: D, workerId: w, jobId: null }, W_CTX),
      ).toEqual({ status: "unavailable" }); // org #3: capped

      const v = await worker();
      expect(
        await off.unlocks.requestUnlock({ payerId: A, workerId: v, jobId: null }, W_CTX),
      ).toMatchObject({ ok: true });
      expect(
        await off.unlocks.requestUnlock({ payerId: B, workerId: v, jobId: null }, W_CTX),
      ).toMatchObject({ ok: true }); // B's own row
      bPersonal -= 1; // `off`: B paid from their own wallet
      expect(await balanceOf(B)).toBe(bPersonal);
      expect(
        await off.unlocks.requestUnlock({ payerId: C, workerId: v, jobId: null }, W_CTX),
      ).toEqual({ status: "unavailable" }); // capped at 2 logins
    });

    it("an order a teammate creates is stamped with the ORG wallet and settles into it — by webhook, and by the anchor's verify", async () => {
      const before = await balanceOf(A);
      const order1 = await on.unlocks.createCreditOrder(B, "pack_50", W_CTX);
      const [stamp] =
        await client.sql`SELECT payer_id FROM payment_orders WHERE id = ${order1!.orderRowId}::uuid`;
      expect(String(stamp?.payer_id)).toBe(A);
      expect(
        await on.unlocks.handleRazorpayEvent(
          {
            eventName: "payment.captured",
            paymentId: `pay_${W_TAG}1`,
            orderId: order1!.providerOrderId,
          },
          W_CTX,
        ),
      ).toEqual({ result: "granted" });
      expect(await balanceOf(A)).toBe(before + 50);

      const order2 = await on.unlocks.createCreditOrder(B, "pack_50", W_CTX);
      const pay2 = `pay_${W_TAG}2`;
      const signature = signCheckoutForTest(order2!.providerOrderId, pay2, KEY_SECRET);
      // An outsider holding a valid signature cannot settle the org's order (byte-identical refusal).
      expect(
        await on.unlocks.verifyCheckoutPayment(
          C,
          { orderId: order2!.providerOrderId, paymentId: pay2, signature },
          W_CTX,
        ),
      ).toEqual({ verified: false });
      expect(
        await on.unlocks.verifyCheckoutPayment(
          A,
          { orderId: order2!.providerOrderId, paymentId: pay2, signature },
          W_CTX,
        ),
      ).toMatchObject({ verified: true, payer_id: A, balance: before + 100, credits: 50 });
      expect(await balanceOf(B)).toBe(bPersonal);
      for (const p of [A, B, C]) await expectReconciled(p);
    });

    it("an order created BEFORE the flip settles into the wallet it was created for (never re-resolved)", async () => {
      const orgBefore = await balanceOf(A);
      const preFlip = await off.unlocks.createCreditOrder(B, "pack_50", W_CTX); // stamped: B
      expect(
        await on.unlocks.handleRazorpayEvent(
          {
            eventName: "payment.captured",
            paymentId: `pay_${W_TAG}3`,
            orderId: preFlip!.providerOrderId,
          },
          W_CTX,
        ),
      ).toEqual({ result: "granted" });
      bPersonal += 50;
      expect(await balanceOf(B)).toBe(bPersonal);
      expect(await balanceOf(A)).toBe(orgBefore);
      await expectReconciled(B);
    });

    it("disclosures: a teammate's row is stamped with the ORG; the org lists it, the outsider and `off` do not", async () => {
      const w = await worker(["profiling"]); // no employer_sharing → the deny row path (no render)
      expect(
        await on.disclosures.requestDisclosure(
          { payerId: B, workerId: w, jobPostingId: null },
          W_CTX,
          "payer_owned",
        ),
      ).toEqual({ status: "unavailable" });
      const [row] =
        await client.sql`SELECT payer_id, status FROM resume_disclosures WHERE worker_id = ${w}::uuid`;
      expect(row).toMatchObject({ payer_id: A, status: "denied" });
      const listed = (p: string, svc: ResumeDisclosureService) =>
        svc.listByPayer(p).then((r) => r.disclosures.map((d) => d.worker_id));
      expect(await listed(A, on.disclosures)).toContain(w);
      expect(await listed(B, on.disclosures)).toContain(w);
      expect(await listed(C, on.disclosures)).not.toContain(w);
      expect(await listed(B, off.disclosures)).not.toContain(w);
    });

    it("the postings page's download counts are the ORG's, read in one grouped query; denied rows and other tenants' downloads never count", async () => {
      /** A disclosure row for A's posting under `payerId`, completed (downloaded) or denied. */
      async function disclosure(payerId: string, downloaded: boolean): Promise<void> {
        const w = await worker();
        await client.sql`
          INSERT INTO resume_disclosures (payer_id, worker_id, job_posting_id, status, deny_reason,
                                          disclosed_at, expires_at)
          VALUES (${payerId}::uuid, ${w}::uuid, ${postingOfA}::uuid,
                  ${downloaded ? "disclosed" : "denied"}, ${downloaded ? null : "capped"},
                  CASE WHEN ${downloaded}::boolean THEN now() END,
                  CASE WHEN ${downloaded}::boolean THEN now() + interval '1 hour' END)`;
      }
      await disclosure(A, true);
      await disclosure(A, true);
      await disclosure(A, false); // a denied request is not a download
      await disclosure(C, true); // another tenant's row on the same posting id

      const unknown = randomUUID();
      // Each read takes the scope its caller resolved (the posting seam resolves once per request).
      const asB = await on.tenancy.resolve(B);
      // `on`: the teammate counts the ORG's two downloads; an id the page holds but nobody
      // disclosed for reads 0.
      expect(await on.disclosures.countDownloadsInScope([postingOfA, unknown], asB)).toEqual(
        new Map([
          [postingOfA, 2],
          [unknown, 0],
        ]),
      );
      // The single-posting read agrees with the page read.
      expect(await on.disclosures.countDownloadsForPostingInScope(postingOfA, asB)).toBe(2);
      // The outsider counts only its own row; `off` keys the teammate to themself (0).
      const asC = await on.tenancy.resolve(C);
      expect((await on.disclosures.countDownloadsInScope([postingOfA], asC)).get(postingOfA)).toBe(
        1,
      );
      const asBOff = await off.tenancy.resolve(B);
      expect(
        (await off.disclosures.countDownloadsInScope([postingOfA], asBOff)).get(postingOfA),
      ).toBe(0);
    });

    it("removal: on the very next call the former teammate is back on their personal wallet and sees none of the org's rows", async () => {
      await members.remove(orgOfA, A, memberIdOfB, W_CTX);
      expect((await on.tenancy.resolve(B)).tenantKey).toBe(B);
      expect(await on.unlocks.getCredits(B)).toEqual({ payer_id: B, balance: bPersonal });
      const [orgUnlocks] =
        await client.sql`SELECT count(*)::int AS n FROM unlocks WHERE payer_id = ${A}::uuid`;
      expect(Number(orgUnlocks?.n)).toBeGreaterThan(0);
      const mine = await on.unlocks.listOwnForPayer(B);
      const [bRows] =
        await client.sql`SELECT count(*)::int AS n FROM unlocks WHERE payer_id = ${B}::uuid AND status IN ('granted','revealed')`;
      expect(mine.unlocks).toHaveLength(Number(bRows?.n));
      expect((await on.disclosures.listByPayer(B)).disclosures).toEqual([]);

      // A handle and an unlock id B KEPT from membership open nothing now (PR #2171 review,
      // security L1): the reveal and both relay routes answer the one neutral body, and no
      // message is written.
      expect(keptOrgUnlockId).not.toBe("");
      const neutral = { status: "unavailable" };
      expect(await on.unlocks.reveal(keptOrgUnlockId, W_CTX, B)).toEqual(neutral);
      expect(await on.relay.readThreadForPayer(B, keptHandle)).toEqual(neutral);
      expect(
        await on.relay.sendFromPayer(
          B,
          keptHandle,
          { kind: "template", template_id: "availability", params: {} },
          W_CTX,
        ),
      ).toEqual(neutral);
      const [sent] = await client.sql`
        SELECT count(*)::int AS n FROM relay_messages WHERE unlock_id = ${keptOrgUnlockId}::uuid`;
      expect(Number(sent?.n)).toBe(0);
      // The anchor still holds the thread (control: the handle itself is live).
      expect(await on.relay.readThreadForPayer(A, keptHandle)).toEqual({ messages: [] });
    });
  },
);
