import "reflect-metadata";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  HttpException,
  Logger,
  NotFoundException,
} from "@nestjs/common";
import { loadServerConfig } from "@badabhai/config";
import { validateEvent } from "@badabhai/event-schema";
import type { RequestContext } from "../common/request-context";
import type { EventsService } from "../events/events.service";
import type { PostingAudienceRepository } from "../job-postings/posting-audience.repository";
import type { PayerTenantScopeService } from "../payers/payer-tenant-scope.service";
import { defaultModeResolver, resolverOver } from "../payers/payer-tenant-scope.test-support";
import { CampusDriveRequestsQuerySchema } from "../campus-link/campus-link.contract";
import { PayerCreateCampusDriveRequestSchema } from "./campus-drive-requests.dto";
import { CampusDriveDecisionsService } from "./campus-drive-decisions.service";
import { indiaDay } from "./campus-drive-dates";
import { CampusDriveRequestsService } from "./campus-drive-requests.service";
import {
  MemoryDriveRequests,
  capturingEvents,
  memoryIdempotency,
  rolloutWith,
  testPii,
  uuid,
} from "./campus-drive-requests.test-support";

const CTX: RequestContext = { correlationId: uuid(0x27460c01), requestId: "drive-unit" };
const COMPANY = uuid(0x27460c02);
const OTHER_COMPANY = uuid(0x27460c03);
const AGENCY = uuid(0x27460c04);
const MEMBER = uuid(0x27460c05);
const OWN_POSTING = uuid(0x27460c06);
const FOREIGN_POSTING = uuid(0x27460c07);
const ON = { CAMPUS_DRIVE_REQUESTS_ROLLOUT: "on" };

/** The reviewer's probe numbers (security review M1), built from code points. */
const DEVANAGARI_PHONE = String.fromCodePoint(
  ...[9, 8, 7, 6, 5, 4, 3, 2, 1, 0].map((d) => 0x966 + d),
);
const FULLWIDTH_PHONE = String.fromCodePoint(
  ...[9, 8, 7, 6, 5, 4, 3, 2, 1, 0].map((d) => 0xff10 + d),
);
const COMBINING_PHONE = "9876543210".split("").join(String.fromCharCode(0x301));

const CONTACT_NAME = "Ravi Sharma";
const CONTACT_PHONE = "+919812345678";
const NOTE = "CNC operators and setters for two shifts";

/** A body as the controller's pipe hands it over. */
function body(over: Record<string, unknown> = {}) {
  return PayerCreateCampusDriveRequestSchema.parse({
    branch_ids: [3, 1, 3],
    preferred_from: "2026-12-01",
    preferred_to: "2026-12-15",
    openings: 12,
    roles_note: NOTE,
    contact_name: CONTACT_NAME,
    contact_phone: CONTACT_PHONE,
    ...over,
  });
}

function world(
  options: {
    settings?: Record<string, string>;
    pilot?: string[];
    tenancy?: PayerTenantScopeService;
    activeBranches?: number[];
  } = {},
) {
  const table = new MemoryDriveRequests();
  const verified = {
    verificationStatus: "verified" as const,
    hasGstNumber: true,
    isTestAccount: false,
  };
  table.facts.set(COMPANY, { role: "employer", ...verified });
  table.facts.set(OTHER_COMPANY, { role: "employer", ...verified });
  table.facts.set(AGENCY, { role: "agent", ...verified });
  table.postings.set(OWN_POSTING, COMPANY);
  table.postings.set(FOREIGN_POSTING, OTHER_COMPANY);
  const active = new Set((options.activeBranches ?? [1, 2, 3, 4]).map(String));
  const options_ = {
    activeOptionRefs: vi.fn(async (_kind: string, refs: readonly string[]) => {
      return new Set(refs.filter((r) => active.has(r)));
    }),
  };
  const events = capturingEvents();
  const pii = testPii();
  // Campus's feed decrypts each company's display name.
  table.companyNames.set(COMPANY, pii.encrypt("Fixture Works"));
  table.companyNames.set(OTHER_COMPANY, pii.encrypt("Other Works"));
  const idempotency = memoryIdempotency(pii);
  const service = new CampusDriveRequestsService(
    table.asRepository(),
    options_ as unknown as PostingAudienceRepository,
    rolloutWith(options.settings ?? ON, options.pilot ?? []),
    options.tenancy ?? defaultModeResolver(),
    idempotency.seam,
    pii,
    events.service as unknown as EventsService,
  );
  // Campus's side of the same table: no switch, no tenancy (owner ruling R1).
  const campus = new CampusDriveDecisionsService(
    table.asRepository(),
    pii,
    events.service as unknown as EventsService,
  );
  /** The same table, with the switch at other settings (a pilot removal, a global off). */
  const withSettings = (settings: Record<string, string>, pilot: string[] = []) =>
    new CampusDriveRequestsService(
      table.asRepository(),
      options_ as unknown as PostingAudienceRepository,
      rolloutWith(settings, pilot),
      options.tenancy ?? defaultModeResolver(),
      idempotency.seam,
      pii,
      events.service as unknown as EventsService,
    );
  return { table, events, service, idempotency, pii, options: options_, campus, withSettings };
}

