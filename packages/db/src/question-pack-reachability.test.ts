/**
 * REACHABILITY — can a worker's own words actually reach the pack authored for their trade?
 *
 * WHY THIS FILE EXISTS. `verify-question-packs` proves a pack is well-formed and that its family
 * has a binding. Neither says anything about whether a real worker ever LANDS on that binding, and
 * that is the gap a role pack falls into. `qp_cnc_turning` was authored bound to the two NCO codes
 * whose titles say "Turning" — and the alias corpus routes "kharad", "lathe", "turning ka kaam",
 * "cnc", "cnc operator" and "machinist" to five OTHER codes. Every one of those workers is a
 * turner; none of them would have been asked a single turning question. The pack would have been
 * measured dead in production while every structural gate stayed green.
 *
 * So this asserts the thing that actually matters: for each alias phrase a worker plausibly says,
 * WHICH family answers. It is a characterization test — it pins today's routing so a change to the
 * alias corpus or to a binding shows up as a diff a human reads, rather than as a trade quietly
 * losing its interview.
 *
 * PRIVACY: occupation ids and reviewed alias text. No worker data.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { loadQuestionPackCorpus, QUESTION_PACK_DATA_DIR } from "./question-pack-corpus";
import { resolveFamily, type ResolvableBinding } from "./question-pack-resolver";

const JOB_DOMAIN_DIR = join(__dirname, "..", "data", "job-domains");

interface AliasRow {
  kind?: string;
  job_domain_id?: string;
  text?: string;
}

/** Every `rvm` alias phrase → the job domain it points at. */
function aliasIndex(): Map<string, string> {
  const out = new Map<string, string>();
  const file = join(JOB_DOMAIN_DIR, "rvm-aliases.jsonl");
  if (!existsSync(file)) return out;
  for (const line of readFileSync(file, "utf8").split(/\r?\n/)) {
    const trimmed = line.trim();
    if (trimmed.length === 0 || trimmed.startsWith("#")) continue;
    let row: AliasRow;
    try {
      row = JSON.parse(trimmed) as AliasRow;
    } catch {
      continue;
    }
    if (row.kind === "alias" && row.job_domain_id && row.text) {
      out.set(row.text.toLowerCase(), row.job_domain_id);
    }
  }
  return out;
}

/** `jd_nco_7223_6001` → its ISCO unit `7223`, the way the resolver's ancestry walk needs it. */
function iscoUnitOf(jobDomainId: string): string | null {
  const m = /^jd_(?:nco|isco)_(\d{4})/.exec(jobDomainId);
  return m?.[1] ?? null;
}

const corpus = loadQuestionPackCorpus(QUESTION_PACK_DATA_DIR);

const bindings: ResolvableBinding[] = corpus.bindings.map((b) => ({
  familyId: b.family_id,
  jobDomainId: b.job_domain_id ?? null,
  iscoUnitCode: b.isco_unit_code ?? null,
  iscoMinorCode: b.isco_minor_code ?? null,
  iscoSubmajorCode: b.isco_submajor_code ?? null,
  iscoMajorCode: b.isco_major_code ?? null,
  isUniversal: b.is_universal ?? false,
}));

const aliases = aliasIndex();

/** Which family answers a worker who says `phrase`? */
function familyFor(phrase: string): string | null {
  const jobDomainId = aliases.get(phrase.toLowerCase());
  if (!jobDomainId) return null;
  return (
    resolveFamily(bindings, { jobDomainId, iscoUnitCode: iscoUnitOf(jobDomainId) })?.familyId ??
    null
  );
}

/**
 * The turning vocabulary, and the family each phrase currently reaches.
 *
 * `fam_machining` here is NOT a pass — it means that worker gets the six generic machining
 * questions and no turning depth at all. The list is written out in full, rather than asserted as
 * a count, so the review of any change is "this phrase moved from A to B".
 */
const TURNING_PHRASES = [
  "cnc turning",
  "kharad",
  "lathe",
  "turning ka kaam",
  "cnc",
  "cnc operator",
  "cnc machine",
  "machinist",
] as const;

/**
 * The GRINDING vocabulary — Batch 1, and the sharpest contrast with turning in this file.
 *
 * Turning went from one reachable phrase to six PURELY by binding, because 7223.0701 already
 * carried six vernacular aliases. Grinding had no such code: the entire grinding vernacular in the
 * alias corpus is three phrases, all on 7223.2200 ("Grinder, Tool and Cutter"), plus the
 * Devanagari ग्राइंडिंग added with the pack. The bare English "grinder" is deliberately NOT an
 * alias — it is also what an angle-grinder hand in a fabrication shop calls himself, and hanging
 * it here would route a weld-dresser into questions about work-head alignment and Ra 0.4.
 */
const GRINDING_PHRASES = ["grinding machine", "ghisai", "घिसाई", "ग्राइंडिंग"] as const;

