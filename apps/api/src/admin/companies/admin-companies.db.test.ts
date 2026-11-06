import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDbClient, hashGstin, normalizeGstin, type DbClient } from "@badabhai/db";
import type { RequestContext } from "../../common/request-context";
import { EventsRepository } from "../../events/events.repository";
import { EventsService } from "../../events/events.service";
import { AdminActionsRepository } from "../admin-actions.repository";
import { NameTokenService } from "../candidate-index/name-token.service";
import { AdminCompaniesRepository } from "./admin-companies.repository";
import { AdminCompaniesService } from "./admin-companies.service";

/**
 * #2564 — the acceptance criteria that are properties of POSTGRES, not of the service:
 *
 *   - the list is ONE ROW PER ORGANISATION: a team login is nested under its founder, never a
 *     company of its own (the founder's own team-membership exclusion is SQL);
 *   - whole-word name search matches through keyed tokens, and only for the row's own key id;
 *   - the GST filter matches the keyed hash exactly;
 *   - archive moves the founder AND every active team login to `archived` (previous status kept)
 *     and freezes each login's postings; restore returns each to its previous status and
 *     un-freezes only a login that comes back usable.
 */
const RUN = process.env.RUN_DB_TESTS === "1";
const DATABASE_URL =
  process.env.E2E_DATABASE_URL ??
  process.env.DATABASE_URL ??
  "postgresql://badabhai:badabhai@localhost:5432/badabhai";

function assertLocalDatabase(url: string): void {
  const host = new URL(url).hostname;
  if (!["localhost", "127.0.0.1", "::1", "[::1]"].includes(host)) {
    throw new Error(`admin-companies.db refuses to write to a non-local host (${host})`);
  }
}

const TAG = randomUUID().slice(0, 8);
const CTX: RequestContext = { correlationId: randomUUID(), requestId: `companies-db-${TAG}` };
const ROOT = randomUUID();
const MEMBER = randomUUID();
const ORG = randomUUID();
const PEPPER = `companies-test-pepper-${TAG}`;
const KID = "test-kid";
const NAME_KEY = "a".repeat(64);
const GSTIN = "27AAPFU0939F1ZV";

const nameTokens = new NameTokenService({
  ADMIN_NAME_TOKEN_KEYS: JSON.stringify({ [KID]: NAME_KEY }),
  ADMIN_NAME_TOKEN_ACTIVE_KID: KID,
} as never);