/** Every log line written while `run` runs, at every level. */
async function logsOf(run: () => Promise<unknown>): Promise<string[]> {
  const lines: string[] = [];
  const spies = (["log", "warn", "error", "debug", "verbose"] as const).map((level) =>
    vi.spyOn(Logger.prototype, level).mockImplementation((...args: unknown[]) => {
      lines.push(args.map(String).join(" "));
    }),
  );
  try {
    await run().catch(() => undefined);
  } finally {
    for (const spy of spies) spy.mockRestore();
  }
  return lines;
}

async function refusal(run: () => Promise<unknown>): Promise<HttpException> {
  try {
    await run();
  } catch (err) {
    if (err instanceof HttpException) return err;
    throw err;
  }
  throw new Error("expected a refusal");
}

beforeEach(() => {
  // 06:00 UTC = 11:30 IST on 14 Nov 2026.
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-11-14T06:00:00.000Z"));
});

afterEach(() => {
  vi.useRealTimers();
});

describe("the switch gates NEW requests only (owner ruling R1, 14 Nov 2026)", () => {
  it.each([["off"], ["pilot"]])(
    "%s, company not listed: create is 404 and writes nothing",
    async (mode) => {
      const { service, table, events } = world({
        settings: { CAMPUS_DRIVE_REQUESTS_ROLLOUT: mode },
      });
      await expect(service.create(COMPANY, body(), "key-0000001", CTX)).rejects.toBeInstanceOf(
        NotFoundException,
      );
      expect(table.rows).toEqual([]);
      expect(events.emitted).toEqual([]);
    },
  );

  it("removed from the pilot: the company still lists, reads and cancels, and the cancel reaches Campus's feed", async () => {
    const { withSettings, campus } = world();
    const pilot = { CAMPUS_DRIVE_REQUESTS_ROLLOUT: "pilot" };
    const made = await withSettings(pilot, [COMPANY]).create(COMPANY, body(), "key-0000001", CTX);
    const removed = withSettings(pilot, []);
    await expect(removed.create(COMPANY, body(), "key-0000002", CTX)).rejects.toBeInstanceOf(
      NotFoundException,
    );
    expect((await removed.list(COMPANY, { limit: 20 })).drive_requests.map((r) => r.id)).toEqual([
      made.id,
    ]);
    await expect(removed.getOne(COMPANY, made.id)).resolves.toMatchObject({ id: made.id });
    await expect(removed.cancel(COMPANY, made.id, CTX)).resolves.toMatchObject({
      status: "cancelled",
    });
    const item = (await campus.list(CampusDriveRequestsQuerySchema.parse({}))).drive_requests[0]!;
    expect(item).toMatchObject({ id: made.id, status: "cancelled" });
  });

  it("switched off everywhere: create is 404, and Campus's feed still carries the existing requests", async () => {
    const { withSettings, campus } = world();
    const made = await withSettings(ON).create(COMPANY, body(), "key-0000001", CTX);
    const off = withSettings({ CAMPUS_DRIVE_REQUESTS_ROLLOUT: "off" });
    await expect(off.create(COMPANY, body(), "key-0000002", CTX)).rejects.toBeInstanceOf(
      NotFoundException,
    );
    const page = await campus.list(CampusDriveRequestsQuerySchema.parse({}));
    expect(page.drive_requests.map((r) => r.id)).toEqual([made.id]);
    expect(page.drive_requests[0]!.contact).toEqual({ name: CONTACT_NAME, phone: CONTACT_PHONE });
  });

  it("an erasure while the switch is off reaches Campus's feed as contact: null", async () => {
    const { withSettings, campus, table } = world();
    const made = await withSettings(ON).create(COMPANY, body(), "key-0000001", CTX);
    const since = (await campus.list(CampusDriveRequestsQuerySchema.parse({}))).drive_requests[0]!
      .changed_at;
    table.eraseContact(made.id); // what the account deletion's erasure writes
    const later = await campus.list(CampusDriveRequestsQuerySchema.parse({ changed_since: since }));
    expect(later.drive_requests.find((r) => r.id === made.id)?.contact).toBeNull();
    await expect(
      withSettings({ CAMPUS_DRIVE_REQUESTS_ROLLOUT: "off" }).getOne(COMPANY, made.id),
    ).resolves.toMatchObject({ contact: null });
  });

  it("pilot admits exactly the listed company", async () => {
    const { service } = world({
      settings: { CAMPUS_DRIVE_REQUESTS_ROLLOUT: "pilot" },
      pilot: [COMPANY],
    });
    await expect(service.create(COMPANY, body(), "key-0000001", CTX)).resolves.toMatchObject({
      status: "requested",
    });
    await expect(service.create(OTHER_COMPANY, body(), "key-0000001", CTX)).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });
});

