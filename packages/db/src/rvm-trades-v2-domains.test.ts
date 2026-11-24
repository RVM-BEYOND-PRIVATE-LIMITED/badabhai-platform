import { describe, expect, it } from "vitest";

import { jobDomainIdFor, loadJobDomainCorpus, validateJobDomainCorpus } from "./job-domain-corpus";

/**
 * #3007 (CEO pack v2, section 13.2): the three occupations NCO-2015 has no entry for are minted
 * in data/job-domains/rvm-trades-v2.jsonl. The forms that bind them (T33 CMM in #3008, T34 NDT in
 * #3016, T60 Piping in #3017) reference these ids, so they are pinned here: an id is permanent
 * once seeded, and a renamed slug would orphan every profile pointing at it.
 */
describe("Trades v2 minted occupation entries (#3007)", () => {
  const corpus = loadJobDomainCorpus();
  const byId = new Map(corpus.map((d) => [jobDomainIdFor(d), d]));

  it.each([
    ["jd_rvm_cmm_operator", "CMM Operator / Programmer", "7543"],
    ["jd_rvm_ndt_technician", "NDT Technician", "7543"],
    ["jd_rvm_piping_designer", "Piping Designer / Draughtsman", "3118"],
  ])("%s is a selectable level-5 entry under ISCO %s", (id, label, parent) => {
    const d = byId.get(id);
    expect(d, `${id} missing from the corpus`).toBeDefined();
    expect(d).toMatchObject({
      source: "rvm",
      code: null,
      level: 5,
      label_en: label,
      parent_code: parent,
      parent_source: "isco08",
      isco_unit: parent,
      selectable: true,
    });
    // Visible to search: at least one alias, and the trade's plain English name is among them.
    expect(d!.aliases.map((a) => a.text)).toContain(label.split(" / ")[0]!.toLowerCase());
  });

  it("NDT is not placed on the medical X-ray code", () => {
    expect(byId.get("jd_rvm_ndt_technician")!.parent_code).not.toBe("3211");
  });

  it("the corpus stays valid with them", () => {
    expect(validateJobDomainCorpus(corpus)).toEqual([]);
  });
});
