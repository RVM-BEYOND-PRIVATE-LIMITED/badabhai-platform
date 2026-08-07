/**
 * The index service's lifecycle.
 *
 * Nearly every test here is about a FAILURE staying visible. An occupation index that
 * quietly degrades to empty produces "no match" for every worker, which the engine records
 * as an unresolved phrase and treats as an ordinary day — a total retrieval outage with no
 * symptom. The assertions below are mostly assertions that this class refuses to do that.
 */
import { describe, expect, it, vi } from "vitest";

import { OccupationIndexService } from "./occupation-index.service";
import type { OccupationRepository } from "./occupation.repository";

const DOMAINS = [
  { jobDomainId: "jd_weld", labelEn: "Welder, Gas", labelHi: null, iscoUnitCode: "7212" },
];
const ALIASES = [{ jobDomainId: "jd_weld", text: "welder" }];
const BINDINGS = [
  {
    familyId: "fam_welding",
    jobDomainId: null,
    iscoUnitCode: "7212",
    iscoMinorCode: null,
    iscoSubmajorCode: null,
    iscoMajorCode: null,
    isUniversal: false,
  },
];

function fakeRepo(overrides: Partial<OccupationRepository> = {}): OccupationRepository {
  return {
    catalogVersion: vi.fn().mockResolvedValue("v1"),
    loadDomains: vi.fn().mockResolvedValue(DOMAINS),
    loadAliases: vi.fn().mockResolvedValue(ALIASES),
    loadBindings: vi.fn().mockResolvedValue(BINDINGS),
    loadFamilyLabels: vi.fn().mockResolvedValue(new Map([["fam_welding", "वेल्डिंग"]])),
    trigramCandidates: vi.fn().mockResolvedValue([]),
    ...overrides,
  } as unknown as OccupationRepository;
}

describe("OccupationIndexService", () => {
  it("has NO snapshot before the first successful build", () => {
    // `null`, not an empty index. A caller reading zero candidates from an empty index
    // cannot tell "we are not ready" from "this trade does not exist".
    expect(new OccupationIndexService(fakeRepo()).snapshot()).toBeNull();
  });

  it("installs a snapshot after a successful refresh", async () => {
    const svc = new OccupationIndexService(fakeRepo());
    await expect(svc.refresh()).resolves.toBe(true);
    expect(svc.snapshot()?.domains.size).toBe(1);
    expect(svc.snapshot()?.catalogVersion).toBe("v1");
  });

  it("keeps the previous snapshot when a refresh THROWS", async () => {
    const repo = fakeRepo();
    const svc = new OccupationIndexService(repo);
    await svc.refresh();

    (repo.catalogVersion as unknown as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
      new Error("connection reset"),
    );
    await expect(svc.refresh()).resolves.toBe(false);
    // Stale-but-correct beats absent. One database blip must not turn every subsequent
    // turn into an unresolved phrase.
    expect(svc.snapshot()?.domains.size).toBe(1);
  });

  it("REFUSES to install an empty catalogue", async () => {
    const svc = new OccupationIndexService(
      fakeRepo({ loadDomains: vi.fn().mockResolvedValue([]) } as Partial<OccupationRepository>),
    );
    await expect(svc.refresh()).resolves.toBe(false);
    // Zero selectable domains means unseeded or unreachable, never a valid catalogue.
    expect(svc.snapshot()).toBeNull();
  });

  it("skips the rebuild when the catalog version has not moved", async () => {
    const repo = fakeRepo();
    const svc = new OccupationIndexService(repo);
    await svc.refresh();
    await expect(svc.refresh()).resolves.toBe(false);
    // The version probe runs every tick; the four table loads must not.
    expect(repo.loadAliases).toHaveBeenCalledTimes(1);
  });

  it("rebuilds when the catalog version DOES move", async () => {
    const repo = fakeRepo();
    (repo.catalogVersion as unknown as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce("v1")
      .mockResolvedValueOnce("v2");
    const svc = new OccupationIndexService(repo);
    await svc.refresh();
    await expect(svc.refresh()).resolves.toBe(true);
    expect(svc.snapshot()?.catalogVersion).toBe("v2");
  });

  it("does not let two refreshes overlap", async () => {
    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const repo = fakeRepo({
      catalogVersion: vi.fn().mockImplementation(async () => {
        await gate;
        return "v1";
      }),
    } as Partial<OccupationRepository>);
    const svc = new OccupationIndexService(repo);

    const first = svc.refresh();
    const second = svc.refresh();
    release?.();
    await expect(second).resolves.toBe(false);
    await expect(first).resolves.toBe(true);
    expect(repo.catalogVersion).toHaveBeenCalledTimes(1);
  });

  it("swaps the snapshot rather than mutating it", async () => {
    const repo = fakeRepo();
    (repo.catalogVersion as unknown as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce("v1")
      .mockResolvedValueOnce("v2");
    const svc = new OccupationIndexService(repo);
    await svc.refresh();
    const before = svc.snapshot();
    await svc.refresh();
    // A turn holding the old reference must keep reading a coherent old snapshot.
    expect(svc.snapshot()).not.toBe(before);
    expect(before?.catalogVersion).toBe("v1");
  });

  it("clears its timer on destroy", () => {
    const svc = new OccupationIndexService(fakeRepo());
    const clear = vi.spyOn(globalThis, "clearInterval");
    svc.onModuleInit();
    svc.onModuleDestroy();
    expect(clear).toHaveBeenCalled();
    clear.mockRestore();
  });

  it("boots without awaiting the database", () => {
    // A slow or down database at boot must delay occupation retrieval, not the process.
    const repo = fakeRepo({
      catalogVersion: vi.fn().mockImplementation(() => new Promise(() => {})),
    } as Partial<OccupationRepository>);
    const svc = new OccupationIndexService(repo);
    expect(() => {
      svc.onModuleInit();
    }).not.toThrow();
    expect(svc.snapshot()).toBeNull();
    svc.onModuleDestroy();
  });
});