describe("role-pack reachability — do a worker's own words reach the pack for their trade", () => {
  it("the fixtures load at all — without this every assertion below is vacuous", () => {
    expect(bindings.length).toBeGreaterThan(0);
    expect(aliases.size).toBeGreaterThan(0);
    for (const phrase of TURNING_PHRASES) {
      expect(aliases.has(phrase), `alias "${phrase}" is not in rvm-aliases.jsonl`).toBe(true);
    }
  });

  it("qp_cnc_turning is bound to a family that the resolver can actually reach", () => {
    const turning = corpus.bindings.filter((b) => b.family_id === "fam_cnc_turning");
    expect(turning.length).toBeGreaterThan(0);
    for (const b of turning) {
      expect(b.job_domain_id, "turning binds by job domain, never by ISCO unit").toBeTruthy();
      const resolved = resolveFamily(bindings, {
        jobDomainId: b.job_domain_id as string,
        iscoUnitCode: iscoUnitOf(b.job_domain_id as string),
      });
      expect(resolved?.familyId, `binding ${b.job_domain_id} is shadowed`).toBe("fam_cnc_turning");
      expect(resolved?.specificity, "job_domain must outrank fam_machining's unit binding").toBe(
        50,
      );
    }
  });

  it("CHARACTERIZES which turning phrases reach turning depth today", () => {
    const routing = Object.fromEntries(TURNING_PHRASES.map((p) => [p, familyFor(p)]));
    // Read this as a report, not as an aspiration.
    //
    // The six `fam_cnc_turning` rows are the owner ruling of 2026-08-28 working: binding
    // 7223.0701 ("Lathe Machinist", which owns kharad / kharaad / खराद / lathe / लेथ /
    // "turning ka kaam") and 7223.0601 took reach from ONE phrase to six, with no change to the
    // alias corpus.
    //
    // The two `fam_machining` rows are DELIBERATE, not a gap. 7223.5001 owns the machine-agnostic
    // "cnc" / "cnc operator" / "cnc machine", and 7223.0500 owns "machinist"; a VMC or milling
    // operator says those words too, and the generic machining pack's first question
    // (`machine_type`) disambiguates lathe from VMC correctly. Routing them here would ask a
    // milling operator about chucks and tailstocks.
    expect(routing).toEqual({
      "cnc turning": "fam_cnc_turning",
      kharad: "fam_cnc_turning",
      lathe: "fam_cnc_turning",
      "turning ka kaam": "fam_cnc_turning",
      cnc: "fam_machining",
      "cnc operator": "fam_machining",
      "cnc machine": "fam_machining",
      machinist: "fam_machining",
    });
  });

  it("the Devanagari twins of the turning phrases route identically to their Latin forms", () => {
    // A worker typing खराद and a worker typing "kharad" are the same worker. If the alias corpus
    // ever points one at a different code the two would get different interviews, which is exactly
    // the kind of split nobody notices.
    for (const [latin, devanagari] of [
      ["kharad", "खराद"],
      ["lathe", "लेथ"],
    ] as const) {
      expect(aliases.has(devanagari), `alias "${devanagari}" is missing`).toBe(true);
      expect(familyFor(devanagari), `"${devanagari}" != "${latin}"`).toBe(familyFor(latin));
    }
  });

  it("no turning phrase falls all the way through to the universal pack", () => {
    // Falling to `fam_universal` would be strictly worse than the generic machining pack: the
    // worker would not even be asked which machine they run.
    for (const phrase of TURNING_PHRASES) {
      expect(familyFor(phrase), `"${phrase}" falls through to universal`).not.toBe("fam_universal");
    }
  });

  it("qp_cnc_grinding is bound to a family that the resolver can actually reach", () => {
    const grinding = corpus.bindings.filter((b) => b.family_id === "fam_cnc_grinding");
    expect(grinding.length).toBeGreaterThan(0);
    for (const b of grinding) {
      expect(b.job_domain_id, "grinding binds by job domain, never by ISCO unit").toBeTruthy();
      const resolved = resolveFamily(bindings, {
        jobDomainId: b.job_domain_id as string,
        iscoUnitCode: iscoUnitOf(b.job_domain_id as string),
      });
      expect(resolved?.familyId, `binding ${b.job_domain_id} is shadowed`).toBe("fam_cnc_grinding");
      expect(resolved?.specificity, "job_domain must outrank the unit bindings").toBe(50);
    }
  });

  it("CHARACTERIZES which grinding phrases reach grinding depth today", () => {
    const routing = Object.fromEntries(GRINDING_PHRASES.map((p) => [p, familyFor(p)]));
    // Read this as a report. All four reach the pack, and that is the WHOLE reach — a grinder
    // who types only "grinder" or "surface grinding" still has to be recognised by the
    // interview, because neither phrase is an alias anywhere in the corpus.
    expect(routing).toEqual({
      "grinding machine": "fam_cnc_grinding",
      ghisai: "fam_cnc_grinding",
      घिसाई: "fam_cnc_grinding",
      ग्राइंडिंग: "fam_cnc_grinding",
    });
  });

  it("binding grinding did not move a single turning or milling phrase", () => {
    // THE REGRESSION THAT MATTERS WHEN A THIRD MACHINING ROLE ARRIVES. 7223.2200 sits inside unit
    // 7223, the same unit fam_machining binds, so a mis-scoped binding here would silently pull
    // turners or millers off their own packs. Asserted by re-running the turning table rather
    // than by inspection.
    expect(familyFor("kharad")).toBe("fam_cnc_turning");
    expect(familyFor("lathe")).toBe("fam_cnc_turning");
    expect(familyFor("milling machine")).toBe("fam_vmc_milling");
    expect(familyFor("vmc operator")).toBe("fam_vmc_milling");
    // And the machine-agnostic words stay on the disambiguator, as the turning table records.
    expect(familyFor("cnc operator")).toBe("fam_machining");
  });
});