describe.skipIf(!RUN)("#2564 company records — against Postgres", () => {
  let client!: DbClient;
  let companies!: AdminCompaniesRepository;
  let actions!: AdminActionsRepository;
  let service!: AdminCompaniesService;

  beforeAll(async () => {
    assertLocalDatabase(DATABASE_URL);
    client = createDbClient(DATABASE_URL, { max: 4 });
    companies = new AdminCompaniesRepository(client.db);
    actions = new AdminActionsRepository(client.db);
    const events = new EventsService(new EventsRepository(client.db), {
      NODE_ENV: "test",
    } as never);
    service = new AdminCompaniesService(
      companies,
      actions,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      nameTokens,
      { revokeAllForPayer: async () => undefined } as never,
      {} as never,
      events,
    );

    await client.sql`
      INSERT INTO payers (id, role, email_enc, email_hash, org_name_enc, status)
      VALUES (${ROOT}::uuid, 'employer', ${`enc:root-${TAG}`}, ${`hash:root-${TAG}`},
              ${`enc:Acme Works ${TAG}`}, 'active'),
             (${MEMBER}::uuid, 'employer', ${`enc:member-${TAG}`}, ${`hash:member-${TAG}`},
              ${`enc:Acme Works ${TAG}`}, 'suspended')`;
    await client.sql`
      INSERT INTO payer_orgs (id, root_payer_id, name_enc, status)
      VALUES (${ORG}::uuid, ${ROOT}::uuid, ${`enc:Acme Works ${TAG}`}, 'active')`;
    await client.sql`
      INSERT INTO payer_members (org_id, member_payer_id, org_role, status)
      VALUES (${ORG}::uuid, ${ROOT}::uuid, 'owner', 'active'),
             (${ORG}::uuid, ${MEMBER}::uuid, 'recruiter', 'active')`;
    // The member's own OPEN posting: with tenancy off it carries the MEMBER's payer id.
    await client.sql`
      INSERT INTO job_postings (created_by, payer_id, org_label, role_title, vacancy_band, status)
      VALUES (${MEMBER}::uuid, ${MEMBER}::uuid, 'Acme', 'Member posting', '1', 'open')`;
    const tokens = nameTokens.tokenise(`Acme Works ${TAG}`, "company");
    await client.sql`
      UPDATE payers SET org_name_token_hashes = ${tokens.hashes}::text[],
        org_name_token_key_id = ${tokens.kid} WHERE id = ${ROOT}::uuid`;
    await client.sql`
      INSERT INTO employer_profiles (payer_id, gst_number_enc, gst_number_hash, verification_status)
      VALUES (${ROOT}::uuid, ${`enc:${GSTIN}`}, ${hashGstin(normalizeGstin(GSTIN), PEPPER)}, 'verified')`;
  });

  afterAll(async () => {
    if (!client) return;
    try {
      await client.sql`DELETE FROM audit_logs WHERE entity_id IN (${ROOT}::uuid, ${MEMBER}::uuid)`;
      await client.sql`DELETE FROM events WHERE correlation_id = ${CTX.correlationId}::uuid`;
      await client.sql`DELETE FROM job_postings WHERE payer_id IN (${ROOT}::uuid, ${MEMBER}::uuid)`;
      await client.sql`DELETE FROM employer_profiles WHERE payer_id = ${ROOT}::uuid`;
      await client.sql`DELETE FROM payer_members WHERE org_id = ${ORG}::uuid`;
      await client.sql`DELETE FROM payer_orgs WHERE id = ${ORG}::uuid`;
      await client.sql`DELETE FROM payers WHERE id IN (${ROOT}::uuid, ${MEMBER}::uuid)`;
    } finally {
      await client.sql.end({ timeout: 5 });
    }
  });

  it("lists the ORGANISATION once, with the team login nested — never as a second company", async () => {
    const { rows, total } = await companies.listCompanies({}, "newest", 0, 50);
    expect(rows.map((r) => r.id)).toContain(ROOT);
    expect(rows.map((r) => r.id)).not.toContain(MEMBER);
    expect(total).toBeGreaterThanOrEqual(1);
    const members = await companies.listMembers([ORG]);
    expect(members.map((m) => m.payerId)).toEqual([MEMBER]);
  });

  it("whole-word name search matches through the keyed tokens, under the row's key id", async () => {
    const match = nameTokens.queryTokens(`acme ${TAG}`, "company");
    expect(match.available).toBe(true);
    const tokens = match.available ? match.perKey.filter((k) => k.hashes.length > 0) : [];
    const found = await companies.listCompanies({ nameTokens: tokens }, "newest", 0, 50);
    expect(found.rows.map((r) => r.id)).toContain(ROOT);

    // A word that is not in the name matches nothing: whole-word, never substring.
    const miss = nameTokens.queryTokens("acm", "company");
    const missTokens = miss.available ? miss.perKey : [];
    const none = await companies.listCompanies({ nameTokens: missTokens }, "newest", 0, 50);
    expect(none.rows.map((r) => r.id)).not.toContain(ROOT);
  });

  it("the GST filter matches the keyed hash exactly", async () => {
    const found = await companies.listCompanies(
      { gstHash: hashGstin(normalizeGstin(GSTIN), PEPPER) },
      "newest",
      0,
      50,
    );
    expect(found.rows.map((r) => r.id)).toContain(ROOT);
    const none = await companies.listCompanies({ gstHash: "not-a-real-hash" }, "newest", 0, 50);
    expect(none.rows.map((r) => r.id)).not.toContain(ROOT);
  });

  it("archive moves the founder AND the team login, keeps previous status, freezes member inventory", async () => {
    const result = await service.archiveCompany(
      { id: randomUUID(), role: "ops_admin", sid: "s" } as never,
      ROOT,
      { reason_code: "inactive", reason_text: "Company confirmed it has stopped hiring" },
      CTX,
    );
    expect(result.changed).toBe(true);

    const rows = await client.sql<{ id: string; status: string; previous_status: string | null }[]>`
      SELECT id, status, previous_status FROM payers WHERE id IN (${ROOT}::uuid, ${MEMBER}::uuid) ORDER BY id`;
    expect(rows).toHaveLength(2);
    expect(rows.every((r) => r.status === "archived")).toBe(true);
    const member = rows.find((r) => r.id === MEMBER)!;
    expect(member.previous_status).toBe("suspended");
    const [posting] = await client.sql<{ status: string }[]>`
      SELECT status FROM job_postings WHERE payer_id = ${MEMBER}::uuid`;
    expect(posting?.status).toBe("suspended");
    const [audit] = await client.sql<{ n: number }[]>`
      SELECT count(*)::int AS n FROM audit_logs WHERE entity_id = ${ROOT}::uuid AND action = 'company_archived'`;
    expect(audit?.n).toBe(1);
    const [spine] = await client.sql<{ n: number }[]>`
      SELECT count(*)::int AS n FROM events
      WHERE correlation_id = ${CTX.correlationId}::uuid AND event_name = 'payer.archived'`;
    expect(spine?.n).toBe(2);
  });

  it("restore returns each login to its previous status; a suspended login stays frozen", async () => {
    const result = await service.restoreCompany(
      { id: randomUUID(), role: "ops_admin", sid: "s" } as never,
      ROOT,
      {
        reason_code: "archived_in_error",
        reason_text: "The archive was applied to the wrong company",
      },
      CTX,
    );
    expect(result.changed).toBe(true);

    const rows = await client.sql<{ id: string; status: string; previous_status: string | null }[]>`
      SELECT id, status, previous_status FROM payers WHERE id IN (${ROOT}::uuid, ${MEMBER}::uuid)`;
    expect(rows.find((r) => r.id === ROOT)?.status).toBe("active");
    expect(rows.find((r) => r.id === MEMBER)?.status).toBe("suspended");
    expect(rows.every((r) => r.previous_status === null)).toBe(true);
    // The founder's inventory comes back; the still-suspended member's stays frozen.
    const [memberPosting] = await client.sql<{ status: string }[]>`
      SELECT status FROM job_postings WHERE payer_id = ${MEMBER}::uuid`;
    expect(memberPosting?.status).toBe("suspended");
  });

  it("the payers CHECK refuses a status outside the four-value lifecycle", async () => {
    await expect(
      client.sql`UPDATE payers SET status = 'archivd' WHERE id = ${ROOT}::uuid`,
    ).rejects.toThrow(/payers_status_chk/);
  });
});
