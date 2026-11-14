import { randomInt, randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import {
  createDbClient,
  events,
  instituteSearchGrants,
  payers,
  workers,
  type DbClient,
} from "@badabhai/db";
import type { RequestContext } from "../common/request-context";
import { PiiCryptoService } from "../common/pii-crypto.service";
import { CandidateSearchRepository } from "../candidates/candidate-search.repository";
import { EventsRepository } from "../events/events.repository";
import { EventsService } from "../events/events.service";
import type { PayerOrgsRepository } from "../payers/payer-orgs.repository";
import type { TenantKey } from "../payers/payer-tenant-scope";
import { PayerTenantScopeService } from "../payers/payer-tenant-scope.service";
import { WorkersRepository } from "../workers/workers.repository";
import { InstituteLinkRepository } from "./institute-link.repository";
import { InstituteLinkService, StudentNotAvailableError } from "./institute-link.service";
import { InstituteOpenGate } from "./institute-open-gate.service";
import { InstituteSearchGrantsRepository } from "./institute-search-grants.repository";
import {
  GrantNotFoundError,
  GrantRefConflictError,
  InstituteSearchGrantsService,
} from "./institute-search-grants.service";
import type {
  RvmConsentLookup,
  RvmStudentApiClient,
  RvmStudentLookup,
  RvmStudentRead,
} from "./rvm-student-api.client";

/**
 * #2752 item 10 — named-company search grants, against Postgres:
 *   - a yes for THIS company stores one grant (on the skill his course maps to) and one ids-only
 *     event; the same ref again answers it; the ref for another company is a conflict;
 *   - a no, a yes for another company, or a reply with no company stores nothing and creates no
 *     worker row;
 *   - the granted student is in the grant holder's search alone, and that company may open him
 *     with no application; a revoke (idempotent) ends both; an unlink revokes his grants.
 */
const RUN = process.env.RUN_DB_TESTS === "1";
const DATABASE_URL =
  process.env.E2E_DATABASE_URL ??
  process.env.DATABASE_URL ??
  "postgresql://badabhai:badabhai@localhost:5432/badabhai";

function assertLocalDatabase(url: string): void {
  const host = new URL(url).hostname;
  if (!["localhost", "127.0.0.1", "::1", "[::1]"].includes(host)) {
    throw new Error(`institute-grants.db refuses to write to a non-local host (${host})`);
  }
}

const CTX: RequestContext = { correlationId: randomUUID(), requestId: "institute-grants-db" };
const TAG = randomUUID().slice(0, 8);
const phone10 = () => `9${String(randomInt(0, 1_000_000_000)).padStart(9, "0")}`;
const SKILL = "mskill_cad_designer_3d";
const MFG = "ind_industrial_manufacturing";

function student(overrides: Partial<RvmStudentRead> = {}): RvmStudentRead {
  return {
    name: "Test Student",
    phone: phone10(),
    course: "SolidWorks",
    branch: "Faridabad",
    status: "current_student",
    test_score: 72.5,
    ...overrides,
  };
}

describe.skipIf(!RUN)("#2752 named-company search grants — against Postgres", () => {
  let client!: DbClient;
  let grants!: InstituteSearchGrantsService;
  let links!: InstituteLinkService;
  let gate!: InstituteOpenGate;
  let search!: CandidateSearchRepository;
  let pii!: PiiCryptoService;
  const students = new Map<string, RvmStudentLookup>();
  const consents = new Map<string, RvmConsentLookup>();
  const touchedWorkers = new Set<string>();
  const touchedPayers: string[] = [];
  let companyA!: { id: string; tenant: TenantKey };
  let companyB!: { id: string; tenant: TenantKey };
  const tenancy = new PayerTenantScopeService(
    { PAYER_ORG_TENANCY_MODE: "off" } as never,
    {
      listActiveMembershipsWithAnchor: async () => [],
      ensureSoloOrg: async () => null,
    } as unknown as PayerOrgsRepository,
  );

  async function company(label: string) {
    const [payer] = await client.db
      .insert(payers)
      .values({
        role: "employer",
        emailEnc: `enc:2752g-${label}-${TAG}`,
        emailHash: `hash:2752g-${label}-${TAG}`,
        orgNameEnc: `enc:company-${label}-${TAG}`,
        status: "active",
      })
      .returning({ id: payers.id });
    touchedPayers.push(payer!.id);
    return { id: payer!.id, tenant: (await tenancy.resolve(payer!.id)).tenantKey };
  }

  beforeAll(async () => {
    assertLocalDatabase(DATABASE_URL);
    client = createDbClient(DATABASE_URL, { max: 4 });
    const eventsService = new EventsService(new EventsRepository(client.db), {
      NODE_ENV: "test",
    } as never);
    pii = new PiiCryptoService({
      PII_HASH_PEPPER: "institute-grants-test-pepper",
      PII_ENCRYPTION_KEY: Buffer.alloc(32, 5).toString("base64"),
      PIN_PEPPER: "institute-grants-test-pin",
    } as never);
    const rvm = {
      readStudent: async (ref: string) => {
        const answer = students.get(ref);
        if (!answer) throw new Error(`no fake student for ${ref}`);
        return answer;
      },
      readConsentRequest: async (id: string) => {
        const answer = consents.get(id);
        if (!answer) throw new Error(`no fake consent request ${id}`);
        return answer;
      },
    } as unknown as RvmStudentApiClient;
    const linkRepo = new InstituteLinkRepository(client.db);
    links = new InstituteLinkService(
      linkRepo,
      new WorkersRepository(client.db),
      rvm,
      pii,
      eventsService,
      { RVM_CONSENT_RECHECK_SECONDS: 300 } as never,
    );
    grants = new InstituteSearchGrantsService(
      new InstituteSearchGrantsRepository(client.db),
      links,
      linkRepo,
      rvm,
      tenancy,
      eventsService,
    );
    gate = new InstituteOpenGate(linkRepo, links);
    search = new CandidateSearchRepository(client.db);
    await client.sql`
      INSERT INTO skill (skill_id, label_en, domain_id, source, status, kind, industry_id)
      VALUES (${SKILL}, '3D CAD Designer', 'cad-design', 'rvm', 'active', 'match_skill', ${MFG})
      ON CONFLICT (skill_id) DO NOTHING`;
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
      for (const id of touchedPayers) await client.sql`DELETE FROM payers WHERE id = ${id}::uuid`;
    } finally {
      await client.sql.end({ timeout: 5 });
    }
  });

  /** A student RVM answers for, and a consent request naming `companyId` with his `answer`. */
  function asked(companyId: string | null, answer: "yes" | "no", s = student()) {
    const ref = randomUUID();
    const consentRef = `consent-${randomUUID().slice(0, 12)}`;
    students.set(ref, { kind: "available", student: s });
    consents.set(consentRef, {
      kind: "found",
      companyRef: companyId,
      answers: new Map([[ref, answer]]),
    });
    return { ref, consentRef, phone: s.phone };
  }

  const grantRef = () => `grant-${randomUUID().slice(0, 12)}`;
  const grantRows = (workerId: string) =>
    client.db
      .select()
      .from(instituteSearchGrants)
      .where(eq(instituteSearchGrants.workerId, workerId));
  const workerByPhone = async (p10: string) =>
    (
      await client.db
        .select({ id: workers.id })
        .from(workers)
        .where(eq(workers.phoneHash, pii.hashPhone(`+91${p10}`)))
    )[0];
  const poolIds = async (tenant?: TenantKey) =>
    (
      await search.searchPool({
        skillIds: [],
        relatedSkillIds: [],
        experience: null,
        industryId: null,
        industryExperience: null,
        city: null,
        tierFloorMonths: 0,
        strict: false,
        after: null,
        limit: 500,
        tenant,
      })
    ).rows.map((r) => r.workerId);

  async function granted() {
    const a = asked(companyA.id, "yes");
    const ref = grantRef();
    const view = await grants.grant(
      ref,
      { company_id: companyA.id, student_ref: a.ref, consent_ref: a.consentRef },
      CTX,
    );
    const workerId = (await workerByPhone(a.phone))!.id;
    touchedWorkers.add(workerId);
    return { ...a, grantRef: ref, view, workerId };
  }

  it("stores one grant on his course's skill, with one ids-only event, after his yes for this company", async () => {
    const g = await granted();

    expect(g.view).toMatchObject({
      grantRef: g.grantRef,
      companyId: companyA.id,
      studentRef: g.ref,
      state: "active",
    });
    const rows = await grantRows(g.workerId);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ payerId: companyA.id, skillId: SKILL, industryId: MFG });
    const fired = await client.db
      .select()
      .from(events)
      .where(
        and(
          eq(events.subjectId, g.workerId),
          eq(events.eventName, "worker.institute_search_granted"),
        ),
      );
    expect(fired.map((e) => e.payload)).toEqual([
      {
        grant_id: rows[0]!.id,
        worker_id: g.workerId,
        payer_id: companyA.id,
        institute_code: "rvm",
      },
    ]);
  });

  it("answers the same grant for the same ref, and refuses the ref for another company", async () => {
    const g = await granted();

    const again = await grants.grant(
      g.grantRef,
      { company_id: companyA.id, student_ref: g.ref, consent_ref: g.consentRef },
      CTX,
    );
    expect(again).toEqual(g.view);
    await expect(
      grants.grant(
        g.grantRef,
        { company_id: companyB.id, student_ref: g.ref, consent_ref: g.consentRef },
        CTX,
      ),
    ).rejects.toBeInstanceOf(GrantRefConflictError);
    expect(await grantRows(g.workerId)).toHaveLength(1);
  });

  it.each([
    ["a no", "no" as const, "self"],
    ["a yes for another company", "yes" as const, "other"],
    ["a reply that names no company", "yes" as const, "none"],
  ])("stores nothing and creates no worker for %s", async (_label, answer, whose) => {
    const companyRef = whose === "self" ? companyA.id : whose === "other" ? companyB.id : null;
    const a = asked(companyRef, answer);

    await expect(
      grants.grant(
        grantRef(),
        { company_id: companyA.id, student_ref: a.ref, consent_ref: a.consentRef },
        CTX,
      ),
    ).rejects.toBeInstanceOf(StudentNotAvailableError);
    expect(await workerByPhone(a.phone)).toBeUndefined();
  });

  it("puts him in the grant holder's search alone, and lets that company open him", async () => {
    const g = await granted();

    expect(await poolIds(companyA.tenant)).toContain(g.workerId);
    expect(await poolIds(companyB.tenant)).not.toContain(g.workerId);
    expect(await poolIds()).not.toContain(g.workerId);
    // No application: the grant alone lets A open him; B cannot.
    expect(await gate.decide(g.workerId, { tenant: companyA.tenant }, CTX)).toBe("open");
    expect(await gate.decide(g.workerId, { tenant: companyB.tenant }, CTX)).toBe("closed");
  });

  it("ends both on a revoke, which is idempotent", async () => {
    const g = await granted();

    const first = await grants.revoke(g.grantRef, CTX);
    const second = await grants.revoke(g.grantRef, CTX);

    expect(first.state).toBe("revoked");
    expect(second).toEqual(first);
    expect(await poolIds(companyA.tenant)).not.toContain(g.workerId);
    expect(await gate.decide(g.workerId, { tenant: companyA.tenant }, CTX)).toBe("closed");
  });

  it("does not grant again on a consent already spent on a revoked grant", async () => {
    const g = await granted();
    await grants.revoke(g.grantRef, CTX);

    await expect(
      grants.grant(
        grantRef(),
        { company_id: companyA.id, student_ref: g.ref, consent_ref: g.consentRef },
        CTX,
      ),
    ).rejects.toBeInstanceOf(StudentNotAvailableError);
    expect((await grantRows(g.workerId)).filter((r) => r.revokedAt === null)).toHaveLength(0);
  });

  it("refuses to revoke a ref it never stored", async () => {
    await expect(grants.revoke(grantRef(), CTX)).rejects.toBeInstanceOf(GrantNotFoundError);
  });

  it("revokes his grants when he is unlinked and keeps an account of his own", async () => {
    const g = await granted();
    // He signed in himself, so the unlink keeps his row and must still end the grant.
    await client.db.update(workers).set({ status: "active" }).where(eq(workers.id, g.workerId));

    await links.unlinkStudent(g.ref, "campus_request", CTX);

    const rows = await grantRows(g.workerId);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.revokedAt).toBeInstanceOf(Date);
  });
});
