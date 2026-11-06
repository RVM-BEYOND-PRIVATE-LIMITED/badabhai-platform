import "reflect-metadata";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { ForbiddenException, HttpException } from "@nestjs/common";
import type { AdminRole } from "@badabhai/db";
import type { RequestContext } from "../common/request-context";
import type { AuthenticatedAdmin } from "./admin-auth.guard";
import { AdminCandidatesService, normalizePhoneToE164 } from "./admin-candidates.service";
import type { AdminCandidateSearchDto } from "./admin-candidates.dto";
import type { AdminCandidatesRepository } from "./admin-candidates.repository";
import type { AdminIdentityService } from "./admin-identity.service";
import type { AdminCandidatesSearchCapService } from "./admin-candidates-search-cap.service";
import type { PiiCryptoService } from "../common/pii-crypto.service";
import type { NameTokenService } from "./candidate-index/name-token.service";
import type { EventsService } from "../events/events.service";

const CTX: RequestContext = { requestId: "req-1", correlationId: "cor-1" };
const ADMIN_ID = "aaaaaaaa-0000-4000-8000-000000000001";
const W1 = "11111111-0000-4000-8000-000000000001";

const admin = (role: AdminRole): AuthenticatedAdmin => ({ id: ADMIN_ID, role, sid: "s" });

function row() {
  return {
    workerId: W1,
    status: "active",
    flagged: false,
    isTestAccount: false,
    deletionScheduledAt: null,
    employerSharingConsent: true,
    currentCity: "Pune",
    currentState: "Maharashtra",
    canonicalTradeId: null,
    canonicalRoleId: null,
    jobDomainId: null,
    tradeLabel: null,
    roleLabel: null,
    domainLabel: null,
    totalExperienceYears: "3",
    roleExperienceMonths: 12,
    salaryMinInr: null,
    salaryMaxInr: null,
    salaryPeriod: "month",
    availabilityStatus: null,
    shiftPreference: null,
    formLevel: null,
    skills: ["CNC operating"],
    languages: [],
    educationLevel: null,
    resumeCount: 1,
    latestResumeStatus: "rendered",
    latestResumeVersion: 2,
    profileStatus: "confirmed",
    profileSource: "form",
    appVersion: null,
    lastActiveAt: null,
    createdAt: new Date("2026-01-01T00:00:00Z"),
    updatedAt: new Date("2026-01-02T00:00:00Z"),
    aiCostInr: "0",
    referralSource: null,
  };
}

function harness(opts: {
  capOk?: boolean;
  emitRejects?: boolean;
  names?: Map<string, string | null> | null;
  keyring?: boolean;
} = {}) {
  const search = vi.fn(async () => ({
    rows: [row()],
    total: 1,
    identityMatches: 1,
    byStatus: [{ value: "active", count: 1 }],
    byTrade: [],
    byCity: [{ value: "Pune", count: 1 }],
    byProfileStatus: [{ value: "confirmed", count: 1 }],
  }));
  const resolve = vi.fn(async () => (opts.names === undefined ? new Map([[W1, "Ramesh"]]) : opts.names));
  const consume = vi.fn(async () =>
    opts.capOk === false ? { ok: false as const, window: "hour" as const } : { ok: true as const },
  );
  const emit = vi.fn(async () => {
    if (opts.emitRejects) throw new Error("events insert failed");
    return undefined;
  });
  // Opaque one-way mock (like the real HMAC): length-derived, never echoing input.
  const hashPhone = vi.fn((phone: string) => `locked#${phone.length}`);
  const termTokens = vi.fn((term: string) =>
    opts.keyring === false || term.trim() === "" ? null : { hashes: [`tok(${term})`], kid: "k1" },
  );
  const svc = new AdminCandidatesService(
    { search } as unknown as AdminCandidatesRepository,
    { resolve } as unknown as AdminIdentityService,
    { consume } as unknown as AdminCandidatesSearchCapService,
    { hashPhone } as unknown as PiiCryptoService,
    { termTokens } as unknown as NameTokenService,
    { emit } as unknown as EventsService,
  );
  return { svc, search, resolve, consume, emit, hashPhone, termTokens };
}

const base: AdminCandidateSearchDto = {
  sort: "last_active_at",
  dir: "desc",
  page: 1,
  page_size: 50,
};

/** First positional arg of the first mock call, typed for assertions. */
function firstArg(mock: { mock: { calls: unknown[][] } }): Record<string, unknown> {
  return (mock.mock.calls[0] as unknown as Array<Record<string, unknown>>)[0]!;
}

describe("normalizePhoneToE164 (ADR-0062 §3.6 — never guessed)", () => {
  it("defaults a bare 10-digit number to +91", () => {
    expect(normalizePhoneToE164("9876543210")).toBe("+919876543210");
    expect(normalizePhoneToE164("98765 43210")).toBe("+919876543210");
  });

  it("passes strict E.164 through, rejects the rest", () => {
    expect(normalizePhoneToE164("+919876543210")).toBe("+919876543210");
    expect(normalizePhoneToE164("+14155552671")).toBe("+14155552671");
    expect(normalizePhoneToE164("Mumbai")).toBeNull();
    expect(normalizePhoneToE164("400001")).toBeNull();
    expect(normalizePhoneToE164("12345678901234567890")).toBeNull();
    expect(normalizePhoneToE164("")).toBeNull();
  });
});