describe("create", () => {
  it("stores the request, contact as ciphertext only, and emits campus_drive.requested in the same transaction", async () => {
    const { service, table, events } = world();
    const answer = await service.create(
      COMPANY,
      body({ job_posting_id: OWN_POSTING }),
      "key-0000001",
      CTX,
    );

    expect(table.rows).toHaveLength(1);
    const row = table.rows[0]!;
    expect(row).toMatchObject({
      payerId: COMPANY,
      createdBy: COMPANY,
      jobPostingId: OWN_POSTING,
      branchIds: [1, 3],
      openings: 12,
      rolesNote: NOTE,
      isTest: false,
      idempotencyKey: "key-0000001",
      status: "requested",
    });
    // Ciphertext at rest: the tokens never contain the values.
    expect(row.contactNameEnc).toMatch(/^v1\./);
    expect(row.contactPhoneEnc).toMatch(/^v1\./);
    expect(JSON.stringify(row)).not.toContain(CONTACT_NAME);
    expect(JSON.stringify(row)).not.toContain("9812345678");

    expect(events.emitted).toHaveLength(1);
    const event = events.emitted[0]!;
    expect(event.event_name).toBe("campus_drive.requested");
    expect(event.tx).toBeDefined();
    expect(event.payload).toEqual({
      campus_drive_request_id: row.id,
      payer_id: COMPANY,
      job_posting_id: OWN_POSTING,
      branch_ids: [1, 3],
      preferred_from: "2026-12-01",
      preferred_to: "2026-12-15",
      openings: 12,
      has_roles_note: true,
      is_test: false,
    });
    expect(event.actor).toEqual({ actor_type: "payer", actor_id: COMPANY });
    expect(event.subject).toEqual({ subject_type: "payer", subject_id: COMPANY });

    // The company reads back its contact only in part.
    expect(answer.contact).toEqual({ name: CONTACT_NAME, phone_last4: "5678" });
    expect(answer).toMatchObject({ id: row.id, status: "requested", scheduled_on: null });
  });

  it("copies the company's test marker onto the row and the event", async () => {
    const { service, table, events } = world();
    table.facts.set(COMPANY, {
      role: "employer",
      verificationStatus: "verified",
      hasGstNumber: true,
      isTestAccount: true,
    });
    await service.create(COMPANY, body(), "key-0000001", CTX);
    expect(table.rows[0]!.isTest).toBe(true);
    expect((events.emitted[0]!.payload as { is_test: boolean }).is_test).toBe(true);
  });

  it("the event is a valid campus_drive.requested and carries no contact and no note", async () => {
    const { service, events } = world();
    await service.create(COMPANY, body(), "key-0000001", CTX);
    const e = events.emitted[0]!;
    const wire = JSON.stringify(e);
    for (const secret of [CONTACT_NAME, "9812345678", NOTE]) expect(wire).not.toContain(secret);
    const envelope = {
      event_id: uuid(1),
      event_name: e.event_name,
      event_version: 1,
      occurred_at: "2026-11-14T06:00:00.000Z",
      actor: e.actor,
      subject: e.subject,
      source: "api",
      correlation_id: CTX.correlationId,
      payload: e.payload,
      metadata: { environment: "test", service: "api" },
    };
    expect(validateEvent(envelope).success).toBe(true);
  });

  it("logs ids only: no contact, no phone, no note, whatever the outcome", async () => {
    const { service, table } = world();
    const lines = [
      ...(await logsOf(() => service.create(COMPANY, body(), "key-0000001", CTX))),
      ...(await logsOf(() => service.create(COMPANY, body(), "key-0000001", CTX))),
      ...(await logsOf(() => service.create(COMPANY, body({ openings: 3 }), "key-0000001", CTX))),
    ];
    table.facts.set(COMPANY, {
      role: "employer",
      verificationStatus: "pending",
      hasGstNumber: false,
      isTestAccount: false,
    });
    lines.push(...(await logsOf(() => service.create(COMPANY, body(), "key-0000002", CTX))));
    expect(lines.length).toBeGreaterThan(0);
    for (const line of lines) {
      for (const secret of [CONTACT_NAME, "9812345678", "5678", NOTE]) {
        expect(line).not.toContain(secret);
      }
    }
  });
});

