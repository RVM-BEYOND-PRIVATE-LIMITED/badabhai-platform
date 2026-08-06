/**
 * The alias-overlay half of the job-domain corpus loader (Phase 2).
 *
 * WHAT THESE TESTS ARE FOR. `validateAliasOverlay` is a BUILD-TIME GATE: it is the only
 * thing standing between a generated alias corpus and a seeded database, and every check
 * in it exists because the corresponding bad row is invisible once seeded. An alias on a
 * non-selectable domain seeds fine and is never retrieved. An alias that normalizes to
 * nothing seeds fine, embeds fine, and is never retrieved. A mined phone number seeds
 * fine and is then committed to git and embedded. None of these fail loudly later — so
 * they must fail here.
 *
 * The tests are therefore written as "this specific bad row is REJECTED", one per check,
 * rather than as a single happy-path assertion. A validator whose checks are never proven
 * to fire is indistinguishable from `return []`.
 */
import { describe, expect, it } from "vitest";

import {
  validateAliasOverlay,
  type JobDomainAliasOverlayRecord,
  type ResolvedJobDomain,
} from "./job-domain-corpus";

/** A minimal selectable domain to hang aliases off. */
function domain(overrides: Partial<ResolvedJobDomain> = {}): ResolvedJobDomain {
  return {
    source: "nco2015",
    code: "7212.0301",
    level: 5,
    parent_code: "7212",
    parent_source: "isco08",
    isco_major: "7",
    isco_unit: "7212",
    skill_level: 2,
    label_en: "Welder",
    label_hi: null,
    description_en: null,
    selectable: true,
    industry_id: null,
    canonical_role_id: null,
    aliases: [{ text: "Welder", lang: "en", source: "nco2015" }],
    jobDomainId: "jd_nco_7212_0301",
    parentJobDomainId: "jd_isco_7212",
    ...overrides,
  };
}

function alias(overrides: Partial<JobDomainAliasOverlayRecord> = {}): JobDomainAliasOverlayRecord {
  return { kind: "alias", job_domain_id: "jd_nco_7212_0301", text: "वेल्डिंग", lang: "hi", ...overrides };
}

