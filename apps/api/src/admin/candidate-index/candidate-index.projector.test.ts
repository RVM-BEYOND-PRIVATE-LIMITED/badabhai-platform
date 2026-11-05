import "reflect-metadata";
import { describe, expect, it, vi } from "vitest";
import { CandidateIndexProjector } from "./candidate-index.projector";
import { CandidateIndexRepository } from "./candidate-index.repository";
import { NameTokenService } from "./name-token.service";

const WORKER = "11111111-1111-4111-8111-111111111111";
const KEY_HEX = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
const KID = "2026-11-a";

const NOW = new Date("2026-11-05T12:00:00.000Z");

function workerRow() {
  return {
    id: WORKER,
    status: "active",
    currentCity: "Pune",
    currentState: "Maharashtra",
    isTestAccount: false,
    deletionScheduledAt: null,
    createdAt: NOW,
    updatedAt: NOW,
    phoneHash: "phone-hash-opaque",
    photoStorageKey: null,
  };
}

function profileRow() {
  return {
    profileStatus: "confirmed",
    source: "form",
    canonicalTradeId: null,
    canonicalRoleId: null,
    jobDomainId: null,
    skills: ["cnc_operating"],
    machines: ["vmc"],
    experience: { total_years: 3 },
    salaryExpectation: null,
    locationPreference: null,
    availability: null,
    rawProfile: null,
    confirmedAt: NOW,
  };
}

function accountRow() {
  return {
    deviceCount: 1,
    latestAppVersion: "1.2.3",
    lastSeenAt: NOW,
    appliedCount: 0,
    skippedCount: 0,
    unlockCount: 0,
    consent: {
      consentVersion: "v3",
      purposes: ["profiling", "employer_sharing"],
      acceptedAt: NOW,
      revokedAt: null,
    },
    flag: null,
    formLevel: "medium",
  };
}

function makeProjector(opts?: { worker?: unknown; profile?: unknown; nameToken?: string | null }) {
  const upsertRow = vi.fn(async () => undefined);
  const workers = {
    findById: vi.fn(async () => (opts?.worker === undefined ? workerRow() : opts.worker)),
    latestProfile: vi.fn(async () => (opts?.profile === undefined ? profileRow() : opts.profile)),
    findFullNameToken: vi.fn(async () => (opts?.nameToken === undefined ? "enc-name" : opts.nameToken)),
  };
  const attributes = {
    loadTradeSheet: vi.fn(async () => ({
      packId: null,
      attributes: {},
      polishedAttributes: {},
      declinedAttributes: new Set<string>(),
    })),
  };
  const qualifications = { loadForResume: vi.fn(async () => ({ certificates: [], educations: [], trainings: [] })) };
  const languages = { loadForResume: vi.fn(async () => []) };
  const detail = {    attributeProvenance: vi.fn(async () => []),
    currentJobDomain: vi.fn(async () => null),
    matchSkills: vi.fn(async () => []),
    industryTenure: vi.fn(async () => []),
    resumeVersions: vi.fn(async () => ({ rows: [], total: 0 })),
    account: vi.fn(async () => accountRow()),
  };
  const index = {
    upsertRow,
    readRow: vi.fn(async () => undefined),
    listWorkerIds: vi.fn(async () => [] as string[]),
    readEventBatch: vi.fn(async () => []),
    getWatermark: vi.fn(async () => 0),
    setWatermark: vi.fn(async () => undefined),
    readAiCostTotal: vi.fn(async () => "0"),
    readReferralSource: vi.fn(async () => null),
  };
  const pii = { decrypt: vi.fn(() => "Ramesh Kumar") };
  const nameTokens = new NameTokenService({
    ADMIN_NAME_TOKEN_KEYS: JSON.stringify({ [KID]: KEY_HEX }),
    ADMIN_NAME_TOKEN_ACTIVE_KID: KID,
  } as never);
  const projector = new CandidateIndexProjector(
    workers as never,
    attributes as never,
    qualifications as never,
    languages as never,
    detail as never,
    index as unknown as CandidateIndexRepository,
    pii as never,
    nameTokens,
  );
  return { projector, upsertRow, workers, index };
}

