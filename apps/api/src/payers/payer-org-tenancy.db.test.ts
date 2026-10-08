import "reflect-metadata";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadServerConfig, type ServerConfig } from "@badabhai/config";
import { CREDIT_PACKS, createDbClient, type DbClient } from "@badabhai/db";
import type { RequestContext } from "../common/request-context";
import { PiiCryptoService } from "../common/pii-crypto.service";
import { EventsRepository } from "../events/events.repository";
import { EventsService } from "../events/events.service";
import { ConsentRepository } from "../consent/consent.repository";
import { WorkersRepository } from "../workers/workers.repository";
import { JobPostingsRepository } from "../job-postings/job-postings.repository";
import { JobPostingsService } from "../job-postings/job-postings.service";
import { PayerCreateJobPostingSchema } from "../job-postings/job-postings.dto";
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
