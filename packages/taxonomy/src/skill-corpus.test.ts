import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { getSkill, SKILLS } from "./index";
import {
  LEGACY_SKILL_IDS,
  SKILL_CORPUS,
  SKILL_DOMAINS,
  type SkillSource,
  validateSkillCorpus,
} from "./skill-corpus";

describe("SKILL_CORPUS — canonical skill vocabulary (ADR-0030 / TAX-2)", () => {
  it("is structurally valid (unique ids, known domains, valid source/status)", () => {
    expect(validateSkillCorpus()).toEqual([]);
  });

  it("every entry has a valid domain_id (in SKILL_DOMAINS) and a valid source", () => {
    const domains = new Set<string>(SKILL_DOMAINS.map((d) => d.id));
    const sources = new Set<SkillSource>(["esco", "onet", "nco", "rvm"]);
    for (const s of SKILL_CORPUS) {
      expect(domains.has(s.domainId), `${s.skillId}: domain ${s.domainId}`).toBe(true);
      expect(sources.has(s.source), `${s.skillId}: source ${s.source}`).toBe(true);
      for (const a of s.aliases) expect(sources.has(a.source)).toBe(true);
    }
  });

  it("preserves the 9 legacy placeholder skill_* ids (existing ids must remain stable)", () => {
    const corpusIds = new Set(SKILL_CORPUS.map((s) => s.skillId));
    // Every legacy placeholder id from index.ts SKILLS is still present in the corpus…
    for (const legacy of SKILLS) {
      expect(LEGACY_SKILL_IDS).toContain(legacy.id);
      expect(corpusIds.has(legacy.id), `corpus missing legacy ${legacy.id}`).toBe(true);
      // …and still resolves through the placeholder accessor (unchanged).
      expect(getSkill(legacy.id)?.id).toBe(legacy.id);
    }
    // LEGACY_SKILL_IDS and the index.ts SKILLS are the same 9 ids.
    expect(new Set(LEGACY_SKILL_IDS)).toEqual(new Set(SKILLS.map((s) => s.id)));
  });

  it("represents all four sources — including the NCO India occupation-name anchors", () => {
    const present = new Set(SKILL_CORPUS.map((s) => s.source));
    for (const src of ["esco", "onet", "nco", "rvm"] as const) {
      expect(present.has(src), `no ${src} entries`).toBe(true);
    }
    // NCO India occupation names present (test-case 2).
    const nco = SKILL_CORPUS.filter((s) => s.source === "nco").map((s) => s.labelEn);
    expect(nco).toContain("Welder");
    expect(nco.length).toBeGreaterThanOrEqual(2);
  });

  it("has a PROVENANCE.md recording the licence for each external source", () => {
    // The §7(c) gate: provenance/licence file present + names each source's terms.
    const path = join(__dirname, "..", "PROVENANCE.md");
    expect(existsSync(path)).toBe(true);
    const md = readFileSync(path, "utf8");
    expect(md).toMatch(/ESCO/);
    expect(md).toMatch(/CC-BY 4\.0/);
    expect(md).toMatch(/onet/i); // O*NET (markdown-escaped in prose; `onet` in the source table)
    expect(md).toMatch(/GODL-India/);
    expect(md).toMatch(/NCO-2015/);
  });
});