describe("who may ask: a verified employer only", () => {
  it.each([
    ["pending review, no GST", "pending", false, ["admin_approval", "gst_number"]],
    ["approved, no GST", "verified", false, ["gst_number"]],
    ["GST but rejected", "rejected", true, ["admin_approval"]],
    ["no company record", null, false, ["admin_approval", "gst_number"]],
  ] as const)("%s → 403 company_not_verified, nothing stored", async (_n, status, gst, missing) => {
    const { service, table, events } = world();
    table.facts.set(COMPANY, {
      role: "employer",
      verificationStatus: status,
      hasGstNumber: gst,
      isTestAccount: false,
    });
    const err = await refusal(() => service.create(COMPANY, body(), "key-0000001", CTX));
    expect(err).toBeInstanceOf(ForbiddenException);
    expect(err.getResponse()).toMatchObject({ reason: "company_not_verified", missing });
    expect(table.rows).toEqual([]);
    expect(events.emitted).toEqual([]);
  });

  it("an agency tenant is refused by the service too, with the PayerRoleGuard's own 403", async () => {
    const { service, table } = world();
    const err = await refusal(() => service.create(AGENCY, body(), "key-0000001", CTX));
    expect(err).toBeInstanceOf(ForbiddenException);
    expect(err.message).toBe("Payer role is not permitted for this resource");
    expect(table.rows).toEqual([]);
  });

  it("a team member under org tenancy `on` is judged by the company's record and files for the company", async () => {
    const tenancy = resolverOver(
      loadServerConfig({ NODE_ENV: "test", PAYER_ORG_TENANCY_MODE: "on" }),
      [{ anchor: COMPANY, members: [MEMBER] }],
    );
    const { service, table, events } = world({ tenancy });
    await service.create(MEMBER, body(), "key-0000001", CTX);
    expect(table.rows[0]).toMatchObject({ payerId: COMPANY, createdBy: MEMBER });
    expect(events.emitted[0]!.actor).toEqual({ actor_type: "payer", actor_id: MEMBER });
    // The founder sees the member's request; the member reads it back too.
    expect((await service.list(COMPANY, { limit: 20 })).drive_requests).toHaveLength(1);
    expect((await service.list(MEMBER, { limit: 20 })).drive_requests).toHaveLength(1);
  });

  it.each(["suspended", "archived", "pending"] as const)(
    "under tenancy `on`, a team member of a company whose account is %s gets 403 company_not_active: the anchor's status is read, as R2 reads it (migration review L2)",
    async (status) => {
      const tenancy = resolverOver(
        loadServerConfig({ NODE_ENV: "test", PAYER_ORG_TENANCY_MODE: "on" }),
        [{ anchor: COMPANY, members: [MEMBER] }],
      );
      const { service, table, events } = world({ tenancy });
      // The member's own login is active and verified-looking; the COMPANY (the anchor) is not.
      table.facts.set(MEMBER, {
        role: "employer",
        verificationStatus: "verified",
        hasGstNumber: true,
        isTestAccount: false,
      });
      table.facts.set(COMPANY, {
        role: "employer",
        status,
        verificationStatus: "verified",
        hasGstNumber: true,
        isTestAccount: false,
      });
      const err = await refusal(() => service.create(MEMBER, body(), "key-0000001", CTX));
      expect(err).toBeInstanceOf(ForbiddenException);
      expect(err.getResponse()).toMatchObject({ reason: "company_not_active" });
      expect(table.rows).toEqual([]);
      expect(events.emitted).toEqual([]);
    },
  );

  it("the standing is read on the INSERT's transaction, not before it opened (migration re-check F7)", async () => {
    const { service, table } = world();
    const facts = vi.spyOn(table, "requesterFacts");
    const posting = vi.spyOn(table, "isOwnPosting");
    await service.create(COMPANY, body({ job_posting_id: OWN_POSTING }), "key-0000001", CTX);
    expect(facts).toHaveBeenCalledTimes(1);
    expect(facts.mock.calls[0]![1]).toEqual({ memoryTx: true });
    expect(posting.mock.calls[0]![2]).toEqual({ memoryTx: true });
    expect(table.transactions).toBe(1);
  });

  it("the account is checked before the verification: a suspended, unverified company hears company_not_active", async () => {
    const { service, table } = world();
    table.facts.set(COMPANY, {
      role: "employer",
      status: "suspended",
      verificationStatus: "pending",
      hasGstNumber: false,
      isTestAccount: false,
    });
    const err = await refusal(() => service.create(COMPANY, body(), "key-0000001", CTX));
    expect(err.getResponse()).toMatchObject({ reason: "company_not_active" });
    expect(table.rows).toEqual([]);
  });
});

