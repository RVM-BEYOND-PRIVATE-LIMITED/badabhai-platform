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
import type { EventsService } from "../events/events.service";

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

/**
 * The same catalogue, but with family labels present.
 *
 * Split from the fixture above on purpose: `snapshot` has NO family labels, so the collision
 * guard there must abandon, and this one has them, so it must qualify instead. Two fixtures
 * is what makes those two behaviours separately assertable — with one, whichever branch the
 * fixture happened to exercise would be the only one ever tested.
 */
const snapshotWithFamilyLabels = buildOccupationSnapshot({
  catalogVersion: "cat-1",
  domains: [
    { jobDomainId: "jd_mason", labelEn: "Mason, Building", labelHi: null, iscoUnitCode: "7112" },
    { jobDomainId: "jd_plumb", labelEn: "Plumber, General", labelHi: null, iscoUnitCode: "7126" },
  ],
  aliases: [
    { jobDomainId: "jd_mason", text: "mistri" },
    { jobDomainId: "jd_plumb", text: "mistri" },
  ],
  bindings: BINDINGS,
  familyLabels: new Map([
    ["fam_masonry", "राजमिस्त्री का काम"],
    ["fam_plumbing", "प्लंबर का काम"],
  ]),
});

function make(opts: {
  snapshot?: ReturnType<typeof buildOccupationSnapshot> | null;
  trigram?: TrigramCandidate[];
  vector?: Array<{ job_domain_id: string; label: string; score: number }>;
  knownUnresolved?: boolean;
} = {}) {
  const index = {
    snapshot: vi.fn().mockReturnValue(opts.snapshot === undefined ? snapshot : opts.snapshot),
  } as unknown as OccupationIndexService;
  const repo = {
    trigramCandidates: vi.fn().mockResolvedValue(opts.trigram ?? []),
    isKnownUnresolved: vi.fn().mockResolvedValue(opts.knownUnresolved ?? false),
  } as unknown as OccupationRepository;
  const skills = {
    nearestDomains: vi.fn().mockResolvedValue(opts.vector ?? []),
    recordUnresolved: vi.fn().mockResolvedValue({ id: "row", count: 1 }),
  } as unknown as SkillsRepository;
  const events = { emit: vi.fn().mockResolvedValue(undefined) } as unknown as EventsService;
  return { svc: new OccupationService(index, repo, skills, events), repo, skills, events };
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
    // The escape rides last on EVERY offer and is not counted against the four-chip cap.
    expect(r.disambiguationOptions.map((o) => o.label)).toEqual(["वेल्डर", "darzi", "Kuch aur"]);
  });

  it("appends the 'Kuch aur' escape with a NULL job_domain_id", async () => {
    // Without it the offer is a trap: a worker whose trade is not on a chip has no way to
    // say so, and the chip they tap anyway becomes their answer of record verbatim. The null
    // id is what tells the caller this tap resolves to no occupation.
    const { svc } = make({
      trigram: [
        { jobDomainId: "jd_weld", rawScore: 0.62 },
        { jobDomainId: "jd_tailor", rawScore: 0.6 },
      ],
    });
    const escape = (await svc.resolve("kaam")).disambiguationOptions.at(-1);
    expect(escape?.label).toBe("Kuch aur");
    expect(escape?.jobDomainId).toBeNull();
  });

  it("QUALIFIES colliding chips from the family label before abandoning", async () => {
    // "mistri" reaches a mason and a plumber. Two chips reading "mistri" would be a coin
    // flip recorded as a deliberate answer — but the families have distinct vernacular
    // names, so the offer survives instead of being thrown away.
    const { svc } = make({ snapshot: snapshotWithFamilyLabels });
    const r = await svc.resolve("mistri");
    expect(r.status).toBe("disambiguate");
    expect(r.disambiguationOptions.map((o) => o.label)).toEqual([
      "राजमिस्त्री का काम",
      "प्लंबर का काम",
      "Kuch aur",
    ]);
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

describe("OccupationService.resolve — the negative cache", () => {
  it("short-circuits a known-unresolved phrase without paying for L2", async () => {
    // The growth queue IS the negative cache. Rediscovering a known miss with a trigram scan
    // on every repeat is pure waste on exactly the phrases workers say most.
    const { svc, repo } = make({ knownUnresolved: true });
    const r = await svc.resolve("kuch bilkul alag");
    expect(r.status).toBe("unresolved");
    expect(r.reason).toContain("negative cache");
    expect(repo.trigramCandidates).not.toHaveBeenCalled();
  });

  it("is NOT probed when L0/L1 already found something", async () => {
    // A phrase can be in the queue AND newly resolvable: ops adds an alias, `status` stays
    // `open` until someone closes it. Letting the free layers speak first means a stale row
    // can never suppress a hit that now exists.
    const { svc, repo } = make({ knownUnresolved: true });
    const r = await svc.resolve("welder");
    expect(r.status).toBe("auto");
    expect(repo.isKnownUnresolved).not.toHaveBeenCalled();
  });

  it("still climbs to L2 when the phrase is NOT a known miss", async () => {
    const { svc, repo } = make({ knownUnresolved: false });
    await svc.resolve("kuch bilkul alag");
    expect(repo.isKnownUnresolved).toHaveBeenCalled();
    expect(repo.trigramCandidates).toHaveBeenCalled();
  });
});

describe("OccupationService.resolve — the IDF tie-break", () => {
  it("prefers the claimant whose OTHER tokens match the utterance", async () => {
    // "mistri" reaches a mason and a plumber with identical evidence. The rest of the
    // sentence is the only thing that can separate them, and `deewar` belongs to masonry.
    //
    // THE IDS ARE CHOSEN SO LEXICOGRAPHIC ORDER DISAGREES WITH THE RIGHT ANSWER. The mason
    // is `jd_zmason` and the plumber `jd_aplumb`, so the final id tie-break would put the
    // PLUMBER first. Only the IDF overlap can produce the mason — which is what makes this
    // test able to fail. The first version used `jd_mason`/`jd_plumb`, where alphabetical
    // order already gave the expected answer, and deleting the entire tie-break left the
    // suite green.
    // THE FILLER DOMAINS ARE NOT PADDING. IDF is `log(N / (df + 1))`, which DEGENERATES TO
    // ZERO at small N: with only the two domains below, `deewar` scores log(2/2) = 0 and
    // `mistri` scores log(2/3), clamped to 0 — every weight is zero and the tie-break cannot
    // fire at all. The real catalogue has N = 4,071, where a df-1 token scores ~7.6. The
    // filler restores enough N for the formula to mean something, and the first version of
    // this test failed for exactly this reason before the filler existed.
    const filler = Array.from({ length: 10 }, (_, i) => ({
      jobDomainId: `jd_filler_${i}`,
      labelEn: `Filler ${i}`,
      labelHi: null,
      iscoUnitCode: "9999",
    }));
    const tie = buildOccupationSnapshot({
      catalogVersion: "cat-1",
      domains: [
        { jobDomainId: "jd_zmason", labelEn: "Mason", labelHi: null, iscoUnitCode: "7112" },
        { jobDomainId: "jd_aplumb", labelEn: "Plumber", labelHi: null, iscoUnitCode: "7126" },
        ...filler,
      ],
      aliases: [
        { jobDomainId: "jd_zmason", text: "mistri" },
        { jobDomainId: "jd_zmason", text: "deewar" },
        { jobDomainId: "jd_aplumb", text: "mistri" },
        { jobDomainId: "jd_aplumb", text: "nal" },
        ...filler.map((f, i) => ({ jobDomainId: f.jobDomainId, text: `filler${i}` })),
      ],
      bindings: BINDINGS,
      familyLabels: new Map([
        ["fam_masonry", "राजमिस्त्री"],
        ["fam_plumbing", "प्लंबर"],
      ]),
    });
    const { svc } = make({ snapshot: tie });
    const r = await svc.resolve("mistri deewar");
    expect(r.candidates[0]?.jobDomainId).toBe("jd_zmason");
  });

  it("leaves the order alone when nothing overlaps", async () => {
    // A tie-break that cannot distinguish the candidates must not reorder them, or two
    // instances with identical evidence would offer chips in different orders.
    const { svc } = make();
    const r = await svc.resolve("mistri");
    expect(r.candidates.map((c) => c.jobDomainId)).toEqual(["jd_mason", "jd_plumb"]);
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

describe("OccupationService.recordUnresolved — the growth queue", () => {
  it("writes with scope 'occupation', never the skill scope", async () => {
    // Same table, different queue. "fitter" is legitimately an open skill gap AND an open
    // occupation gap; sharing a row would let resolving one silently close the other.
    const { svc, skills } = make();
    (skills.recordUnresolved as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({
      id: "11111111-1111-4111-8111-111111111111",
      count: 3,
    });
    await svc.recordUnresolved("Kuch Alag KAAM!", "hi");
    // STORED NORMALIZED, so the negative-cache probe can find it again. It probes on
    // `normalizeOccupationText(utterance)`; storing the raw phrase would mean the cache
    // never hits for the same trade said twice — and a cache that silently never hits is
    // indistinguishable from one that works.
    expect(skills.recordUnresolved).toHaveBeenCalledWith("kuch alag", null, "hi", "occupation");
  });

  it("emits the phrase HASH, never the phrase", async () => {
    // Even pseudonymized text must not ride the event spine. The payload is `.strict()`,
    // so an attempt to add the text back is a schema failure, not a silent leak.
    const { svc, skills, events } = make();
    (skills.recordUnresolved as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({
      id: "11111111-1111-4111-8111-111111111111",
      count: 2,
    });
    await svc.recordUnresolved("kuch alag kaam", "hi");

    const emitted = (events.emit as unknown as ReturnType<typeof vi.fn>).mock.calls[0]?.[0] as {
      event_name: string;
      payload: Record<string, unknown>;
    };
    expect(emitted.event_name).toBe("occupation.phrase_unresolved");
    expect(emitted.payload.phrase_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(JSON.stringify(emitted)).not.toContain("kuch alag kaam");
  });

  it("keys idempotency on the row AND the count", async () => {
    // On the row alone, a genuine second occurrence would be swallowed as a retry; on
    // neither, an at-least-once retry would double-count the growth signal.
    const { svc, skills, events } = make();
    (skills.recordUnresolved as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({
      id: "abc",
      count: 7,
    });
    await svc.recordUnresolved("phrase", "hi");
    const emitted = (events.emit as unknown as ReturnType<typeof vi.fn>).mock.calls[0]?.[0] as {
      idempotencyKey: string;
    };
    expect(emitted.idempotencyKey).toBe("occupation.phrase_unresolved:abc:7");
  });

  it("does NOT record automatically from resolve()", async () => {
    // `resolve` receives the worker's RAW utterance; this table's contract is pseudonymized
    // text only. Auto-recording would put raw worker words into an ops queue on every
    // unmatched turn, silently.
    const { svc, skills } = make();
    await svc.resolve("aaj mausam accha hai");
    expect(skills.recordUnresolved).not.toHaveBeenCalled();
  });
});
