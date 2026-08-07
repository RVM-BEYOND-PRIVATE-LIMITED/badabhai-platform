/**
 * The retrieval ladder.
 *
 * The assertions that matter most are the ones about STOPPING and about REFUSING:
 * the ladder must not pay for L2 when L0 already settled it, must not pin when a different
 * family is close behind, must not offer two chips that read the same, and must not report
 * "unresolved" when the truth is "the index never built".
 */
import { describe, expect, it, vi } from "vitest";

import { normalizeOccupationText } from "@badabhai/profiling-lexicon";
import { buildOccupationSnapshot } from "./occupation-index";
import type { OccupationIndexService } from "./occupation-index.service";
import type { OccupationRepository, TrigramCandidate } from "./occupation.repository";
import { OccupationService } from "./occupation.service";
import type { SkillsRepository } from "../skills/skills.repository";

const BINDINGS = [
  { familyId: "fam_welding", iscoUnitCode: "7212" },
  { familyId: "fam_tailoring", iscoUnitCode: "7531" },
  { familyId: "fam_masonry", iscoUnitCode: "7112" },
  { familyId: "fam_plumbing", iscoUnitCode: "7126" },
  { familyId: "fam_machining", iscoUnitCode: "7223" },
];

const snapshot = buildOccupationSnapshot({
  catalogVersion: "cat-1",
  domains: [
    { jobDomainId: "jd_weld", labelEn: "Welder, Gas", labelHi: "वेल्डर", iscoUnitCode: "7212" },
    { jobDomainId: "jd_tailor", labelEn: "Tailor, General", labelHi: null, iscoUnitCode: "7531" },
    { jobDomainId: "jd_mason", labelEn: "Mason, Building", labelHi: null, iscoUnitCode: "7112" },
    { jobDomainId: "jd_plumb", labelEn: "Plumber, General", labelHi: null, iscoUnitCode: "7126" },
    { jobDomainId: "jd_lathe", labelEn: "Lathe Machinist", labelHi: null, iscoUnitCode: "7223" },
  ],
  aliases: [
    { jobDomainId: "jd_weld", text: "welder" },
    { jobDomainId: "jd_tailor", text: "darzi" },
    // Two different families whose shortest alias is the SAME word — the "mistri" case.
    { jobDomainId: "jd_mason", text: "mistri" },
    { jobDomainId: "jd_plumb", text: "mistri" },
    { jobDomainId: "jd_lathe", text: "kharad" },
  ],
  bindings: BINDINGS,
});

function make(opts: {
  snapshot?: ReturnType<typeof buildOccupationSnapshot> | null;
  trigram?: TrigramCandidate[];
  vector?: Array<{ job_domain_id: string; label: string; score: number }>;
} = {}) {
  const index = {
    snapshot: vi.fn().mockReturnValue(opts.snapshot === undefined ? snapshot : opts.snapshot),
  } as unknown as OccupationIndexService;
  const repo = {
    trigramCandidates: vi.fn().mockResolvedValue(opts.trigram ?? []),
  } as unknown as OccupationRepository;
  const skills = {
    nearestDomains: vi.fn().mockResolvedValue(opts.vector ?? []),
  } as unknown as SkillsRepository;
  return { svc: new OccupationService(index, repo, skills), repo, skills };
}

describe("OccupationService.resolve — the ladder", () => {
  it("auto-pins an unambiguous L0 hit WITHOUT touching the database", async () => {
    // The whole economic case: a turn that resolves at L0 costs nothing at all.
    const { svc, repo, skills } = make();
    const r = await svc.resolve("main welder hoon");
    expect(r.status).toBe("auto");
    expect(r.pinned?.jobDomainId).toBe("jd_weld");
    expect(r.pinned?.layer).toBe("L0");
    expect(repo.trigramCandidates).not.toHaveBeenCalled();
    expect(skills.nearestDomains).not.toHaveBeenCalled();
  });

  it("shows the vernacular label, never the official English title", async () => {
    const { svc } = make();
    expect((await svc.resolve("welder")).pinned?.label).toBe("वेल्डर");
  });

  it("climbs to L2 when the lexical layers found nothing", async () => {
    const { svc, repo } = make({ trigram: [{ jobDomainId: "jd_tailor", rawScore: 0.95 }] });
    const r = await svc.resolve("kapde silne wala kaam");
    expect(repo.trigramCandidates).toHaveBeenCalled();
    expect(r.candidates[0]?.jobDomainId).toBe("jd_tailor");
    expect(r.candidates[0]?.layer).toBe("L2");
  });

  it("does NOT spend a vector call when L2 already settled it", async () => {
    const { svc, skills } = make({ trigram: [{ jobDomainId: "jd_tailor", rawScore: 1 }] });
    const r = await svc.resolve("kapde silne wala kaam", { vector: new Array(768).fill(0.1) });
    expect(r.status).toBe("auto");
    expect(skills.nearestDomains).not.toHaveBeenCalled();
  });

  it("never embeds — L3 runs only on a vector the caller already holds", async () => {
    const { svc, skills } = make();
    const r = await svc.resolve("kuch aur hi kaam");
    expect(skills.nearestDomains).not.toHaveBeenCalled();
    expect(r.embedSpent).toBe(false);
  });

  it("runs L3 when a vector IS supplied and the cheaper layers were not enough", async () => {
    const { svc, skills } = make({
      vector: [{ job_domain_id: "jd_weld", label: "Welder, Gas", score: 0.95 }],
    });
    const r = await svc.resolve("jodne ka kaam", { vector: new Array(768).fill(0.1) });
    expect(skills.nearestDomains).toHaveBeenCalled();
    expect(r.pinned?.layer).toBe("L3");
  });

  it("keeps the STRONGEST evidence per domain, not the last layer to speak", async () => {
    // An L2 score must never overwrite an exact L0 hit for the same occupation.
    const { svc } = make({ trigram: [{ jobDomainId: "jd_weld", rawScore: 0.4 }] });
    const r = await svc.resolve("welder");
    expect(r.pinned?.layer).toBe("L0");
  });
});