describe("validateAliasOverlay", () => {
  it("accepts a well-formed vernacular alias", () => {
    expect(validateAliasOverlay([alias()], [domain()])).toEqual([]);
  });

  it("rejects an alias pointing at a domain that does not exist", () => {
    const problems = validateAliasOverlay([alias({ job_domain_id: "jd_nco_9999_0000" })], [domain()]);
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain("not in the domain corpus");
  });

  it("rejects a malformed job_domain_id", () => {
    const problems = validateAliasOverlay([alias({ job_domain_id: "NCO-7212" })], [domain()]);
    expect(problems[0]).toContain("job_domain_id");
  });

  it("rejects an alias on a non-selectable domain, which retrieval could never surface", () => {
    // `is_searchable` requires `selectable AND status='active'`, so this row would seed,
    // embed, and never be returned by any layer.
    const problems = validateAliasOverlay([alias()], [domain({ selectable: false })]);
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain("not selectable");
  });

  it("rejects an alias whose source claims a published standard", () => {
    // The `source` column is how an auditor separates "the government calls this a Gas
    // Welder" from "we decided workers say gas welding wala". A mislabelled row makes
    // that distinction unrecoverable, so it is a hard error rather than a normalisation.
    const problems = validateAliasOverlay([alias({ source: "nco2015" })], [domain()]);
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain("must be source 'rvm'");
  });

  it("accepts an explicit source of rvm", () => {
    expect(validateAliasOverlay([alias({ source: "rvm" })], [domain()])).toEqual([]);
  });

  it("rejects an unknown lang", () => {
    const problems = validateAliasOverlay(
      [alias({ lang: "ta" as JobDomainAliasOverlayRecord["lang"] })],
      [domain()],
    );
    expect(problems[0]).toContain("lang must be one of");
  });

  describe("the PII guard", () => {
    // These are not style rules. The overlay's second generator mines real chat_messages,
    // so without this the corpus is one careless promotion away from committing a worker's
    // phone number to git and then embedding it.
    it.each([
      ["a Latin digit", "welder 9876"],
      ["a Devanagari digit", "वेल्डर ९८७६"],
      ["an at-sign", "welder@site"],
      ["a URL", "welder https://x.io"],
      ["a bare www host", "welder www.x.io"],
    ])("rejects %s", (_label, text) => {
      const problems = validateAliasOverlay([alias({ text, lang: "en" })], [domain()]);
      expect(problems.some((p) => p.includes("digit, '@' or a URL"))).toBe(true);
    });

    it("matches Devanagari digits, which a `\\d`-based check would miss in JS", () => {
      // JS `\d` is ASCII-only while Python's is Unicode-aware — the divergence documented
      // at skills.dto.ts:10-13. A Devanagari phone number must not pass a check an ASCII
      // one fails, so this asserts the explicit class rather than trusting `\d`.
      const ascii = validateAliasOverlay([alias({ text: "welder 1", lang: "en" })], [domain()]);
      const deva = validateAliasOverlay([alias({ text: "welder १", lang: "en" })], [domain()]);
      expect(ascii.length).toBe(deva.length);
      expect(deva.length).toBeGreaterThan(0);
    });
  });

  it("rejects text that normalizes to nothing", () => {
    // Punctuation only. The normalizer's keep-set drops all of it, leaving no lexical
    // surface at all — the row would still seed and still cost an embedding.
    //
    // Note what does NOT belong here: "ka kaam". The particle stripper has a minimum-stem
    // guard, so a string that is nothing BUT a particle keeps its text rather than
    // vanishing. Asserting otherwise would pin a behaviour the normalizer does not have.
    const problems = validateAliasOverlay([alias({ text: "- / -", lang: "en" })], [domain()]);
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain("normalizes to the empty string");
  });

  it("rejects a Devanagari danda-only string too", () => {
    const problems = validateAliasOverlay([alias({ text: "।।।" })], [domain()]);
    expect(problems[0]).toContain("normalizes to the empty string");
  });

  it("rejects an exact duplicate of a published alias", () => {
    const problems = validateAliasOverlay([alias({ text: "Welder", lang: "en" })], [domain()]);
    expect(problems.some((p) => p.includes("duplicate"))).toBe(true);
  });

  it("rejects an exact duplicate WITHIN the overlay", () => {
    const problems = validateAliasOverlay([alias(), alias()], [domain()]);
    expect(problems.some((p) => p.includes("duplicate"))).toBe(true);
  });

  describe("the normalized-collision check", () => {
    // The check that stops the corpus being padded. Three rows that all collapse to
    // `welding` are not three aliases: exactly one wins `is_searchable` and the other two
    // are unreachable rows that still cost an embedding each.
    it("rejects two aliases that differ only by a stripped particle", () => {
      const problems = validateAliasOverlay(
        [alias({ text: "welding", lang: "en" }), alias({ text: "welding wala", lang: "en" })],
        [domain()],
      );
      expect(problems).toHaveLength(1);
      expect(problems[0]).toContain("Only one of them can win is_searchable");
    });

    it("rejects an alias that collapses onto a PUBLISHED alias after case folding", () => {
      // This one fired against the real authored corpus on its first run — "gas cutter"
      // against the published "Gas Cutter" — which is why it is asserted rather than
      // assumed.
      const d = domain({ aliases: [{ text: "Gas Cutter", lang: "en", source: "nco2015" }] });
      const problems = validateAliasOverlay([alias({ text: "gas cutter", lang: "en" })], [d]);
      expect(problems).toHaveLength(1);
      expect(problems[0]).toContain("Only one of them can win is_searchable");
    });

    it("allows the same normalized form in a DIFFERENT language", () => {
      // `is_searchable` dedupes per (job_domain_id, text_norm, lang), so the scripts do
      // not compete. Devanagari and Latin forms of one trade are both reachable.
      expect(
        validateAliasOverlay(
          [alias({ text: "welding", lang: "en" }), alias({ text: "वेल्डिंग", lang: "hi" })],
          [domain()],
        ),
      ).toEqual([]);
    });

    it("allows the same normalized form on a DIFFERENT domain", () => {
      const other = domain({ jobDomainId: "jd_nco_7212_0100", code: "7212.0100", aliases: [] });
      expect(
        validateAliasOverlay(
          [alias({ text: "welding", lang: "en" }), alias({ job_domain_id: "jd_nco_7212_0100", text: "welding", lang: "en" })],
          [domain(), other],
        ),
      ).toEqual([]);
    });
  });

  it("rejects text with leading or trailing whitespace", () => {
    const problems = validateAliasOverlay([alias({ text: " welding", lang: "en" })], [domain()]);
    expect(problems.some((p) => p.includes("whitespace"))).toBe(true);
  });

  it("rejects empty text", () => {
    const problems = validateAliasOverlay([alias({ text: "   " })], [domain()]);
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain("text is empty");
  });

  it("rejects text over the length cap", () => {
    // Catches a generator that pasted a definition instead of a trade name — the failure
    // mode the scraped corpus already exhibits at 232 characters.
    const problems = validateAliasOverlay([alias({ text: "क".repeat(61) })], [domain()]);
    expect(problems.some((p) => p.includes("over the 60 cap"))).toBe(true);
  });

  it("reports EVERY problem rather than throwing on the first", () => {
    // The same discipline validateJobDomainCorpus applies, and for the same reason: a bad
    // generator run fails in families, and fixing 400 aliases one exception per run is
    // miserable.
    const problems = validateAliasOverlay(
      [
        alias({ job_domain_id: "jd_nco_9999_0000" }),
        alias({ text: "- / -", lang: "en" }),
        alias({ text: "welder 9", lang: "en" }),
      ],
      [domain()],
    );
    expect(problems.length).toBe(3);
  });
});