describe("the body's rules", () => {
  it("preferred_from may be today in India, never before", async () => {
    const { service } = world();
    await expect(
      service.create(COMPANY, body({ preferred_from: "2026-11-14" }), "key-0000001", CTX),
    ).resolves.toBeDefined();
    const err = await refusal(() =>
      service.create(COMPANY, body({ preferred_from: "2026-11-13" }), "key-0000002", CTX),
    );
    expect(err).toBeInstanceOf(BadRequestException);
    expect(err.getResponse()).toMatchObject({ reason: "preferred_dates_in_past" });
  });

  it("preferred_to may be at most a year after today in India (security review L2)", async () => {
    const { service } = world();
    await expect(
      service.create(COMPANY, body({ preferred_to: "2027-11-14" }), "key-0000001", CTX),
    ).resolves.toBeDefined();
    const err = await refusal(() =>
      service.create(COMPANY, body({ preferred_to: "2027-11-15" }), "key-0000002", CTX),
    );
    expect(err).toBeInstanceOf(BadRequestException);
    expect(err.getResponse()).toMatchObject({ reason: "preferred_dates_too_far" });
  });

  it("today is India's: just after midnight IST, yesterday's UTC date is already the past", async () => {
    // 2026-11-13T19:00Z is 00:30 IST on the 14th.
    vi.setSystemTime(new Date("2026-11-13T19:00:00.000Z"));
    expect(indiaDay()).toBe("2026-11-14");
    const { service } = world();
    const err = await refusal(() =>
      service.create(
        COMPANY,
        body({ preferred_from: "2026-11-13", preferred_to: "2026-11-20" }),
        "key-0000001",
        CTX,
      ),
    );
    expect(err.getResponse()).toMatchObject({ reason: "preferred_dates_in_past" });
  });

  it("from after to, a non-date, an unknown key, zero openings: the schema refuses them", () => {
    const parse = (over: Record<string, unknown>) =>
      PayerCreateCampusDriveRequestSchema.safeParse({
        preferred_from: "2026-12-01",
        preferred_to: "2026-12-15",
        openings: 12,
        contact_name: CONTACT_NAME,
        contact_phone: CONTACT_PHONE,
        ...over,
      }).success;
    expect(parse({})).toBe(true);
    expect(parse({ preferred_from: "2026-12-16" })).toBe(false);
    expect(parse({ preferred_to: "2026-02-30" })).toBe(false);
    expect(parse({ payer_id: COMPANY })).toBe(false);
    expect(parse({ openings: 0 })).toBe(false);
    expect(parse({ openings: 1001 })).toBe(false);
    expect(parse({ contact_phone: "9812345678" })).toBe(false);
    expect(parse({ branch_ids: Array.from({ length: 51 }, (_, i) => i + 1) })).toBe(false);
    expect(parse({ roles_note: "x".repeat(1001) })).toBe(false);
  });

  it.each([
    ["a phone number", "Call 98123 45678 for details", "phone"],
    ["an email", "Mail hr@sharma-works.example", "email"],
    ["a salary range in digits (reads as a phone)", "Pay 15000-18000", "phone"],
    // Security review M1: the reviewer's probe cases (p6/probe.mts), every one a phone or an email
    // the shared detector missed on the raw note. Built from code points.
    ["Devanagari digits", `call ${DEVANAGARI_PHONE}`, "phone"],
    ["full-width digits", `call ${FULLWIDTH_PHONE}`, "phone"],
    ["a combining mark after each digit", `call ${COMBINING_PHONE}`, "phone"],
    ["a ZWJ inside the number", `call 98765${String.fromCharCode(0x200d)}43210`, "phone"],
    ["a Mongolian vowel separator", `call 98765${String.fromCharCode(0x180e)}43210`, "phone"],
    ["a full-width at sign", `mail ravi${String.fromCharCode(0xff20)}example.com`, "email"],
    ["ASCII and Devanagari digits mixed", `call 98765${DEVANAGARI_PHONE.slice(5)}`, "phone"],
    // Security re-check N1: IDs written with `/`, which the detector matches on the note itself
    // (a copy alone, with `/` read as a space, lost every one). Both are screened.
    ["a bank account (A/c no, letters)", "A/c no SBIN12345", "credential_id"],
    ["a bank account (A/c no, digits)", "A/c no 12345678", "credential_id"],
    ["a vehicle registration", "Reg No: MH/2019/1234", "credential_id"],
    ["a registration number", "Regn. No. MH/12/AB/1234", "credential_id"],
    ["a roll number", "Roll no 21/CS/045", "credential_id"],
    ["an enrolment number", "Enrolment no 2021/ME/0456", "credential_id"],
    ["a passport number", "Passport no K/1234567", "credential_id"],
    ["a voter ID", "Voter ID No: XYZ/987/6543", "credential_id"],
    // Security re-check I1: NFKC composes A + U+0301 into one letter, so the copy loses the PAN;
    // only the screen of the note as stored catches it. Built from code points.
    ["a PAN with a combining mark after it", `PAN ABCDE1234A${String.fromCharCode(0x301)}`, "pan"],
  ])("roles_note with %s → 400 roles_note_has_identifier", async (_n, note, identifier) => {
    const { service, table } = world();
    const err = await refusal(() =>
      service.create(COMPANY, body({ roles_note: note }), "key-0000001", CTX),
    );
    expect(err).toBeInstanceOf(BadRequestException);
    expect(err.getResponse()).toMatchObject({ reason: "roles_note_has_identifier", identifier });
    // The 400 never repeats the text that matched.
    expect(JSON.stringify(err.getResponse())).not.toContain(note);
    expect(table.rows).toEqual([]);
  });

  it.each([
    ["class years", "2024/2025/2026 pass-outs"],
    ["a salary range with a slash", "12000/18000"],
    ["a date range", "12/11/2026 - 15/11/2026"],
    ["machine models", "VMC 850/1060/1260"],
    ["two PIN codes", "411057/411018"],
  ])(
    "roles_note with %s is accepted: `/` is not a separator (owner decision, re-check N2/N3)",
    async (_n, note) => {
      const { service, table } = world();
      await service.create(COMPANY, body({ roles_note: note }), "key-0000001", CTX);
      expect(table.rows[0]!.rolesNote).toBe(note);
    },
  );

  it.each([
    ["a slash", "/"],
    ["a backslash", String.fromCharCode(0x5c)],
    ["a division slash (U+2215)", String.fromCharCode(0x2215)],
    ["a fraction slash (U+2044)", String.fromCharCode(0x2044)],
    ["a colon", ":"],
    ["a tilde", "~"],
    ["an asterisk", "*"],
    ["a plus", "+"],
    ["an equals sign", "="],
    ["a katakana middle dot (U+30FB)", String.fromCharCode(0x30fb)],
  ])(
    "KNOWN GAP (risk R86, #2812): a phone split by %s is NOT refused yet; flip this when #2812 lands",
    async (_n, separator) => {
      const { service, table } = world();
      const note = `call 98765${separator}43210`;
      await service.create(COMPANY, body({ roles_note: note }), "key-0000001", CTX);
      expect(table.rows[0]!.rolesNote).toBe(note);
    },
  );

  it("the refusal tells the company to write a range with words (re-check I2)", async () => {
    const { service } = world();
    const err = await refusal(() =>
      service.create(COMPANY, body({ roles_note: "Pay 15,000-18,000" }), "key-0000001", CTX),
    );
    expect(err.getResponse()).toMatchObject({
      reason: "roles_note_has_identifier",
      message: expect.stringContaining("with words (15,000 to 18,000)"),
    });
  });

  it("the screen reads a NORMALISED copy; the stored note is the cleaned ORIGINAL", async () => {
    const { service, table } = world();
    // Full-width letters NFKC-fold to ASCII for the screen, and stay full-width in storage.
    const fullwidthCnc = String.fromCodePoint(0xff23, 0xff2e, 0xff23);
    const note = `${fullwidthCnc} operators, ${String.fromCodePoint(0x967, 0x968)} shifts, 9/5 duty`;
    await service.create(COMPANY, body({ roles_note: note }), "key-0000001", CTX);
    expect(table.rows[0]!.rolesNote).toBe(note);
  });

  it("a note with numbers in words is accepted; hidden characters go, the Indic joiners stay (PR 5's note rule)", async () => {
    const { service, table } = world();
    const RLO = String.fromCharCode(0x202e);
    const ZWNJ = String.fromCharCode(0x200c);
    const ZWJ = String.fromCharCode(0x200d);
    await service.create(
      COMPANY,
      body({ roles_note: `Pay 15,000 to 18,000 ${RLO}a month, kaa${ZWNJ}m${ZWJ}gar` }),
      "key-0000001",
      CTX,
    );
    expect(table.rows[0]!.rolesNote).toBe(`Pay 15,000 to 18,000 a month, kaa${ZWNJ}m${ZWJ}gar`);
  });

  it.each([
    ["zero-width spaces", String.fromCharCode(0x200b, 0x200b)],
    [
      "joiners and a space (kept characters that render blank)",
      String.fromCharCode(0x200c, 0x20, 0x200d),
    ],
  ])("a contact name of %s is refused", async (_name, contactName) => {
    const { service, table } = world();
    const err = await refusal(() =>
      service.create(COMPANY, body({ contact_name: contactName }), "key-0000001", CTX),
    );
    expect(err.getResponse()).toMatchObject({ reason: "contact_name_required" });
    expect(table.rows).toEqual([]);
  });

  it("a roles note of joiners and spaces only is stored as no note", async () => {
    const { service, table } = world();
    await service.create(
      COMPANY,
      body({ roles_note: String.fromCharCode(0x200c, 0x20, 0x200d) }),
      "key-0000001",
      CTX,
    );
    expect(table.rows[0]!.rolesNote).toBeNull();
  });

  it("job_posting_id must be the company's OWN posting: foreign and unknown are the same 404", async () => {
    const { service, table } = world();
    for (const id of [FOREIGN_POSTING, uuid(0xdead)]) {
      await expect(
        service.create(COMPANY, body({ job_posting_id: id }), `key-${id.slice(-7)}`, CTX),
      ).rejects.toBeInstanceOf(NotFoundException);
    }
    expect(table.rows).toEqual([]);
  });

  it("each branch must be an ACTIVE option; [] is any branch", async () => {
    const { service, table, options } = world({ activeBranches: [1, 2] });
    const err = await refusal(() =>
      service.create(COMPANY, body({ branch_ids: [1, 9] }), "key-0000001", CTX),
    );
    expect(err.getResponse()).toMatchObject({ reason: "targeting_option_not_offered" });
    expect(String((err.getResponse() as { message: string }).message)).toContain("9");
    await service.create(COMPANY, body({ branch_ids: [] }), "key-0000002", CTX);
    expect(table.rows[0]!.branchIds).toEqual([]);
    expect(options.activeOptionRefs).toHaveBeenCalledWith("branch", ["1", "9"]);
  });
});

