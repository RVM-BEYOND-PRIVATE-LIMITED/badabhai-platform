/**
 * The internal occupation routes.
 *
 * WHY THE QUESTION-PACK ROUTE NEEDS ITS OWN TESTS. Its three selectors answer three
 * DIFFERENT questions, and the tempting simplification — "they all return a pack, just pick
 * whichever field is set" — silently breaks two of them. Falling through for `family_id`
 * would show ops somebody else's pack when the answer is "this family has none yet";
 * re-resolving for `pack_id` would hand a live conversation a different version of the pack
 * it was pinned to, mid-interview.
 */
import "reflect-metadata";
import { describe, expect, it, vi } from "vitest";
import { NotFoundException } from "@nestjs/common";

import { OccupationController } from "./occupation.controller";
import type { OccupationService } from "./occupation.service";
import type { PackRegistryService } from "../profiling/pack-registry.service";

const PACK = { pack_id: "qp_welding", version: 1, family_id: "fam_welding", items: [] };

const DOMAIN = {
  jobDomainId: "jd_weld",
  labelEn: "Welder, Gas",
  labelHi: null,
  label: "वेल्डर",
  iscoUnitCode: "7212",
  familyId: "fam_welding",
  catalogVersion: "cat-1",
};

function make(
  overrides: {
    describeDomain?: unknown;
    resolveForOccupation?: unknown;
    loadForFamily?: unknown;
    loadPinned?: unknown;
  } = {},
) {
  // `in`, not `??`. Every override here is meaningfully NULL — "no such domain", "no active
  // pack" — and `null ?? DEFAULT` yields the default, so `??` would silently turn each of the
  // 404 tests into a duplicate of the happy path. They failed loudly, which is the only
  // reason this is a comment rather than four tests that passed while asserting nothing.
  const pick = <T,>(key: keyof typeof overrides, fallback: T): T =>
    key in overrides ? (overrides[key] as T) : fallback;

  const occupation = {
    resolve: vi.fn(),
    describeDomain: vi.fn().mockReturnValue(pick("describeDomain", DOMAIN)),
  } as unknown as OccupationService;
  const packs = {
    resolveForOccupation: vi.fn().mockResolvedValue(pick("resolveForOccupation", PACK)),
    loadForFamily: vi.fn().mockResolvedValue(pick("loadForFamily", PACK)),
    loadPinned: vi.fn().mockResolvedValue(pick("loadPinned", PACK)),
  } as unknown as PackRegistryService;
  return { controller: new OccupationController(occupation, packs), occupation, packs };
}

describe("POST /internal/occupation/question-pack", () => {
  it("walks the fallback chain for job_domain_id", async () => {
    // "What would this worker actually be asked" — an unauthored trade correctly answers
    // with its parent's pack.
    const { controller, packs } = make();
    const r = await controller.questionPack({ job_domain_id: "jd_weld" });
    expect(packs.resolveForOccupation).toHaveBeenCalled();
    expect(r.pack).toEqual(PACK);
  });

  it("does NOT fall through for family_id", async () => {
    // "What does THIS family own." A fall-through would answer a question about family A
    // with family B's pack, and the pack-authoring loop would never see the gap.
    const { controller, packs } = make();
    await controller.questionPack({ family_id: "fam_welding" });
    expect(packs.loadForFamily).toHaveBeenCalledWith("fam_welding", expect.any(Number));
    expect(packs.resolveForOccupation).not.toHaveBeenCalled();
  });

  it("loads the EXACT pinned version, never re-resolving", async () => {
    // Handing a live conversation a different version of the pack it was pinned to means
    // asking question 7 of a pack whose 1-6 were never asked.
    const { controller, packs } = make();
    await controller.questionPack({ pack_id: "qp_welding", pack_version: 3 });
    expect(packs.loadPinned).toHaveBeenCalledWith("qp_welding", 3, expect.any(Number));
    expect(packs.loadForFamily).not.toHaveBeenCalled();
    expect(packs.resolveForOccupation).not.toHaveBeenCalled();
  });

  it("404s on an unknown occupation instead of falling back to universal", async () => {
    // The caller named an occupation. Answering about a different one would be a wrong
    // answer wearing a 200.
    const { controller, packs } = make({ describeDomain: null });
    await expect(controller.questionPack({ job_domain_id: "jd_nope" })).rejects.toBeInstanceOf(
      NotFoundException,
    );
    expect(packs.resolveForOccupation).not.toHaveBeenCalled();
  });

  it("404s when a family genuinely has no active pack", async () => {
    const { controller } = make({ loadForFamily: null });
    await expect(controller.questionPack({ family_id: "fam_unauthored" })).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });

  it("404s when a pinned version is gone", async () => {
    const { controller } = make({ loadPinned: null });
    await expect(
      controller.questionPack({ pack_id: "qp_welding", pack_version: 99 }),
    ).rejects.toBeInstanceOf(NotFoundException);
  });
});

describe("GET /internal/occupation/domain/:id", () => {
  it("returns catalogue metadata", () => {
    expect(make().controller.domain("jd_weld")).toMatchObject({
      job_domain_id: "jd_weld",
      label: "वेल्डर",
      family_id: "fam_welding",
    });
  });

  it("404s for unknown or non-selectable, without saying which", () => {
    // Distinguishing them would leak the shape of the catalogue's non-selectable tail.
    const { controller } = make({ describeDomain: null });
    expect(() => controller.domain("jd_nope")).toThrow(NotFoundException);
  });
});
