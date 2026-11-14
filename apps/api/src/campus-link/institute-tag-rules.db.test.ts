import { randomInt, randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import {
  applications,
  createDbClient,
  events,
  jobPostings,
  payers,
  workerConsents,
  workerCredentials,
  workerInstituteLinks,
  workerSkills,
  workers,
  type DbClient,
} from "@badabhai/db";
import type { RequestContext } from "../common/request-context";
import type { PayerOrgsRepository } from "../payers/payer-orgs.repository";
import type { TenantKey } from "../payers/payer-tenant-scope";
import { PayerTenantScopeService } from "../payers/payer-tenant-scope.service";
import { PiiCryptoService } from "../common/pii-crypto.service";
import { CandidateSearchRepository } from "../candidates/candidate-search.repository";
import { ConsentRepository } from "../consent/consent.repository";
import { EventsRepository } from "../events/events.repository";
import { EventsService } from "../events/events.service";
import { WorkersRepository } from "../workers/workers.repository";
import { InstituteAiGate, InstituteAiRefusedError } from "./institute-ai-gate.service";
import { InstituteLinkRepository } from "./institute-link.repository";
import { InstituteLinkService } from "./institute-link.service";
import { InstituteOpenGate } from "./institute-open-gate.service";
import {
  RvmStudentApiUnavailableError,
  type RvmStudentApiClient,
  type RvmStudentLookup,
  type RvmStudentRead,
} from "./rvm-student-api.client";

/**
 * #2752 part C — the tag rules' POSTGRES contract:
 *   - the open gate: not linked → the caller's own rule; linked → open only for a company he
 *     applied to, with his RVM consent fresh or re-read; an RVM refusal withdraws the link and
 *     never deletes, an outage ends nothing; both refuse the open; a refusal older than a newer
 *     confirmation stands down;
 *   - unlink (Campus's request): a link-created row he never used as an account (no consent,
 *     PIN or device) is deleted with his applications; anyone else keeps his row and loses only the
 *     copied facts; a repeat or an unknown reference does nothing; one ids-only
 *     `worker.institute_unlinked` per unlink;
 *   - company search leaves out an actively linked student even when he holds BadaBhai's own
 *     consent and a wanted skill, and lets him back once the link is withdrawn.
 */
const RUN = process.env.RUN_DB_TESTS === "1";
const DATABASE_URL =
  process.env.E2E_DATABASE_URL ??
  process.env.DATABASE_URL ??
  "postgresql://badabhai:badabhai@localhost:5432/badabhai";

function assertLocalDatabase(url: string): void {
  const host = new URL(url).hostname;
  if (!["localhost", "127.0.0.1", "::1", "[::1]"].includes(host)) {
    throw new Error(`institute-tag-rules.db refuses to write to a non-local host (${host})`);
  }
}

const CTX: RequestContext = { correlationId: randomUUID(), requestId: "institute-tag-rules-db" };
const RECHECK_SECONDS = 300;
const TAG = randomUUID().slice(0, 8);

const phone10 = () => `9${String(randomInt(0, 1_000_000_000)).padStart(9, "0")}`;

function student(overrides: Partial<RvmStudentRead> = {}): RvmStudentRead {
  return {
    name: "Test Student",
    phone: phone10(),
    course: "CNC Programming",
    branch: "Faridabad",
    status: "current_student",
    test_score: 72.5,
    ...overrides,
  };
}

interface Company {
  payerId: string;
  postingId: string;
  tenant: TenantKey;
}

describe.skipIf(!RUN)("#2752 tag rules — against Postgres", () => {
  let client!: DbClient;
  let pii!: PiiCryptoService;
  let workersRepo!: WorkersRepository;
  let links!: InstituteLinkService;
  let gate!: InstituteOpenGate;
  let search!: CandidateSearchRepository;
  /** What the fake Student API answers next, per reference; every read is counted. */
  const answers = new Map<string, RvmStudentLookup | Error>();
  const reads: string[] = [];
  const touchedWorkers = new Set<string>();
  const touchedPayers: string[] = [];
  /** A company that owns one open posting, and one that owns another. */
  let companyA!: Company;
  let companyB!: Company;
  /** The real resolver in mode `off` (no memberships), so a tenant key is never minted by hand. */
  const tenancy = new PayerTenantScopeService(
    { PAYER_ORG_TENANCY_MODE: "off" } as never,
    {
      listActiveMembershipsWithAnchor: async () => [],
      ensureSoloOrg: async () => null,
    } as unknown as PayerOrgsRepository,
  );

  async function company(label: string): Promise<Company> {
    const [payer] = await client.db
      .insert(payers)
      .values({
        role: "employer",
        emailEnc: `enc:2752c-${label}-${TAG}`,
        emailHash: `hash:2752c-${label}-${TAG}`,
        orgNameEnc: `enc:company-${label}-${TAG}`,
        status: "active",
      })
      .returning({ id: payers.id });
    touchedPayers.push(payer!.id);
    const [posting] = await client.db
      .insert(jobPostings)
      .values({
        createdBy: payer!.id,
        payerId: payer!.id,
        orgLabel: `Company ${label} ${TAG}`,
        roleTitle: "CNC Operator",
        vacancyBand: "2-5",
        status: "open",
      })
      .returning({ id: jobPostings.id });
    const { tenantKey } = await tenancy.resolve(payer!.id);
    return { payerId: payer!.id, postingId: posting!.id, tenant: tenantKey };
  }

  beforeAll(async () => {
    assertLocalDatabase(DATABASE_URL);
    client = createDbClient(DATABASE_URL, { max: 4 });
    const eventsService = new EventsService(new EventsRepository(client.db), {
      NODE_ENV: "test",
    } as never);
    pii = new PiiCryptoService({
      PII_HASH_PEPPER: "institute-tag-rules-test-pepper",
      PII_ENCRYPTION_KEY: Buffer.alloc(32, 7).toString("base64"),
      PIN_PEPPER: "institute-tag-rules-test-pin",
    } as never);
    workersRepo = new WorkersRepository(client.db);
    const rvm = {
      readStudent: async (ref: string) => {
        reads.push(ref);
        const answer = answers.get(ref);
        if (answer === undefined) throw new Error(`no fake answer for ${ref}`);
        if (answer instanceof Error) throw answer;
        return answer;
      },
    } as unknown as RvmStudentApiClient;
    const repo = new InstituteLinkRepository(client.db);
    links = new InstituteLinkService(repo, workersRepo, rvm, pii, eventsService, {
      RVM_CONSENT_RECHECK_SECONDS: RECHECK_SECONDS,
    } as never);
    gate = new InstituteOpenGate(repo, links);
    search = new CandidateSearchRepository(client.db);
    companyA = await company("a");
    companyB = await company("b");
  });

  afterAll(async () => {
    if (!client) return;
    try {
      await client.sql`DELETE FROM events WHERE correlation_id = ${CTX.correlationId}::uuid`;
      for (const id of touchedWorkers) {
        await client.sql`DELETE FROM audit_logs WHERE entity_id = ${id}::uuid`;
        await client.sql`DELETE FROM workers WHERE id = ${id}::uuid`;
      }
      for (const id of touchedPayers) {
        await client.sql`DELETE FROM unlocks WHERE payer_id = ${id}::uuid`;
        await client.sql`DELETE FROM job_postings WHERE payer_id = ${id}::uuid`;
        await client.sql`DELETE FROM payers WHERE id = ${id}::uuid`;
      }
    } finally {
      await client.sql.end({ timeout: 5 });
    }
  });

  /** Links a fresh consenting student; his link is confirmed now. */
  async function linkedStudent(s: RvmStudentRead = student()) {
    const ref = randomUUID();
    answers.set(ref, { kind: "available", student: s });
    const linked = await links.linkStudent(ref, CTX);
    touchedWorkers.add(linked.workerId);
    return { ref, workerId: linked.workerId, student: s };
  }

  /** A worker who signed up in the worker app himself, with the phone given. */
  async function ownWorker(p10: string) {
    const row = await workersRepo.create({
      phoneE164: pii.encrypt(`+91${p10}`),
      phoneHash: pii.hashPhone(`+91${p10}`),
      fullName: pii.encrypt("His Own Name"),
      status: "active",
    });
    touchedWorkers.add(row.id);
    return row;
  }

  const applyTo = (workerId: string, postingId: string) =>
    client.db.insert(applications).values({ jobPostingId: postingId, workerId, action: "applied" });

  /** Makes his last RVM confirmation older than the re-check window. */
  const ageConfirmation = (workerId: string) =>
    client.db
      .update(workerInstituteLinks)
      .set({ syncedAt: new Date(Date.now() - (RECHECK_SECONDS + 60) * 1000) })
      .where(eq(workerInstituteLinks.workerId, workerId));

  const linkOf = async (workerId: string) =>
    (
      await client.db
        .select()
        .from(workerInstituteLinks)
        .where(eq(workerInstituteLinks.workerId, workerId))
    )[0];
  const workerOf = async (workerId: string) =>
    (await client.db.select().from(workers).where(eq(workers.id, workerId)))[0];
  const unlinkedEvents = (workerId: string) =>
    client.db
      .select()
      .from(events)
      .where(
        and(eq(events.subjectId, workerId), eq(events.eventName, "worker.institute_unlinked")),
      );

  describe("the open gate", () => {
    it("leaves a worker who is not linked to the caller's own rule", async () => {
      const own = await ownWorker(phone10());

      expect(await gate.decide(own.id, { tenant: companyA.tenant }, CTX)).toBe("not_linked");
    });

    it("is closed to a company he never applied to, without asking RVM", async () => {
      const { workerId, ref } = await linkedStudent();
      await applyTo(workerId, companyA.postingId);
      await ageConfirmation(workerId);

      expect(await gate.decide(workerId, { tenant: companyB.tenant }, CTX)).toBe("closed");
      expect(reads.filter((r) => r === ref)).toHaveLength(1); // the link's own read only
    });

    it("opens for the company he applied to while his confirmation is fresh, without asking RVM", async () => {
      const { workerId, ref } = await linkedStudent();
      await applyTo(workerId, companyA.postingId);

      expect(await gate.decide(workerId, { tenant: companyA.tenant }, CTX)).toBe("open");
      expect(reads.filter((r) => r === ref)).toHaveLength(1);
    });

    it("on a reveal, opens only for the company that holds the unlock, read from the unlock row", async () => {
      const { workerId } = await linkedStudent();
      await applyTo(workerId, companyA.postingId);
      const [held, other] = await client.sql<{ id: string }[]>`
        INSERT INTO unlocks (payer_id, worker_id, status, granted_at, expires_at) VALUES
          (${companyA.payerId}::uuid, ${workerId}::uuid, 'granted', now(), now() + interval '14 days'),
          (${companyB.payerId}::uuid, ${workerId}::uuid, 'granted', now(), now() + interval '14 days')
        RETURNING id`;

      expect(await gate.decide(workerId, { unlockId: held!.id }, CTX)).toBe("open");
      expect(await gate.decide(workerId, { unlockId: other!.id }, CTX)).toBe("closed");
    });

    it("re-reads a stale confirmation and opens when RVM still answers for him", async () => {
      const { workerId, ref } = await linkedStudent();
      await applyTo(workerId, companyA.postingId);
      await ageConfirmation(workerId);
      answers.set(ref, { kind: "available", student: student({ course: "Refreshed" }) });

      expect(await gate.decide(workerId, { tenant: companyA.tenant }, CTX)).toBe("open");
      const link = await linkOf(workerId);
      expect(link?.course).toBe("Refreshed");
      expect(Date.now() - link!.syncedAt!.getTime()).toBeLessThan(60_000);
    });

    it("withdraws the link when RVM no longer answers for him, refuses the open, and deletes nothing", async () => {
      const { workerId, ref } = await linkedStudent();
      await applyTo(workerId, companyA.postingId);
      await ageConfirmation(workerId);
      answers.set(ref, { kind: "not_available" });

      expect(await gate.decide(workerId, { tenant: companyA.tenant }, CTX)).toBe("closed");
      // RVM says NOT_AVAILABLE for any reason, so this signal never deletes: the row and his
      // application stay; the link is withdrawn and the copied facts are gone.
      expect((await workerOf(workerId))?.status).toBe("pending");
      expect(await linkOf(workerId)).toMatchObject({ status: "withdrawn", course: null });
      const kept = await client.db
        .select()
        .from(applications)
        .where(eq(applications.workerId, workerId));
      expect(kept).toHaveLength(1);
      const ended = await unlinkedEvents(workerId);
      expect(ended.map((e) => e.payload)).toEqual([
        {
          worker_id: workerId,
          institute_code: "rvm",
          reason: "consent_not_confirmed",
          worker_deleted: false,
        },
      ]);
      // Withdrawn, he is no longer linked; with no BadaBhai consent his own rule refuses him too.
      expect(await gate.decide(workerId, { tenant: companyA.tenant }, CTX)).toBe("not_linked");
    });

    it("lets a refusal older than a newer confirmation stand down", async () => {
      const { workerId, ref } = await linkedStudent();
      const before = new Date(Date.now() - 60_000);

      await links.unlinkStudent(ref, "consent_not_confirmed", CTX, before);

      expect((await linkOf(workerId))?.status).toBe("active");
      expect(await unlinkedEvents(workerId)).toHaveLength(0);
    });

    it("ends nothing when RVM is down, and still refuses the open", async () => {
      const { workerId, ref } = await linkedStudent();
      await applyTo(workerId, companyA.postingId);
      await ageConfirmation(workerId);
      answers.set(ref, new RvmStudentApiUnavailableError("timeout"));

      expect(await gate.decide(workerId, { tenant: companyA.tenant }, CTX)).toBe("closed");
      expect((await linkOf(workerId))?.status).toBe("active");
      expect(await unlinkedEvents(workerId)).toHaveLength(0);
    });
  });

  describe("unlink", () => {
    it("deletes the row the link created when he never signed in, his applications with it", async () => {
      const { workerId, ref } = await linkedStudent();
      await applyTo(workerId, companyA.postingId);

      await links.unlinkStudent(ref, "campus_request", CTX);

      expect(await workerOf(workerId)).toBeUndefined();
      expect(await linkOf(workerId)).toBeUndefined();
      const left = await client.db
        .select()
        .from(applications)
        .where(eq(applications.workerId, workerId));
      expect(left).toHaveLength(0);
      const ended = await unlinkedEvents(workerId);
      expect(ended).toHaveLength(1);
      expect(ended[0]!.payload).toEqual({
        worker_id: workerId,
        institute_code: "rvm",
        reason: "campus_request",
        worker_deleted: true,
      });
      expect(JSON.stringify(ended[0])).not.toContain(ref);
    });

    it("keeps a worker with his own BadaBhai account and erases only what came from RVM", async () => {
      const s = student();
      const own = await ownWorker(s.phone);
      const { ref } = await linkedStudent(s);

      await links.unlinkStudent(ref, "campus_request", CTX);

      const worker = await workerOf(own.id);
      expect(worker?.status).toBe("active");
      expect(pii.decrypt(worker!.fullName!)).toBe("His Own Name");
      expect(await linkOf(own.id)).toMatchObject({
        studentRef: ref,
        status: "withdrawn",
        studentStatus: null,
        course: null,
        branch: null,
        testScore: null,
        consentVersion: null,
        consentAt: null,
      });
      expect((await linkOf(own.id))?.withdrawnAt).toBeInstanceOf(Date);
      expect((await unlinkedEvents(own.id)).map((e) => e.payload)).toEqual([
        {
          worker_id: own.id,
          institute_code: "rvm",
          reason: "campus_request",
          worker_deleted: false,
        },
      ]);
    });

    it("keeps a pending link-created row that holds a PIN (a PIN reset leaves it pending)", async () => {
      const { workerId, ref } = await linkedStudent();
      await client.db
        .insert(workerCredentials)
        .values({ workerId, pinHash: "scrypt-v1.test.test" });

      await links.unlinkStudent(ref, "campus_request", CTX);

      expect((await workerOf(workerId))?.status).toBe("pending");
      expect((await linkOf(workerId))?.status).toBe("withdrawn");
      expect((await unlinkedEvents(workerId))[0]!.payload).toMatchObject({ worker_deleted: false });
    });

    it("keeps a pending link-created row that has accepted BadaBhai's consent", async () => {
      const { workerId, ref } = await linkedStudent();
      await client.db.insert(workerConsents).values({
        workerId,
        consentVersion: "test-2752c",
        purposes: ["profiling"],
        acceptedAt: new Date(),
      });

      await links.unlinkStudent(ref, "campus_request", CTX);

      expect(await workerOf(workerId)).toBeDefined();
      expect((await linkOf(workerId))?.status).toBe("withdrawn");
    });

    it("keeps a link-created row once he has signed in to it himself", async () => {
      const { workerId, ref, student: s } = await linkedStudent();
      await workersRepo.activatePending(workerId, pii.hashPhone(`+91${s.phone}`));

      await links.unlinkStudent(ref, "campus_request", CTX);

      expect((await workerOf(workerId))?.status).toBe("active");
      expect((await linkOf(workerId))?.status).toBe("withdrawn");
    });

    it("is idempotent: a second unlink changes nothing and emits nothing", async () => {
      const s = student();
      const own = await ownWorker(s.phone);
      const { ref } = await linkedStudent(s);

      await links.unlinkStudent(ref, "campus_request", CTX);
      await links.unlinkStudent(ref, "campus_request", CTX);

      expect(await unlinkedEvents(own.id)).toHaveLength(1);
    });

    it("does nothing for a reference BadaBhai never linked", async () => {
      await expect(
        links.unlinkStudent(randomUUID(), "campus_request", CTX),
      ).resolves.toBeUndefined();
    });

    it("lets a withdrawn student link again when he consents again", async () => {
      const s = student();
      const own = await ownWorker(s.phone);
      const { ref } = await linkedStudent(s);
      await links.unlinkStudent(ref, "campus_request", CTX);

      answers.set(ref, { kind: "available", student: s });
      await links.linkStudent(ref, CTX);

      expect(await linkOf(own.id)).toMatchObject({ status: "active", course: "CNC Programming" });
    });
  });

  describe("the AI gate (item 13)", () => {
    const aiGate = () =>
      new InstituteAiGate(new InstituteLinkRepository(client.db), new ConsentRepository(client.db));

    it("lets a worker who was never linked through", async () => {
      const own = await ownWorker(phone10());
      await expect(aiGate().assertMayRunAi(own.id)).resolves.toBeUndefined();
    });

    it("refuses a linked student until he accepts BadaBhai's own consent", async () => {
      const { workerId } = await linkedStudent();
      await expect(aiGate().assertMayRunAi(workerId)).rejects.toBeInstanceOf(
        InstituteAiRefusedError,
      );

      await client.db.insert(workerConsents).values({
        workerId,
        consentVersion: "test-2752c",
        purposes: ["profiling"],
        acceptedAt: new Date(),
      });
      await expect(aiGate().assertMayRunAi(workerId)).resolves.toBeUndefined();
    });

    it("still refuses him once the link is withdrawn, with no BadaBhai consent", async () => {
      const { workerId, ref } = await linkedStudent();
      await links.unlinkStudent(ref, "consent_not_confirmed", CTX);

      expect((await linkOf(workerId))?.status).toBe("withdrawn");
      await expect(aiGate().assertMayRunAi(workerId)).rejects.toBeInstanceOf(
        InstituteAiRefusedError,
      );
    });
  });

  describe("company search", () => {
    it("leaves out an actively linked student with BadaBhai's own consent, and lets him back once unlinked", async () => {
      // The same taxonomy row the candidate-search suite seeds; a no-op where it exists.
      const SKILL = "mskill_cnc_turner";
      const MFG = "ind_industrial_manufacturing";
      await client.sql`
        INSERT INTO skill (skill_id, label_en, domain_id, source, status, kind, industry_id)
        VALUES (${SKILL}, 'CNC Turner', 'cnc-machining', 'rvm', 'active', 'match_skill', ${MFG})
        ON CONFLICT (skill_id) DO NOTHING`;
      const s = student();
      const own = await ownWorker(s.phone);
      await client.db.insert(workerConsents).values({
        workerId: own.id,
        consentVersion: "test-2752c",
        purposes: ["profiling", "employer_sharing"],
        acceptedAt: new Date(),
      });
      await client.db.insert(workerSkills).values({
        workerId: own.id,
        skillId: SKILL,
        industryId: MFG,
        monthsBucketed: 12,
        wants: true,
        source: "ops",
      });
      // Before the link he is in the pool, which proves the fixture is a searchable worker.
      expect(await search.findCardRow(own.id)).not.toBeNull();

      const { ref } = await linkedStudent(s);
      expect(await search.findCardRow(own.id)).toBeNull();

      await links.unlinkStudent(ref, "campus_request", CTX);
      expect(await search.findCardRow(own.id)).not.toBeNull();
    });
  });
});