describe("Idempotency-Key", () => {
  it("the same key and body twice is ONE request, one event, the same answer", async () => {
    const { service, table, events } = world();
    const first = await service.create(COMPANY, body(), "key-0000001", CTX);
    const second = await service.create(COMPANY, body(), "key-0000001", CTX);
    expect(second).toEqual(first);
    expect(table.rows).toHaveLength(1);
    expect(events.emitted).toHaveLength(1);
  });

  it("the stored Redis answer is encrypted: the contact's name is not in it", async () => {
    const { service, idempotency } = world();
    await service.create(COMPANY, body(), "key-0000001", CTX);
    const stored = [...idempotency.store.values()].join("|");
    expect(stored.length).toBeGreaterThan(0);
    expect(stored).not.toContain(CONTACT_NAME);
    expect(stored).not.toContain("5678");
  });

  it("after Redis forgets, the TABLE still answers the first request (no second row, no event)", async () => {
    const { service, table, events, idempotency } = world();
    const first = await service.create(COMPANY, body(), "key-0000001", CTX);
    idempotency.forget();
    // Even after the dates passed and the company lost its approval: a repeat is not a new ask.
    vi.setSystemTime(new Date("2026-12-20T06:00:00.000Z"));
    table.facts.set(COMPANY, {
      role: "employer",
      verificationStatus: "pending",
      hasGstNumber: false,
      isTestAccount: false,
    });
    const again = await service.create(COMPANY, body(), "key-0000001", CTX);
    expect(again.id).toBe(first.id);
    expect(table.rows).toHaveLength(1);
    expect(events.emitted).toHaveLength(1);
  });

  it.each([["inside the Redis window"], ["after it"]])(
    "the same key with a DIFFERENT body is 409 idempotency_key_reused, %s",
    async (when) => {
      const { service, table, idempotency } = world();
      await service.create(COMPANY, body(), "key-0000001", CTX);
      if (when === "after it") idempotency.forget();
      for (const changed of [
        { openings: 13 },
        { contact_phone: "+919812345679" },
        { contact_name: "Someone Else" },
        { roles_note: undefined },
        { branch_ids: [1] },
      ]) {
        const err = await refusal(() => service.create(COMPANY, body(changed), "key-0000001", CTX));
        expect(err).toBeInstanceOf(ConflictException);
        expect(err.getResponse()).toMatchObject({ reason: "idempotency_key_reused" });
      }
      expect(table.rows).toHaveLength(1);
    },
  );

  it("the same key in two companies is two requests (the key space is per company)", async () => {
    const { service, table } = world();
    await service.create(COMPANY, body(), "key-0000001", CTX);
    await service.create(OTHER_COMPANY, body(), "key-0000001", CTX);
    expect(table.rows.map((r) => r.payerId).sort()).toEqual([COMPANY, OTHER_COMPANY].sort());
  });

  it("a refused attempt writes nothing, so the same key works for the corrected body", async () => {
    const { service, table } = world();
    await expect(
      service.create(COMPANY, body({ roles_note: "Call 98123 45678" }), "key-0000001", CTX),
    ).rejects.toBeInstanceOf(BadRequestException);
    await service.create(COMPANY, body(), "key-0000001", CTX);
    expect(table.rows).toHaveLength(1);
  });

  it("a duplicate that lands while the first is still running is the house 409 in_flight", async () => {
    const { service, table } = world();
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const insert = table.insert.bind(table);
    table.insert = async (...args: Parameters<typeof insert>) => {
      await gate;
      return insert(...args);
    };
    const first = service.create(COMPANY, body(), "key-0000001", CTX);
    // Let the first reach its reservation and park inside the insert.
    await new Promise((r) => setImmediate(r));
    const err = await refusal(() => service.create(COMPANY, body(), "key-0000001", CTX));
    expect(err).toBeInstanceOf(ConflictException);
    expect(err.getResponse()).toMatchObject({ reason: "in_flight" });
    release();
    await first;
    expect(table.rows).toHaveLength(1);
  });
});

