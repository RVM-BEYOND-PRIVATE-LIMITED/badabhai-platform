import { randomBytes, randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { createDbClient, workerOrigins, type DbClient } from "@badabhai/db";
import { PiiCryptoService } from "../common/pii-crypto.service";
import { ConsentRepository } from "../consent/consent.repository";
import { EventsRepository } from "../events/events.repository";
import { EventsService } from "../events/events.service";
import { InviteRepository } from "../messaging/invite.repository";
import { InviteService } from "../messaging/invite.service";
import { AgencyInvitesRepository } from "../agency/agency-invites.repository";
import { AgencyService } from "../agency/agency.service";
import { ReferralAttributionService } from "./referral-attribution.service";
import { ReferralHelperNameRepository } from "./referral-helper-name.repository";
import { ReferralHelperNameService } from "./referral-helper-name.service";
import { ReferralLinkRepository } from "./referral-link.repository";
import { ReferralLinkService } from "./referral-link.service";
import { WorkerOriginRepository } from "./worker-origin.repository";

/**
 * #2753 item 12 — referral codes, AGAINST POSTGRES:
 *   - CAME-FROM. The real attribution (consent gate, worker and agency seams) writes one
 *     `worker_origins` row on success — `referrer` / `partner`, ref = the code, which the table's
 *     CHECKs accept — and none on a refusal; an origin he already has (the Campus link's
 *     `institute`) is never overwritten (first origin wins).
 *   - THE HELPER'S NAME. The one lookup answers the agency's decrypted company name for a live
 *     agency code (an unaccepted invite, an unexpired `agent` link of an ACTIVE agency) and null
 *     for a worker's code, an unknown code, a spent invite, an expired link, a suspended agency,
 *     an employer, and a code that also names a worker's invite or a résumé QR.
 *
 * Synthetic markers only: no real phone, email or name exists in this fixture.
 */
const RUN = process.env.RUN_DB_TESTS === "1";
const DATABASE_URL =
  process.env.E2E_DATABASE_URL ??
  process.env.DATABASE_URL ??
  "postgresql://badabhai:badabhai@localhost:5432/badabhai";

function assertLocalDatabase(url: string): void {
  const host = new URL(url).hostname;
  if (!["localhost", "127.0.0.1", "::1", "[::1]"].includes(host)) {
    throw new Error(`referral-came-from.db refuses to write to a non-local host (${host})`);
  }
}

const code = () => randomBytes(6).toString("hex");
const TAG = randomBytes(4).toString("hex");

const INVITER = randomUUID();
const W_REFERRED = randomUUID();
const W_PARTNERED = randomUUID();
const W_INSTITUTE = randomUUID();
const W_NO_CONSENT = randomUUID();
const W_UNKNOWN = randomUUID();
const WORKERS = [INVITER, W_REFERRED, W_PARTNERED, W_INSTITUTE, W_NO_CONSENT, W_UNKNOWN];

const AGENCY = randomUUID();
const AGENCY_SUSPENDED = randomUUID();
const EMPLOYER = randomUUID();
const PAYERS = [AGENCY, AGENCY_SUSPENDED, EMPLOYER];
const AGENCY_NAME = `Came-From Test Agency ${TAG}`;

/** Codes, one per case. */
const C = {
  workerInvite: code(),
  workerInviteForNoConsent: code(),
  agencyInvite: code(),
  agencyInviteForInstitute: code(),
  agencyInviteHelper: code(),
  agencyInviteSpent: code(),
  agencySuspended: code(),
  employerInvite: code(),
  agentLink: code(),
  agentLinkExpired: code(),
  collidesWorkerInvite: code(),
  collidesResumeQr: code(),
  unknown: code(),
};

describe.skipIf(!RUN)("#2753 item 12 — referral came-from and the helper's name (Postgres)", () => {
  let client!: DbClient;
  let attribution!: ReferralAttributionService;
  let helperName!: ReferralHelperNameService;
  const inviteIds: string[] = [];
  const linkIds: string[] = [];

  beforeAll(async () => {
    assertLocalDatabase(DATABASE_URL);
    client = createDbClient(DATABASE_URL, { max: 4 });
    const { db, sql } = client;
    const pii = new PiiCryptoService({
      PII_HASH_PEPPER: "referral-came-from-test-pepper",
      PII_ENCRYPTION_KEY: Buffer.alloc(32, 7).toString("base64"),
      PIN_PEPPER: "referral-came-from-test-pin",
    } as never);
    const events = new EventsService(new EventsRepository(db), { NODE_ENV: "test" } as never);
    const consent = new ConsentRepository(db);
    attribution = new ReferralAttributionService(
      consent,
      new InviteService(new InviteRepository(db), events),
      new AgencyService(
        {} as never,
        new AgencyInvitesRepository(db),
        consent,
        events,
        {} as never,
        {} as never,
        {} as never,
      ),
      new ReferralLinkService(new ReferralLinkRepository(db), events, pii, {
        REFERRAL_MATCH_WINDOW_ORGANIC_HOURS: 168,
        REFERRAL_MATCH_WINDOW_PAID_HOURS: 24,
        REFERRAL_SHORT_LINK_BASE: "https://example.invalid",
      } as never),
      new WorkerOriginRepository(db),
    );
    helperName = new ReferralHelperNameService(new ReferralHelperNameRepository(db), pii);

    for (const id of WORKERS) {
      await sql`
        INSERT INTO workers (id, phone_e164, phone_hash, status)
        VALUES (${id}::uuid, ${`enc:came-from-${TAG}-${id}`}, ${`hash:came-from-${TAG}-${id}`},
                'active')`;
    }
    for (const id of [W_REFERRED, W_PARTNERED, W_INSTITUTE, W_UNKNOWN]) {
      await sql`
        INSERT INTO worker_consents (worker_id, consent_version, purposes, accepted_at)
        VALUES (${id}::uuid, 'test', ${JSON.stringify(["profiling"])}::jsonb,
                now() - interval '1 hour')`;
    }
    // The Campus link's origin, recorded before any code reaches him.
    await sql`
      INSERT INTO worker_origins (worker_id, kind, ref)
      VALUES (${W_INSTITUTE}::uuid, 'institute', 'rvm')`;

    for (const [id, role, status, name] of [
      [AGENCY, "agent", "active", pii.encrypt(AGENCY_NAME)],
      [AGENCY_SUSPENDED, "agent", "suspended", pii.encrypt(`Suspended Agency ${TAG}`)],
      [EMPLOYER, "employer", "active", pii.encrypt(`Employer ${TAG}`)],
    ] as const) {
      await sql`
        INSERT INTO payers (id, role, email_enc, email_hash, org_name_enc, status)
        VALUES (${id}::uuid, ${role}, ${`enc:came-from-${TAG}-${id}`},
                ${`hash:came-from-${TAG}-${id}`}, ${name}, ${status})`;
    }

    const invite = async (c: string) => {
      const [row] = await sql<{ id: string }[]>`
        INSERT INTO invites (code, inviter_worker_id) VALUES (${c}, ${INVITER}::uuid)
        RETURNING id`;
      inviteIds.push(row!.id);
    };
    await invite(C.workerInvite);
    await invite(C.workerInviteForNoConsent);
    await invite(C.collidesWorkerInvite);

    for (const [c, payer] of [
      [C.agencyInvite, AGENCY],
      [C.agencyInviteForInstitute, AGENCY],
      [C.agencyInviteHelper, AGENCY],
      [C.agencyInviteSpent, AGENCY],
      [C.agencySuspended, AGENCY_SUSPENDED],
      [C.employerInvite, EMPLOYER],
      [C.collidesWorkerInvite, AGENCY],
      [C.collidesResumeQr, AGENCY],
    ] as const) {
      await sql`INSERT INTO agency_invites (inviter_payer_id, code) VALUES (${payer}::uuid, ${c})`;
    }
    await sql`
      UPDATE agency_invites SET invited_worker_id = ${INVITER}::uuid, status = 'accepted'
      WHERE code = ${C.agencyInviteSpent}`;

    for (const [c, kind, payer, owner, expires] of [
      [C.agentLink, "agent", AGENCY, null, null],
      [C.agentLinkExpired, "agent", AGENCY, null, "2020-01-01T00:00:00Z"],
      [C.collidesResumeQr, "resume_qr", null, INVITER, null],
    ] as const) {
      const [row] = await sql<{ id: string }[]>`
        INSERT INTO referral_links (code, kind, agent_payer_id, owner_worker_id, expires_at)
        VALUES (${c}, ${kind}, ${payer}::uuid, ${owner}::uuid, ${expires}::timestamptz)
        RETURNING id`;
      linkIds.push(row!.id);
    }
  });

  afterAll(async () => {
    if (!client) return;
    const { sql } = client;
    try {
      await sql`DELETE FROM events WHERE subject_id = ANY(${inviteIds}::uuid[])`;
      await sql`
        DELETE FROM events WHERE subject_id IN (
          SELECT id FROM agency_invites WHERE inviter_payer_id = ANY(${PAYERS}::uuid[]))`;
      await sql`DELETE FROM referral_clicks WHERE code = ANY(${Object.values(C)})`;
      await sql`DELETE FROM referral_links WHERE id = ANY(${linkIds}::uuid[])`;
      await sql`DELETE FROM invites WHERE id = ANY(${inviteIds}::uuid[])`;
      await sql`DELETE FROM payers WHERE id = ANY(${PAYERS}::uuid[])`;
      await sql`DELETE FROM workers WHERE id = ANY(${WORKERS}::uuid[])`;
    } finally {
      await sql.end({ timeout: 5 });
    }
  });

  const originOf = async (workerId: string) =>
    client.db
      .select({ kind: workerOrigins.kind, ref: workerOrigins.ref })
      .from(workerOrigins)
      .where(eq(workerOrigins.workerId, workerId));

  describe("came-from", () => {
    it("a worker's invite → attributed, and one `referrer` origin with the code", async () => {
      const out = await attribution.attribute(C.workerInvite, W_REFERRED, "app_link");
      expect(out).toMatchObject({ attributed: true, kind: "worker" });
      expect(await originOf(W_REFERRED)).toEqual([{ kind: "referrer", ref: C.workerInvite }]);
    });

    it("an agency's invite → attributed, and one `partner` origin with the code", async () => {
      const out = await attribution.attribute(C.agencyInvite, W_PARTNERED, "install_referrer");
      expect(out).toMatchObject({ attributed: true, kind: "agency" });
      expect(await originOf(W_PARTNERED)).toEqual([{ kind: "partner", ref: C.agencyInvite }]);
    });

    it("a repeat, and a second code later, leave the first origin as it was", async () => {
      await attribution.attribute(C.workerInvite, W_PARTNERED);
      await attribution.attribute(C.agencyInvite, W_PARTNERED);
      expect(await originOf(W_PARTNERED)).toEqual([{ kind: "partner", ref: C.agencyInvite }]);
    });

    it("an institute origin is never overwritten by a code (first origin wins)", async () => {
      const out = await attribution.attribute(C.agencyInviteForInstitute, W_INSTITUTE);
      expect(out).toMatchObject({ attributed: true, kind: "agency" });
      expect(await originOf(W_INSTITUTE)).toEqual([{ kind: "institute", ref: "rvm" }]);
    });

    it("no consent → not attributed, and no origin", async () => {
      const out = await attribution.attribute(C.workerInviteForNoConsent, W_NO_CONSENT);
      expect(out).toMatchObject({ attributed: false, reason: "no_consent" });
      expect(await originOf(W_NO_CONSENT)).toEqual([]);
    });

    it("an unknown code and a spent invite → not attributed, and no origin", async () => {
      expect(await attribution.attribute(C.unknown, W_UNKNOWN)).toMatchObject({
        attributed: false,
      });
      expect(await attribution.attribute(C.agencyInviteSpent, W_UNKNOWN)).toMatchObject({
        attributed: false,
      });
      expect(await originOf(W_UNKNOWN)).toEqual([]);
    });
  });

  describe("the helper's name", () => {
    it("an unaccepted agency invite → the agency's decrypted company name", async () => {
      expect(await helperName.displayName(C.agencyInviteHelper)).toBe(AGENCY_NAME);
    });

    it("an unexpired `agent` link → the agency's company name", async () => {
      expect(await helperName.displayName(C.agentLink)).toBe(AGENCY_NAME);
    });

    it.each([
      ["a worker's invite", () => C.workerInvite],
      ["an unknown code", () => C.unknown],
      ["a spent (accepted) agency invite", () => C.agencyInviteSpent],
      ["an expired agent link", () => C.agentLinkExpired],
      ["a suspended agency's invite", () => C.agencySuspended],
      ["an employer's invite", () => C.employerInvite],
      ["an agency code that is also a worker's invite", () => C.collidesWorkerInvite],
      ["an agency code that is also a résumé QR", () => C.collidesResumeQr],
      ["a malformed code", () => "NOT-A-CODE"],
    ])("%s → null", async (_n, pick) => {
      expect(await helperName.displayName(pick())).toBeNull();
    });
  });
});