describe("OccupationService.resolve — refusing", () => {
  it("reports DEGRADED, not unresolved, when the index has never built", async () => {
    // The difference is the whole point: "unresolved" would record a worker's real trade
    // as an unknown phrase and drop them to the universal pack with nothing looking wrong.
    const { svc } = make({ snapshot: null });
    const r = await svc.resolve("welder");
    expect(r.status).toBe("degraded");
    expect(r.candidates).toEqual([]);
    expect(r.catalogVersion).toBeNull();
  });

  it("ABANDONS the offer when two chips would read identically", async () => {
    // "mistri" reaches a mason and a plumber. Two chips both saying "mistri" ask the
    // worker to choose between two things that look like one thing, and record whichever
    // they tap as a deliberate answer.
    const { svc } = make();
    const r = await svc.resolve("mistri");
    expect(r.status).toBe("unresolved");
    expect(r.disambiguationOptions).toEqual([]);
    expect(r.needsDisambiguation).toBe(false);
    expect(r.reason).toContain("chip label");
  });

  it("offers chips when the labels are genuinely distinguishable", async () => {
    const { svc } = make({
      trigram: [
        { jobDomainId: "jd_weld", rawScore: 0.62 },
        { jobDomainId: "jd_tailor", rawScore: 0.6 },
      ],
    });
    const r = await svc.resolve("kaam");
    expect(r.status).toBe("disambiguate");
    expect(r.needsDisambiguation).toBe(true);
    expect(r.disambiguationOptions.map((o) => o.label)).toEqual(["वेल्डर", "darzi"]);
  });

  it("sets needs_disambiguation only when it is actually offering something", async () => {
    const { svc } = make();
    const r = await svc.resolve("aaj mausam accha hai");
    expect(r.status).toBe("unresolved");
    expect(r.needsDisambiguation).toBe(false);
  });

  it("carries the catalog version on every resolved answer, for pinning", async () => {
    const { svc } = make();
    expect((await svc.resolve("welder")).catalogVersion).toBe("cat-1");
  });

  it("always explains itself", async () => {
    const { svc } = make();
    for (const text of ["welder", "mistri", "aaj mausam accha hai"]) {
      expect((await svc.resolve(text)).reason.length).toBeGreaterThan(0);
    }
  });
});

describe("OccupationService.describeDomain", () => {
  it("returns catalogue metadata from the snapshot", () => {
    const { svc } = make();
    expect(svc.describeDomain("jd_weld")).toMatchObject({
      jobDomainId: "jd_weld",
      labelEn: "Welder, Gas",
      label: "वेल्डर",
      familyId: "fam_welding",
      catalogVersion: "cat-1",
    });
  });

  it("returns null for an unknown occupation", () => {
    expect(make().svc.describeDomain("jd_nope")).toBeNull();
  });

  it("returns null rather than throwing when there is no index", () => {
    expect(make({ snapshot: null }).svc.describeDomain("jd_weld")).toBeNull();
  });
});

describe("L2 receives NORMALIZED text — the contract its parameter name states", () => {
  it("normalizes the utterance before handing it to trigramCandidates", async () => {
    // REGRESSION (#619 review, CRITICAL). `trigramCandidates(queryNorm, k)` compares its argument
    // against `a.text_norm`, the column `normalizeOccupationText` wrote. The raw utterance was
    // passed instead. L0/L1 hid it completely — `matchSpan` normalizes internally — so the bug is
    // only reachable on the inputs L2 exists for: a conversational sentence that L0/L1 miss.
    const { svc, repo } = make({ trigram: [] });
    const raw = "Main KAPDE  silne ka kaam karta hun!!";

    await svc.resolve(raw, {});

    expect(repo.trigramCandidates).toHaveBeenCalledOnce();
    const passed = (repo.trigramCandidates as unknown as ReturnType<typeof vi.fn>).mock
      .calls[0]![0] as string;
    expect(passed).toBe(normalizeOccupationText(raw));
    // And concretely: no upper case, no punctuation, no doubled spaces — the shape `text_norm`
    // is stored in. Asserting this as well as the equality means a change to the normalizer
    // cannot make the check above vacuously true.
    expect(passed).not.toMatch(/[A-Z!]/);
    expect(passed).not.toContain("  ");
    expect(passed).not.toBe(raw);
  });
});