describe("q classification (the term is never logged — asserted by the logging test)", () => {
  beforeEach(() => vi.restoreAllMocks());

  it("runs text+name branches for a label term (permitted admin)", async () => {
    const h = harness();
    const res = await h.svc.search(admin("support"), { ...base, q: "cnc" }, CTX);
    expect(res.q_type).toBe("name");
    expect(h.termTokens).toHaveBeenCalledWith("cnc");
    const input = firstArg(h.search);
    expect(input.textLike).toBe("%cnc%");
    expect(input.phoneHash).toBeNull();
    expect(input.nameHashes).toEqual(["tok(cnc)"]);
  });

  it("runs the phone branch for a 10-digit term (hash, never the number, reaches the repo)", async () => {
    const h = harness();
    const res = await h.svc.search(admin("support"), { ...base, q: "9876543210" }, CTX);
    expect(res.q_type).toBe("phone");
    expect(h.hashPhone).toHaveBeenCalledWith("+919876543210");
    const input = firstArg(h.search);
    expect(input.phoneHash).toBe("locked#13");
    // A pure phone term runs ONLY the phone branch — the digits travel no
    // further than the hash (no text fragment, no name token).
    expect(input.textLike).toBeNull();
    expect(input.nameHashes).toBeNull();
    expect(JSON.stringify(input)).not.toContain("9876543210");
  });

  it("never guesses a phone inside a lettered term (Mumbai 400001 stays text+name)", async () => {
    const h = harness();
    await h.svc.search(admin("support"), { ...base, q: "Mumbai 400001" }, CTX);
    expect(h.hashPhone).not.toHaveBeenCalled();
    const input = firstArg(h.search);
    expect(input.phoneHash).toBeNull();
    expect(input.textLike).toBe("%mumbai 400001%");
  });

  it("skips the name branch without a keyring (fail closed, text+phone still run)", async () => {
    const h = harness({ keyring: false });
    const res = await h.svc.search(admin("support"), { ...base, q: "cnc" }, CTX);
    expect(res.q_type).toBeNull();
    const input = firstArg(h.search);
    expect(input.nameHashes).toBeNull();
    expect(input.textLike).toBe("%cnc%");
  });

  it("403s an analyst's phone-shaped term and serves NOTHING (never faceless rows)", async () => {
    const h = harness();
    await expect(h.svc.search(admin("analyst"), { ...base, q: "9876543210" }, CTX)).rejects.toBeInstanceOf(
      ForbiddenException,
    );
    expect(h.search).not.toHaveBeenCalled();
    expect(h.emit).not.toHaveBeenCalled();
  });

  it("serves an analyst's label search faceless (no name branch, no names)", async () => {
    const h = harness({ names: null });
    const res = await h.svc.search(admin("analyst"), { ...base, q: "cnc" }, CTX);
    expect(h.termTokens).not.toHaveBeenCalled();
    expect(res.candidates[0]).not.toHaveProperty("name");
    expect(res.q_type).toBeNull();
  });
});

describe("gates (cap, audit, names)", () => {
  it("429s on a tripped search cap + emits the PII-free breach (no term, no count)", async () => {
    const h = harness({ capOk: false });
    await expect(h.svc.search(admin("support"), { ...base, q: "cnc" }, CTX)).rejects.toBeInstanceOf(
      HttpException,
    );
    expect(h.search).not.toHaveBeenCalled();
    const calls = h.emit.mock.calls as unknown as Array<[{ event_name: string }]>;
    expect(calls.map((c) => c[0].event_name)).toEqual(["admin.candidates_search_cap_exceeded"]);
    const payload = (firstArg(h.emit) as { payload: Record<string, unknown> }).payload;
    expect(Object.keys(payload).sort()).toEqual(["admin_id", "window"].sort());
  });

  it("audits the lookup after the match (identity_searched carries kind + count, never the term)", async () => {
    const h = harness();
    await h.svc.search(admin("support"), { ...base, q: "9876543210" }, CTX);
    const audit = (h.emit.mock.calls as unknown as Array<[{ payload: Record<string, unknown>; event_name: string }]>)
      .map((c) => c[0])
      .find((a) => a.event_name === "admin.identity_searched")!;
    expect(audit.payload).toMatchObject({ admin_id: ADMIN_ID, search_kind: "phone", match_count: 1 });
    expect(JSON.stringify(audit)).not.toContain("9876543210");
  });

  it("returns an EMPTY page when the audit emit fails (fail closed, never partial rows)", async () => {
    const h = harness({ emitRejects: true });
    const res = await h.svc.search(admin("support"), { ...base, q: "cnc" }, CTX);
    expect(res).toMatchObject({ candidates: [], total: 0, total_pages: 0 });
  });

  it("merges disclosed names; absent field when undisclosed, null when unnamed", async () => {
    const named = harness({ names: new Map([[W1, "Ramesh"]]) });
    const r1 = await named.svc.search(admin("support"), { ...base }, CTX);
    expect(r1.candidates[0]!.name).toBe("Ramesh");

    const capped = harness({ names: null });
    const r2 = await capped.svc.search(admin("support"), { ...base }, CTX);
    expect(r2.candidates[0]).not.toHaveProperty("name");

    const unnamed = harness({ names: new Map([[W1, null]]) });
    const r3 = await unnamed.svc.search(admin("support"), { ...base }, CTX);
    expect(r3.candidates[0]).toHaveProperty("name", null);
  });

  it("paginates (page, exact total, total_pages) and serves facets", async () => {
    const h = harness({ names: null });
    const res = await h.svc.search(admin("support"), { ...base, page: 2, page_size: 25 }, CTX);
    expect(res).toMatchObject({ page: 2, page_size: 25, total: 1, total_pages: 1 });
    expect(res.counts.by_city).toEqual([{ value: "Pune", count: 1 }]);
    const input = firstArg(h.search);
    expect(input).toMatchObject({ limit: 25, offset: 25, sort: "last_active_at", dir: "desc" });
  });
});
