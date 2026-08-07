import { describe, expect, it } from "vitest";

import { jobDomainIdFor, loadJobDomainCorpus } from "./job-domain-corpus";
import { loadQuestionPackCorpus } from "./question-pack-corpus";
import { resolveFamily, type ResolvableBinding } from "./question-pack-resolver";

/**
 * THE COVERAGE CLAIM, ENFORCED — "every blue-collar occupation reaches a real pack".
 *
 * WHY THIS FILE EXISTS. That number is the headline of Phase 6 and it was verified by NOTHING
 * automated. The live verifier's coverage check is real but cannot carry it: it counts DISTINCT
 * UNIT GROUPS (≤199) rather than occupations, it is `level: "WARN"` so it can never fail the gate,
 * it only exists on the live-database path (`--corpus` skips it and prints no coverage at all),
 * and it joins `profiling_family_binding` without ever touching `question_pack` — so it measures
 * BINDING reach, not PACK reach. On top of that, `db:verify:packs` runs in no CI workflow.
 *
 * The whole claim is computable from committed data with no Postgres, which is what makes it
 * gateable here: the occupations come from the job-domain corpus, the bindings and packs from the
 * question-pack corpus, and the decision from the same `resolveFamily` the runtime and the deploy
 * gate both use. A regression now fails a PR instead of a dev's memory.
 */

/** Majors 5–9 are the blue-collar span the plan scopes: services, agriculture, crafts, plant, elementary. */
const BLUE_COLLAR_MAJORS = new Set(["5", "6", "7", "8", "9"]);

function blueCollarOccupations() {
  return loadJobDomainCorpus().filter(
    (d) =>
      d.selectable &&
      // STATUS IS DELIBERATELY NOT CONSULTED, and that is the accurate filter rather than the
      // cautious-looking one. `JobDomainSeedRecord` does not declare it, `seed-job-domains.ts`
      // never reads it, and `job_domain.status` is `.notNull().default("active")` — so every
      // seeded row is active regardless of what the JSONL says (today: `"active"` on all 3,452
      // occurrences that carry it, absent on the rest). Filtering on it here would make this
      // suite disagree with the database it is supposed to describe.
      d.isco_unit !== null &&
      d.isco_major !== null &&
      BLUE_COLLAR_MAJORS.has(d.isco_major),
  );
}

function bindingsOf(): ResolvableBinding[] {
  const corpus = loadQuestionPackCorpus();
  return corpus.bindings.map((b) => ({
    familyId: b.family_id,
    jobDomainId: b.job_domain_id ?? null,
    iscoUnitCode: b.isco_unit_code ?? null,
    iscoMinorCode: b.isco_minor_code ?? null,
    iscoSubmajorCode: b.isco_submajor_code ?? null,
    iscoMajorCode: b.isco_major_code ?? null,
    isUniversal: b.is_universal ?? false,
  }));
}

/** family_id → true when that family has an ACTIVE pack. Reach means a pack, not a binding. */
function familiesWithActivePack(): Set<string> {
  const corpus = loadQuestionPackCorpus();
  return new Set(
    corpus.packs.filter((p) => p.status === "active").map((p) => p.family_id),
  );
}

describe("every blue-collar occupation reaches a real question pack", () => {
  const occupations = blueCollarOccupations();
  const bindings = bindingsOf();
  const active = familiesWithActivePack();

  // NOTE the id below is DERIVED via `jobDomainIdFor`, the same helper the seeder uses.
  // `JobDomainSeedRecord` carries no `job_domain_id` field, so reading one directly hands
  // `resolveFamily` `undefined` for every occupation — silently disabling its most specific
  // level and reducing every diagnostic in this file to a list of `undefined`.

  it("the catalogue is the size the plan scopes, so this suite cannot pass vacuously", () => {
    // Without this, deleting the corpus would make every assertion below trivially true.
    expect(occupations.length).toBeGreaterThan(2000);
    expect(bindings.length).toBeGreaterThan(50);
    expect(active.size).toBeGreaterThan(50);
  });

  it("resolves EVERY occupation to a family — none falls off the chain", () => {
    const unresolved = occupations.filter(
      (d) => resolveFamily(bindings, { jobDomainId: jobDomainIdFor(d), iscoUnitCode: d.isco_unit }) === null,
    );
    expect(unresolved.map(jobDomainIdFor)).toEqual([]);
  });

  it("resolves every occupation to a family that HAS AN ACTIVE PACK", () => {
    // The check the live verifier cannot make: it never joins `question_pack`, so an occupation
    // bound to a family with no active pack would still count as covered there.
    const packless = occupations.filter((d) => {
      const r = resolveFamily(bindings, { jobDomainId: jobDomainIdFor(d), iscoUnitCode: d.isco_unit });
      return r !== null && !active.has(r.familyId);
    });
    expect(packless.map(jobDomainIdFor)).toEqual([]);
  });

  it("reaches a NON-UNIVERSAL pack — the universal fallback is not coverage", () => {
    // "Reaches a pack" and "reaches a trade pack" are different claims, and only the second is
    // worth anything to a worker: the universal pack is the same seven questions for everyone.
    const onlyUniversal = occupations.filter((d) => {
      const r = resolveFamily(bindings, { jobDomainId: jobDomainIdFor(d), iscoUnitCode: d.isco_unit });
      return r === null || r.specificity === 0;
    });
    expect(onlyUniversal.map(jobDomainIdFor)).toEqual([]);
  });

  it("reports the specificity mix, so a silent slide toward the fallback is visible", () => {
    const mix = new Map<number, number>();
    for (const d of occupations) {
      const r = resolveFamily(bindings, { jobDomainId: jobDomainIdFor(d), iscoUnitCode: d.isco_unit });
      const key = r?.specificity ?? -1;
      mix.set(key, (mix.get(key) ?? 0) + 1);
    }
    // Unit-level (40) is the most specific level the corpus actually uses; minor-level (30) is the
    // cluster tier. Both are real packs. Nothing may land on universal (0) or unresolved (-1).
    expect(mix.get(0) ?? 0).toBe(0);
    expect(mix.get(-1) ?? 0).toBe(0);
    expect((mix.get(40) ?? 0) + (mix.get(30) ?? 0)).toBe(occupations.length);
  });
});