describe("list and read: the company's own only", () => {
  it("lists newest first with a keyset cursor, and never another company's", async () => {
    const { service } = world();
    for (let i = 1; i <= 5; i += 1) {
      await service.create(COMPANY, body({ openings: i }), `key-000000${i}`, CTX);
    }
    await service.create(OTHER_COMPANY, body(), "key-0000009", CTX);

    const page1 = await service.list(COMPANY, { limit: 2 });
    expect(page1.drive_requests.map((r) => r.openings)).toEqual([5, 4]);
    expect(page1.next_cursor).not.toBeNull();
    const { decodeDriveCursor } = await import("./campus-drive-cursor");
    const page2 = await service.list(COMPANY, {
      limit: 2,
      cursor: decodeDriveCursor("company", page1.next_cursor!)!,
    });
    expect(page2.drive_requests.map((r) => r.openings)).toEqual([3, 2]);
    const page3 = await service.list(COMPANY, {
      limit: 2,
      cursor: decodeDriveCursor("company", page2.next_cursor!)!,
    });
    expect(page3.drive_requests.map((r) => r.openings)).toEqual([1]);
    expect(page3.next_cursor).toBeNull();
  });

  it("reads one of its own; another company's id is the same 404 as an unknown one", async () => {
    const { service } = world();
    const mine = await service.create(COMPANY, body(), "key-0000001", CTX);
    const theirs = await service.create(OTHER_COMPANY, body(), "key-0000001", CTX);
    await expect(service.getOne(COMPANY, mine.id)).resolves.toMatchObject({ id: mine.id });
    await expect(service.getOne(COMPANY, theirs.id)).rejects.toBeInstanceOf(NotFoundException);
    await expect(service.getOne(COMPANY, uuid(0xbeef))).rejects.toBeInstanceOf(NotFoundException);
  });
});