describe("CandidateIndexProjector.projectWorker (B4, #2557)", () => {
  it("upserts the derived row through the employer-facing resolvers", async () => {
    const { projector, upsertRow } = makeProjector();
    await expect(projector.projectWorker(WORKER)).resolves.toBe(true);
    expect(upsertRow).toHaveBeenCalledOnce();
    const calls = upsertRow.mock.calls as unknown as Array<[Record<string, unknown>]>;
    const row = calls[0]![0];
    expect(row.workerId).toBe(WORKER);
    expect(row.status).toBe("active");
    expect(row.currentCity).toBe("Pune");
    expect(row.currentState).toBe("Maharashtra");
    expect(row.phoneHash).toBe("phone-hash-opaque");
    expect(row.employerSharingConsent).toBe(true);
    expect(row.formLevel).toBe("medium");
    expect(row.appVersion).toBe("1.2.3");
    expect(row.profileStatus).toBe("confirmed");
    expect(row.nameTokenKeyId).toBe(KID);
    // Two whole-word tokens (Ramesh Kumar), 64-hex HMACs in hash order. The
    // exact values are pinned by name-token.service.test.ts; this asserts the
    // projector stored the tokenised name and nothing else.
    expect(row.nameTokenHashes).toHaveLength(2);
    expect((row.nameTokenHashes as string[]).every((t) => /^[0-9a-f]{64}$/.test(t))).toBe(true);
    expect([...(row.nameTokenHashes as string[])].sort()).toEqual(row.nameTokenHashes);
    expect(row.totalExperienceYears).toBe("3");
    // Folded canonical labels only.
    expect(row.searchDoc as string).toContain("pune");
  });

  it("stores NO name, phone or answer value on the row (PII regression)", async () => {
    const { projector, upsertRow } = makeProjector();
    await projector.projectWorker(WORKER);
    const calls = upsertRow.mock.calls as unknown as Array<[Record<string, unknown>]>;
    const serialised = JSON.stringify(calls[0]![0]);
    expect(serialised).not.toContain("Ramesh Kumar");
    expect(serialised).not.toContain("enc-name");
    expect(serialised).not.toContain("+91");
  });

  it("is a no-op (false, no write) when the worker row is gone", async () => {
    // findById null → erased mid-tick; the FK cascade owns the row, not this.
    const { projector, upsertRow } = makeProjector({ worker: null });
    await expect(projector.projectWorker(WORKER)).resolves.toBe(false);
    expect(upsertRow).not.toHaveBeenCalled();
  });

  it("projects a profile-less worker with status none (never a 404)", async () => {
    const { projector, upsertRow } = makeProjector({ profile: null });
    await expect(projector.projectWorker(WORKER)).resolves.toBe(true);
    const calls = upsertRow.mock.calls as unknown as Array<[Record<string, unknown>]>;
    const row = calls[0]![0];
    expect(row.profileStatus).toBe("none");
    expect(row.skills).toEqual([]);
  });

  it("stores empty tokens with a null kid when the keyring is unavailable", async () => {
    const { projector, upsertRow, workers } = makeProjector({ nameToken: null });
    await projector.projectWorker(WORKER);
    expect(workers.findFullNameToken).toHaveBeenCalledWith(WORKER);
    const calls = upsertRow.mock.calls as unknown as Array<[Record<string, unknown>]>;
    const row = calls[0]![0];
    expect(row.nameTokenHashes).toEqual([]);
    expect(row.nameTokenKeyId).toBeNull();
  });
});

describe("CandidateIndexProjector.driftForWorker", () => {
  it("reports a missing row as drifted", async () => {
    const { projector } = makeProjector();
    await expect(projector.driftForWorker(WORKER)).resolves.toEqual({
      drifted: true,
      columns: ["<missing>"],
    });
  });
});