describe("cancel", () => {
  it("from requested: cancelled, one campus_drive.cancelled in the transaction, a repeat changes nothing", async () => {
    const { service, events } = world();
    const made = await service.create(COMPANY, body(), "key-0000001", CTX);
    const cancelled = await service.cancel(COMPANY, made.id, CTX);
    expect(cancelled.status).toBe("cancelled");
    expect(cancelled.cancelled_at).not.toBeNull();
    const cancels = events.emitted.filter((e) => e.event_name === "campus_drive.cancelled");
    expect(cancels).toHaveLength(1);
    expect(cancels[0]!.tx).toBeDefined();
    expect(cancels[0]!.payload).toEqual({
      campus_drive_request_id: made.id,
      payer_id: COMPANY,
      previous_status: "requested",
    });
    const again = await service.cancel(COMPANY, made.id, CTX);
    expect(again).toEqual(cancelled);
    expect(events.emitted.filter((e) => e.event_name === "campus_drive.cancelled")).toHaveLength(1);
  });

  it("from scheduled: allowed (the company may call off a scheduled drive)", async () => {
    const { service, table, events } = world();
    const made = await service.create(COMPANY, body(), "key-0000001", CTX);
    Object.assign(table.rows[0]!, { status: "scheduled", scheduledOn: "2026-12-05" });
    await expect(service.cancel(COMPANY, made.id, CTX)).resolves.toMatchObject({
      status: "cancelled",
      scheduled_on: "2026-12-05",
    });
    expect(events.emitted.at(-1)!.payload).toMatchObject({ previous_status: "scheduled" });
  });

  it.each([["declined"], ["completed"]])(
    "from %s: 409 drive_request_not_cancellable, nothing changes",
    async (status) => {
      const { service, table, events } = world();
      const made = await service.create(COMPANY, body(), "key-0000001", CTX);
      Object.assign(table.rows[0]!, { status });
      const before = table.digest();
      const err = await refusal(() => service.cancel(COMPANY, made.id, CTX));
      expect(err).toBeInstanceOf(ConflictException);
      expect(err.getResponse()).toMatchObject({ reason: "drive_request_not_cancellable", status });
      expect(table.digest()).toBe(before);
      expect(events.emitted.filter((e) => e.event_name === "campus_drive.cancelled")).toEqual([]);
    },
  );

  it("another company's request is the same 404 as an unknown one", async () => {
    const { service } = world();
    const theirs = await service.create(OTHER_COMPANY, body(), "key-0000001", CTX);
    await expect(service.cancel(COMPANY, theirs.id, CTX)).rejects.toBeInstanceOf(NotFoundException);
  });
});
