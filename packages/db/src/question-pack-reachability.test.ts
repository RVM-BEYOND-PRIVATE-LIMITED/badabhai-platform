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
 * IT RESOLVES THROUGH THE REAL RETRIEVAL INDEX, and that is not a detail. The first version of
 * this file looked the phrase up in a Map built by re-reading `rvm-aliases.jsonl`, which made
 * every assertion an identity check on a row the same change had just added: the table could not
 * fail on the defects that authoring a tranche of aliases actually creates, because those defects
 * live in the INDEX and not in the file. All three that Batch 1 shipped were invisible to it —
 * a bare 1-token row winning a span its author never considered ("draughtsman" taking every
 * civil and electrical draughtsman to the mechanical pack), a bare row poisoning a skeleton
 * bucket for a whole other trade ("fusion" taking welders and every misspelling of "fashion"),
 * and a new skeleton claimant capturing another pack's own vocabulary ("cad" swallowing
 * "g code"). Resolving with `buildOccupationIndex` + `resolveOccupation` — the same pair
 * `eval-occupation-retrieval.ts` measures the acceptance gate with, over the same
 * `@badabhai/profiling-lexicon` span search production runs — is what lets a row go red.
 *
 * PRIVACY: occupation ids and reviewed alias text. No worker data.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { normalizeOccupationText } from "@badabhai/profiling-lexicon";

import { resolveJobDomainCorpus } from "./job-domain-corpus";
import { buildOccupationIndex, resolveOccupation } from "./occupation-retrieval-eval";
import { loadQuestionPackCorpus, QUESTION_PACK_DATA_DIR } from "./question-pack-corpus";
import { resolveFamily, type ResolvableBinding } from "./question-pack-resolver";

const JOB_DOMAIN_DIR = join(__dirname, "..", "data", "job-domains");

interface AliasRow {
  kind?: string;
  job_domain_id?: string;
  text?: string;
}

/**
 * Every `rvm` alias phrase → the job domain it points at.
 *
 * USED ONLY TO ASSERT THAT A ROW EXISTS IN THE FILE, never to decide where a phrase routes —
 * see the header. "The author wrote this row" and "a worker saying this word reaches that pack"
 * are different claims, and conflating them is what made the first version of this file vacuous.
 */
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

/**
 * THE REAL RETRIEVAL INDEX, built once for the file. ~150 ms for the whole NCO + ISCO corpus
 * plus the overlay, which is what `pnpm db:eval:occupation` pays on every run.
 */
const occupationIndex = buildOccupationIndex(resolveJobDomainCorpus());

/**
 * Which family answers a worker who says `phrase`?
 *
 * The full production chain, end to end: span search over the built index (L0 exact, then L1
 * skeleton, longest span first) → the ISCO unit the winning domain belongs to → `resolveFamily`.
 * A phrase that reaches no domain at all returns null, exactly as an unrecognised worker does.
 */
function familyFor(phrase: string): string | null {
  const hit = resolveOccupation(occupationIndex, phrase);
  if (hit === null) return null;
  const iscoUnitCode = occupationIndex.unitByDomain.get(hit.jobDomainId) ?? null;
  return resolveFamily(bindings, { jobDomainId: hit.jobDomainId, iscoUnitCode })?.familyId ?? null;
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
const GRINDING_PHRASES = [
  "grinding machine",
  "ghisai",
  "घिसाई",
  "ग्राइंडिंग",
  // E4 MIDDLE-WAY EXPAND-12 (Grinding starter; Turner P4 mirror). Machine-variant
  // phrases authored as aliases on jd_nco_7223_2200 in this tranche. Bare "grinder"
  // stays out (fab-shop angle-grinder collision); "grinding wala" folds via
  // particles.json and routes through the role's occupation terms, not retrieval.
  "cnc grinding",
  "surface grinding",
  "cylindrical grinding",
  "centreless grinding",
  "centerless grinding",
  "internal grinding",
  // PHASE 2 #2 (CEO Launch Plan Pack v1, sheet 15 "Words"): the part and process
  // compounds, authored on jd_nco_7223_2200 like the E4 rows.
  "bore grinding",
  "thread grinding",
  "gear grinding",
  "bearing grinding",
  "shaft grinding",
  "crank grinding",
] as const;

/**
 * The PART-PROGRAMMING vocabulary — Batch 1, and the first list in this file that is entirely the
 * alias tranche's work rather than the binding's.
 *
 * Turning gained six phrases by binding an existing code. Programming had ONE reachable phrase
 * before this batch — "cnc programmer", the published NCO title on 7223.6003, which reached the
 * code and then got `fam_machining`'s six generic questions at unit level. Nothing a worker
 * actually types ("mastercam", "part programming", "कैम प्रोग्रामर") was in the corpus at all.
 *
 * Bare "cam" is deliberately NOT here and never should be: it is a cam follower, a cam shaft and a
 * camera, and an L0 row on a three-letter word claims its skeleton for one domain as well. Bare
 * "programmer" is absent for the opposite reason: it is a level rung on three roles in this
 * cluster and an occupation term on none.
 *
 * THE G-CODE ROWS ARE THE OWNER'S FIRST DECISION MADE REACHABLE. This family is scoped to part
 * programming in general — the desk CAM programmer AND the man editing G-code at the controller —
 * so "g code" is the single most characteristic word an MDI programmer types. It reached the golf
 * caddie before Batch 1 and the mechanical DRAWING OFFICE after it, because "code" folds to the
 * "cd" skeleton that bare "cad" now owns; these exact rows are what take it back.
 */
const CAM_PHRASES = [
  "cam programmer",
  "cam programming",
  "part programming",
  "part programmer",
  "mastercam",
  "powermill",
  "solidcam",
  "edgecam",
  "post processor",
  "post processing",
  "g code",
  "gcode",
  "कैम प्रोग्रामर",
  "सीएनसी प्रोग्रामर",
  "जी कोड",
  // E5 MIDDLE-WAY EXPAND-12 (CAM starter, owner-scoped). The toolpath pair joins
  // the G-code rows as words that were reaching the WRONG trade, not merely
  // missing: "tool path" resolved to cart before its exact row.
  "toolpath",
  "tool path",
] as const;

/**
 * The DRAWING-OFFICE vocabulary — Batch 1, and the only list here where every row was measured
 * ROUTING SOMEWHERE WRONG rather than merely missing. See the characterization test below for
 * where each one used to land; "cad" reached a golf caddie and "cad designer" a garment designer.
 *
 * "catia", "creo" and "fusion" ARE ABSENT, against the role's own software list, and all three are
 * measured decisions rather than omissions. A bare alias row indexes its SKELETON too, and that
 * skeleton then belongs to one domain: creo -> "cr" swallowed car, core, carrier and courier;
 * catia -> "ct" swallowed cut, coat, cot and chat; fusion -> "fsn" is the same key as "fashion",
 * and the bare row also won at span 0 ahead of any welding span, so it took fusion welders and
 * every misspelling of "fashion" to a drawing office. An L1 hit pre-empts the trigram and vector
 * layers, so an honest MISS becomes a confident wrong answer — strictly worse than the word being
 * unreachable. "fusion 360", the form a worker really types, cannot be authored at all (the
 * overlay validator rejects digits), so all three wait on an owner ruling.
 *
 * ONLY MECHANICAL AND PACKAGE WORDS ARE HERE. The generic unit-3118 vocabulary lives in
 * DRAUGHTING_PHRASES below and routes to the router family, not to this role pack.
 */
const CAD_PHRASES = [
  "cad",
  "cad operator",
  "cad designer",
  "mechanical designer",
  "draughtsman mechanical",
  "mechanical draughtsman",
  "autocad",
  "solidworks",
  "कैड",
  "ऑटोकैड",
] as const;

/**
 * COMPOUND phrases a worker actually types, which are NOT alias rows in their own right.
 *
 * SEPARATE FROM `CAD_PHRASES` BECAUSE THE CONTRACT IS DIFFERENT. Every row in that list is an
 * authored alias; every row here is two of them in one sentence, resolved by longest-first span
 * search rather than by a row anybody wrote. That distinction is why this list exists at all —
 * `matchSpan` returns the FIRST span it hits scanning longest-first and then left to right, so a
 * compound resolves on whichever of its words comes first, and nothing in the by-phrase tables
 * above would notice if that changed.
 *
 * "cad draughtsman" IS THE PHRASE A WORKER REPORTED, and it is the sharpest case: its two words
 * pull in OPPOSITE directions. "cad" is authored on jd_nco_3118_0401 (mechanical, the role pack)
 * and "draughtsman" on jd_nco_3118_0301 (the generic title, the router) — deliberately, per
 * DRAUGHTING_PHRASES below. Left-to-right at span length 1 is what settles it for the role pack,
 * which is the right answer for a man who says CAD: he draws on a machine, and the mechanical
 * pack is the deeper interview. If a future tranche authors a longer span over either word, or
 * reorders the scan, this row moves and the diff says so.
 */
const COMPOUND_DRAWING_OFFICE_PHRASES = [
  "cad draughtsman",
  "cad draftsman",
  "autocad draughtsman",
] as const;

/**
 * THE GENERIC DRAUGHTING VOCABULARY, and the list that would have caught the worst defect in the
 * Batch 1 alias tranche.
 *
 * A bare "draughtsman" row was authored on jd_nco_3118_0401, the MECHANICAL code, whose family
 * binds at specificity 50 — above the unit-3118 router. Measured through this index: "civil
 * draughtsman", "electrical draughtsman", "architectural draughtsman", "structural draughtsman"
 * and "topographical draughtsman" all matched the 1-token span and were handed the mechanical
 * form, eighteen questions about sheet-metal flat patterns for a man who draws drainage layouts.
 * Worse than the honest NO MATCH they had before, which fell through to trigram and vector.
 *
 * The generic words therefore point at 3118.0301 ("Draftsman"), inside `fam_draughting`'s unit
 * binding, so the router's own first question is what settles which line the worker draws for.
 * That is the whole reason owner decision 2 created the router; a phrase-keyed table is the only
 * thing that proves the alias corpus actually delivers it, because the by-CODE table below
 * reports the binding rather than the routing.
 */
const DRAUGHTING_PHRASES = [
  "draughtsman",
  "draftsman",
  "drafting",
  "draughting",
  "naksha",
  "नक्शा",
  "ड्राफ्ट्समैन",
  "civil draughtsman",
  "electrical draughtsman",
  "architectural draughtsman",
  "structural draughtsman",
  "topographical draughtsman",
] as const;

/** Every occupation in NCO unit 3118 — the fourteen the two draughting families split. */
const UNIT_3118_CODES = [
  "0100",
  "0200",
  "0201",
  "0300",
  "0301",
  "0302",
  "0401",
  "0402",
  "0500",
  "0600",
  "0700",
  "0800",
  "0900",
  "9900",
] as const;

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
    // The three `fam_machining` rows are DELIBERATE, not a gap. 7223.5001 owns the
    // machine-agnostic "cnc" / "cnc operator" / "cnc machine"; a VMC or milling operator says
    // those words too, and the generic machining pack's first question (`machine_type`)
    // disambiguates lathe from VMC correctly. Routing them here would ask a milling operator
    // about chucks and tailstocks.
    //
    // "machinist" MOVED IN BATCH 2, from fam_machining to fam_conventional_machining, and this
    // row is the whole reason that move is reviewable. 7223.0500 ("Mechanist, General/Machinist")
    // owns it, and that code's NCO description is decisive — "operates various types of power
    // driven metal cutting or grinding machines... Fastens metal in chuck, jig or other fixture",
    // with no programming in it anywhere; NCO files the CNC people separately on 5001/6001-6003.
    // So the man who types "machinist" is a manual machinist and now gets manual-machining depth
    // instead of six generic questions. It does NOT reach turning: `lathe`, `kharad` and `खराद`
    // stay on fam_cnc_turning above, which is why conventional-machinist.role.ts declares those
    // as its own machine terms rather than trying to take them.
    expect(routing).toEqual({
      "cnc turning": "fam_cnc_turning",
      kharad: "fam_cnc_turning",
      lathe: "fam_cnc_turning",
      "turning ka kaam": "fam_cnc_turning",
      cnc: "fam_machining",
      "cnc operator": "fam_machining",
      "cnc machine": "fam_machining",
      machinist: "fam_conventional_machining",
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
    // Read this as a report. All sixteen reach the pack — the four shipped rows,
    // the six E4 machine-variant rows and the six Phase 2 #2 part compounds. A
    // grinder who types only "grinder" still has to be recognised by the
    // interview, because that phrase is an alias nowhere in the corpus (fab-shop
    // angle-grinder collision, pinned above).
    expect(routing).toEqual({
      "grinding machine": "fam_cnc_grinding",
      ghisai: "fam_cnc_grinding",
      घिसाई: "fam_cnc_grinding",
      ग्राइंडिंग: "fam_cnc_grinding",
      "cnc grinding": "fam_cnc_grinding",
      "surface grinding": "fam_cnc_grinding",
      "cylindrical grinding": "fam_cnc_grinding",
      "centreless grinding": "fam_cnc_grinding",
      "centerless grinding": "fam_cnc_grinding",
      "internal grinding": "fam_cnc_grinding",
      "bore grinding": "fam_cnc_grinding",
      "thread grinding": "fam_cnc_grinding",
      "gear grinding": "fam_cnc_grinding",
      "bearing grinding": "fam_cnc_grinding",
      "shaft grinding": "fam_cnc_grinding",
      "crank grinding": "fam_cnc_grinding",
    });
  });

  it("P4 MIDDLE-WAY §8 STARTER — the new Turner/VMC rows reach the right families", () => {
    // Turner + VMC only (Grinding moved in E4, CAM moves in E5). Each row below is an alias added
    // in this tranche; the second half re-runs the shipped rows to prove the tranche
    // moved nothing it did not add.
    const routing = Object.fromEntries(
      [
        "cnc kharad",
        "सीएनसी खराद",
        "turn mill",
        "twin spindle",
        "sliding head",
        "vtl",
        "live tool",
        "vmc machine",
        "machining centre",
        "machining center",
        "hmc",
        "एचएमसी",
        "मशीनिंग सेंटर",
      ].map((p) => [p, familyFor(p)]),
    );
    expect(routing).toEqual({
      "cnc kharad": "fam_cnc_turning",
      "सीएनसी खराद": "fam_cnc_turning",
      "turn mill": "fam_cnc_turning",
      "twin spindle": "fam_cnc_turning",
      "sliding head": "fam_cnc_turning",
      vtl: "fam_cnc_turning",
      "live tool": "fam_cnc_turning",
      "vmc machine": "fam_vmc_milling",
      "machining centre": "fam_vmc_milling",
      "machining center": "fam_vmc_milling",
      hmc: "fam_vmc_milling",
      एचएमसी: "fam_vmc_milling",
      "मशीनिंग सेंटर": "fam_vmc_milling",
    });
    // And the shipped rows answer exactly as before.
    expect(familyFor("turning ka kaam")).toBe("fam_cnc_turning");
    expect(familyFor("kharad")).toBe("fam_cnc_turning");
    expect(familyFor("lathe")).toBe("fam_cnc_turning");
    expect(familyFor("milling machine")).toBe("fam_vmc_milling");
    expect(familyFor("vmc operator")).toBe("fam_vmc_milling");
    expect(familyFor("cnc operator")).toBe("fam_machining");
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
  it("qp_cam_programming is bound to a family that the resolver can actually reach", () => {
    const cam = corpus.bindings.filter((b) => b.family_id === "fam_cam_programming");
    expect(cam.length).toBeGreaterThan(0);
    for (const b of cam) {
      expect(
        b.job_domain_id,
        "part programming binds by job domain, never by ISCO unit",
      ).toBeTruthy();
      const resolved = resolveFamily(bindings, {
        jobDomainId: b.job_domain_id as string,
        iscoUnitCode: iscoUnitOf(b.job_domain_id as string),
      });
      expect(resolved?.familyId, `binding ${b.job_domain_id} is shadowed`).toBe(
        "fam_cam_programming",
      );
      expect(resolved?.specificity, "job_domain must outrank fam_machining's unit binding").toBe(
        50,
      );
    }
  });

  it("CHARACTERIZES which part-programming phrases reach programming depth today", () => {
    const routing = Object.fromEntries(CAM_PHRASES.map((p) => [p, familyFor(p)]));
    // Read this as a report. Seventeen reach the pack — the fifteen shipped rows plus
    // the two E5 toolpath rows. "tool path" is the fourth ACTIVELY-WRONG fix after
    // "post processor" / "post processing" / "g code": it resolved to cart, and the
    // exact row takes it back by the same L0-beats-L1 mechanism documented above.
    //
    // THREE WERE ACTIVELY WRONG rather than merely missing, and each names its own mechanism.
    // "post processor" and "post processing": as a single token, "post" folds to the skeleton
    // "pst" and resolved to jd_isco_4412, Mail Carriers — a two-token exact row beats a one-token
    // skeleton fold, and the gerund needed its own row because it is a different exact key.
    // "g code": "code" folds to "cd", which the golf caddie owned before Batch 1 and bare "cad"
    // owns after it, so the phrase moved from one wrong answer to another until an exact row
    // claimed it. L0 is exhausted at every span before L1 is tried at any, which is why an exact
    // 2-token row wins outright over the 1-token fold.
    expect(routing).toEqual({
      "cam programmer": "fam_cam_programming",
      "cam programming": "fam_cam_programming",
      "part programming": "fam_cam_programming",
      "part programmer": "fam_cam_programming",
      mastercam: "fam_cam_programming",
      powermill: "fam_cam_programming",
      solidcam: "fam_cam_programming",
      edgecam: "fam_cam_programming",
      "post processor": "fam_cam_programming",
      "post processing": "fam_cam_programming",
      "g code": "fam_cam_programming",
      gcode: "fam_cam_programming",
      "कैम प्रोग्रामर": "fam_cam_programming",
      "सीएनसी प्रोग्रामर": "fam_cam_programming",
      "जी कोड": "fam_cam_programming",
      toolpath: "fam_cam_programming",
      "tool path": "fam_cam_programming",
    });
  });

  it("a G-code phrase inside a sentence still reaches programming, not the drawing office", () => {
    // THE SPAN-ORDER ASSERTION, and the one that fails if the exact rows above are ever tidied
    // away as redundant. A worker does not type "g code"; he types a sentence with it in the
    // middle, and the 1-token "code" fold into bare "cad"'s skeleton bucket is waiting at L1 for
    // every one of them. Only an L0 span hit pre-empts it.
    expect(familyFor("g code programmer")).toBe("fam_cam_programming");
    expect(familyFor("main g code likhta hun")).toBe("fam_cam_programming");
    expect(familyFor("gcode editing ka kaam")).toBe("fam_cam_programming");
  });

  it("the machine-agnostic CNC words stay on the disambiguator, as they do for turning", () => {
    // 7223.6003 is bound because its whole NCO definition is writing the program. 7223.5001
    // ("CNC Operator") is NOT, for exactly the reason the turning table records: a VMC operator, a
    // miller and a turner all say "cnc operator", and `qp_machining`'s first question is what
    // separates them. Routing it here would ask a button-pressing operator about post-processors.
    expect(familyFor("cnc")).toBe("fam_machining");
    expect(familyFor("cnc operator")).toBe("fam_machining");
    expect(familyFor("cnc machine")).toBe("fam_machining");
  });

  it("qp_cad_drafting is bound to a family that the resolver can actually reach", () => {
    const cad = corpus.bindings.filter((b) => b.family_id === "fam_cad_drafting");
    expect(cad.length).toBeGreaterThan(0);
    for (const b of cad) {
      expect(b.job_domain_id, "CAD binds by job domain, never by ISCO unit").toBeTruthy();
      const resolved = resolveFamily(bindings, {
        jobDomainId: b.job_domain_id as string,
        iscoUnitCode: iscoUnitOf(b.job_domain_id as string),
      });
      expect(resolved?.familyId, `binding ${b.job_domain_id} is shadowed`).toBe("fam_cad_drafting");
      expect(resolved?.specificity, "job_domain must outrank fam_draughting's unit binding").toBe(
        50,
      );
    }
  });

  it("CHARACTERIZES which drawing-office phrases reach CAD depth today", () => {
    const routing = Object.fromEntries(CAD_PHRASES.map((p) => [p, familyFor(p)]));
    // READ THIS AS A REPORT, AND AS THE SHARPEST §2b CASE IN THIS FILE. Every row below was
    // MEASURED WRONG before Batch 1, not merely missing:
    //
    //   cad, cad operator          -> jd_nco_9621_0300 "Caddie" (GOLF)      => fam_other_elementary@30
    //   cad designer, mech designer-> jd_nco_7532_0100 "Designer (Garment)" => fam_garment_trades@30
    //   autocad, solidworks, and
    //   every Devanagari form      -> NO MATCH
    //
    // "cad" was a SKELETON COLLISION, not a gap: `skeletonKey` drops interior vowels, so
    // cad -> "cd" and caddie -> "cdd" -> "cd" are one key, and the golf caddie won on an L1 fold.
    // "cad designer" was worse — an L0 exact hit on the one-token span "designer", which belongs
    // to the garment trade. Both are fixed the same way the shipped driver/Drover and
    // fitter/Father rows are: a bare L0 row pre-empts the fold, and a longer L0 span beats a
    // shorter one.
    //
    // TRACK A #4 (CEO Launch Plan Pack v1, sheet 4): the three 3D-meaning phrases below
    // moved to jd_rvm_3d_cad_designer (retired off 3118_0401, same change) — a
    // SolidWorks-main-job worker is a 3D designer, not a draughtsman.
    expect(routing).toEqual({
      cad: "fam_cad_drafting",
      "cad operator": "fam_cad_drafting",
      "cad designer": "fam_cad_design_3d",
      "mechanical designer": "fam_cad_design_3d",
      "draughtsman mechanical": "fam_cad_drafting",
      "mechanical draughtsman": "fam_cad_drafting",
      autocad: "fam_cad_drafting",
      solidworks: "fam_cad_design_3d",
      कैड: "fam_cad_drafting",
      ऑटोकैड: "fam_cad_drafting",
    });
  });

  it("CHARACTERIZES the compound phrases — two alias words in one sentence", () => {
    const routing = Object.fromEntries(COMPOUND_DRAWING_OFFICE_PHRASES.map((p) => [p, familyFor(p)]));
    // THE REPORTED DEFECT, PINNED AT THE LAYER THAT ACTUALLY FAILED. A worker typed "cad
    // draughtsman" and was asked his trade twice, with Devanagari chips the second time. The
    // alias corpus was never the problem — measured here it is a clean L0 hit on the "cad"
    // span, one candidate, one family, which `decide()` pins at 0.97 with no disambiguation
    // possible. The failure was that those rows were not in the DATABASE, which is why the
    // fix in this change is a deploy-gate check and not an edit to the corpus.
    //
    // This table is what proves the corpus side stays correct: if it ever goes red, the
    // phrase really has become ambiguous and the double-ask is a retrieval defect after all.
    expect(routing).toEqual({
      "cad draughtsman": "fam_cad_drafting",
      "cad draftsman": "fam_cad_drafting",
      "autocad draughtsman": "fam_cad_drafting",
    });
  });

  it("CHARACTERIZES the generic draughting words — they must reach the ROUTER, not the role", () => {
    const routing = Object.fromEntries(DRAUGHTING_PHRASES.map((p) => [p, familyFor(p)]));
    // THE ASSERTION THAT WOULD HAVE CAUGHT THE WORST DEFECT IN THIS TRANCHE, and the reason it
    // is phrase-keyed rather than code-keyed like the table below. Every `fam_draughting` row
    // here is a worker whose interview is the five-item router — which line do you draw for,
    // which software, which drawing type, which work, which workplace — rather than eighteen
    // mechanical questions he cannot answer. `fam_cad_drafting` appearing on ANY row below means
    // a bare 1-token row has been authored on jd_nco_3118_0401 again.
    expect(routing).toEqual({
      draughtsman: "fam_draughting",
      draftsman: "fam_draughting",
      drafting: "fam_draughting",
      draughting: "fam_draughting",
      naksha: "fam_draughting",
      नक्शा: "fam_draughting",
      ड्राफ्ट्समैन: "fam_draughting",
      "civil draughtsman": "fam_draughting",
      "electrical draughtsman": "fam_draughting",
      "architectural draughtsman": "fam_draughting",
      "structural draughtsman": "fam_draughting",
      "topographical draughtsman": "fam_draughting",
    });
  });

  it("the tranche claims nothing outside its own two trades — welders and caddies keep theirs", () => {
    // THE COLLISIONS THE CAD TRANCHE CREATED, pinned by the MISSPELLINGS rather than by the one
    // exact string that happened to be tested first — a guard asserted only on its own spelling
    // is green on the case that works and silent on the ones that do not, which is how the first
    // draft of this file passed while three welding phrases and six spellings of "fashion" were
    // being handed to a drawing office.
    // `fam_welding_trade` SINCE BATCH 2, and the assertion's meaning is unchanged: these phrases
    // must stay with WELDING rather than being swallowed by the CAD tranche's "fsn" skeleton.
    // Batch 2 bound the arc/MIG/TIG/gas occupations to the role pack, so the welding answer is now
    // the deeper one — the guard still fails the moment a drawing office takes any of them.
    for (const phrase of ["fusion welding", "fusion welder", "fusion weld", "seam fusion welder"]) {
      expect(familyFor(phrase), `"${phrase}" left the welding trade`).toBe("fam_welding_trade");
    }
    expect(familyFor("fusion cutting")).toBe("fam_fabrication"); // #3016: on 7212.0400, moved T22
    // THE "fsn" SKELETON IS LEFT UNCLAIMED, which is why bare "fusion" is not an alias and the
    // "fashion" row that guarded it was withdrawn with it. Neither this tranche's packs nor any
    // other family may answer these: an unclaimed bucket falls through to trigram and vector,
    // and an honest miss beats a confident wrong answer — the same ruling that holds back catia
    // and creo. "fusion 360" is the one that makes it concrete: it is what a CAD worker types,
    // it cannot be authored (the overlay validator rejects digits), and with a claimant in the
    // bucket it resolved to a GARMENT designer.
    for (const phrase of ["fusion", "fusion 360", "fashion", "fasion", "faishan", "phashion"]) {
      const fam = familyFor(phrase);
      expect(fam, `"${phrase}" was captured by a Batch 1 pack`).not.toBe("fam_cad_drafting");
      expect(fam, `"${phrase}" was captured by a Batch 1 pack`).not.toBe("fam_cam_programming");
    }
    // Bare "cad" REVERSES the "cd" skeleton fold rather than pre-empting it — the bucket now
    // holds the drawing office first and the caddie second — so the caddie's own spellings need
    // their own L0 rows. "cadi" is knowingly left in the drawing office: see the alias file.
    for (const phrase of ["caddie", "caddy", "golf caddy"]) {
      expect(familyFor(phrase), `"${phrase}" left the golf course`).toBe("fam_other_elementary");
    }
  });

  it("REPORTS what the unit-3118 router catches — the twelve codes CAD does not claim", () => {
    // WITHOUT `fam_draughting` EVERY ROW BELOW SAID `fam_universal` (specificity 0): eight
    // trade-agnostic questions, with not one drawing question among them, for a civil or
    // electrical draughtsman. Measured live before this batch: "draftsman" -> jd_nco_3118_0301 ->
    // fam_universal@0.
    //
    // It is resolved by CODE rather than by alias phrase on purpose. Twelve of these fourteen
    // occupations have no vernacular alias at all — their only alias is their formal NCO title —
    // so an alias-keyed table would report an absence of routing rather than the routing itself.
    //
    // BUT A CODE TABLE ALONE IS NOT EVIDENCE THAT THE ROUTER IS REACHED. It reports the BINDING;
    // whether a worker's words land on one of these codes is a different question, and it is the
    // one DRAUGHTING_PHRASES above answers. Batch 1 shipped this table green while a bare alias
    // row sent every civil and electrical draughtsman past it to the mechanical role pack.
    const routing = Object.fromEntries(
      UNIT_3118_CODES.map((code) => {
        const jobDomainId = `jd_nco_3118_${code}`;
        const r = resolveFamily(bindings, { jobDomainId, iscoUnitCode: "3118" });
        return [jobDomainId, `${r?.familyId ?? "null"}@${r?.specificity ?? "-"}`];
      }),
    );
    expect(routing).toEqual({
      jd_nco_3118_0100: "fam_draughting@40", // Draughtsperson, Architectural
      jd_nco_3118_0200: "fam_draughting@40", // Draughtsperson, Civil
      jd_nco_3118_0201: "fam_draughting@40", // Plumbing Draftsman
      jd_nco_3118_0300: "fam_draughting@40", // Draughtsperson, Electrical
      jd_nco_3118_0301: "fam_draughting@40", // Draftsman — was fam_universal@0
      jd_nco_3118_0302: "fam_draughting@40", // Physical Design Engineer
      jd_nco_3118_0401: "fam_cad_drafting@50", // Draughtsperson, Mechanical — the role pack
      jd_nco_3118_0402: "fam_cad_drafting@50", // Draughtsman-Mechanical — the role pack
      jd_nco_3118_0500: "fam_draughting@40", // Draught person, Structural
      jd_nco_3118_0600: "fam_draughting@40", // Draughtsperson, Topographical
      jd_nco_3118_0700: "fam_draughting@40", // Lithographic Designer
      jd_nco_3118_0800: "fam_draughting@40", // Tracer
      jd_nco_3118_0900: "fam_draughting@40", // Blue Printer
      jd_nco_3118_9900: "fam_draughting@40", // Draughtspersons, Other
    });
  });

  it("no CAM, CAD or draughting phrase falls all the way through to the universal pack", () => {
    for (const phrase of [
      ...CAM_PHRASES,
      ...CAD_PHRASES,
      ...DRAUGHTING_PHRASES,
      ...COMPOUND_DRAWING_OFFICE_PHRASES,
    ]) {
      expect(familyFor(phrase), `"${phrase}" falls through to universal`).not.toBe("fam_universal");
      expect(familyFor(phrase), `"${phrase}" reaches nothing at all`).not.toBeNull();
    }
  });

  it("binding the two desk trades did not move a single turning, milling or grinding phrase", () => {
    // THE REGRESSION THAT MATTERS WHEN A FIFTH AND SIXTH ROLE ARRIVE, and it is a sharper risk
    // than grinding's was. 7223.6003 sits inside unit 7223 — the unit `fam_machining` binds and
    // the turning and milling packs carve out of — so a mis-scoped programming binding would pull
    // machining workers off their own packs. The CAD tranche is riskier still: it added BARE
    // alias rows for "cad", "autocad" and "solidworks", and a bare row indexes its skeleton too.
    // Asserted by re-running the whole shipped table rather than by inspection.
    expect(familyFor("cnc turning")).toBe("fam_cnc_turning");
    expect(familyFor("kharad")).toBe("fam_cnc_turning");
    expect(familyFor("खराद")).toBe("fam_cnc_turning");
    expect(familyFor("lathe")).toBe("fam_cnc_turning");
    expect(familyFor("लेथ")).toBe("fam_cnc_turning");
    expect(familyFor("turning ka kaam")).toBe("fam_cnc_turning");
    expect(familyFor("milling machine")).toBe("fam_vmc_milling");
    expect(familyFor("vmc operator")).toBe("fam_vmc_milling");
    expect(familyFor("grinding machine")).toBe("fam_cnc_grinding");
    expect(familyFor("ghisai")).toBe("fam_cnc_grinding");
    expect(familyFor("घिसाई")).toBe("fam_cnc_grinding");
    expect(familyFor("ग्राइंडिंग")).toBe("fam_cnc_grinding");
    // And the machine-agnostic words stay on the disambiguator, as the turning table records.
    expect(familyFor("cnc operator")).toBe("fam_machining");
    // "machinist" is NO LONGER on the disambiguator — Batch 2 gave it a home. See the turning
    // table above for why 7223.0500 is unambiguously the MANUAL trade. Kept in this list, with the
    // new answer, rather than deleted: the property under guard is "the desk trades moved
    // nothing", and dropping the row would hide the next move instead of recording this one.
    expect(familyFor("machinist")).toBe("fam_conventional_machining");
  });
});

/**
 * BATCH 2, PART ONE — the four roles the corpus could already reach.
 *
 * ═══ WHY ONLY FOUR OF ELEVEN, AND WHY THAT IS THE HEADLINE ═══
 *
 * Reachability was measured for all eleven Batch 2 roles through this same chain BEFORE any pack
 * was authored. Seven cannot be reached by binding at all — "sheet metal", "fabricator" and
 * "press brake" are NO MATCH; "power press" reaches masonry; "press operator" reaches textile
 * machines; every electrician phrase reaches fam_electrical's house wiring; "qc", "quality
 * control" and "क्वालिटी" are NO MATCH. Binding decides which family a HIT lands in; it cannot
 * create a hit. Those seven wait on a ratified alias tranche rather than shipping a pack that
 * passes every structural gate and that no worker can reach.
 *
 * The four below each already owned live vernacular on a bindable code, which is the only thing
 * that separates them.
 */
describe("Batch 2 part one — the four roles whose words already reached a bindable code", () => {
  it("CHARACTERIZES the four new families, and what each deliberately did NOT take", () => {
    const routing = Object.fromEntries(
      [
        // Conventional machining — 7223.0500 owns "machinist" and "machine shop"; the rest are
        // one machine word each on their own NCO code.
        "machinist", "machine shop", "shaper", "planer", "slotter", "drilling machine",
        "radial driller", "cylinder borer",
        // Tool and die — 7222.0200 is the sole claimant of every one of these.
        "tool maker", "tool room", "टूल रूम", "टूल मेकर", "डाई मेकर", "jig borer", "jig fixture",
        // Welding — the deepest reach in the batch, because 7212.0301 already carried vernacular.
        // #3016: "gas cutting" retired off the welder (7212.0400 moved to T22) — pinned in Wave 2.
        "welder", "welding", "वेल्डर", "वेल्डिंग", "welding mistri", "jodai ka kaam", "जोड़ाई",
        "veldar", "arc welding", "mig welding", "tig welding", "gas welding",
        // Powder coating — one contaminated code doing most of the work. See below.
        "spray painter", "स्प्रे पेंटिंग", "industrial painter", "painter spray", "metal sprayer",
      ].map((p) => [p, familyFor(p)]),
    );
    expect(routing).toEqual({
      machinist: "fam_conventional_machining",
      "machine shop": "fam_conventional_machining",
      shaper: "fam_conventional_machining",
      planer: "fam_conventional_machining",
      slotter: "fam_conventional_machining",
      "drilling machine": "fam_conventional_machining",
      "radial driller": "fam_conventional_machining",
      "cylinder borer": "fam_boring_machine",
      "tool maker": "fam_tool_die_making",
      "tool room": "fam_tool_die_making",
      "टूल रूम": "fam_tool_die_making",
      "टूल मेकर": "fam_tool_die_making",
      "डाई मेकर": "fam_tool_die_making",
      "jig borer": "fam_boring_machine",
      "jig fixture": "fam_tool_die_making",
      welder: "fam_welding_trade",
      welding: "fam_welding_trade",
      "वेल्डर": "fam_welding_trade",
      "वेल्डिंग": "fam_welding_trade",
      "welding mistri": "fam_welding_trade",
      "jodai ka kaam": "fam_welding_trade",
      "जोड़ाई": "fam_welding_trade",
      veldar: "fam_welding_trade",
      "arc welding": "fam_welding_trade",
      "mig welding": "fam_welding_trade",
      "tig welding": "fam_welding_trade",
      "gas welding": "fam_welding_trade",
      "spray painter": "fam_powder_coating",
      "स्प्रे पेंटिंग": "fam_powder_coating",
      "industrial painter": "fam_powder_coating",
      "painter spray": "fam_powder_coating",
      "metal sprayer": "fam_powder_coating",
    });
  });

  it("takes nothing that belongs to a neighbouring trade", () => {
    // TURNING KEEPS THE LATHE. This is the pair that collides hardest in the whole registry, and
    // it is why conventional-machinist.role.ts declares "lathe"/"खराद" as its OWN machine terms:
    // a word shared by VALUE vetoes neither trade, and the binding never contests them.
    expect(familyFor("lathe")).toBe("fam_cnc_turning");
    expect(familyFor("kharad")).toBe("fam_cnc_turning");
    expect(familyFor("खराद")).toBe("fam_cnc_turning");
    // THE GENERIC MACHINING DISAMBIGUATOR KEEPS THE MACHINE-AGNOSTIC CNC WORDS.
    expect(familyFor("cnc")).toBe("fam_machining");
    expect(familyFor("cnc operator")).toBe("fam_machining");
    // WELDING'S ADJACENT JOINING TRADES STAY ON THE GENERIC PACK. 7212.0500 and 7212.0600 were
    // deliberately not bound: brazing and lead burning are not the arc/gas trade this pack asks
    // eighteen questions about.
    expect(familyFor("brazer")).toBe("fam_welding");
    expect(familyFor("lead burner")).toBe("fam_welding");
    // HOUSE PAINTING STAYS HOUSE PAINTING. 7131.0100 owns "painter", "पेंटर" and "paint shop" and
    // is not bound — fam_painting already disambiguates it, and a powder-coating form asking a
    // building painter about oven schedules is the failure painter-coating.role.ts exists to name.
    expect(familyFor("painter")).toBe("fam_painting");
    expect(familyFor("पेंटर")).toBe("fam_painting");
    expect(familyFor("paint shop")).toBe("fam_painting");
    // THE TOOL-ROOM NODE IS NOT BOUND, and these three are why: jd_isco_7222 owns "Locksmith",
    // "Gunsmith" and "Patternmaker" alongside "Toolmaker" and "Die maker". Binding it to win two
    // phrases would hand a locksmith questions about punch-and-die clearance, so the two one-word
    // phrases stay generic instead.
    expect(familyFor("locksmith")).toBe("fam_toolmaking");
    expect(familyFor("gunsmith")).toBe("fam_toolmaking");
    expect(familyFor("patternmaker")).toBe("fam_toolmaking");
    expect(familyFor("toolmaker")).toBe("fam_toolmaking");
    expect(familyFor("die maker")).toBe("fam_toolmaking");
  });

  it("PINS THE TWO IMPRECISIONS THIS BATCH KNOWINGLY ACCEPTED", () => {
    // NOT ASPIRATIONS — these two rows are wrong, they are bound anyway, and they are pinned so
    // the harm stays visible and reviewable rather than being discovered on a worker's screen.
    //
    // 1. "paper hanger" REACHES A POWDER-COATING FORM. The nco2015 scrape hung "Paper Hanger/
    //    Wallpaper Fixer/Decorator" on 7131.0500, which is also the ONLY row in the corpus owning
    //    "spray painter" and "स्प्रे पेंटिंग". Leaving it unbound costs the trade its commonest
    //    phrase — the qp_cnc_turning failure exactly. Binding it costs a wallpaper fixer one wrong
    //    form. The alias rows belong on a decorating code; that is ratification work.
    expect(familyFor("paper hanger")).toBe("fam_powder_coating");
    // 2. "brazier" AND "flame cutter" COME WITH THE WELDING UNIT NODE, whose isco08 alias list is
    //    "Welders and Flame Cutters / Brazier / Flame cutter / Welder". The node is bound because
    //    it is the only carrier of the bare word "welder". Flame cutting is squarely in trade; a
    //    brazier is the one accepted imprecision, and the dedicated code 7212.0500 still routes
    //    "brazer" correctly, which is why the miss is narrow.
    expect(familyFor("brazier")).toBe("fam_welding_trade");
    expect(familyFor("flame cutter")).toBe("fam_welding_trade");
  });

  it("PHASE 2 #4 — the coating trade's own name and the plating words reach its family", () => {
    // CEO Launch Plan Pack v1, sheet 20. Before this tranche the trade's own name went to the
    // welder (7212.0400 Gas Cutter) and every plating word reached nothing.
    // #3016: 8122.0100 moved to fam_surface_treatment (T28) — the plating words move with
    // it. The powder-coating trade's own words stay (their codes did not move).
    for (const p of [
      "powder coating", "पाउडर कोटिंग", "coating operator", "powder coating operator",
    ]) {
      expect(familyFor(p), p).toBe("fam_powder_coating");
    }
    for (const p of [
      "electroplating", "इलेक्ट्रोप्लेटिंग", "zinc plating", "nickel plating", "chrome plating",
    ]) {
      expect(familyFor(p), p).toBe("fam_surface_treatment");
    }
    // House painting is untouched, and the fabricator keeps its own cutting words (#3016: gas
    // cutting retired off the welder to T22 fabrication).
    expect(familyFor("painter")).toBe("fam_painting");
    expect(familyFor("gas cutting")).toBe("fam_fabrication");
    // Held out on purpose (see the rvm-aliases block): bare "plating" folds onto pleating and
    // plaiting, so it is not a row and must not reach this family.
    expect(familyFor("pleating")).not.toBe("fam_powder_coating");
  });

  it("no phrase of the four new trades falls through to the universal pack", () => {
    for (const phrase of ["machinist", "tool room", "welder", "spray painter"]) {
      expect(familyFor(phrase), `"${phrase}" falls through`).not.toBe("fam_universal");
      expect(familyFor(phrase), `"${phrase}" reaches nothing`).not.toBeNull();
    }
  });
});

/**
 * THE BATCH 2 ROUTING TRANCHE — the ratified vocabulary for the seven roles above that no worker's
 * words could reach (worksheet Part 5, signed 2026-09-24).
 *
 * WHAT A PASS HERE MEANS, precisely. Every phrase lands on the NCO code the ruling chose, and that
 * code sits under a GENERIC unit pack today — fam_sheet_metal, fam_other_craft, fam_fitting,
 * fam_electrical_equipment, fam_machining, fam_assembly. None of the seven role families is bound:
 * a family binds with its pack, because a binding with no active pack sends a worker to the
 * universal pack. So the families below are an INTERIM routing, and each one is expected to move
 * to its role family, in a diff, in the PR that ships that role's pack.
 */
describe("Batch 2 routing tranche — the seven roles' ratified vocabulary", () => {
  it("CHARACTERIZES every accepted phrase — the ruled code, on today's generic pack", () => {
    const routing = Object.fromEntries(
      [
        // Sheet metal — items 1-5, all on 7213.0101, which fam_sheet_metal_fab binds since its pack
        // shipped — so these moved off the generic minor-721 pack in that change, by design.
        // #3016: "fabricator" and "fabrication ka kaam" retired off 7213.0101 to T22 fabrication
        // (pinned in the Wave 2 block, not here).
        "sheet metal", "शीट मेटल", "press brake", "laser cutting", "chadar ka kaam",
        // Quality inspection — items 6-10, all on 7543.2001, which fam_quality_inspection binds since
        // its pack shipped — so these eight moved off the generic minor-754 pack in that change, by
        // design.
        "qc", "qc inspector", "qa qc", "quality control", "क्वालिटी", "inspection ka kaam",
        "quality check karna", "quality wala",
        // Maintenance — items 12-14, on 7233.0101, the code ruling A1 gives Maintenance Technician.
        // They reached the FITTER pack while fam_fitter held 0101 as an owner-decided interim; A1
        // landed (plain "fitter" retired off 0101) and 0101 moved to fam_maintenance_tech with its
        // pack, so these four are on the role family now, by design.
        // #3010 (CEO pack v2, 23 Nov 2026): "breakdown maintenance" and "plant maintenance" are
        // retired off 7233.0101 and left to routing (#3015), so they are no longer accepted here.
        // They are pinned as null in the "Retirements — #3010" block at the end, not here.
        "machine ki marammat", "machine repair",
        // Industrial electrician — items 17-19, on 7412.0200, which fam_industrial_electrician binds
        // since its pack shipped — so these five moved off the generic minor-741 pack in that
        // change, by design.
        "panel wiring", "industrial electrician", "इंडस्ट्रियल इलेक्ट्रीशियन", "panel electrician",
        "plant electrician",
        // Press — items 20 and 22, on 7223.2300 and 7223.3000, which fam_press_operation binds since
        // its pack shipped — so both moved off the generic unit-7223 machining pack in that change.
        "power press", "stamping",
        // Assembly line — item 25, on 8219.0100, which fam_assembly_line binds since its pack
        // shipped — so it moved off the generic unit-8219 pack in that change, by design.
        "assembly ka kaam",
      ].map((p) => [p, familyFor(p)]),
    );
    expect(routing).toEqual({
      "sheet metal": "fam_sheet_metal_fab",
      "शीट मेटल": "fam_sheet_metal_fab",
      "press brake": "fam_sheet_metal_fab",
      "laser cutting": "fam_sheet_metal_fab",
      "chadar ka kaam": "fam_sheet_metal_fab",
      qc: "fam_quality_inspection",
      "qc inspector": "fam_quality_inspection",
      "qa qc": "fam_quality_inspection",
      "quality control": "fam_quality_inspection",
      "क्वालिटी": "fam_quality_inspection",
      "inspection ka kaam": "fam_quality_inspection",
      "quality check karna": "fam_quality_inspection",
      "quality wala": "fam_quality_inspection",
      "machine ki marammat": "fam_maintenance_tech",
      "machine repair": "fam_maintenance_tech",
      "panel wiring": "fam_industrial_electrician",
      "industrial electrician": "fam_industrial_electrician",
      "इंडस्ट्रियल इलेक्ट्रीशियन": "fam_industrial_electrician",
      "panel electrician": "fam_industrial_electrician",
      "plant electrician": "fam_industrial_electrician",
      "power press": "fam_press_operation",
      stamping: "fam_press_operation",
      "assembly ka kaam": "fam_assembly_line",
    });
  });

  it("every accepted phrase lands on the exact code the ruling chose", () => {
    // The family table above cannot see a phrase landing on the WRONG CODE inside the right unit,
    // and the code is what a role family will bind. Pinned by code for exactly that reason.
    const codeFor = (p: string): string | null => resolveOccupation(occupationIndex, p)?.jobDomainId ?? null;
    for (const p of ["sheet metal", "press brake", "chadar ka kaam"]) {
      expect(codeFor(p), p).toBe("jd_nco_7213_0101");
    }
    // #3016: "fabricator" retired off 7213.0101 to T22 (now on jd_nco_7224_0102).
    expect(codeFor("fabricator"), "fabricator").toBe("jd_nco_7224_0102");
    for (const p of ["qc", "quality control", "inspection ka kaam", "quality wala"]) {
      expect(codeFor(p), p).toBe("jd_nco_7543_2001");
    }
    for (const p of ["machine ki marammat", "machine repair"]) {
      expect(codeFor(p), p).toBe("jd_nco_7233_0101");
    }
    // #3010 retires "breakdown maintenance" off 7233.0101 to routing (#3015): no claimant now.
    expect(codeFor("breakdown maintenance"), "breakdown maintenance").toBeNull();
    for (const p of ["panel wiring", "industrial electrician", "plant electrician"]) {
      expect(codeFor(p), p).toBe("jd_nco_7412_0200");
    }
    expect(codeFor("power press")).toBe("jd_nco_7223_2300");
    expect(codeFor("stamping")).toBe("jd_nco_7223_3000");
    expect(codeFor("assembly ka kaam")).toBe("jd_nco_8219_0100");
  });

  it("the STRUCK phrases reach none of the tranche's codes", () => {
    const tranche = new Set([
      "jd_nco_7213_0101", "jd_nco_7543_2001", "jd_nco_7233_0101", "jd_nco_7412_0200",
      "jd_nco_7223_2300", "jd_nco_7223_3000", "jd_nco_8219_0100",
    ]);
    // 11, 15, 16, 23, 24, 26, 27 — and 28, withdrawn after measurement (see the footing test).
    for (const p of [
      "naap tol", "maintenance", "मेंटेनेंस", "marammat ka kaam", "press ka kaam", "machine operator",
      "machine chalana", "fitting line", "production line", "fitting ka kaam",
    ]) {
      const id = resolveOccupation(occupationIndex, p)?.jobDomainId ?? null;
      expect(id !== null && tranche.has(id), `struck "${p}" reached tranche code ${id}`).toBe(false);
    }
  });

  it("ruling A2 — the generic electrician vocabulary stays on the domestic wireman", () => {
    for (const p of ["bijli mistri", "बिजली मिस्त्री", "electric mistri", "wiring ka kaam", "electrician", "wireman"]) {
      expect(familyFor(p), p).toBe("fam_electrical");
    }
  });

  it("takes nothing from a neighbouring trade — the two guard rows, and the words that stay put", () => {
    // GUARDS. Both phrases moved when the tranche's bare rows landed and both are ruled back.
    expect(familyFor("chadar silai")).toBe("fam_tailoring");
    expect(familyFor("chadar ki silai")).toBe("fam_tailoring");
    expect(familyFor("fabrication welder")).toBe("fam_welding_trade");
    expect(familyFor("welding fabrication")).toBe("fam_welding_trade");
    // "assembly fitter" routed to the fitting pack through "fitter" before the tranche, and bare
    // "assembly" would have taken it at span 0. The worksheet ruled it stays WITH THE FITTER — on
    // the guard row's 7233.0200, which fam_fitter binds since its pack shipped, so it now reaches
    // the fitter pack rather than the generic one: the ruling honoured, not reversed.
    expect(familyFor("assembly fitter")).toBe("fam_fitter");
    // Longer rows another trade already owned keep winning on longest-first.
    expect(familyFor("pipe fitting")).toBe("fam_plumbing");
    expect(familyFor("silai machine repair")).toBe("fam_fitting");
    expect(familyFor("mobile repair")).toBe("fam_electronics");
    expect(familyFor("gas cutting")).toBe("fam_fabrication"); // #3016: retired off welder to T22
    // "quality inspector" STAYS on fam_other_craft even with the QC family bound: its only alias row
    // is on the unbound ISCO node jd_isco_7543. A known gap, pinned in the QC block at the end.
    expect(familyFor("quality inspector")).toBe("fam_other_craft");
  });

  it("item 28 stays withdrawn — 'footing' is construction work, not fitting", () => {
    // "fitting" -> "ftng" == "footing". With a bare "fitting" row, both of these went NO MATCH ->
    // Fitter at L1. This goes red the moment anyone re-authors the row without a guard.
    expect(familyFor("footing")).toBeNull();
    expect(familyFor("footing ka kaam")).toBeNull();
  });

  it("PINS THE IMPRECISIONS THIS TRANCHE KNOWINGLY LEAVES", () => {
    // 1. "vehicle inspection" REACHES THE QC CODE through bare "inspection" (item 8). Accepted
    //    2026-09-24 as not a factory-trade phrase that "lands on a generic pack, not a form" —
    //    and the second half of that no longer holds: fam_quality_inspection binds 7543.2001 since
    //    the QC pack shipped, so this phrase now reaches the QC family, and the code's chip label
    //    ("qc") is a QC occupation term, so a pin here hands over to the QC form. RE-AFFIRMED by
    //    the owner 2026-09-24, knowing it now reaches a form: still accepted, still pinned.
    expect(familyFor("vehicle inspection")).toBe("fam_quality_inspection");
    // 2. ALL THREE RETIREMENTS HAVE LANDED (rvm-alias-retirements.jsonl, 2026-09-25; pinned in
    //    full in "Retirements — A4 and item 21" and the maintenance block at the end):
    //    A4: bare "machine …" no longer reaches dairy — it reaches nothing, and the interview asks,
    expect(familyFor("machine operator")).toBeNull();
    //    21: "press operator" is the metal press shop,
    expect(familyFor("press operator")).toBe("fam_press_operation");
    //    A1: plain "fitter" is Bench Fitter's, off 7233.0101 (now the maintenance technician's).
    expect(resolveOccupation(occupationIndex, "fitter")?.jobDomainId).toBe("jd_nco_7233_0200");
    // 3. "naap tol" is STRUCK from QC but was a cart puller before the tranche and still is — the
    //    strike keeps it off the inspector's code, it does not repair the L1 fold on "tol".
    expect(familyFor("naap tol")).toBe("fam_cart");
  });
});

/**
 * BATCH 2 PART TWO — SHEET METAL, the first of the seven to ship its pack.
 *
 * Two bindings, both measured before they were written: 7213.0101 carries the tranche's whole
 * sheet-metal vocabulary, and 7223.2400 carries its own published title "Sheet Metal Machine
 * Operator". Every other code in unit 7213 stays on the generic minor-721 pack — the auto-body
 * denters, the tinsmiths and the "Structural" code, whose NCO description is vehicle and aircraft
 * body assembly despite its name.
 */
describe("Batch 2 part two — sheet metal", () => {
  it("binds exactly the two codes its words reach", () => {
    const codes = corpus.bindings
      .filter((b) => b.family_id === "fam_sheet_metal_fab")
      .map((b) => b.job_domain_id);
    expect(codes).toEqual(["jd_nco_7213_0101", "jd_nco_7223_2400"]);
    expect(familyFor("sheet metal machine operator")).toBe("fam_sheet_metal_fab");
    expect(familyFor("sheet metal worker")).toBe("fam_sheet_metal_fab");
    // The L1 fold of the tranche's "chadar" comes with it — a misspelling, not a new claim.
    expect(familyFor("chaddar")).toBe("fam_sheet_metal_fab");
  });

  it("leaves the auto-body and tinsmith codes on the generic pack", () => {
    // #3016: "tin coater" sits on 8122.0100, moved with it to T28 surface treatment.
    for (const p of ["dent remover", "tinsmith", "panel beater", "boilersmith"]) {
      expect(familyFor(p), p).toBe("fam_sheet_metal");
    }
    expect(familyFor("sheet metal worker structural")).toBe("fam_sheet_metal");
  });

  it("no sheet metal phrase falls through to the universal pack", () => {
    for (const p of ["sheet metal", "press brake", "laser cutting", "fabricator", "शीट मेटल"]) {
      expect(familyFor(p), `"${p}" falls through`).not.toBe("fam_universal");
      expect(familyFor(p), `"${p}" reaches nothing`).not.toBeNull();
    }
  });
});

/**
 * BATCH 2 PART TWO — INDUSTRIAL ELECTRICIAN.
 *
 * ONE binding, measured before it was written: 7412.0200 "Electrical Fitter" carries the tranche's
 * whole industrial vocabulary (worksheet Part 5, items 17-19) and its own published title. Every
 * other code in unit 7412 stays on the generic minor-741 pack (`fam_electrical_equipment`) —
 * automation, winding, relays, PCB test, vehicle electricians, the "Mechanical Fitter" codes whose
 * alias every mechanical fitter says, and the unit's catch-all — and the ISCO node jd_isco_7412 is
 * NOT bound, because its aliases are the automotive electrician and the lift mechanic.
 *
 * RULING A2 is the other half: the generic electrician vocabulary stays on the domestic wireman,
 * so nothing in 7411 is bound and every one of those words still reaches `fam_electrical`.
 */
describe("Batch 2 part two — industrial electrician", () => {
  it("binds exactly the one code its words reach", () => {
    const codes = corpus.bindings
      .filter((b) => b.family_id === "fam_industrial_electrician")
      .map((b) => b.job_domain_id);
    expect(codes).toEqual(["jd_nco_7412_0200"]);
    const codeFor = (p: string): string | null => resolveOccupation(occupationIndex, p)?.jobDomainId ?? null;
    // The two tranche phrases the ruled-code test above does not pin, and the code's own title.
    for (const p of ["panel electrician", "इंडस्ट्रियल इलेक्ट्रीशियन", "electrical fitter"]) {
      expect(codeFor(p), p).toBe("jd_nco_7412_0200");
    }
    expect(familyFor("electrical fitter")).toBe("fam_industrial_electrician");
    // A rung or a filler beside the trade word keeps the route: the span search takes the longest
    // alias it finds and the rest of the sentence costs nothing.
    for (const p of ["senior industrial electrician", "panel wiring helper", "panel wiring ka kaam"]) {
      expect(familyFor(p), p).toBe("fam_industrial_electrician");
    }
  });

  it("ruling A2 — no generic electrician word moves off the domestic wireman", () => {
    for (const p of [
      "bijli mistri", "बिजली मिस्त्री", "electric mistri", "wiring ka kaam", "ilectrician",
      "electrician", "bijli", "bijli ka kaam", "वायरिंग", "wireman", "electrician general",
    ]) {
      expect(familyFor(p), p).toBe("fam_electrical");
    }
    // AN UNQUALIFIED "… electrician" IS STILL THE BARE WORD. "maintenance electrician" and
    // "factory electrician" own no alias, so the span search lands on "electrician" and the house
    // wireman's interview — the fail-safe direction A2 chose, recorded so a future alias shows here.
    for (const p of ["maintenance electrician", "factory electrician", "auto electrician"]) {
      expect(familyFor(p), p).toBe("fam_electrical");
    }
  });

  it("leaves every other 7412 neighbour, and the ISCO node, on the generic pack", () => {
    // 7412.0101 "automation specialist" (process-control systems) LEFT this list in Phase 2 #6:
    // it is the PLC / automation family's own code now (see the Phase 2 #6 block at the end).
    for (const p of [
      "fitter-electrical and electronic assembly", // 7412.0201 — panels and electronics
      // "mechanical fitter" LEFT this list in the CEO-pack sheet-word audit (2026-11-04): sheet 6
      // gives it to the Fitter, so the Bench Fitter code 7233.0200 now carries it too and wins the
      // tie. The control-panel code 7412.0202 itself stays here, unbound (pinned in the fitter block).
      "iron and steel fitter electrical assembly", // 7412.0203 — machine assembly
      "adjuster relays", // 7412.0300
      "armature winder", // 7412.0400 — the winding trade
      "coil winder machine", // 7412.0500
      "electrician automobile", // 7412.0701
      "site engineer-control panel", // 7412.1002 — a panel OEM's commissioning engineer
      "electrical mechanics and fitters other", // 7412.9900 — the catch-all
      "electrical mechanic", // jd_isco_7412
      "lift mechanic", // jd_isco_7412
    ]) {
      expect(familyFor(p), p).toBe("fam_electrical_equipment");
    }
    // Overhead lines and cable jointing are the lineman's.
    expect(familyFor("lineman")).toBe("fam_lineman");
    expect(familyFor("cable jointer")).toBe("fam_lineman");
  });

  it("no industrial electrician phrase falls through to the universal pack", () => {
    for (const p of [
      "panel wiring", "industrial electrician", "इंडस्ट्रियल इलेक्ट्रीशियन", "panel electrician",
      "plant electrician", "electrical fitter",
    ]) {
      expect(familyFor(p), `"${p}" falls through`).not.toBe("fam_universal");
      expect(familyFor(p), `"${p}" reaches nothing`).not.toBeNull();
    }
  });

  it("PINS THE GAP THIS BINDING DOES NOT CLOSE — the descriptor's machine words reach no trade", () => {
    // The role's `machineTerms` are CORROBORATION for a family pin, not routes, so none of them was
    // ever meant to land a worker here on its own. But measured, a worker who says only the
    // equipment reaches NOTHING, or a wrong code on the universal pack. Closing it is an alias
    // tranche for the owner to rule, not a binding; this pin makes that change show up as a diff.
    for (const p of ["vfd", "megger", "star delta", "induction motor", "cable termination", "pcc panel"]) {
      expect(familyFor(p), p).toBeNull();
    }
    // Three reach a wrong code at the universal pack: "mcc" folds onto "Mimic" (2659.0800),
    // "starter" is the motor-transport time-keeper (4110.0600), "pit" folds onto isco 2641.
    for (const p of ["mcc panel", "dol starter", "earth pit"]) {
      expect(familyFor(p), p).toBe("fam_universal");
    }
  });
});


/**
 * BATCH 2 PART TWO — PRESS / MACHINE OPERATOR, the second of the seven to ship its pack.
 *
 * Five bindings, each measured before it was written and each an NCO code whose description is
 * metal-press work and nothing else: the tranche's two (7223.2300 "power press", 7223.3000
 * "stamping"), the press tool setter (7223.0200) and the two automotive press-shop codes
 * (7211.0101 operator, 7211.0102 helper). No generic press pack existed, so every one of these
 * moved off a neighbour's generic pack — fam_machining (unit 7223) or fam_sheet_metal (minor 721).
 * The forging, punching, supervisory and non-metal presses stay where they were.
 */
describe("Batch 2 part two — press / machine operator", () => {
  it("binds exactly the five codes, and the phrases that reach them", () => {
    const codes = corpus.bindings
      .filter((b) => b.family_id === "fam_press_operation")
      .map((b) => b.job_domain_id);
    expect(codes).toEqual([
      "jd_nco_7211_0101",
      "jd_nco_7211_0102",
      "jd_nco_7223_0200",
      "jd_nco_7223_2300",
      "jd_nco_7223_3000",
    ]);
    for (const p of [
      "power press", "power press operator", "power press ka kaam", "stamping", "stamping operator",
      "metal stamper", "tool setter press", "press shop operator", "press shop assistant/helper",
    ]) {
      expect(familyFor(p), p).toBe("fam_press_operation");
    }
  });

  it("leaves forging, punching, supervision and the non-metal presses where they were", () => {
    // Forge work — bare "stamper" is 7221.0500's alias, and that code is hot drop forging. It sat
    // on fam_blacksmithing only because no forging trade existed; Phase 2 #11 (CEO Launch Plan
    // Pack v1, sheet 19) moved the industrial forging codes to the forging trade, and the foundry
    // split (#3009) gives them their own family, fam_forging (T26). Never press.
    for (const p of ["stamper", "forging operator", "power hammer operator", "hammer man"]) {
      expect(familyFor(p), p).toBe("fam_forging");
    }
    // The drop-forging die setter sits in unit 7223 beside the press tool setter; it binds to the
    // forging trade too, and still never to the press shop.
    expect(familyFor("setter drop forging machine")).toBe("fam_forging");
    // "Puncher, Metal" punches boiler frames; it stays with its unit.
    expect(familyFor("puncher metal")).toBe("fam_plumbing");
    // SUPERVISORY. The press shop supervisor's code is one CEO pack v2 section 13.1 lists under
    // T45 Production Supervisor, so Wave 1 (#3008) binds it there; it never reaches the press form.
    expect(familyFor("press shop supervisor")).toBe("fam_production_supervisor");
    expect(familyFor("press shop shift in charge")).toBe("fam_production_supervisor");
    expect(familyFor("extrusion press operator")).toBe("fam_metal_processing");
    expect(familyFor("pressing machine operator")).toBe("fam_assemblers_other");
    // "press brake" is the sheet metal worker's, and the press binding takes none of it.
    expect(familyFor("press brake")).toBe("fam_sheet_metal_fab");
    expect(familyFor("press brake operator")).toBe("fam_sheet_metal_fab");
    expect(familyFor("sheet metal machine operator")).toBe("fam_sheet_metal_fab");
  });

  it("PINS THE GAPS IT KNOWINGLY LEAVES", () => {
    // Item 21 and A4 were retired into place 2026-09-25 — see "Retirements — A4 and item 21" at
    // the end: the role's own first word now reaches it, in both scripts, and "machine operator"
    // reaches nothing.
    expect(familyFor("press operator")).toBe("fam_press_operation");
    expect(familyFor("प्रेस ऑपरेटर")).toBe("fam_press_operation");
    expect(familyFor("machine operator")).toBeNull();
    // The struck "press ka kaam" still reaches nothing. "press tool setter" folded to the tile
    // setter at L1 ("tool setter" ~ "tile setter") until the CEO-pack sheet-word audit
    // (2026-11-04) gave it a row on the Tool Setter, Press code.
    expect(familyFor("press ka kaam")).toBeNull();
    expect(familyFor("press tool setter")).toBe("fam_press_operation");
    // The helper code's title matches only WITH its slash; without it the one span left is
    // "shop assistant", which is retail.
    expect(familyFor("press shop assistant helper")).toBe("fam_retail");
  });

  it("PHASE 2 #3 — the sheet-18 press words reach the press family, and only those", () => {
    // CEO Launch Plan Pack v1, sheet 18 "Words": three new rows.
    for (const p of ["servo press", "mechanical press", "press setter"]) {
      expect(familyFor(p), p).toBe("fam_press_operation");
    }
    // Held out on purpose (see the rvm-aliases block): neither moved by this change.
    expect(familyFor("hydraulic press")).not.toBe("fam_press_operation");
    expect(familyFor("die setter")).not.toBe("fam_press_operation");
  });

  it("no ratified press phrase falls through to the universal pack", () => {
    for (const p of ["power press", "stamping", "tool setter press", "press shop operator"]) {
      expect(familyFor(p), `"${p}" falls through`).not.toBe("fam_universal");
      expect(familyFor(p), `"${p}" reaches nothing`).not.toBeNull();
    }
  });
});

/**
 * BATCH 2 PART TWO — ASSEMBLY LINE, the second of the seven to ship its pack.
 *
 * Three bindings, all measured before they were written. 8219.0100 carries the role's whole
 * vocabulary — "assembly line", "असेंबली", "असेंबलर" and the tranche's stem "assembly" — despite
 * its published title "Assembler, Bicycle". 8211.1100 ("Assembler, Continuity", conveyor work by
 * definition) and 8211.1200 ("Assembler, Automobile", the reference page's own worker) carry only
 * their titles. Every other assembler stays on a generic pack, and the fitter keeps "assembly
 * fitter", which is the one cross-cluster phrase this family must never take.
 */
describe("Batch 2 part two — assembly line", () => {
  it("binds exactly the three codes, and the role's words reach them", () => {
    const codes = corpus.bindings
      .filter((b) => b.family_id === "fam_assembly_line")
      .map((b) => b.job_domain_id);
    expect(codes).toEqual(["jd_nco_8219_0100", "jd_nco_8211_1100", "jd_nco_8211_1200"]);
    for (const p of [
      "assembly line",
      "असेंबली",
      "असेंबलर",
      "assembly",
      "assembly ka kaam",
      "assembly line worker",
      "final assembly",
      "sub assembly",
      "assembler continuity",
      "assembler automobile",
    ]) {
      expect(familyFor(p), p).toBe("fam_assembly_line");
    }
    // The L1 folds of the stem come with it — misspellings, not new claims.
    expect(familyFor("asembly")).toBe("fam_assembly_line");
    expect(familyFor("assembley")).toBe("fam_assembly_line");
  });

  it("'assembly fitter' stays with the fitter — the cross-cluster guard row holds", () => {
    // The worksheet ruled it (Part 5); the 2-token guard row on Bench Fitter keeps it off bare
    // "assembly" on longest-first. Binding 8219.0100 must not have moved it.
    expect(resolveOccupation(occupationIndex, "assembly fitter")?.jobDomainId).toBe(
      "jd_nco_7233_0200",
    );
    // fam_fitting while this block was written; fam_fitter once the fitter pack bound 7233.0200.
    expect(familyFor("assembly fitter")).toBe("fam_fitter");
    expect(familyFor("assembly fitter")).not.toBe("fam_assembly_line");
    expect(familyFor("fitter")).not.toBe("fam_assembly_line");
  });

  it("leaves every rejected neighbour where it was", () => {
    // 8211 — machinery, motor-cycle, tractor and fitter-titled assemblers stay on the minor-821
    // generic pack; 8212 electronics likewise.
    for (const p of [
      "assembler motor cycle",
      "assembler tractor",
      "vehicle assembly fitter",
      "fitter-mechanical assembly",
      "mechanical sub-assembly technician",
      "assembler workshop machine and equipment",
      "electrical assembly operator",
      "pcb assembly operator",
    ]) {
      expect(familyFor(p), p).toBe("fam_assemblers_other");
    }
    // 8219 — sewing machine and plastic product assemblers, and the ISCO node that claims the
    // published "Assembler, Bicycle" title first, stay on the unit-8219 generic pack.
    for (const p of ["assembler sewing machine", "plastic assembly", "assembler bicycle"]) {
      expect(familyFor(p), p).toBe("fam_assembly");
    }
  });

  it("bare English 'assembler' reaches the Assembly Technician since the split alias retired", () => {
    // Two claimants shared the span: 8211.1300's published split alias "Assembler" and 8219.0100's
    // rvm row, and the rejected neighbour 8211.1300 won it. The CEO-pack sheet-word audit
    // (2026-11-04, sheet 11 "assembler" -> Trade: Assembly Technician) retired that split alias;
    // 8211.1300 keeps its published title "Assembler, Motor Cycle".
    expect(resolveOccupation(occupationIndex, "assembler")?.jobDomainId).toBe("jd_nco_8219_0100");
    expect(familyFor("assembler")).toBe("fam_assembly_line");
    expect(familyFor("असेंबलर")).toBe("fam_assembly_line");
  });

  it("the STRUCK phrases stay unauthored — 'fitting line' and 'production line'", () => {
    // Worksheet Part 5 items 26-27: one collides with the fitter, the other is any factory hand.
    for (const p of ["fitting line", "production line"]) {
      expect(familyFor(p), p).not.toBe("fam_assembly_line");
      expect(familyFor(p), p).toBeNull();
    }
  });

  it("no assembly line phrase falls through to the universal pack", () => {
    for (const p of ["assembly line", "असेंबली", "assembly", "assembly ka kaam", "असेंबलर"]) {
      expect(familyFor(p), `"${p}" falls through`).not.toBe("fam_universal");
      expect(familyFor(p), `"${p}" reaches nothing`).not.toBeNull();
    }
  });
});

/**
 * BATCH 2 PART TWO — FITTER, the second of the seven to ship its pack.
 *
 * The fitter needed bindings, not vocabulary: "fitter", "फिटर", "bench fitter" and "assembly
 * fitter" all reached the generic fam_fitting before this change. Three bindings, each measured
 * before it was written — 7233.0200 "Fitter, Bench" (the ruled home, ruling A1), 7233.0100
 * "Fitter, General" (reached by its published title; every worker under it is a fitter). 7233.0101
 * "Maintenance Fitter-Mechanical" was bound here as an OWNER-DECIDED INTERIM (2026-09-24) until
 * ruling A1 could be carried out; it has been — plain "fitter" retired off 0101 and added to
 * 7233.0200 — and 0101 moved to fam_maintenance_tech with that pack. Everything else in unit
 * 7233, and every "… fitter" in another unit, stays where it resolves today.
 */
describe("Batch 2 part two — fitter", () => {
  const codeFor = (p: string): string | null =>
    resolveOccupation(occupationIndex, p)?.jobDomainId ?? null;

  it("binds exactly the two codes its words reach, now that A1 has landed", () => {
    const codes = corpus.bindings
      .filter((b) => b.family_id === "fam_fitter")
      .map((b) => b.job_domain_id);
    expect(codes).toEqual(["jd_nco_7233_0200", "jd_nco_7233_0100"]);
    // The phrase, the code it lands on, and the family that answers it — each binding earns a row.
    expect(codeFor("फिटर")).toBe("jd_nco_7233_0200");
    expect(codeFor("bench fitter")).toBe("jd_nco_7233_0200");
    expect(codeFor("assembly fitter")).toBe("jd_nco_7233_0200");
    expect(codeFor("fitter general")).toBe("jd_nco_7233_0100");
    // Ruling A1: plain "fitter" is Bench Fitter's, retired off 7233.0101.
    expect(codeFor("fitter")).toBe("jd_nco_7233_0200");
    for (const p of [
      "fitter", "फिटर", "bench fitter", "assembly fitter", "fitter general", "iti fitter",
      "senior fitter", "fitter helper", "फिटर का काम",
    ]) {
      expect(familyFor(p), p).toBe("fam_fitter");
    }
  });

  it("A1 LANDED — the interim's maintenance words left with 7233.0101", () => {
    // While fam_fitter held 0101 as an interim, the tranche's four maintenance phrases and A1's
    // own "maintenance fitter" reached THIS pack. 0101 is the maintenance technician's now, and
    // every one of them went with it — the diff this block promised when it pinned the interim.
    // #3010 moves two of the four on: "breakdown maintenance" and "plant maintenance" are retired
    // off 0101 to routing (#3015), pinned as null in the "Retirements — #3010" block, not here.
    for (const p of [
      "machine ki marammat", "machine repair",
      "maintenance fitter", "मेंटेनेंस फिटर",
    ]) {
      expect(codeFor(p), p).toBe("jd_nco_7233_0101");
      expect(familyFor(p), p).toBe("fam_maintenance_tech");
    }
    // STILL PINNED, and not fixed by A1: any "… fitter" whose only hit is the bare word lands on
    // the word's code, now 7233.0200 — still this family. An AC installer is plainly another trade;
    // alias guard rows, not routing, would fix it.
    expect(familyFor("ac fitter")).toBe("fam_fitter");
    expect(familyFor("structural fitter")).toBe("fam_fabrication"); // #3016: retired off fitter to T22
  });

  it("leaves every rejected neighbour where it resolves today", () => {
    const stays: Record<string, string> = {
      // Unit 7233's maintenance side — Maintenance Technician's since that pack shipped. Levelling
      // and alignment is on BOTH pages, so it stays generic for either.
      "fitter levelling alignment and balancing": "fam_fitting",
      "fitter hydraulic and pneumatic system": "fam_maintenance_tech",
      "bearing maintenance": "fam_maintenance_tech",
      millwright: "fam_maintenance_tech",
      "mechanic maintenance": "fam_maintenance_tech",
      // Engine, vehicle and pump mechanics, and the catch-all — a fitter title is not the trade.
      "diesel mechanic": "fam_fitting",
      "mechanic pump": "fam_fitting",
      "fitter marine": "fam_fitting",
      "fitter loco": "fam_fitting",
      "machinery mechanics and fitters other": "fam_fitting",
      // 8211.1202 — decided, not skipped: spliced with a motorcycle line assembler's description,
      // and on Assembly Line Worker's side of the declared veto pair.
      "fitter-mechanical assembly": "fam_assemblers_other",
      "vehicle assembly fitter": "fam_assemblers_other",
      "assembly line": "fam_assembly_line", // Assembly Line Worker binds 8219.0100
      // Fabrication fit-up, structural and site steel. #3016: T22 fabrication owns the
      // fit-up words now ("fitter structural" retired off the fitter to T22; "fitter-fabrication"
      // sits on the moved 7212.0400).
      "fitter-fabrication": "fam_fabrication",
      "fitter structural": "fam_fabrication",
      "fitter construction": "fam_sheet_metal",
      "boiler fitter": "fam_sheet_metal",
      // Other trades whose title carries the word.
      // Sheet 6 gives the phrase to the Fitter (CEO-pack sheet-word audit, 2026-11-04): the Bench
      // Fitter code carries it now. The control-panel code 7412.0202 stays unbound.
      "mechanical fitter": "fam_fitter",
      "electrical fitter": "fam_industrial_electrician", // the industrial electrician binds 7412.0200
      "pipe fitter": "fam_plumbing",
      "pipe fitting": "fam_plumbing",
      "gas fitter": "fam_plumbing",
      "fitter automobile": "fam_auto_mechanic",
      "mechanic fitter": "fam_auto_mechanic",
      "die fitter": "fam_tool_die_making",
    };
    const got = Object.fromEntries(Object.keys(stays).map((p) => [p, familyFor(p)]));
    expect(got).toEqual(stays);
  });

  it("no fitter phrase falls through to the universal pack", () => {
    for (const p of ["fitter", "फिटर", "bench fitter", "assembly fitter", "fitter general"]) {
      expect(familyFor(p), `"${p}" falls through`).not.toBe("fam_universal");
      expect(familyFor(p), `"${p}" reaches nothing`).not.toBeNull();
    }
  });
});

/**
 * BATCH 2 PART TWO — QUALITY INSPECTION, the second of the seven to ship its pack.
 *
 * Two bindings, both measured before they were written: 7543.2001 carries the tranche's whole QC
 * vocabulary, and 7311.0500 "Viewer, Workshop / Examiner, Metal Working" carries its own two
 * titles — a metal-working inspector that fell to fam_handicraft before. Every other code in unit
 * 7543 stays on the generic minor-754 pack: the cloth, footwear, wood and apparel graders, the
 * electronics testers, and the five rubber-sector line-QC codes (3001-3005) that belong to Batch
 * 3's Plastic Process Technician question (worksheet R4-b, unresolved).
 */
describe("Batch 2 part two — quality inspection", () => {
  const unit7543Codes = resolveJobDomainCorpus()
    .filter((d) => d.jobDomainId.startsWith("jd_nco_7543_") && d.selectable)
    .map((d) => d.jobDomainId);
  const familyForCode = (jobDomainId: string): string | null =>
    resolveFamily(bindings, {
      jobDomainId,
      iscoUnitCode: occupationIndex.unitByDomain.get(jobDomainId) ?? null,
    })?.familyId ?? null;

  it("binds exactly the two codes its words reach", () => {
    const codes = corpus.bindings
      .filter((b) => b.family_id === "fam_quality_inspection")
      .map((b) => b.job_domain_id);
    expect(codes).toEqual(["jd_nco_7543_2001", "jd_nco_7311_0500"]);
    for (const p of [
      "qc", "qc inspector", "qa qc", "quality control", "क्वालिटी", "inspection", "quality check",
      "quality", "qc engineer", "final inspection", "patrol inspection", "incoming inspection",
    ]) {
      expect(familyFor(p), p).toBe("fam_quality_inspection");
    }
    // 7311.0500's two published titles — its whole reach; no vernacular alias lands on it.
    expect(familyFor("viewer workshop")).toBe("fam_quality_inspection");
    expect(familyFor("examiner metal working")).toBe("fam_quality_inspection");
  });

  it("leaves every other 7543 code on the generic pack — pinned by CODE", () => {
    // By code rather than by phrase: most of these published titles never self-resolve (garbled
    // or hyphenated labels), so a phrase table would pass without testing the binding at all.
    // Vacuity guard: the unit has 31 selectable NCO codes; an empty filter would pass on nothing.
    expect(unit7543Codes.length).toBeGreaterThan(20);
    const moved = unit7543Codes.filter(
      (id) => id !== "jd_nco_7543_2001" && familyForCode(id) !== "fam_other_craft",
    );
    expect(moved).toEqual([]);
    // Named, because each was a decision: 0301 "Measurement Checker" is an APPAREL checker by its
    // description, and 3001-3005 are rubber-sector line QC (R4-b).
    for (const id of [
      "jd_nco_7543_0301", "jd_nco_7543_3001", "jd_nco_7543_3002", "jd_nco_7543_3003",
      "jd_nco_7543_3004", "jd_nco_7543_3005",
    ]) {
      expect(familyForCode(id), id).toBe("fam_other_craft");
    }
    for (const p of [
      "measurement checker", "cloth examiner", "incoming qc technician", "functional tester",
      "safety testing technician", "factory compliance auditor",
      "product graders and testers others",
    ]) {
      expect(familyFor(p), p).toBe("fam_other_craft");
    }
    // The ISCO node is not bound, so what it alone carries stays generic.
    expect(familyFor("wool classer")).toBe("fam_other_craft");
    expect(familyFor("product grader")).toBe("fam_other_craft");
  });

  it("PINS THE GAPS AND IMPRECISIONS THIS BINDING KNOWINGLY LEAVES", () => {
    // 1. THE EXACT PHRASE "quality inspector" DOES NOT REACH THIS FAMILY. Its only alias row is on
    //    the unbound ISCO node jd_isco_7543, so offline it resolves to fam_other_craft. In
    //    production that node's aliases are SHADOWED (F4 — 7543 has selectable NCO children,
    //    `alias-lifecycle.ts`), so the row is not searchable there at all. Moving the phrase is an
    //    alias change and needs an owner ruling; binding the node would take every grader with it.
    expect(resolveOccupation(occupationIndex, "quality inspector")?.jobDomainId).toBe(
      "jd_isco_7543",
    );
    expect(familyFor("quality inspector")).toBe("fam_other_craft");
    // 2. THE TRADE'S OTHER TITLES LAND ON UNBOUND CODES. "quality control inspector" is the
    //    published title of 3139.5001, whose description is generic ("manufactured products"), not
    //    metal — so it is not bound without a ruling, and the phrase keeps the universal pack.
    //    "quality engineer" is 2152.0601, which CEO pack v2 section 13.1 lists under T37 Quality
    //    Engineer: Wave 1 (#3008) binds it to that trade's own family, never to this one.
    expect(familyFor("quality control inspector")).toBe("fam_universal");
    expect(familyFor("quality engineer")).toBe("fam_quality_engineer");
    // 3. BARE "quality" IS RATIFIED ON THE METAL CODE (item 10), so "quality manager" reaches this
    //    family. NOT in the 2026-09-24 guard ruling — left as an accepted imprecision.
    expect(familyFor("quality manager")).toBe("fam_quality_inspection");
  });

  it("GUARD ROWS (2026-09-24) — four non-metal QC phrases reach their own trade", () => {
    // Bare "qc" (item 6) took every one of these to the metal code once this family bound it.
    // Each guard is an exact multi-token row that wins on longest-first before "qc" is tried.
    // Before the guards all four were fam_quality_inspection; before THIS binding, fam_other_craft.
    const codeFor = (p: string): string | null =>
      resolveOccupation(occupationIndex, p)?.jobDomainId ?? null;
    // The apparel sewing-line QC code, on the generic minor-754 pack.
    for (const p of ["garment qc", "qc executive sewing line"]) {
      expect(codeFor(p), p).toBe("jd_nco_7543_0201");
      expect(familyFor(p), p).toBe("fam_other_craft");
    }
    // The published title keeps its hyphen through normalization, so it matched on its own and
    // needed no row — only the spaced form a worker types did.
    expect(codeFor("QC Executive-Sewing Line")).toBe("jd_nco_7543_0201");
    // 2113.0601 "Quality Control Chemist" — the pharma QC lab. Its unit has no family binding.
    for (const p of ["pharma qc", "qc chemist"]) {
      expect(codeFor(p), p).toBe("jd_nco_2113_0601");
      expect(familyFor(p), p).toBe("fam_universal");
    }
    // Longest-first keeps them when the worker adds the metal code's own words after them.
    expect(familyFor("garment qc inspector")).toBe("fam_other_craft");
    expect(familyFor("pharma qc chemist")).toBe("fam_universal");
    // And the guards take nothing back from the trade itself.
    expect(familyFor("qc")).toBe("fam_quality_inspection");
    expect(familyFor("qc inspector")).toBe("fam_quality_inspection");
  });

  it("no quality-inspection phrase falls through to the universal pack", () => {
    for (const p of ["qc", "qc inspector", "quality control", "क्वालिटी", "inspection ka kaam"]) {
      expect(familyFor(p), `"${p}" falls through`).not.toBe("fam_universal");
      expect(familyFor(p), `"${p}" reaches nothing`).not.toBeNull();
    }
  });
});

/**
 * RETIREMENTS — A4 AND ITEM 21, landed 2026-09-25 through `rvm-alias-retirements.jsonl` (#1718).
 *
 * A4 retires the junk "Machine" alias split off "Milker, Machine"; item 21 retires the woollen-cloth
 * press's published title "Press Operator" and gives the phrase to 7211.0101 "Press Shop Operator",
 * with "woollen press operator" left as the woollen press's way in. Owner rulings of 2026-09-25 add
 * the guards for what those two moves exposed: the printing presses, which would otherwise reach the
 * metal press on bare "press operator", and "sewing machine operator", which production routed to
 * dairy through the same junk alias.
 *
 * TWO VIEWS, because production and this offline index disagree on exactly these phrases. The
 * offline index keeps every selectable ISCO unit; production shadows the 370 with selectable NCO
 * children (F4). The printing presses' and the sewing machine operator's own titles sit ONLY on
 * shadowed units 7322 and 8153, so offline they look fine with or without a guard — the
 * prod-like view below is the one that shows why the guards exist.
 */
describe("Retirements — A4 and item 21", () => {
  const codeFor = (p: string): string | null =>
    resolveOccupation(occupationIndex, p)?.jobDomainId ?? null;

  // PRODUCTION'S VIEW: the offline corpus with the F4 shadow rule applied, as the normalizer does.
  const offline = resolveJobDomainCorpus();
  const parentsOfSelectable = new Set(
    offline.filter((d) => d.selectable && d.parentJobDomainId).map((d) => d.parentJobDomainId),
  );
  const prodIndex = buildOccupationIndex(
    offline.map((d) =>
      d.source === "isco08" && parentsOfSelectable.has(d.jobDomainId) ? { ...d, aliases: [] } : d,
    ),
  );
  const prodFamilyFor = (p: string): string | null => {
    const hit = resolveOccupation(prodIndex, p);
    if (!hit) return null;
    const iscoUnitCode = prodIndex.unitByDomain.get(hit.jobDomainId) ?? null;
    return resolveFamily(bindings, { jobDomainId: hit.jobDomainId, iscoUnitCode })?.familyId ?? null;
  };

  it("A4 — no bare 'machine' phrase reaches dairy any more; each reaches nothing", () => {
    // #3016: "boring machine" left this list — T19 boring binds 7223.1701/1800 and owns it now.
    for (const p of [
      "machine", "machine operator", "machine chalana", "machine wala", "machine helper",
      "press machine", "press machine operator",
    ]) {
      expect(familyFor(p), p).toBeNull();
      expect(prodFamilyFor(p), `${p} (prod view)`).toBeNull();
    }
    // The milker keeps its own two aliases — nothing else about the occupation moved.
    expect(codeFor("milker machine")).toBe("jd_nco_6121_0800");
    expect(familyFor("machine milker")).toBe("fam_animal_rearing");
  });

  it("A4 — every '<x> machine' that names a real trade still reaches it", () => {
    expect(familyFor("machine shop")).toBe("fam_conventional_machining");
    expect(familyFor("milling machine")).toBe("fam_vmc_milling");
    expect(familyFor("cnc machine")).toBe("fam_machining");
    expect(familyFor("silai machine")).toBe("fam_sewing_machine");
    // A1 has landed, so the maintenance phrases on 7233.0101 reach the maintenance technician.
    expect(familyFor("machine repair")).toBe("fam_maintenance_tech");
    expect(familyFor("machine ki marammat")).toBe("fam_maintenance_tech");
  });

  it("item 21 — 'press operator' puts the metal press shop FIRST, in both scripts and views", () => {
    // FIRST CLAIMANT ONLY. `resolveOccupation` reads a span's first claimant — see the next test
    // for what production does with the second.
    for (const p of ["press operator", "प्रेस ऑपरेटर", "hydraulic press operator", "mechanical press operator"]) {
      expect(familyFor(p), p).toBe("fam_press_operation");
      expect(prodFamilyFor(p), `${p} (prod view)`).toBe("fam_press_operation");
    }
    expect(codeFor("press operator")).toBe("jd_nco_7211_0101");
    expect(codeFor("प्रेस ऑपरेटर")).toBe("jd_nco_7211_0101");
  });

  it("item 21 — bare 'press operator' has a SECOND claimant, so production asks, not pins", () => {
    // The ceramics pressman (8181.0400) carries "Press Operator" as a published alias. Two
    // claimants in two families is exactly where the live resolver refuses to guess: measured
    // 2026-09-25 with the real OccupationService on this corpus, bare "press operator" asks one
    // question — "press operator" (7211.0101, the Press form) or "Pressman" (ceramics).
    // The Devanagari phrase has one claimant and pins outright. Honest ambiguity, pinned not
    // ruled (worksheet Part 7); retiring the ceramics alias is the owner's call.
    const claimantsOf = (norm: string) =>
      offline
        .filter((d) => d.selectable && !(d.source === "isco08" && parentsOfSelectable.has(d.jobDomainId)))
        .filter((d) => d.aliases.some((a) => normalizeOccupationText(a.text) === norm))
        .map((d) => d.jobDomainId)
        .sort();
    expect(claimantsOf(normalizeOccupationText("press operator"))).toEqual([
      "jd_nco_7211_0101",
      "jd_nco_8181_0400",
    ]);
    expect(prodFamilyFor("pressman ceramics")).not.toBe("fam_press_operation");
    expect(claimantsOf(normalizeOccupationText("प्रेस ऑपरेटर"))).toEqual(["jd_nco_7211_0101"]);
  });

  it("item 21 — the woollen-cloth press keeps a way in, and wins as the longer span", () => {
    expect(codeFor("woollen press operator")).toBe("jd_nco_8159_0400");
    expect(familyFor("woollen press operator")).toBe("fam_textile_machines");
    expect(prodFamilyFor("woollen press operator")).toBe("fam_textile_machines");
  });

  it("the printing-press guards keep printing workers in printing — in PRODUCTION's view", () => {
    const guards: Record<string, string> = {
      "printing press operator": "jd_nco_7322_1300",
      "offset press operator": "jd_nco_7322_2100",
      "web press operator": "jd_nco_7322_2000",
      "digital press operator": "jd_nco_7322_1300",
      "flexographic press operator": "jd_nco_7322_1300",
      "screen printing press operator": "jd_nco_7322_1300",
    };
    for (const [p, code] of Object.entries(guards)) {
      expect(resolveOccupation(prodIndex, p)?.jobDomainId, p).toBe(code);
      expect(prodFamilyFor(p), p).toBe("fam_printing");
      expect(familyFor(p), `${p} (offline)`).toBe("fam_printing");
    }
    // KNOWINGLY LEFT: "small press operator" is honestly ambiguous — a small power press is metal
    // work too — so it takes the metal press in production. Pinned so a change shows in review.
    expect(prodFamilyFor("small press operator")).toBe("fam_press_operation");
  });

  it("the sewing machine operator reaches the sewing pack, not dairy, in production's view", () => {
    expect(resolveOccupation(prodIndex, "sewing machine operator")?.jobDomainId).toBe("jd_nco_8153_0101");
    expect(prodFamilyFor("sewing machine operator")).toBe("fam_sewing_machine");
    expect(familyFor("sewing machine operator")).toBe("fam_sewing_machine");
  });

  it("retires nothing it was not asked to — both rows are still in the catalogue", () => {
    const rows = resolveJobDomainCorpus(undefined, { includeRetiredAliases: true });
    const aliasesOf = (id: string) => rows.find((d) => d.jobDomainId === id)?.aliases.map((a) => a.text);
    expect(aliasesOf("jd_nco_6121_0800")).toContain("Machine");
    expect(aliasesOf("jd_nco_8159_0400")).toContain("Press Operator");
  });
});

/**
 * BATCH 2 PART TWO — MAINTENANCE TECHNICIAN, the last of the seven to ship its pack.
 *
 * It shipped with ruling A1: plain "fitter" retired off 7233.0101 "Maintenance Fitter-Mechanical"
 * and moved to Bench Fitter, so 0101 left the Fitter's interim binding and came here. Nine bindings,
 * each measured in a production view of the index before it was written (see _families.jsonl):
 * 0101, the factory maintenance technicians of the technician band (3113.0601, 3113.0401,
 * 3115.0102, 3115.0103 — owner ruling 2026-09-25), and unit 7233's plant maintenance mechanics
 * (hydraulic & pneumatic, bearing, chemical plant, millwright).
 */
describe("Batch 2 part two — maintenance technician", () => {
  const codeFor = (p: string): string | null =>
    resolveOccupation(occupationIndex, p)?.jobDomainId ?? null;

  // PRODUCTION'S VIEW, with every claimant — the offline helper reads only a span's first.
  const offline = resolveJobDomainCorpus();
  const parentsOfSelectable = new Set(
    offline.filter((d) => d.selectable && d.parentJobDomainId).map((d) => d.parentJobDomainId),
  );
  const live = offline.filter(
    (d) => d.selectable && !(d.source === "isco08" && parentsOfSelectable.has(d.jobDomainId)),
  );
  const liveClaimants = (phrase: string) => {
    const norm = normalizeOccupationText(phrase);
    return live
      .filter((d) => d.aliases.some((a) => normalizeOccupationText(a.text) === norm))
      .map((d) => d.jobDomainId)
      .sort();
  };

  it("binds exactly the nine codes its words reach", () => {
    const codes = corpus.bindings
      .filter((b) => b.family_id === "fam_maintenance_tech")
      .map((b) => b.job_domain_id);
    expect(codes).toEqual([
      "jd_nco_7233_0101",
      "jd_nco_3113_0601",
      "jd_nco_3113_0401",
      "jd_nco_3115_0102",
      "jd_nco_3115_0103",
      "jd_nco_7233_2901",
      "jd_nco_7233_0301",
      "jd_nco_7233_1100",
      "jd_nco_7233_1200",
    ]);
  });

  it("reaches the family on the trade's own words — each the ONLY claimant in production", () => {
    const claimed: Record<string, string> = {
      "maintenance technician": "jd_nco_3113_0601",
      "machine maintenance technician": "jd_nco_3113_0401",
      "maintenance fitter": "jd_nco_7233_0101",
      "मेंटेनेंस फिटर": "jd_nco_7233_0101",
      "machine repair": "jd_nco_7233_0101",
      // #3010 retires "breakdown maintenance" and "plant maintenance" off 7233.0101 to routing
      // (#3015). They are pinned as null in the "Retirements — #3010" block, not here.
      "bearing maintenance": "jd_nco_7233_0301",
      "mechanic maintenance": "jd_nco_7233_1100",
      millwright: "jd_nco_7233_1200",
    };
    for (const [p, code] of Object.entries(claimed)) {
      expect(codeFor(p), p).toBe(code);
      expect(familyFor(p), p).toBe("fam_maintenance_tech");
      expect(liveClaimants(p), `${p} (production claimants)`).toEqual([code]);
    }
    // The particle-stripped tranche phrase folds onto its stem, "machine marammat".
    expect(familyFor("machine ki marammat")).toBe("fam_maintenance_tech");
  });

  it("BARE 'maintenance' reaches no occupation — worksheet item 15, struck", () => {
    for (const p of ["maintenance", "मेंटेनेंस", "maintenance ka kaam", "ac maintenance", "building maintenance"]) {
      expect(familyFor(p), p).toBeNull();
    }
  });

  it("leaves every rejected neighbour where it resolves today", () => {
    const stays: Record<string, string> = {
      // Electrical maintenance is the industrial electrician's side of the cluster; unbound.
      "maintenance technician electrical": "fam_universal",
      // A vehicle workshop, an operator's job, a sector title left for review.
      "maintenance technician-service workshop": "fam_auto_mechanic",
      "conveyor operation and maintenance": "fam_fitting",
      "mechanic dairy maintenance": "fam_fitting",
      // Alignment is on the fitter's page too, so it stays generic for either.
      "fitter levelling alignment and balancing": "fam_fitting",
      // Supervisory: CEO pack v2 section 13.1 lists 3115.0501 under T43 Maintenance Engineer, so
      // Wave 1 (#3008) binds it to that trade's family, not to this technician form.
      "manager maintenance mechanical and electrical": "fam_maintenance_engineer",
    };
    const got = Object.fromEntries(Object.keys(stays).map((p) => [p, familyFor(p)]));
    expect(got).toEqual(stays);
  });

  it("PINS A PRE-EXISTING MISROUTE it does not fix", () => {
    // "Maintenance Mechanic" is the published title of a TELEPHONE maintenance code (7422.0200), so
    // a plant maintenance mechanic who says it reaches electronics installation. A guard alias would
    // fix it; that is an owner decision, not made here.
    expect(codeFor("maintenance mechanic")).toBe("jd_nco_7422_0200");
    expect(familyFor("maintenance mechanic")).toBe("fam_electronics_install");
  });

  it("no maintenance phrase falls through to the universal pack", () => {
    // #3010 retires "plant maintenance" to routing (null), so it is not in this list.
    // It is pinned as null in the "Retirements — #3010" block.
    for (const p of ["maintenance technician", "maintenance fitter", "machine repair"]) {
      expect(familyFor(p), `"${p}" falls through`).not.toBe("fam_universal");
      expect(familyFor(p), `"${p}" reaches nothing`).not.toBeNull();
    }
  });
});

describe("Phase 2 #5 — the sheet-21 maintenance words (CEO Launch Plan Pack v1)", () => {
  // PRODUCTION'S VIEW as well as the offline helper's: shadowed ISCO units removed, every
  // claimant listed — the same check the Batch 2 maintenance block above makes.
  const offline = resolveJobDomainCorpus();
  const parents = new Set(
    offline.filter((d) => d.selectable && d.parentJobDomainId).map((d) => d.parentJobDomainId),
  );
  const live = offline.filter(
    (d) => d.selectable && !(d.source === "isco08" && parents.has(d.jobDomainId)),
  );
  const liveClaimants = (phrase: string) => {
    const norm = normalizeOccupationText(phrase);
    return live
      .filter((d) => d.aliases.some((a) => normalizeOccupationText(a.text) === norm))
      .map((d) => d.jobDomainId)
      .sort();
  };

  it("reaches the maintenance family, each the ONLY claimant in production", () => {
    const claimed: Record<string, string> = {
      "machine maintenance": "jd_nco_7233_0101",
      "mechanical maintenance": "jd_nco_7233_0101",
      "hydraulic maintenance": "jd_nco_7233_0101",
      "machine tool maintenance": "jd_nco_7233_0101",
      "cnc maintenance": "jd_nco_7233_1200",
      "मेंटेनेंस टेक्नीशियन": "jd_nco_7233_0101",
    };
    for (const [phrase, code] of Object.entries(claimed)) {
      expect(familyFor(phrase), phrase).toBe("fam_maintenance_tech");
      expect(liveClaimants(phrase), phrase).toEqual([code]);
    }
  });

  it("leaves the CNC operator and the electronics mechanic where they were", () => {
    expect(familyFor("cnc operator")).toBe("fam_machining");
    expect(familyFor("maintenance mechanic")).toBe("fam_electronics_install");
  });
});

describe("Phase 2 #6 — PLC / automation, a new family on 7412.0101 (CEO Launch Plan Pack v1)", () => {
  const offline = resolveJobDomainCorpus();
  const parents = new Set(
    offline.filter((d) => d.selectable && d.parentJobDomainId).map((d) => d.parentJobDomainId),
  );
  const live = offline.filter(
    (d) => d.selectable && !(d.source === "isco08" && parents.has(d.jobDomainId)),
  );
  const liveClaimants = (phrase: string) => {
    const norm = normalizeOccupationText(phrase);
    return live
      .filter((d) => d.aliases.some((a) => normalizeOccupationText(a.text) === norm))
      .map((d) => d.jobDomainId)
      .sort();
  };

  it("binds exactly the one code", () => {
    const codes = corpus.bindings
      .filter((b) => b.family_id === "fam_plc_automation")
      .map((b) => b.job_domain_id);
    expect(codes).toEqual(["jd_nco_7412_0101"]);
  });

  it("reaches the family on the trade's programming words, each the ONLY claimant in production", () => {
    for (const phrase of [
      "plc programming",
      "plc programmer",
      "plc technician",
      "automation technician",
      "automation engineer",
      "पीएलसी प्रोग्रामिंग",
      "automation specialist",
    ]) {
      expect(familyFor(phrase), phrase).toBe("fam_plc_automation");
      if (phrase !== "automation specialist") {
        expect(liveClaimants(phrase), phrase).toEqual(["jd_nco_7412_0101"]);
      }
    }
  });

  it("leaves the panel electrician, police and place where they were", () => {
    expect(familyFor("panel wiring")).not.toBe("fam_plc_automation");
    expect(familyFor("electrical fitter")).not.toBe("fam_plc_automation");
    expect(familyFor("police")).not.toBe("fam_plc_automation");
  });
});

describe("Phase 2 #7 — EDM / wire-cut, a new family on 7223.2800 (CEO Launch Plan Pack v1)", () => {
  const offline = resolveJobDomainCorpus();
  const parents = new Set(
    offline.filter((d) => d.selectable && d.parentJobDomainId).map((d) => d.parentJobDomainId),
  );
  const live = offline.filter(
    (d) => d.selectable && !(d.source === "isco08" && parents.has(d.jobDomainId)),
  );
  const liveClaimants = (phrase: string) => {
    const norm = normalizeOccupationText(phrase);
    return live
      .filter((d) => d.aliases.some((a) => normalizeOccupationText(a.text) === norm))
      .map((d) => d.jobDomainId)
      .sort();
  };

  it("binds exactly the one code", () => {
    const codes = corpus.bindings
      .filter((b) => b.family_id === "fam_edm_wirecut")
      .map((b) => b.job_domain_id);
    expect(codes).toEqual(["jd_nco_7223_2800"]);
  });

  it("reaches the family on the trade's own words, each the ONLY claimant in production", () => {
    for (const phrase of [
      "wire cut",
      "wirecut",
      "wire edm",
      "edm operator",
      "wire cut operator",
      "spark erosion",
      "वायर कट",
    ]) {
      expect(familyFor(phrase), phrase).toBe("fam_edm_wirecut");
      expect(liveClaimants(phrase), phrase).toEqual(["jd_nco_7223_2800"]);
    }
  });

  it("leaves the tool room's own words with the tool room", () => {
    for (const phrase of ["tool maker", "tool room", "die maker"]) {
      expect(familyFor(phrase), phrase).not.toBe("fam_edm_wirecut");
    }
  });
});

describe("Phase 2 #9 — injection moulding, a new family on four 8142 codes (CEO Launch Plan Pack v1)", () => {
  const offline = resolveJobDomainCorpus();
  const parents = new Set(
    offline.filter((d) => d.selectable && d.parentJobDomainId).map((d) => d.parentJobDomainId),
  );
  const live = offline.filter(
    (d) => d.selectable && !(d.source === "isco08" && parents.has(d.jobDomainId)),
  );
  const liveClaimants = (phrase: string) => {
    const norm = normalizeOccupationText(phrase);
    return live
      .filter((d) => d.aliases.some((a) => normalizeOccupationText(a.text) === norm))
      .map((d) => d.jobDomainId)
      .sort();
  };

  it("binds exactly the four plastic-moulding codes", () => {
    const codes = corpus.bindings
      .filter((b) => b.family_id === "fam_injection_moulding")
      .map((b) => b.job_domain_id);
    expect(codes).toEqual([
      "jd_nco_8142_0501",
      "jd_nco_8142_0502",
      "jd_nco_8142_1300",
      "jd_nco_8142_1301",
    ]);
  });

  it("reaches the family on the trade's own words, each the ONLY claimant in production", () => {
    for (const [phrase, code] of [
      ["injection moulding", "jd_nco_8142_0501"],
      ["injection molding", "jd_nco_8142_0501"],
      ["injection moulding operator", "jd_nco_8142_0501"],
      ["moulding machine operator", "jd_nco_8142_0501"],
      ["इंजेक्शन मोल्डिंग", "jd_nco_8142_0501"],
      ["moulding operator", "jd_nco_8142_0502"],
      ["mould setter", "jd_nco_8142_1300"],
      ["moulding setter", "jd_nco_8142_1300"],
      ["injection moulding setter", "jd_nco_8142_1300"],
      ["plastic moulding", "jd_nco_8142_1301"],
    ] as const) {
      expect(familyFor(phrase), phrase).toBe("fam_injection_moulding");
      expect(liveClaimants(phrase), phrase).toEqual([code]);
    }
  });

  it("moves 'injection moulding operator' off the rubber code, which keeps its own phrase", () => {
    expect(liveClaimants("injection moulding operator")).not.toContain("jd_nco_8141_0713");
    expect(liveClaimants("rubber injection moulding operator")).toEqual(["jd_nco_8141_0713"]);
    // #3016: T32 rubber moulding binds the rubber code now.
    expect(familyFor("rubber injection moulding operator")).toBe("fam_rubber_moulding");
  });

  it("leaves the tool room's mould words with the tool room, and the other plastics machines put", () => {
    for (const phrase of ["mould maker", "tool maker", "tool room"]) {
      expect(familyFor(phrase), phrase).not.toBe("fam_injection_moulding");
    }
    // Compression moulding and every other unbound 814 code stay on the generic plastics pack.
    // #3016: bottle blowing is T30 blow moulding now.
    expect(familyFor("Compression Moulding Machine Operator (Plastic)")).toBe("fam_rubber_plastic");
    expect(familyFor("Bottle Blowing Machine Operator (Plastic)")).toBe("fam_blow_moulding");
  });
});

describe("Phase 2 #8 — heat treatment, a new family on four 8121 codes (CEO Launch Plan Pack v1)", () => {
  const offline = resolveJobDomainCorpus();
  const parents = new Set(
    offline.filter((d) => d.selectable && d.parentJobDomainId).map((d) => d.parentJobDomainId),
  );
  const live = offline.filter(
    (d) => d.selectable && !(d.source === "isco08" && parents.has(d.jobDomainId)),
  );
  const liveClaimants = (phrase: string) => {
    const norm = normalizeOccupationText(phrase);
    return live
      .filter((d) => d.aliases.some((a) => normalizeOccupationText(a.text) === norm))
      .map((d) => d.jobDomainId)
      .sort();
  };

  it("binds exactly the four codes, plus the two CEO pack v2 adds (Wave 1, #3008)", () => {
    const codes = corpus.bindings
      .filter((b) => b.family_id === "fam_heat_treatment")
      .map((b) => b.job_domain_id)
      .sort();
    expect(codes).toEqual([
      // Pack v2 section 13.1, T27: the metallurgist and the heat-treatment technician titles.
      "jd_nco_2146_0501",
      "jd_nco_3135_3001",
      "jd_nco_8121_3701",
      "jd_nco_8121_4700",
      "jd_nco_8121_4800",
      "jd_nco_8121_4900",
    ]);
  });

  it("reaches the family on the trade's own words, each the ONLY claimant in production", () => {
    for (const [phrase, code] of [
      ["heat treatment", "jd_nco_8121_3701"],
      ["heat treatment operator", "jd_nco_8121_3701"],
      ["furnace operator", "jd_nco_8121_3701"],
      ["हीट ट्रीटमेंट", "jd_nco_8121_3701"],
      ["hardening", "jd_nco_8121_4800"],
      ["case hardening", "jd_nco_8121_4800"],
      ["induction hardening", "jd_nco_8121_4800"],
      ["carburising", "jd_nco_8121_4800"],
      ["nitriding", "jd_nco_8121_4800"],
      ["gas nitriding", "jd_nco_8121_4800"],
      ["quenching", "jd_nco_8121_4800"],
      ["sealed quench", "jd_nco_8121_4800"],
      ["pit furnace", "jd_nco_8121_4800"],
      ["vacuum furnace", "jd_nco_8121_4800"],
      ["salt bath", "jd_nco_8121_4800"],
      ["ht job work", "jd_nco_8121_4800"],
      ["tempering", "jd_nco_8121_4900"],
      ["annealing", "jd_nco_8121_4700"],
      ["normalising", "jd_nco_8121_4700"],
    ] as const) {
      expect(familyFor(phrase), phrase).toBe("fam_heat_treatment");
      expect(liveClaimants(phrase), phrase).toEqual([code]);
    }
  }, 30_000); // 19 phrases, each scanned against the whole live corpus — CI runs every file at once.

  it("leaves the melt shop's and the QC inspector's own words where they were", () => {
    // Bare "furnace" is the foundry's (sheet 19) and stays on the metal-processing code;
    // hardness and Rockwell are QC instrument words (sheet 12), capture chips only.
    expect(familyFor("furnace")).toBe("fam_metal_processing");
    for (const phrase of ["hardness testing", "rockwell", "quality inspector"]) {
      expect(familyFor(phrase), phrase).not.toBe("fam_heat_treatment");
    }
  });
});

describe("Phase 2 #10 — production supervisor, a new family on the cross-trade 3122 codes (CEO Launch Plan Pack v1)", () => {
  const offline = resolveJobDomainCorpus();
  const parents = new Set(
    offline.filter((d) => d.selectable && d.parentJobDomainId).map((d) => d.parentJobDomainId),
  );
  const live = offline.filter(
    (d) => d.selectable && !(d.source === "isco08" && parents.has(d.jobDomainId)),
  );
  const liveClaimants = (phrase: string) => {
    const norm = normalizeOccupationText(phrase);
    return live
      .filter((d) => d.aliases.some((a) => normalizeOccupationText(a.text) === norm))
      .map((d) => d.jobDomainId)
      .sort();
  };

  it("binds the four cross-trade supervisor codes (owner ruling 2026-11-04) and pack v2's list (#3008)", () => {
    const codes = corpus.bindings
      .filter((b) => b.family_id === "fam_production_supervisor")
      .map((b) => b.job_domain_id);
    expect(codes).toEqual([
      "jd_nco_3122_9900",
      "jd_nco_3122_1900",
      "jd_nco_3122_0601",
      "jd_nco_3122_6503",
      // CEO pack v2 section 13.1, T45 (Akshit, 23 Nov 2026), loaded by Wave 1 (#3008). The four
      // casting and forging supervisor codes the pack also lists (3122.4401/4402/4501/4502) stay
      // with those trades (#2995 point 4 default), so they are not here.
      "jd_nco_3122_0400",
      "jd_nco_3122_0500",
      "jd_nco_3122_2000",
      "jd_nco_3122_2100",
      "jd_nco_3122_2200",
      "jd_nco_3122_2300",
      "jd_nco_3122_4200",
      "jd_nco_3122_4300",
      "jd_nco_3122_4601",
      "jd_nco_3122_4602",
      "jd_nco_3122_4702",
      "jd_nco_3122_5000",
      "jd_nco_3122_5200",
      "jd_nco_3123_0600",
      "jd_nco_3123_0700",
      "jd_nco_3139_2001",
      "jd_nco_7223_0502",
    ]);
  });

  it("reaches the family on the sheet's words, each the ONLY claimant in production", () => {
    for (const [phrase, code] of [
      ["production supervisor", "jd_nco_3122_9900"],
      ["production in-charge", "jd_nco_3122_9900"],
      ["production incharge", "jd_nco_3122_9900"],
      ["production in charge", "jd_nco_3122_9900"],
      ["plant in-charge", "jd_nco_3122_9900"],
      ["shift in-charge", "jd_nco_3122_9900"],
      ["shift incharge", "jd_nco_3122_9900"],
      ["shift in charge", "jd_nco_3122_9900"],
      ["floor incharge", "jd_nco_3122_9900"],
      ["production team leader", "jd_nco_3122_9900"],
      ["प्रोडक्शन सुपरवाइजर", "jd_nco_3122_9900"],
      ["शिफ्ट इंचार्ज", "jd_nco_3122_9900"],
      ["line in-charge", "jd_nco_3122_0601"],
      ["line incharge", "jd_nco_3122_0601"],
      ["foreman", "jd_nco_3122_1900"],
      ["फोरमैन", "jd_nco_3122_1900"],
    ] as const) {
      expect(familyFor(phrase), phrase).toBe("fam_production_supervisor");
      expect(liveClaimants(phrase), phrase).toEqual([code]);
    }
    expect(familyFor("Assembly Line Supervisor")).toBe("fam_production_supervisor");
    expect(familyFor("Planning Supervisor")).toBe("fam_production_supervisor");
  }, 30_000); // 16 phrases, each scanned against the whole live corpus — CI runs every file at once.

  it("routes bare 'supervisor' nowhere, and leaves the trade supervisors where they were", () => {
    // A3: bare supervisor is every trade's top rung; the interview asks the department first.
    expect(familyFor("supervisor")).toBeNull();
    // Sheet 23 kept a trade supervisor with his trade. CEO pack v2 (Akshit, 23 Nov 2026) is the
    // later ruling: section 13.1 lists the press, welding and plastic-moulding shop supervisor
    // codes under T45, so Wave 1 (#3008) binds them here. The forging and casting shop
    // supervisors stay with those trades (#2995 point 4 default, awaiting Akshit's ruling: the
    // forging pair to T26 and the casting pair to T24, #3009).
    const got = Object.fromEntries(
      [
        "Press Shop Supervisor",
        "Welding Supervisor",
        "Plastic Moulding Shop Supervisor",
        "Forging Shop Supervisor",
        "Forging Shop Shift In charge",
        "Casting Line Supervisor",
        "Casting Line In charge",
      ].map((phrase) => [phrase, familyFor(phrase)]),
    );
    expect(got).toEqual({
      "Press Shop Supervisor": "fam_production_supervisor",
      "Welding Supervisor": "fam_production_supervisor",
      "Plastic Moulding Shop Supervisor": "fam_production_supervisor",
      "Forging Shop Supervisor": "fam_forging",
      "Forging Shop Shift In charge": "fam_forging",
      "Casting Line Supervisor": "fam_foundry_casting",
      "Casting Line In charge": "fam_foundry_casting",
    });
  });
});

describe("The foundry split (#3009) — Foundry T24, Die Casting T25 and Forging T26 replace fam_foundry_forging (CEO pack v2)", () => {
  const offline = resolveJobDomainCorpus();
  const parents = new Set(
    offline.filter((d) => d.selectable && d.parentJobDomainId).map((d) => d.parentJobDomainId),
  );
  const live = offline.filter(
    (d) => d.selectable && !(d.source === "isco08" && parents.has(d.jobDomainId)),
  );
  const liveClaimants = (phrase: string) => {
    const norm = normalizeOccupationText(phrase);
    return live
      .filter((d) => d.aliases.some((a) => normalizeOccupationText(a.text) === norm))
      .map((d) => d.jobDomainId)
      .sort();
  };
  const boundTo = (familyId: string) =>
    corpus.bindings
      .filter((b) => b.family_id === familyId)
      .map((b) => b.job_domain_id)
      .sort();

  it("retires fam_foundry_forging: it binds nothing, and its only form is deprecated", () => {
    expect(boundTo("fam_foundry_forging")).toEqual([]);
    const forms = corpus.packs.filter((p) => p.family_id === "fam_foundry_forging");
    expect(forms.map((p) => `${p.pack_id}@${p.version}:${p.status}`)).toEqual([
      "qp_foundry_forging@1:deprecated",
    ]);
  });

  it("binds each family exactly its pack section 13.1 codes, plus the #2995 point 4 supervisor default", () => {
    expect(boundTo("fam_foundry_casting")).toEqual([
      "jd_nco_3122_4401", // #2995 point 4 default (the pack lists it under T45)
      "jd_nco_3122_4402", // #2995 point 4 default (the pack lists it under T45)
      "jd_nco_3135_3100",
      "jd_nco_7211_0100",
      "jd_nco_7211_0200",
      "jd_nco_7211_0201",
      "jd_nco_7211_0300",
      "jd_nco_7211_0400",
      "jd_nco_7211_0500",
      "jd_nco_7211_0600",
      "jd_nco_7211_9900",
      "jd_nco_8121_3301",
      "jd_nco_8121_3801",
      "jd_nco_8121_4300",
      "jd_nco_8121_4400",
      "jd_nco_8121_4500",
      "jd_nco_8121_4600",
    ]);
    expect(boundTo("fam_die_casting")).toEqual(["jd_nco_8121_4200", "jd_nco_8121_4201"]);
    expect(boundTo("fam_forging")).toEqual([
      "jd_nco_3122_4501", // #2995 point 4 default (the pack lists it under T45)
      "jd_nco_3122_4502", // #2995 point 4 default (the pack lists it under T45)
      "jd_nco_7221_0100",
      "jd_nco_7221_0300",
      "jd_nco_7221_0301",
      "jd_nco_7221_0400",
      "jd_nco_7221_0500",
      "jd_nco_7221_9900",
      "jd_nco_7223_0300",
    ]);
  });

  it("reaches each trade on its own words, each the ONLY claimant in production, and none reaches the old family", () => {
    for (const [phrase, family, code] of [
      // T24 Foundry / Casting
      ["foundry", "fam_foundry_casting", "jd_nco_7211_0201"],
      ["casting", "fam_foundry_casting", "jd_nco_7211_0201"],
      ["sand casting", "fam_foundry_casting", "jd_nco_7211_0201"],
      ["shell moulding", "fam_foundry_casting", "jd_nco_7211_0201"],
      ["investment casting", "fam_foundry_casting", "jd_nco_7211_0201"],
      ["aluminium casting", "fam_foundry_casting", "jd_nco_7211_0201"],
      ["फाउंड्री", "fam_foundry_casting", "jd_nco_7211_0201"],
      ["core making", "fam_foundry_casting", "jd_nco_7211_0500"],
      ["core maker", "fam_foundry_casting", "jd_nco_7211_0500"],
      ["cupola", "fam_foundry_casting", "jd_nco_8121_3801"],
      ["melting", "fam_foundry_casting", "jd_nco_8121_3801"],
      ["induction furnace", "fam_foundry_casting", "jd_nco_8121_3801"],
      ["fettling", "fam_foundry_casting", "jd_nco_8121_3301"],
      // T25 Die Casting
      ["die casting", "fam_die_casting", "jd_nco_8121_4201"],
      ["hpdc", "fam_die_casting", "jd_nco_8121_4201"],
      ["pressure die casting", "fam_die_casting", "jd_nco_8121_4201"],
      ["gravity die casting", "fam_die_casting", "jd_nco_8121_4201"],
      // T26 Forging
      ["forging", "fam_forging", "jd_nco_7221_0301"],
      ["hot forging", "fam_forging", "jd_nco_7221_0301"],
      ["press forging", "fam_forging", "jd_nco_7221_0301"],
      ["upset forging", "fam_forging", "jd_nco_7221_0301"],
      ["फोर्जिंग", "fam_forging", "jd_nco_7221_0301"],
      ["power hammer", "fam_forging", "jd_nco_7221_0300"],
    ] as const) {
      expect(familyFor(phrase), phrase).toBe(family);
      expect(liveClaimants(phrase), phrase).toEqual([code]);
    }
  }, 30_000); // 23 phrases, each scanned against the whole live corpus — CI runs every file at once.

  it("leaves the press shop, the village blacksmith and the plastics moulder where they were", () => {
    expect(familyFor("press operator")).toBe("fam_press_operation");
    expect(familyFor("furnace")).toBe("fam_metal_processing");
    // Pack 13.1 binds 7221.0100 "Blacksmith" to T26, but the bare word resolves to the ISCO 7221
    // unit row, which fam_blacksmithing holds by its minor-group binding. The pack also says
    // "lohar ka kaam" must not lead to T26 without asking.
    expect(familyFor("blacksmith")).toBe("fam_blacksmithing");
    for (const phrase of ["blacksmith", "moulding", "injection moulding"]) {
      expect(familyFor(phrase), phrase).not.toBe("fam_forging");
      expect(familyFor(phrase), phrase).not.toBe("fam_foundry_casting");
      expect(familyFor(phrase), phrase).not.toBe("fam_foundry_forging");
    }
  });
});

describe("CEO Launch Plan Pack v1 — sheet-word audit (2026-11-04)", () => {
  // Every word a sheet routes to its trade was run through this resolver. These had reached
  // another trade, mostly on one stray token matched loosely ("die" -> street sales, "threading"
  // -> beauty, "seal" -> tailoring, "coat" -> 3D CAD). Each now has a full-phrase row on its own
  // trade's code, or the stray split alias that beat it was retired.
  it("sends each sheet word to its own trade", () => {
    const expected: Record<string, string> = {
      "die fitting": "fam_tool_die_making",
      "die repair": "fam_tool_die_making",
      "die maintenance": "fam_tool_die_making",
      "die assembly": "fam_tool_die_making",
      "progressive die": "fam_tool_die_making",
      "blanking die": "fam_tool_die_making",
      "forming die": "fam_tool_die_making",
      "press tool": "fam_tool_die_making",
      "core cavity": "fam_tool_die_making",
      "die casting die": "fam_tool_die_making",
      "hand finishing": "fam_tool_die_making",
      "ladder logic": "fam_plc_automation",
      "instrument mechanic": "fam_instrumentation", // #3016: retired off PLC to T40
      grinder: "fam_cnc_grinding",
      "cylindrical grinder": "fam_cnc_grinding",
      "diamond dresser": "fam_cnc_grinding",
      "die sinking": "fam_edm_wirecut",
      "copper electrode": "fam_edm_wirecut",
      "taper cutting": "fam_edm_wirecut",
      "wire threading": "fam_edm_wirecut",
      "super drill": "fam_edm_wirecut",
      "coil feeder": "fam_press_operation",
      "press tool setter": "fam_press_operation",
      "powder coat": "fam_powder_coating",
      "spray painting": "fam_powder_coating",
      "ed coating": "fam_powder_coating",
      "salt spray test": "fam_material_lab", // #3016: retired off Painter to T36
      "seal change": "fam_maintenance_tech",
      "manual lathe": "fam_conventional_machining",
      "conventional lathe": "fam_conventional_machining",
      "body banata hoon": "fam_sheet_metal_fab",
      "cad engineer": "fam_cad_design_3d",
      "mechanical fitter": "fam_fitter",
      "electrical technician": "fam_industrial_electrician",
      assembler: "fam_assembly_line",
    };
    const got = Object.fromEntries(Object.keys(expected).map((p) => [p, familyFor(p)]));
    expect(got).toEqual(expected);
  }, 30_000); // 35 phrases through the full chain — CI runs every file at once.

  it("leaves the words held out on purpose where they were", () => {
    // Owner ruling A2: the generic electrician words stay on the house wireman.
    expect(familyFor("electrician")).toBe("fam_electrical");
    expect(familyFor("wireman")).toBe("fam_electrical");
    // The draughting ROUTER keeps the generic drawing-office words (see the role-pack block).
    expect(familyFor("draftsman")).toBe("fam_draughting");
    // Sheet A3: plain "designer" asks the software first, so it routes nowhere now.
    expect(familyFor("designer")).toBeNull();
    // The sheets say ask "CNC ya manual?" for a bare lathe word.
    expect(familyFor("kharad")).toBe("fam_cnc_turning");
    // Bare "furnace" is the melt shop's; "painter" stays with building painting.
    expect(familyFor("furnace")).toBe("fam_metal_processing");
    expect(familyFor("painter")).toBe("fam_painting");
  });
});


/**
 * WAVE 1 WORKER PHRASES (#3010) — CEO pack v2, 23 Nov 2026.
 *
 * One table per Wave 1 trade, phrase to expected family, for every LOADED phrase (530
 * on #3010 + 7 digit phrases on #3082 per ruling #2995 point 2 = 537).
 * "Loaded" means a row in rvm-aliases.jsonl pointing at the trade's occupation that most
 * exactly names it (spread across the trade's codes the way heat treatment's were).
 *
 * NOT in these tables (all listed on #2995, points 2/3/5 on stated defaults): digits now
 * LOADED in #3082 (T21 2, T33 3, T38 1, T58 1 hi; T58 five domain-file rows grandfathered),
 * shorts held (plc, ppc, plc ka kaam), live-collision holds (qc engineer, quality manager,
 * fettler), routing holds (plant/breakdown + Devanagari twins to #3015), 90 same-family
 * dups, 13 ka-kaam stems. No must-NOT phrase is loaded. No pinned live route changes
 * except plant/breakdown to null.
 */
describe("Wave 1 worker phrases (#3010) — every loaded phrase reaches its trade", () => {
  it("T17 EDM / Wire-cut — 29 loaded phrases reach fam_edm_wirecut", () => {
    const routing = Object.fromEntries(
      [
        "cnc edm",
        "cnc wire cut",
        "die sinker",
        "edm",
        "edm drill",
        "edm machine",
        "electronica wire cut",
        "moly wire cut",
        "robocut",
        "sinker edm",
        "sodick machine",
        "spark machine",
        "sparking ka kaam",
        "sparking machine",
        "sprintcut",
        "wayar cut",
        "wire cut machine",
        "znc",
        "znc machine",
        "znc operator",
        "ईडीएम ऑपरेटर",
        "ईडीएम मशीन",
        "जेडएनसी मशीन",
        "डाई सिंकिंग",
        "वायर कट मशीन",
        "वायरकट ऑपरेटर",
        "स्पार्क इरोज़न",
        "स्पार्क मशीन",
        "स्पार्किंग मशीन",
      ].map((p) => [p, familyFor(p)]),
    );
    expect(routing).toEqual({
      "cnc edm": "fam_edm_wirecut",
      "cnc wire cut": "fam_edm_wirecut",
      "die sinker": "fam_edm_wirecut",
      "edm": "fam_edm_wirecut",
      "edm drill": "fam_edm_wirecut",
      "edm machine": "fam_edm_wirecut",
      "electronica wire cut": "fam_edm_wirecut",
      "moly wire cut": "fam_edm_wirecut",
      "robocut": "fam_edm_wirecut",
      "sinker edm": "fam_edm_wirecut",
      "sodick machine": "fam_edm_wirecut",
      "spark machine": "fam_edm_wirecut",
      "sparking ka kaam": "fam_edm_wirecut",
      "sparking machine": "fam_edm_wirecut",
      "sprintcut": "fam_edm_wirecut",
      "wayar cut": "fam_edm_wirecut",
      "wire cut machine": "fam_edm_wirecut",
      "znc": "fam_edm_wirecut",
      "znc machine": "fam_edm_wirecut",
      "znc operator": "fam_edm_wirecut",
      "ईडीएम ऑपरेटर": "fam_edm_wirecut",
      "ईडीएम मशीन": "fam_edm_wirecut",
      "जेडएनसी मशीन": "fam_edm_wirecut",
      "डाई सिंकिंग": "fam_edm_wirecut",
      "वायर कट मशीन": "fam_edm_wirecut",
      "वायरकट ऑपरेटर": "fam_edm_wirecut",
      "स्पार्क इरोज़न": "fam_edm_wirecut",
      "स्पार्क मशीन": "fam_edm_wirecut",
      "स्पार्किंग मशीन": "fam_edm_wirecut",
    });
  });

  it("T21 CNC Router — 40 loaded phrases reach fam_cnc_router", () => {
    const routing = Object.fromEntries(
      [
        "cnc rauter",
        "cnc router",
        "cnc router operator",
        "router machine",
        "wood cnc",
        "wood router",
        "राउटर मशीन",
        "सीएनसी राउटर",
        "acp cutting",
        "acrylic cutting",
        "art cam",
        "artcam",
        "artcam designer",
        "artcam operator",
        "aspire software",
        "carving machine",
        "cnc engraving",
        "cnc wood carving",
        "die engraving",
        "engraving machine",
        "engraving operator",
        "jali cutting",
        "jdpaint",
        "laser engraving",
        "marble cnc",
        "mdf cutting",
        "mdf jali cutting",
        "stone cnc",
        "vcarve",
        "wood carving machine",
        "आर्टकैम ऑपरेटर",
        "आर्टकैम डिज़ाइनर",
        "एनग्रेविंग मशीन",
        "जाली कटिंग",
        "थ्रीडी कार्विंग",
        "लेज़र एनग्रेविंग",
        "वुड कार्विंग मशीन",
        "स्टोन सीएनसी",
        "3d carving",
        "type3",
      ].map((p) => [p, familyFor(p)]),
    );
    expect(routing).toEqual({
      "cnc rauter": "fam_cnc_router",
      "cnc router": "fam_cnc_router",
      "cnc router operator": "fam_cnc_router",
      "router machine": "fam_cnc_router",
      "wood cnc": "fam_cnc_router",
      "wood router": "fam_cnc_router",
      "राउटर मशीन": "fam_cnc_router",
      "सीएनसी राउटर": "fam_cnc_router",
      "acp cutting": "fam_cnc_router",
      "acrylic cutting": "fam_cnc_router",
      "art cam": "fam_cnc_router",
      "artcam": "fam_cnc_router",
      "artcam designer": "fam_cnc_router",
      "artcam operator": "fam_cnc_router",
      "aspire software": "fam_cnc_router",
      "carving machine": "fam_cnc_router",
      "cnc engraving": "fam_cnc_router",
      "cnc wood carving": "fam_cnc_router",
      "die engraving": "fam_cnc_router",
      "engraving machine": "fam_cnc_router",
      "engraving operator": "fam_cnc_router",
      "jali cutting": "fam_cnc_router",
      "jdpaint": "fam_cnc_router",
      "laser engraving": "fam_cnc_router",
      "marble cnc": "fam_cnc_router",
      "mdf cutting": "fam_cnc_router",
      "mdf jali cutting": "fam_cnc_router",
      "stone cnc": "fam_cnc_router",
      "vcarve": "fam_cnc_router",
      "wood carving machine": "fam_cnc_router",
      "आर्टकैम ऑपरेटर": "fam_cnc_router",
      "आर्टकैम डिज़ाइनर": "fam_cnc_router",
      "एनग्रेविंग मशीन": "fam_cnc_router",
      "जाली कटिंग": "fam_cnc_router",
      "थ्रीडी कार्विंग": "fam_cnc_router",
      "लेज़र एनग्रेविंग": "fam_cnc_router",
      "वुड कार्विंग मशीन": "fam_cnc_router",
      "स्टोन सीएनसी": "fam_cnc_router",
      "3d carving": "fam_cnc_router",
      "type3": "fam_cnc_router",
    });
  });

  it("T33 CMM — 34 loaded phrases reach fam_cmm", () => {
    const routing = Object.fromEntries(
      [
        "accurate cmm",
        "c m m",
        "calypso",
        "cmm",
        "cmm engineer",
        "cmm inspector",
        "cmm machine",
        "cmm oprator",
        "cmm programmer",
        "cmm programming",
        "cmm report",
        "cmm room",
        "coordinate measuring machine",
        "faro arm",
        "hexagon cmm",
        "layout inspection",
        "mcosmos",
        "mitutoyo cmm",
        "pc dmis",
        "pcdmis",
        "vision measuring machine",
        "vmm",
        "vmm operator",
        "zeiss cmm",
        "कैलिप्सो",
        "ज़ाइस सीएमएम",
        "वीएमएम ऑपरेटर",
        "सीएमएम",
        "सीएमएम ऑपरेटर",
        "सीएमएम प्रोग्रामर",
        "सीएमएम मशीन",
        "3d scanner operator",
        "3d scanning",
        "3\u0921\u0940 \u0938\u094d\u0915\u0948\u0928\u0930",
      ].map((p) => [p, familyFor(p)]),
    );
    expect(routing).toEqual({
      "accurate cmm": "fam_cmm",
      "c m m": "fam_cmm",
      "calypso": "fam_cmm",
      "cmm": "fam_cmm",
      "cmm engineer": "fam_cmm",
      "cmm inspector": "fam_cmm",
      "cmm machine": "fam_cmm",
      "cmm oprator": "fam_cmm",
      "cmm programmer": "fam_cmm",
      "cmm programming": "fam_cmm",
      "cmm report": "fam_cmm",
      "cmm room": "fam_cmm",
      "coordinate measuring machine": "fam_cmm",
      "faro arm": "fam_cmm",
      "hexagon cmm": "fam_cmm",
      "layout inspection": "fam_cmm",
      "mcosmos": "fam_cmm",
      "mitutoyo cmm": "fam_cmm",
      "pc dmis": "fam_cmm",
      "pcdmis": "fam_cmm",
      "vision measuring machine": "fam_cmm",
      "vmm": "fam_cmm",
      "vmm operator": "fam_cmm",
      "zeiss cmm": "fam_cmm",
      "कैलिप्सो": "fam_cmm",
      "ज़ाइस सीएमएम": "fam_cmm",
      "वीएमएम ऑपरेटर": "fam_cmm",
      "सीएमएम": "fam_cmm",
      "सीएमएम ऑपरेटर": "fam_cmm",
      "सीएमएम प्रोग्रामर": "fam_cmm",
      "सीएमएम मशीन": "fam_cmm",
      "3d scanner operator": "fam_cmm",
      "3d scanning": "fam_cmm",
      "3\u0921\u0940 \u0938\u094d\u0915\u0948\u0928\u0930": "fam_cmm",
    });
  });

  it("T24 Foundry / Casting — 25 loaded phrases reach fam_foundry_casting", () => {
    const routing = Object.fromEntries(
      [
        "hand moulder",
        "moulder",
        "मोल्डर",
        "dhalai",
        "foundary",
        "foundryman",
        "lost wax casting",
        "no bake moulding",
        "ढलाई",
        "सैंड कास्टिंग",
        "cold box operator",
        "core shop",
        "कोर मेकर",
        "knock out",
        "shot blasting operator",
        "फेटलिंग",
        "शॉट ब्लास्टिंग",
        "arpa machine",
        "disa line",
        "induction furnace operator",
        "ladle man",
        "melter",
        "metal galana",
        "इंडक्शन फर्नेस ऑपरेटर",
        "sand moulding machine",
      ].map((p) => [p, familyFor(p)]),
    );
    expect(routing).toEqual({
      "hand moulder": "fam_foundry_casting",
      "moulder": "fam_foundry_casting",
      "मोल्डर": "fam_foundry_casting",
      "dhalai": "fam_foundry_casting",
      "foundary": "fam_foundry_casting",
      "foundryman": "fam_foundry_casting",
      "lost wax casting": "fam_foundry_casting",
      "no bake moulding": "fam_foundry_casting",
      "ढलाई": "fam_foundry_casting",
      "सैंड कास्टिंग": "fam_foundry_casting",
      "cold box operator": "fam_foundry_casting",
      "core shop": "fam_foundry_casting",
      "कोर मेकर": "fam_foundry_casting",
      "knock out": "fam_foundry_casting",
      "shot blasting operator": "fam_foundry_casting",
      "फेटलिंग": "fam_foundry_casting",
      "शॉट ब्लास्टिंग": "fam_foundry_casting",
      "arpa machine": "fam_foundry_casting",
      "disa line": "fam_foundry_casting",
      "induction furnace operator": "fam_foundry_casting",
      "ladle man": "fam_foundry_casting",
      "melter": "fam_foundry_casting",
      "metal galana": "fam_foundry_casting",
      "इंडक्शन फर्नेस ऑपरेटर": "fam_foundry_casting",
      "sand moulding machine": "fam_foundry_casting",
    });
  });

  it("T25 Die Casting — 30 loaded phrases reach fam_die_casting", () => {
    const routing = Object.fromEntries(
      [
        "alloy wheel casting",
        "aluminium casting machine",
        "aluminium die casting",
        "buhler die casting",
        "cold chamber machine",
        "dai casting",
        "die casting operator",
        "die casting setter",
        "diecasting",
        "gdc",
        "gdc operator",
        "hot chamber machine",
        "toshiba die casting",
        "zinc die casting",
        "एल्युमिनियम डाई कास्टिंग",
        "ग्रेविटी डाई कास्टिंग",
        "जीडीसी",
        "डाई कास्टिंग",
        "डाई कास्टिंग ऑपरेटर",
        "पीडीसी ऑपरेटर",
        "पीडीसी मशीन",
        "प्रेशर डाई कास्टिंग",
        "hpdc operator",
        "low pressure die casting",
        "lpdc",
        "pdc",
        "pdc machine",
        "pdc operator",
        "pdc setter",
        "pdc shop",
      ].map((p) => [p, familyFor(p)]),
    );
    expect(routing).toEqual({
      "alloy wheel casting": "fam_die_casting",
      "aluminium casting machine": "fam_die_casting",
      "aluminium die casting": "fam_die_casting",
      "buhler die casting": "fam_die_casting",
      "cold chamber machine": "fam_die_casting",
      "dai casting": "fam_die_casting",
      "die casting operator": "fam_die_casting",
      "die casting setter": "fam_die_casting",
      "diecasting": "fam_die_casting",
      "gdc": "fam_die_casting",
      "gdc operator": "fam_die_casting",
      "hot chamber machine": "fam_die_casting",
      "toshiba die casting": "fam_die_casting",
      "zinc die casting": "fam_die_casting",
      "एल्युमिनियम डाई कास्टिंग": "fam_die_casting",
      "ग्रेविटी डाई कास्टिंग": "fam_die_casting",
      "जीडीसी": "fam_die_casting",
      "डाई कास्टिंग": "fam_die_casting",
      "डाई कास्टिंग ऑपरेटर": "fam_die_casting",
      "पीडीसी ऑपरेटर": "fam_die_casting",
      "पीडीसी मशीन": "fam_die_casting",
      "प्रेशर डाई कास्टिंग": "fam_die_casting",
      "hpdc operator": "fam_die_casting",
      "low pressure die casting": "fam_die_casting",
      "lpdc": "fam_die_casting",
      "pdc": "fam_die_casting",
      "pdc machine": "fam_die_casting",
      "pdc operator": "fam_die_casting",
      "pdc setter": "fam_die_casting",
      "pdc shop": "fam_die_casting",
    });
  });

  it("T26 Forging — 30 loaded phrases reach fam_forging", () => {
    const routing = Object.fromEntries(
      [
        "drop hammer",
        "hammer operator",
        "ड्रॉप हैमर",
        "हैमर ऑपरेटर",
        "हैमरमैन",
        "cold forging",
        "forger",
        "forging hammer",
        "forging shop",
        "forjing",
        "forzing",
        "कोल्ड फोर्जिंग",
        "फोर्जिंग ऑपरेटर",
        "बोल्ट फॉर्मर",
        "हॉट फोर्जिंग",
        "hammer driver",
        "forging press operator",
        "फोर्जिंग प्रेस",
        "billet heater operator",
        "bolt banane ki machine",
        "bolt former",
        "cold heading",
        "forging die setter",
        "forging trimming",
        "friction press",
        "header operator",
        "nut former",
        "ring rolling",
        "screw press",
        "upsetter operator",
      ].map((p) => [p, familyFor(p)]),
    );
    expect(routing).toEqual({
      "drop hammer": "fam_forging",
      "hammer operator": "fam_forging",
      "ड्रॉप हैमर": "fam_forging",
      "हैमर ऑपरेटर": "fam_forging",
      "हैमरमैन": "fam_forging",
      "cold forging": "fam_forging",
      "forger": "fam_forging",
      "forging hammer": "fam_forging",
      "forging shop": "fam_forging",
      "forjing": "fam_forging",
      "forzing": "fam_forging",
      "कोल्ड फोर्जिंग": "fam_forging",
      "फोर्जिंग ऑपरेटर": "fam_forging",
      "बोल्ट फॉर्मर": "fam_forging",
      "हॉट फोर्जिंग": "fam_forging",
      "hammer driver": "fam_forging",
      "forging press operator": "fam_forging",
      "फोर्जिंग प्रेस": "fam_forging",
      "billet heater operator": "fam_forging",
      "bolt banane ki machine": "fam_forging",
      "bolt former": "fam_forging",
      "cold heading": "fam_forging",
      "forging die setter": "fam_forging",
      "forging trimming": "fam_forging",
      "friction press": "fam_forging",
      "header operator": "fam_forging",
      "nut former": "fam_forging",
      "ring rolling": "fam_forging",
      "screw press": "fam_forging",
      "upsetter operator": "fam_forging",
    });
  });

  it("T27 Heat Treatment — 19 loaded phrases reach fam_heat_treatment", () => {
    const routing = Object.fromEntries(
      [
        "heat treater",
        "heat tritment",
        "ht shop",
        "paani chadhana",
        "पानी चढ़ाना",
        "हीट ट्रीटमेंट ऑपरेटर",
        "एनीलिंग",
        "cht",
        "hardning",
        "induction hardening operator",
        "mesh belt furnace",
        "pit furnace operator",
        "sealed quench furnace",
        "sqf operator",
        "vacuum hardening",
        "इंडक्शन हार्डनिंग",
        "केस हार्डनिंग",
        "नाइट्राइडिंग",
        "टेम्परिंग",
      ].map((p) => [p, familyFor(p)]),
    );
    expect(routing).toEqual({
      "heat treater": "fam_heat_treatment",
      "heat tritment": "fam_heat_treatment",
      "ht shop": "fam_heat_treatment",
      "paani chadhana": "fam_heat_treatment",
      "पानी चढ़ाना": "fam_heat_treatment",
      "हीट ट्रीटमेंट ऑपरेटर": "fam_heat_treatment",
      "एनीलिंग": "fam_heat_treatment",
      "cht": "fam_heat_treatment",
      "hardning": "fam_heat_treatment",
      "induction hardening operator": "fam_heat_treatment",
      "mesh belt furnace": "fam_heat_treatment",
      "pit furnace operator": "fam_heat_treatment",
      "sealed quench furnace": "fam_heat_treatment",
      "sqf operator": "fam_heat_treatment",
      "vacuum hardening": "fam_heat_treatment",
      "इंडक्शन हार्डनिंग": "fam_heat_treatment",
      "केस हार्डनिंग": "fam_heat_treatment",
      "नाइट्राइडिंग": "fam_heat_treatment",
      "टेम्परिंग": "fam_heat_treatment",
    });
  });

  it("T29 Injection Moulding — 27 loaded phrases reach fam_injection_moulding", () => {
    const routing = Object.fromEntries(
      [
        "engel machine",
        "ferromatik",
        "haitian machine",
        "imm operator",
        "injection machine",
        "injecton molding",
        "l&t moulding machine",
        "milacron machine",
        "moldig machine",
        "plastic machine operator",
        "plastic molding machine",
        "toshiba moulding machine",
        "windsor moulding machine",
        "प्लास्टिक मशीन ऑपरेटर",
        "प्लास्टिक मोल्डिंग",
        "मोल्डिंग मशीन",
        "molding operator",
        "moulding ka kaam",
        "मोल्डिंग ऑपरेटर",
        "mold setter",
        "mould change ka kaam",
        "mould loading",
        "मोल्ड चेंज",
        "मोल्ड सेटर",
        "plastic process technician",
        "process technician",
        "प्रोसेस टेक्नीशियन",
      ].map((p) => [p, familyFor(p)]),
    );
    expect(routing).toEqual({
      "engel machine": "fam_injection_moulding",
      "ferromatik": "fam_injection_moulding",
      "haitian machine": "fam_injection_moulding",
      "imm operator": "fam_injection_moulding",
      "injection machine": "fam_injection_moulding",
      "injecton molding": "fam_injection_moulding",
      "l&t moulding machine": "fam_injection_moulding",
      "milacron machine": "fam_injection_moulding",
      "moldig machine": "fam_injection_moulding",
      "plastic machine operator": "fam_injection_moulding",
      "plastic molding machine": "fam_injection_moulding",
      "toshiba moulding machine": "fam_injection_moulding",
      "windsor moulding machine": "fam_injection_moulding",
      "प्लास्टिक मशीन ऑपरेटर": "fam_injection_moulding",
      "प्लास्टिक मोल्डिंग": "fam_injection_moulding",
      "मोल्डिंग मशीन": "fam_injection_moulding",
      "molding operator": "fam_injection_moulding",
      "moulding ka kaam": "fam_injection_moulding",
      "मोल्डिंग ऑपरेटर": "fam_injection_moulding",
      "mold setter": "fam_injection_moulding",
      "mould change ka kaam": "fam_injection_moulding",
      "mould loading": "fam_injection_moulding",
      "मोल्ड चेंज": "fam_injection_moulding",
      "मोल्ड सेटर": "fam_injection_moulding",
      "plastic process technician": "fam_injection_moulding",
      "process technician": "fam_injection_moulding",
      "प्रोसेस टेक्नीशियन": "fam_injection_moulding",
    });
  });

  it("T38 PLC / Automation — 31 loaded phrases reach fam_plc_automation", () => {
    const routing = Object.fromEntries(
      [
        "ab plc",
        "allen bradley",
        "autometion engineer",
        "delta plc",
        "gx works",
        "hmi programming",
        "ladder program",
        "mitsubishi plc",
        "omron plc",
        "plc commissioning",
        "plc engineer",
        "plc mentenance",
        "plc programer",
        "plc scada",
        "rslogix",
        "scada",
        "servo drive",
        "siemens plc",
        "spm automation",
        "tia portal",
        "vfd drive ka kaam",
        "s7 300",
        "एचएमआई",
        "ऑटोमेशन इंजीनियर",
        "पीएलसी",
        "पीएलसी टेक्नीशियन",
        "पीएलसी प्रोग्रामर",
        "लैडर लॉजिक",
        "वीएफडी ड्राइव",
        "सीमेंस पीएलसी",
        "स्काडा",
      ].map((p) => [p, familyFor(p)]),
    );
    expect(routing).toEqual({
      "ab plc": "fam_plc_automation",
      "allen bradley": "fam_plc_automation",
      "autometion engineer": "fam_plc_automation",
      "delta plc": "fam_plc_automation",
      "gx works": "fam_plc_automation",
      "hmi programming": "fam_plc_automation",
      "ladder program": "fam_plc_automation",
      "mitsubishi plc": "fam_plc_automation",
      "omron plc": "fam_plc_automation",
      "plc commissioning": "fam_plc_automation",
      "plc engineer": "fam_plc_automation",
      "plc mentenance": "fam_plc_automation",
      "plc programer": "fam_plc_automation",
      "plc scada": "fam_plc_automation",
      "rslogix": "fam_plc_automation",
      "scada": "fam_plc_automation",
      "servo drive": "fam_plc_automation",
      "siemens plc": "fam_plc_automation",
      "spm automation": "fam_plc_automation",
      "tia portal": "fam_plc_automation",
      "vfd drive ka kaam": "fam_plc_automation",
      "एचएमआई": "fam_plc_automation",
      "ऑटोमेशन इंजीनियर": "fam_plc_automation",
      "पीएलसी": "fam_plc_automation",
      "पीएलसी टेक्नीशियन": "fam_plc_automation",
      "पीएलसी प्रोग्रामर": "fam_plc_automation",
      "लैडर लॉजिक": "fam_plc_automation",
      "वीएफडी ड्राइव": "fam_plc_automation",
      "सीमेंस पीएलसी": "fam_plc_automation",
      "स्काडा": "fam_plc_automation",
      "s7 300": "fam_plc_automation",
    });
  });

  it("T37 Quality Engineer — 32 loaded phrases reach fam_quality_engineer", () => {
    const routing = Object.fromEntries(
      [
        "qms engineer",
        "quality assurance",
        "quality head",
        "quality incharge",
        "quality officer",
        "cqa engineer",
        "customer quality",
        "कस्टमर क्वालिटी",
        "supplier quality",
        "सप्लायर क्वालिटी",
        "det quality",
        "get quality",
        "mr quality",
        "npd quality",
        "ppap engineer",
        "qa engineer",
        "qa qc engineer",
        "quality control engineer",
        "quality engg",
        "qulity engineer",
        "sqa engineer",
        "क्यूए इंजीनियर",
        "क्यूसी इंजीनियर",
        "क्वालिटी इंजीनियर",
        "क्वालिटी एश्योरेंस",
        "क्वालिटी मैनेजर",
        "क्वालिटी हेड",
        "in-process quality engineer",
        "incoming quality engineer",
        "iqc engineer",
        "line quality engineer",
        "pdi engineer",
      ].map((p) => [p, familyFor(p)]),
    );
    expect(routing).toEqual({
      "qms engineer": "fam_quality_engineer",
      "quality assurance": "fam_quality_engineer",
      "quality head": "fam_quality_engineer",
      "quality incharge": "fam_quality_engineer",
      "quality officer": "fam_quality_engineer",
      "cqa engineer": "fam_quality_engineer",
      "customer quality": "fam_quality_engineer",
      "कस्टमर क्वालिटी": "fam_quality_engineer",
      "supplier quality": "fam_quality_engineer",
      "सप्लायर क्वालिटी": "fam_quality_engineer",
      "det quality": "fam_quality_engineer",
      "get quality": "fam_quality_engineer",
      "mr quality": "fam_quality_engineer",
      "npd quality": "fam_quality_engineer",
      "ppap engineer": "fam_quality_engineer",
      "qa engineer": "fam_quality_engineer",
      "qa qc engineer": "fam_quality_engineer",
      "quality control engineer": "fam_quality_engineer",
      "quality engg": "fam_quality_engineer",
      "qulity engineer": "fam_quality_engineer",
      "sqa engineer": "fam_quality_engineer",
      "क्यूए इंजीनियर": "fam_quality_engineer",
      "क्यूसी इंजीनियर": "fam_quality_engineer",
      "क्वालिटी इंजीनियर": "fam_quality_engineer",
      "क्वालिटी एश्योरेंस": "fam_quality_engineer",
      "क्वालिटी मैनेजर": "fam_quality_engineer",
      "क्वालिटी हेड": "fam_quality_engineer",
      "in-process quality engineer": "fam_quality_engineer",
      "incoming quality engineer": "fam_quality_engineer",
      "iqc engineer": "fam_quality_engineer",
      "line quality engineer": "fam_quality_engineer",
      "pdi engineer": "fam_quality_engineer",
    });
  });

  it("T43 Maintenance Engineer — 28 loaded phrases reach fam_maintenance_engineer", () => {
    const routing = Object.fromEntries(
      [
        "electrical maintenance engineer",
        "jr engineer maintenance",
        "machine maintenance engineer",
        "maintainance engineer",
        "maintenance engineer",
        "maintenence engineer",
        "mechanical maintenance engineer",
        "mentenance engineer",
        "shift engineer maintenance",
        "मेंटेनेंस इंजीनियर",
        "यूटिलिटी इंजीनियर",
        "maintenance det",
        "maintenance get",
        "maintenance officer",
        "maintenance head",
        "maintenance in-charge",
        "maintenance incharge",
        "maintenance manager",
        "maintenance supervisor",
        "plant engineer",
        "pm planner",
        "preventive maintenance planning",
        "sap pm",
        "tpm",
        "utility engineer",
        "मेंटेनेंस इंचार्ज",
        "मेंटेनेंस मैनेजर",
        "मेंटेनेंस सुपरवाइजर",
      ].map((p) => [p, familyFor(p)]),
    );
    expect(routing).toEqual({
      "electrical maintenance engineer": "fam_maintenance_engineer",
      "jr engineer maintenance": "fam_maintenance_engineer",
      "machine maintenance engineer": "fam_maintenance_engineer",
      "maintainance engineer": "fam_maintenance_engineer",
      "maintenance engineer": "fam_maintenance_engineer",
      "maintenence engineer": "fam_maintenance_engineer",
      "mechanical maintenance engineer": "fam_maintenance_engineer",
      "mentenance engineer": "fam_maintenance_engineer",
      "shift engineer maintenance": "fam_maintenance_engineer",
      "मेंटेनेंस इंजीनियर": "fam_maintenance_engineer",
      "यूटिलिटी इंजीनियर": "fam_maintenance_engineer",
      "maintenance det": "fam_maintenance_engineer",
      "maintenance get": "fam_maintenance_engineer",
      "maintenance officer": "fam_maintenance_engineer",
      "maintenance head": "fam_maintenance_engineer",
      "maintenance in-charge": "fam_maintenance_engineer",
      "maintenance incharge": "fam_maintenance_engineer",
      "maintenance manager": "fam_maintenance_engineer",
      "maintenance supervisor": "fam_maintenance_engineer",
      "plant engineer": "fam_maintenance_engineer",
      "pm planner": "fam_maintenance_engineer",
      "preventive maintenance planning": "fam_maintenance_engineer",
      "sap pm": "fam_maintenance_engineer",
      "tpm": "fam_maintenance_engineer",
      "utility engineer": "fam_maintenance_engineer",
      "मेंटेनेंस इंचार्ज": "fam_maintenance_engineer",
      "मेंटेनेंस मैनेजर": "fam_maintenance_engineer",
      "मेंटेनेंस सुपरवाइजर": "fam_maintenance_engineer",
    });
  });

  it("T45 Production Supervisor — 21 loaded phrases reach fam_production_supervisor", () => {
    const routing = Object.fromEntries(
      [
        "moulding supervisor",
        "cell leader",
        "chargeman",
        "group leader",
        "junior supervisor",
        "line chalata hoon",
        "line leader",
        "line supervisor",
        "manpower handling ka kaam",
        "production foreman",
        "shift sambhalta hoon",
        "shift supervisor",
        "shop floor supervisor",
        "suparvisor production",
        "superviser production",
        "team leader production",
        "प्रोडक्शन इंचार्ज",
        "लाइन इंचार्ज",
        "लाइन लीडर",
        "लाइन सुपरवाइजर",
        "शॉप फ्लोर सुपरवाइजर",
      ].map((p) => [p, familyFor(p)]),
    );
    expect(routing).toEqual({
      "moulding supervisor": "fam_production_supervisor",
      "cell leader": "fam_production_supervisor",
      "chargeman": "fam_production_supervisor",
      "group leader": "fam_production_supervisor",
      "junior supervisor": "fam_production_supervisor",
      "line chalata hoon": "fam_production_supervisor",
      "line leader": "fam_production_supervisor",
      "line supervisor": "fam_production_supervisor",
      "manpower handling ka kaam": "fam_production_supervisor",
      "production foreman": "fam_production_supervisor",
      "shift sambhalta hoon": "fam_production_supervisor",
      "shift supervisor": "fam_production_supervisor",
      "shop floor supervisor": "fam_production_supervisor",
      "suparvisor production": "fam_production_supervisor",
      "superviser production": "fam_production_supervisor",
      "team leader production": "fam_production_supervisor",
      "प्रोडक्शन इंचार्ज": "fam_production_supervisor",
      "लाइन इंचार्ज": "fam_production_supervisor",
      "लाइन लीडर": "fam_production_supervisor",
      "लाइन सुपरवाइजर": "fam_production_supervisor",
      "शॉप फ्लोर सुपरवाइजर": "fam_production_supervisor",
    });
  });

  it("T46 Production Engineer — 32 loaded phrases reach fam_production_engineer", () => {
    const routing = Object.fromEntries(
      [
        "assembly engineer",
        "machine shop engineer",
        "moulding production engineer",
        "press shop engineer",
        "weld shop engineer",
        "diploma engineer trainee production",
        "je production",
        "junior engineer production",
        "line engineer",
        "prodction engineer",
        "production assistant manager",
        "production det",
        "production engg",
        "production enginer",
        "production executive",
        "production get",
        "production head",
        "production hod",
        "production manager",
        "production me engineer hoon",
        "production officer",
        "shift engineer",
        "shift ka production dekhta hoon",
        "shop engineer",
        "उत्पादन इंजीनियर",
        "प्रोडक्शन इंजिनियर",
        "प्रोडक्शन इंजीनियर",
        "प्रोडक्शन एग्जीक्यूटिव",
        "प्रोडक्शन ऑफिसर",
        "प्रोडक्शन मैनेजर",
        "लाइन इंजीनियर",
        "शिफ्ट इंजीनियर",
      ].map((p) => [p, familyFor(p)]),
    );
    expect(routing).toEqual({
      "assembly engineer": "fam_production_engineer",
      "machine shop engineer": "fam_production_engineer",
      "moulding production engineer": "fam_production_engineer",
      "press shop engineer": "fam_production_engineer",
      "weld shop engineer": "fam_production_engineer",
      "diploma engineer trainee production": "fam_production_engineer",
      "je production": "fam_production_engineer",
      "junior engineer production": "fam_production_engineer",
      "line engineer": "fam_production_engineer",
      "prodction engineer": "fam_production_engineer",
      "production assistant manager": "fam_production_engineer",
      "production det": "fam_production_engineer",
      "production engg": "fam_production_engineer",
      "production enginer": "fam_production_engineer",
      "production executive": "fam_production_engineer",
      "production get": "fam_production_engineer",
      "production head": "fam_production_engineer",
      "production hod": "fam_production_engineer",
      "production manager": "fam_production_engineer",
      "production me engineer hoon": "fam_production_engineer",
      "production officer": "fam_production_engineer",
      "shift engineer": "fam_production_engineer",
      "shift ka production dekhta hoon": "fam_production_engineer",
      "shop engineer": "fam_production_engineer",
      "उत्पादन इंजीनियर": "fam_production_engineer",
      "प्रोडक्शन इंजिनियर": "fam_production_engineer",
      "प्रोडक्शन इंजीनियर": "fam_production_engineer",
      "प्रोडक्शन एग्जीक्यूटिव": "fam_production_engineer",
      "प्रोडक्शन ऑफिसर": "fam_production_engineer",
      "प्रोडक्शन मैनेजर": "fam_production_engineer",
      "लाइन इंजीनियर": "fam_production_engineer",
      "शिफ्ट इंजीनियर": "fam_production_engineer",
    });
  });

  it("T47 Process Engineer — 32 loaded phrases reach fam_process_engineer", () => {
    const routing = Object.fromEntries(
      [
        "ie department",
        "ie engineer",
        "आईई इंजीनियर",
        "इंडस्ट्रियल इंजीनियर",
        "cost reduction engineer",
        "layout planning engineer",
        "lean engineer",
        "line balancing ka kaam",
        "time study engineer",
        "time study ka kaam",
        "tooling engineer",
        "vave engineer",
        "टाइम स्टडी",
        "टूलिंग इंजीनियर",
        "प्रोसेस प्लानिंग",
        "manufacturing engg",
        "manufacturing engineer",
        "me department",
        "me engineer",
        "mfg engineer",
        "new line setup ka kaam",
        "pe department",
        "pfmea control plan banata hoon",
        "process engg",
        "process engineer",
        "process enginer",
        "process planning engineer",
        "process sheet banata hoon",
        "production engineering department",
        "एमई इंजीनियर",
        "प्रोसेस इंजीनियर",
        "मैन्युफैक्चरिंग इंजीनियर",
      ].map((p) => [p, familyFor(p)]),
    );
    expect(routing).toEqual({
      "ie department": "fam_process_engineer",
      "ie engineer": "fam_process_engineer",
      "आईई इंजीनियर": "fam_process_engineer",
      "इंडस्ट्रियल इंजीनियर": "fam_process_engineer",
      "cost reduction engineer": "fam_process_engineer",
      "layout planning engineer": "fam_process_engineer",
      "lean engineer": "fam_process_engineer",
      "line balancing ka kaam": "fam_process_engineer",
      "time study engineer": "fam_process_engineer",
      "time study ka kaam": "fam_process_engineer",
      "tooling engineer": "fam_process_engineer",
      "vave engineer": "fam_process_engineer",
      "टाइम स्टडी": "fam_process_engineer",
      "टूलिंग इंजीनियर": "fam_process_engineer",
      "प्रोसेस प्लानिंग": "fam_process_engineer",
      "manufacturing engg": "fam_process_engineer",
      "manufacturing engineer": "fam_process_engineer",
      "me department": "fam_process_engineer",
      "me engineer": "fam_process_engineer",
      "mfg engineer": "fam_process_engineer",
      "new line setup ka kaam": "fam_process_engineer",
      "pe department": "fam_process_engineer",
      "pfmea control plan banata hoon": "fam_process_engineer",
      "process engg": "fam_process_engineer",
      "process engineer": "fam_process_engineer",
      "process enginer": "fam_process_engineer",
      "process planning engineer": "fam_process_engineer",
      "process sheet banata hoon": "fam_process_engineer",
      "production engineering department": "fam_process_engineer",
      "एमई इंजीनियर": "fam_process_engineer",
      "प्रोसेस इंजीनियर": "fam_process_engineer",
      "मैन्युफैक्चरिंग इंजीनियर": "fam_process_engineer",
    });
  });

  it("T48 NPD Engineer — 33 loaded phrases reach fam_npd_engineer", () => {
    const routing = Object.fromEntries(
      [
        "d&d engineer",
        "design and development",
        "development department",
        "development engineer",
        "naya part develop karta hoon",
        "new part development",
        "new product development",
        "npd",
        "npd engineer",
        "npd enginer",
        "npd executive",
        "part development ka kaam",
        "product development engineer",
        "r and d engineer",
        "r&d engineer",
        "आरएंडडी इंजीनियर",
        "एनपीडी इंजीनियर",
        "डेवलपमेंट इंजीनियर",
        "न्यू प्रोडक्ट डेवलपमेंट",
        "पार्ट डेवलपमेंट",
        "पीपीएपी का काम",
        "प्रोडक्ट डेवलपमेंट",
        "सैंपल डेवलपमेंट",
        "apqp engineer",
        "costing engineer",
        "customer project engineer",
        "engineering department",
        "ppap apqp ka kaam",
        "ppap banata hoon",
        "project engineer npd",
        "rfq engineer",
        "sample development",
        "tooling development engineer",
      ].map((p) => [p, familyFor(p)]),
    );
    expect(routing).toEqual({
      "d&d engineer": "fam_npd_engineer",
      "design and development": "fam_npd_engineer",
      "development department": "fam_npd_engineer",
      "development engineer": "fam_npd_engineer",
      "naya part develop karta hoon": "fam_npd_engineer",
      "new part development": "fam_npd_engineer",
      "new product development": "fam_npd_engineer",
      "npd": "fam_npd_engineer",
      "npd engineer": "fam_npd_engineer",
      "npd enginer": "fam_npd_engineer",
      "npd executive": "fam_npd_engineer",
      "part development ka kaam": "fam_npd_engineer",
      "product development engineer": "fam_npd_engineer",
      "r and d engineer": "fam_npd_engineer",
      "r&d engineer": "fam_npd_engineer",
      "आरएंडडी इंजीनियर": "fam_npd_engineer",
      "एनपीडी इंजीनियर": "fam_npd_engineer",
      "डेवलपमेंट इंजीनियर": "fam_npd_engineer",
      "न्यू प्रोडक्ट डेवलपमेंट": "fam_npd_engineer",
      "पार्ट डेवलपमेंट": "fam_npd_engineer",
      "पीपीएपी का काम": "fam_npd_engineer",
      "प्रोडक्ट डेवलपमेंट": "fam_npd_engineer",
      "सैंपल डेवलपमेंट": "fam_npd_engineer",
      "apqp engineer": "fam_npd_engineer",
      "costing engineer": "fam_npd_engineer",
      "customer project engineer": "fam_npd_engineer",
      "engineering department": "fam_npd_engineer",
      "ppap apqp ka kaam": "fam_npd_engineer",
      "ppap banata hoon": "fam_npd_engineer",
      "project engineer npd": "fam_npd_engineer",
      "rfq engineer": "fam_npd_engineer",
      "sample development": "fam_npd_engineer",
      "tooling development engineer": "fam_npd_engineer",
    });
  });

  it("T52 PPC — 32 loaded phrases reach fam_ppc", () => {
    const routing = Object.fromEntries(
      [
        "planing engineer",
        "planning department",
        "planning ka kaam",
        "schedule banana",
        "scheduling engineer",
        "प्लानिंग इंजीनियर",
        "प्लानिंग का काम",
        "शेड्यूल बनाना",
        "customer schedule follow up",
        "material planner",
        "material planning",
        "mrp ka kaam",
        "p p c",
        "pcc engineer",
        "plan vs actual",
        "ppc assistant",
        "ppc engineer",
        "ppc executive",
        "ppc head",
        "ppc incharge",
        "ppc mis",
        "production plan banata hoon",
        "production planing",
        "production planner",
        "production planning",
        "production planning and control",
        "sap pp",
        "पीपीसी",
        "पीपीसी इंचार्ज",
        "पीपीसी इंजीनियर",
        "प्रोडक्शन प्लानिंग",
        "मटेरियल प्लानिंग",
      ].map((p) => [p, familyFor(p)]),
    );
    expect(routing).toEqual({
      "planing engineer": "fam_ppc",
      "planning department": "fam_ppc",
      "planning ka kaam": "fam_ppc",
      "schedule banana": "fam_ppc",
      "scheduling engineer": "fam_ppc",
      "प्लानिंग इंजीनियर": "fam_ppc",
      "प्लानिंग का काम": "fam_ppc",
      "शेड्यूल बनाना": "fam_ppc",
      "customer schedule follow up": "fam_ppc",
      "material planner": "fam_ppc",
      "material planning": "fam_ppc",
      "mrp ka kaam": "fam_ppc",
      "p p c": "fam_ppc",
      "pcc engineer": "fam_ppc",
      "plan vs actual": "fam_ppc",
      "ppc assistant": "fam_ppc",
      "ppc engineer": "fam_ppc",
      "ppc executive": "fam_ppc",
      "ppc head": "fam_ppc",
      "ppc incharge": "fam_ppc",
      "ppc mis": "fam_ppc",
      "production plan banata hoon": "fam_ppc",
      "production planing": "fam_ppc",
      "production planner": "fam_ppc",
      "production planning": "fam_ppc",
      "production planning and control": "fam_ppc",
      "sap pp": "fam_ppc",
      "पीपीसी": "fam_ppc",
      "पीपीसी इंचार्ज": "fam_ppc",
      "पीपीसी इंजीनियर": "fam_ppc",
      "प्रोडक्शन प्लानिंग": "fam_ppc",
      "मटेरियल प्लानिंग": "fam_ppc",
    });
  });

  it("T54 Purchase — 34 loaded phrases reach fam_purchase", () => {
    const routing = Object.fromEntries(
      [
        "khareedari",
        "kharid ka kaam",
        "po banana",
        "purchaser",
        "rate negotiation",
        "खरीद का काम",
        "outsourcing engineer",
        "sourcing engineer",
        "strategic sourcing",
        "supplier development",
        "vd engineer",
        "vendor development",
        "vendor development engineer",
        "vendor follow up",
        "वेंडर डेवलपमेंट",
        "सोर्सिंग इंजीनियर",
        "material purchase",
        "parchase engineer",
        "procurement engineer",
        "procurement executive",
        "purchase assistant",
        "purchase department",
        "purchase engineer",
        "purchase ka kaam",
        "purchase manager",
        "purchase officer",
        "purches executive",
        "sap mm purchase",
        "scm purchase",
        "परचेज इंजीनियर",
        "परचेज एग्जीक्यूटिव",
        "परचेज ऑफिसर",
        "परचेज का काम",
        "प्रोक्योरमेंट",
      ].map((p) => [p, familyFor(p)]),
    );
    expect(routing).toEqual({
      "khareedari": "fam_purchase",
      "kharid ka kaam": "fam_purchase",
      "po banana": "fam_purchase",
      "purchaser": "fam_purchase",
      "rate negotiation": "fam_purchase",
      "खरीद का काम": "fam_purchase",
      "outsourcing engineer": "fam_purchase",
      "sourcing engineer": "fam_purchase",
      "strategic sourcing": "fam_purchase",
      "supplier development": "fam_purchase",
      "vd engineer": "fam_purchase",
      "vendor development": "fam_purchase",
      "vendor development engineer": "fam_purchase",
      "vendor follow up": "fam_purchase",
      "वेंडर डेवलपमेंट": "fam_purchase",
      "सोर्सिंग इंजीनियर": "fam_purchase",
      "material purchase": "fam_purchase",
      "parchase engineer": "fam_purchase",
      "procurement engineer": "fam_purchase",
      "procurement executive": "fam_purchase",
      "purchase assistant": "fam_purchase",
      "purchase department": "fam_purchase",
      "purchase engineer": "fam_purchase",
      "purchase ka kaam": "fam_purchase",
      "purchase manager": "fam_purchase",
      "purchase officer": "fam_purchase",
      "purches executive": "fam_purchase",
      "sap mm purchase": "fam_purchase",
      "scm purchase": "fam_purchase",
      "परचेज इंजीनियर": "fam_purchase",
      "परचेज एग्जीक्यूटिव": "fam_purchase",
      "परचेज ऑफिसर": "fam_purchase",
      "परचेज का काम": "fam_purchase",
      "प्रोक्योरमेंट": "fam_purchase",
    });
  });

  it("T58 3D CAD — 28 loaded phrases reach fam_cad_design_3d", () => {
    const routing = Object.fromEntries(
      [
        "biw fixture design",
        "design ka kaam",
        "die design",
        "jig fixture design",
        "mold design",
        "mould design",
        "press tool design",
        "sheet metal design",
        "spm design",
        "tool design",
        "कैटिया",
        "कैड डिज़ाइनर",
        "जिग फिक्स्चर डिज़ाइन",
        "टूल डिज़ाइन",
        "डिज़ाइन इंजीनियर",
        "मशीन डिज़ाइन",
        "मोल्ड डिज़ाइन",
        "शीट मेटल डिज़ाइन",
        "सॉलिडवर्क्स",
        "mechanical design engineer",
        "catia designer",
        "creo designer",
        "nx designer",
        "pro e",
        "solid works",
        "solidworks designer",
        "ug nx",
        "3\u0921\u0940 \u0921\u093f\u091c\u093c\u093e\u0907\u0928",
      ].map((p) => [p, familyFor(p)]),
    );
    expect(routing).toEqual({
      "biw fixture design": "fam_cad_design_3d",
      "design ka kaam": "fam_cad_design_3d",
      "die design": "fam_cad_design_3d",
      "jig fixture design": "fam_cad_design_3d",
      "mold design": "fam_cad_design_3d",
      "mould design": "fam_cad_design_3d",
      "press tool design": "fam_cad_design_3d",
      "sheet metal design": "fam_cad_design_3d",
      "spm design": "fam_cad_design_3d",
      "tool design": "fam_cad_design_3d",
      "कैटिया": "fam_cad_design_3d",
      "कैड डिज़ाइनर": "fam_cad_design_3d",
      "जिग फिक्स्चर डिज़ाइन": "fam_cad_design_3d",
      "टूल डिज़ाइन": "fam_cad_design_3d",
      "डिज़ाइन इंजीनियर": "fam_cad_design_3d",
      "मशीन डिज़ाइन": "fam_cad_design_3d",
      "मोल्ड डिज़ाइन": "fam_cad_design_3d",
      "शीट मेटल डिज़ाइन": "fam_cad_design_3d",
      "सॉलिडवर्क्स": "fam_cad_design_3d",
      "mechanical design engineer": "fam_cad_design_3d",
      "catia designer": "fam_cad_design_3d",
      "creo designer": "fam_cad_design_3d",
      "nx designer": "fam_cad_design_3d",
      "pro e": "fam_cad_design_3d",
      "solid works": "fam_cad_design_3d",
      "solidworks designer": "fam_cad_design_3d",
      "ug nx": "fam_cad_design_3d",
      "3\u0921\u0940 \u0921\u093f\u091c\u093c\u093e\u0907\u0928": "fam_cad_design_3d",
    });
  });

});

/**
 * WAVE 2 WORKER PHRASES (#3016 step 3) — every loaded phrase reaches its trade.
 *
 * One table per Wave 2 trade (T18, T19, T20, T22, T23, T28, T30, T31, T32, T34, T35,
 * T36, T39, T40, T41, T42, T56, T57), phrase to expected family, for every phrase LOADED
 * by this change (alias row in rvm-aliases.jsonl pointing at the trade's occupation).
 *
 * NOT in these tables: the 23 same-family skips (sheet words already reaching the trade
 * through a published title or an earlier row — no duplicate row), the 10 ka-kaam stems
 * covered by their loaded stem, the 7 held phrases (Held block below), and 2 loaded rows
 * the offline resolver cannot pin: "boring machine operator" and "crane operator" tie an
 * exact ISCO-unit alias offline and this file resolves through the offline index, so they
 * pin to fam_machining / fam_mobile_plant here; in production the shadowed ISCO units are
 * unsearchable and the Wave 2 rows win, so the rows ship. No must-NOT phrase is loaded.
 * The six ruled moves (#2995 point 5) invalidate the old pins for "fabricator",
 * "fabrication ka kaam", "gas cutting", "structural fitter", "salt spray test" and
 * "instrument mechanic" in the blocks above — updated with the owning slices at merge.
 */
describe("Wave 2 worker phrases (#3016) — every loaded phrase reaches its trade", () => {
  it("T18 Gear Cutting — 31 loaded phrases reach fam_gear_cutting", () => {
    const routing = Object.fromEntries(
      [
        "gear cutting",
        "gear cutting operator",
        "gear banane ka kaam",
        "gear hobbing",
        "hobbing",
        "hobbing machine",
        "hobbing operator",
        "hob machine",
        "cnc hobbing",
        "gear shaper",
        "gear shaping",
        "gear shaving",
        "shaving machine",
        "bevel generator",
        "gleason machine",
        "spline hobbing",
        "sprocket cutting",
        "worm wheel cutting",
        "garari ka kaam",
        "garari cutting",
        "hmt hobbing",
        "liebherr hobbing",
        "gear hobing",
        "gear cuting",
        "गियर कटिंग",
        "गियर हॉबिंग",
        "हॉबिंग मशीन",
        "हॉबिंग ऑपरेटर",
        "गियर शेपर",
        "गियर शेविंग",
        "गरारी का काम",
      ].map((p) => [p, familyFor(p)]),
    );
    expect(routing).toEqual({
      "gear cutting": "fam_gear_cutting",
      "gear cutting operator": "fam_gear_cutting",
      "gear banane ka kaam": "fam_gear_cutting",
      "gear hobbing": "fam_gear_cutting",
      "hobbing": "fam_gear_cutting",
      "hobbing machine": "fam_gear_cutting",
      "hobbing operator": "fam_gear_cutting",
      "hob machine": "fam_gear_cutting",
      "cnc hobbing": "fam_gear_cutting",
      "gear shaper": "fam_gear_cutting",
      "gear shaping": "fam_gear_cutting",
      "gear shaving": "fam_gear_cutting",
      "shaving machine": "fam_gear_cutting",
      "bevel generator": "fam_gear_cutting",
      "gleason machine": "fam_gear_cutting",
      "spline hobbing": "fam_gear_cutting",
      "sprocket cutting": "fam_gear_cutting",
      "worm wheel cutting": "fam_gear_cutting",
      "garari ka kaam": "fam_gear_cutting",
      "garari cutting": "fam_gear_cutting",
      "hmt hobbing": "fam_gear_cutting",
      "liebherr hobbing": "fam_gear_cutting",
      "gear hobing": "fam_gear_cutting",
      "gear cuting": "fam_gear_cutting",
      "गियर कटिंग": "fam_gear_cutting",
      "गियर हॉबिंग": "fam_gear_cutting",
      "हॉबिंग मशीन": "fam_gear_cutting",
      "हॉबिंग ऑपरेटर": "fam_gear_cutting",
      "गियर शेपर": "fam_gear_cutting",
      "गियर शेविंग": "fam_gear_cutting",
      "गरारी का काम": "fam_gear_cutting",
    });
  });

  it("T19 Boring Machine — 34 loaded phrases reach fam_boring_machine", () => {
    const routing = Object.fromEntries(
      [
        "hbm",
        "hbm operator",
        "hbm machine",
        "cnc hbm",
        "horizontal boring",
        "horizontal boring machine",
        "horizontal borer",
        "boring mill",
        "cnc boring machine",
        "floor boring",
        "floor borer",
        "floor type boring",
        "table type boring",
        "jig boring",
        "plano miller",
        "planomiller",
        "plano milling",
        "line boring",
        "heavy machining",
        "heavy job machining",
        "hmt boring machine",
        "wmw boring",
        "tos boring",
        "skoda boring",
        "horizantal boring",
        "boaring machine",
        "बोरिंग मशीन ऑपरेटर",
        "हॉरिजॉन्टल बोरिंग",
        "एचबीएम ऑपरेटर",
        "एचबीएम मशीन",
        "फ्लोर बोरिंग",
        "जिग बोरिंग",
        "प्लानो मिलर",
        "लाइन बोरिंग",
      ].map((p) => [p, familyFor(p)]),
    );
    expect(routing).toEqual({
      "hbm": "fam_boring_machine",
      "hbm operator": "fam_boring_machine",
      "hbm machine": "fam_boring_machine",
      "cnc hbm": "fam_boring_machine",
      "horizontal boring": "fam_boring_machine",
      "horizontal boring machine": "fam_boring_machine",
      "horizontal borer": "fam_boring_machine",
      "boring mill": "fam_boring_machine",
      "cnc boring machine": "fam_boring_machine",
      "floor boring": "fam_boring_machine",
      "floor borer": "fam_boring_machine",
      "floor type boring": "fam_boring_machine",
      "table type boring": "fam_boring_machine",
      "jig boring": "fam_boring_machine",
      "plano miller": "fam_boring_machine",
      "planomiller": "fam_boring_machine",
      "plano milling": "fam_boring_machine",
      "line boring": "fam_boring_machine",
      "heavy machining": "fam_boring_machine",
      "heavy job machining": "fam_boring_machine",
      "hmt boring machine": "fam_boring_machine",
      "wmw boring": "fam_boring_machine",
      "tos boring": "fam_boring_machine",
      "skoda boring": "fam_boring_machine",
      "horizantal boring": "fam_boring_machine",
      "boaring machine": "fam_boring_machine",
      "बोरिंग मशीन ऑपरेटर": "fam_boring_machine",
      "हॉरिजॉन्टल बोरिंग": "fam_boring_machine",
      "एचबीएम ऑपरेटर": "fam_boring_machine",
      "एचबीएम मशीन": "fam_boring_machine",
      "फ्लोर बोरिंग": "fam_boring_machine",
      "जिग बोरिंग": "fam_boring_machine",
      "प्लानो मिलर": "fam_boring_machine",
      "लाइन बोरिंग": "fam_boring_machine",
    });
  });

  it("T20 Honing / Broaching / SPM — 36 loaded phrases reach fam_spm_finishing", () => {
    const routing = Object.fromEntries(
      [
        "honing",
        "honing machine",
        "honing operator",
        "vertical honing",
        "horizontal honing",
        "liner honing",
        "broaching",
        "broaching machine",
        "broach machine",
        "broaching operator",
        "keyway broaching",
        "lapping machine",
        "lapping operator",
        "superfinishing",
        "super finish machine",
        "gun drilling",
        "gun drill machine",
        "deep hole drilling",
        "thread rolling",
        "thread rolling machine",
        "spm operator",
        "spm machine",
        "special purpose machine",
        "facing centring machine",
        "multi spindle drilling",
        "honning machine",
        "broching machine",
        "होनिंग मशीन",
        "होनिंग ऑपरेटर",
        "ब्रोचिंग मशीन",
        "ब्रोचिंग ऑपरेटर",
        "लैपिंग मशीन",
        "एसपीएम ऑपरेटर",
        "गन ड्रिलिंग",
        "थ्रेड रोलिंग",
        "सुपर फिनिशिंग",
      ].map((p) => [p, familyFor(p)]),
    );
    expect(routing).toEqual({
      "honing": "fam_spm_finishing",
      "honing machine": "fam_spm_finishing",
      "honing operator": "fam_spm_finishing",
      "vertical honing": "fam_spm_finishing",
      "horizontal honing": "fam_spm_finishing",
      "liner honing": "fam_spm_finishing",
      "broaching": "fam_spm_finishing",
      "broaching machine": "fam_spm_finishing",
      "broach machine": "fam_spm_finishing",
      "broaching operator": "fam_spm_finishing",
      "keyway broaching": "fam_spm_finishing",
      "lapping machine": "fam_spm_finishing",
      "lapping operator": "fam_spm_finishing",
      "superfinishing": "fam_spm_finishing",
      "super finish machine": "fam_spm_finishing",
      "gun drilling": "fam_spm_finishing",
      "gun drill machine": "fam_spm_finishing",
      "deep hole drilling": "fam_spm_finishing",
      "thread rolling": "fam_spm_finishing",
      "thread rolling machine": "fam_spm_finishing",
      "spm operator": "fam_spm_finishing",
      "spm machine": "fam_spm_finishing",
      "special purpose machine": "fam_spm_finishing",
      "facing centring machine": "fam_spm_finishing",
      "multi spindle drilling": "fam_spm_finishing",
      "honning machine": "fam_spm_finishing",
      "broching machine": "fam_spm_finishing",
      "होनिंग मशीन": "fam_spm_finishing",
      "होनिंग ऑपरेटर": "fam_spm_finishing",
      "ब्रोचिंग मशीन": "fam_spm_finishing",
      "ब्रोचिंग ऑपरेटर": "fam_spm_finishing",
      "लैपिंग मशीन": "fam_spm_finishing",
      "एसपीएम ऑपरेटर": "fam_spm_finishing",
      "गन ड्रिलिंग": "fam_spm_finishing",
      "थ्रेड रोलिंग": "fam_spm_finishing",
      "सुपर फिनिशिंग": "fam_spm_finishing",
    });
  });

  it("T22 Fabricator / Structural Fitter — 34 loaded phrases reach fam_fabrication", () => {
    const routing = Object.fromEntries(
      [
        "fabricator",
        "fabrication",
        "fabrication fitter",
        "fitter fabricator",
        "structural fitter",
        "structure fitter",
        "plate fitter",
        "fit up",
        "fitup ka kaam",
        "tacking ka kaam",
        "marking fitter",
        "layout marker",
        "gas cutting",
        "plate cutting",
        "heavy fabrication",
        "structural fabrication",
        "tank fabrication",
        "vessel fabrication",
        "pressure vessel fitter",
        "peb fitter",
        "shed ka kaam",
        "gate grill ka kaam",
        "loha fabrication",
        "fabricater",
        "febrication",
        "fabrikator",
        "फैब्रिकेटर",
        "फैब्रिकेशन का काम",
        "स्ट्रक्चर फिटर",
        "प्लेट फिटर",
        "फिट अप",
        "टैंक फैब्रिकेशन",
        "हैवी फैब्रिकेशन",
        "मार्किंग फिटर",
      ].map((p) => [p, familyFor(p)]),
    );
    expect(routing).toEqual({
      "fabricator": "fam_fabrication",
      "fabrication": "fam_fabrication",
      "fabrication fitter": "fam_fabrication",
      "fitter fabricator": "fam_fabrication",
      "structural fitter": "fam_fabrication",
      "structure fitter": "fam_fabrication",
      "plate fitter": "fam_fabrication",
      "fit up": "fam_fabrication",
      "fitup ka kaam": "fam_fabrication",
      "tacking ka kaam": "fam_fabrication",
      "marking fitter": "fam_fabrication",
      "layout marker": "fam_fabrication",
      "gas cutting": "fam_fabrication",
      "plate cutting": "fam_fabrication",
      "heavy fabrication": "fam_fabrication",
      "structural fabrication": "fam_fabrication",
      "tank fabrication": "fam_fabrication",
      "vessel fabrication": "fam_fabrication",
      "pressure vessel fitter": "fam_fabrication",
      "peb fitter": "fam_fabrication",
      "shed ka kaam": "fam_fabrication",
      "gate grill ka kaam": "fam_fabrication",
      "loha fabrication": "fam_fabrication",
      "fabricater": "fam_fabrication",
      "febrication": "fam_fabrication",
      "fabrikator": "fam_fabrication",
      "फैब्रिकेटर": "fam_fabrication",
      "फैब्रिकेशन का काम": "fam_fabrication",
      "स्ट्रक्चर फिटर": "fam_fabrication",
      "प्लेट फिटर": "fam_fabrication",
      "फिट अप": "fam_fabrication",
      "टैंक फैब्रिकेशन": "fam_fabrication",
      "हैवी फैब्रिकेशन": "fam_fabrication",
      "मार्किंग फिटर": "fam_fabrication",
    });
  });

  it("T23 Tube Bending / Roll Forming — 36 loaded phrases reach fam_tube_forming", () => {
    const routing = Object.fromEntries(
      [
        "tube bending",
        "pipe bending",
        "pipe bending machine",
        "tube bending machine",
        "cnc tube bending",
        "cnc pipe bending",
        "cnc bender",
        "nc bending machine",
        "mandrel bending",
        "pipe bender",
        "tube bender",
        "roll forming",
        "roll forming machine",
        "roll forming operator",
        "tube mill",
        "tube mill operator",
        "pipe mill",
        "end forming",
        "tube end forming",
        "swaging machine",
        "pipe cutting machine",
        "section bending",
        "profile bending",
        "exhaust pipe bending",
        "silencer pipe bending",
        "handle bar bending",
        "pipe banding",
        "tube banding",
        "पाइप बेंडिंग",
        "ट्यूब बेंडिंग",
        "पाइप बेंडिंग मशीन",
        "सीएनसी पाइप बेंडिंग",
        "पाइप बेंडर",
        "रोल फॉर्मिंग",
        "ट्यूब मिल",
        "एंड फॉर्मिंग",
      ].map((p) => [p, familyFor(p)]),
    );
    expect(routing).toEqual({
      "tube bending": "fam_tube_forming",
      "pipe bending": "fam_tube_forming",
      "pipe bending machine": "fam_tube_forming",
      "tube bending machine": "fam_tube_forming",
      "cnc tube bending": "fam_tube_forming",
      "cnc pipe bending": "fam_tube_forming",
      "cnc bender": "fam_tube_forming",
      "nc bending machine": "fam_tube_forming",
      "mandrel bending": "fam_tube_forming",
      "pipe bender": "fam_tube_forming",
      "tube bender": "fam_tube_forming",
      "roll forming": "fam_tube_forming",
      "roll forming machine": "fam_tube_forming",
      "roll forming operator": "fam_tube_forming",
      "tube mill": "fam_tube_forming",
      "tube mill operator": "fam_tube_forming",
      "pipe mill": "fam_tube_forming",
      "end forming": "fam_tube_forming",
      "tube end forming": "fam_tube_forming",
      "swaging machine": "fam_tube_forming",
      "pipe cutting machine": "fam_tube_forming",
      "section bending": "fam_tube_forming",
      "profile bending": "fam_tube_forming",
      "exhaust pipe bending": "fam_tube_forming",
      "silencer pipe bending": "fam_tube_forming",
      "handle bar bending": "fam_tube_forming",
      "pipe banding": "fam_tube_forming",
      "tube banding": "fam_tube_forming",
      "पाइप बेंडिंग": "fam_tube_forming",
      "ट्यूब बेंडिंग": "fam_tube_forming",
      "पाइप बेंडिंग मशीन": "fam_tube_forming",
      "सीएनसी पाइप बेंडिंग": "fam_tube_forming",
      "पाइप बेंडर": "fam_tube_forming",
      "रोल फॉर्मिंग": "fam_tube_forming",
      "ट्यूब मिल": "fam_tube_forming",
      "एंड फॉर्मिंग": "fam_tube_forming",
    });
  });

  it("T28 Plating / Surface Treatment — 31 loaded phrases reach fam_surface_treatment", () => {
    const routing = Object.fromEntries(
      [
        "plating",
        "pleting",
        "plating operator",
        "plating plant",
        "nickel chrome",
        "nikal polish",
        "hard chrome",
        "anodising",
        "anodizing",
        "phosphating",
        "blackening",
        "galvanising",
        "galvanizing",
        "hot dip galvanizing",
        "jasta chadhana",
        "ced line",
        "ced coating",
        "electroless nickel",
        "barrel plating",
        "vat plating",
        "passivation",
        "surface treatment",
        "प्लेटिंग",
        "प्लेटर",
        "जिंक प्लेटिंग",
        "निकल क्रोम",
        "निकल पॉलिश",
        "हार्ड क्रोम",
        "एनोडाइजिंग",
        "फॉस्फेटिंग",
        "गैल्वनाइजिंग",
      ].map((p) => [p, familyFor(p)]),
    );
    expect(routing).toEqual({
      "plating": "fam_surface_treatment",
      "pleting": "fam_surface_treatment",
      "plating operator": "fam_surface_treatment",
      "plating plant": "fam_surface_treatment",
      "nickel chrome": "fam_surface_treatment",
      "nikal polish": "fam_surface_treatment",
      "hard chrome": "fam_surface_treatment",
      "anodising": "fam_surface_treatment",
      "anodizing": "fam_surface_treatment",
      "phosphating": "fam_surface_treatment",
      "blackening": "fam_surface_treatment",
      "galvanising": "fam_surface_treatment",
      "galvanizing": "fam_surface_treatment",
      "hot dip galvanizing": "fam_surface_treatment",
      "jasta chadhana": "fam_surface_treatment",
      "ced line": "fam_surface_treatment",
      "ced coating": "fam_surface_treatment",
      "electroless nickel": "fam_surface_treatment",
      "barrel plating": "fam_surface_treatment",
      "vat plating": "fam_surface_treatment",
      "passivation": "fam_surface_treatment",
      "surface treatment": "fam_surface_treatment",
      "प्लेटिंग": "fam_surface_treatment",
      "प्लेटर": "fam_surface_treatment",
      "जिंक प्लेटिंग": "fam_surface_treatment",
      "निकल क्रोम": "fam_surface_treatment",
      "निकल पॉलिश": "fam_surface_treatment",
      "हार्ड क्रोम": "fam_surface_treatment",
      "एनोडाइजिंग": "fam_surface_treatment",
      "फॉस्फेटिंग": "fam_surface_treatment",
      "गैल्वनाइजिंग": "fam_surface_treatment",
    });
  });

  it("T30 Blow Moulding — 36 loaded phrases reach fam_blow_moulding", () => {
    const routing = Object.fromEntries(
      [
        "blow moulding",
        "blow molding",
        "blow moulding operator",
        "blow machine operator",
        "bottle machine",
        "bottle banane ki machine",
        "pet blowing",
        "pet blow machine",
        "pet bottle plant",
        "stretch blow machine",
        "isbm machine",
        "ebm machine",
        "extrusion blow moulding",
        "jerry can machine",
        "drum blow moulding",
        "tank blow moulding",
        "parison",
        "blow moulding setter",
        "jagmohan machine",
        "cmp machine",
        "sipa machine",
        "sidel machine",
        "asb machine",
        "kautex",
        "bottle plant operator",
        "blowing operator",
        "blow mold",
        "hdpe bottle machine",
        "ब्लो मोल्डिंग",
        "ब्लो मशीन ऑपरेटर",
        "बोतल मशीन",
        "पेट ब्लोइंग",
        "पेट बोतल प्लांट",
        "जेरी कैन मशीन",
        "ड्रम मशीन",
        "बोतल प्लांट",
      ].map((p) => [p, familyFor(p)]),
    );
    expect(routing).toEqual({
      "blow moulding": "fam_blow_moulding",
      "blow molding": "fam_blow_moulding",
      "blow moulding operator": "fam_blow_moulding",
      "blow machine operator": "fam_blow_moulding",
      "bottle machine": "fam_blow_moulding",
      "bottle banane ki machine": "fam_blow_moulding",
      "pet blowing": "fam_blow_moulding",
      "pet blow machine": "fam_blow_moulding",
      "pet bottle plant": "fam_blow_moulding",
      "stretch blow machine": "fam_blow_moulding",
      "isbm machine": "fam_blow_moulding",
      "ebm machine": "fam_blow_moulding",
      "extrusion blow moulding": "fam_blow_moulding",
      "jerry can machine": "fam_blow_moulding",
      "drum blow moulding": "fam_blow_moulding",
      "tank blow moulding": "fam_blow_moulding",
      "parison": "fam_blow_moulding",
      "blow moulding setter": "fam_blow_moulding",
      "jagmohan machine": "fam_blow_moulding",
      "cmp machine": "fam_blow_moulding",
      "sipa machine": "fam_blow_moulding",
      "sidel machine": "fam_blow_moulding",
      "asb machine": "fam_blow_moulding",
      "kautex": "fam_blow_moulding",
      "bottle plant operator": "fam_blow_moulding",
      "blowing operator": "fam_blow_moulding",
      "blow mold": "fam_blow_moulding",
      "hdpe bottle machine": "fam_blow_moulding",
      "ब्लो मोल्डिंग": "fam_blow_moulding",
      "ब्लो मशीन ऑपरेटर": "fam_blow_moulding",
      "बोतल मशीन": "fam_blow_moulding",
      "पेट ब्लोइंग": "fam_blow_moulding",
      "पेट बोतल प्लांट": "fam_blow_moulding",
      "जेरी कैन मशीन": "fam_blow_moulding",
      "ड्रम मशीन": "fam_blow_moulding",
      "बोतल प्लांट": "fam_blow_moulding",
    });
  });

  it("T31 Plastic Extrusion — 39 loaded phrases reach fam_plastic_extrusion", () => {
    const routing = Object.fromEntries(
      [
        "extrusion",
        "extruder operator",
        "extrusion line operator",
        "pipe plant",
        "pipe plant operator",
        "pvc pipe machine",
        "hdpe pipe plant",
        "cpvc pipe line",
        "profile extrusion",
        "blown film",
        "film plant",
        "multilayer film plant",
        "poly film machine",
        "sheet line",
        "sheet extrusion",
        "thermoforming machine",
        "cable extrusion",
        "wire insulation line",
        "tape plant",
        "raffia tape line",
        "monofilament plant",
        "compounding",
        "masterbatch plant",
        "twin screw extruder",
        "dana machine",
        "plastic dana plant",
        "recycling pelletizer",
        "kabra machine",
        "rajoo machine",
        "extrution",
        "एक्सट्रूज़न",
        "एक्सट्रूडर ऑपरेटर",
        "पाइप प्लांट",
        "पीवीसी पाइप मशीन",
        "फिल्म प्लांट",
        "दाना मशीन",
        "केबल एक्सट्रूज़न",
        "शीट लाइन",
        "टेप प्लांट",
      ].map((p) => [p, familyFor(p)]),
    );
    expect(routing).toEqual({
      "extrusion": "fam_plastic_extrusion",
      "extruder operator": "fam_plastic_extrusion",
      "extrusion line operator": "fam_plastic_extrusion",
      "pipe plant": "fam_plastic_extrusion",
      "pipe plant operator": "fam_plastic_extrusion",
      "pvc pipe machine": "fam_plastic_extrusion",
      "hdpe pipe plant": "fam_plastic_extrusion",
      "cpvc pipe line": "fam_plastic_extrusion",
      "profile extrusion": "fam_plastic_extrusion",
      "blown film": "fam_plastic_extrusion",
      "film plant": "fam_plastic_extrusion",
      "multilayer film plant": "fam_plastic_extrusion",
      "poly film machine": "fam_plastic_extrusion",
      "sheet line": "fam_plastic_extrusion",
      "sheet extrusion": "fam_plastic_extrusion",
      "thermoforming machine": "fam_plastic_extrusion",
      "cable extrusion": "fam_plastic_extrusion",
      "wire insulation line": "fam_plastic_extrusion",
      "tape plant": "fam_plastic_extrusion",
      "raffia tape line": "fam_plastic_extrusion",
      "monofilament plant": "fam_plastic_extrusion",
      "compounding": "fam_plastic_extrusion",
      "masterbatch plant": "fam_plastic_extrusion",
      "twin screw extruder": "fam_plastic_extrusion",
      "dana machine": "fam_plastic_extrusion",
      "plastic dana plant": "fam_plastic_extrusion",
      "recycling pelletizer": "fam_plastic_extrusion",
      "kabra machine": "fam_plastic_extrusion",
      "rajoo machine": "fam_plastic_extrusion",
      "extrution": "fam_plastic_extrusion",
      "एक्सट्रूज़न": "fam_plastic_extrusion",
      "एक्सट्रूडर ऑपरेटर": "fam_plastic_extrusion",
      "पाइप प्लांट": "fam_plastic_extrusion",
      "पीवीसी पाइप मशीन": "fam_plastic_extrusion",
      "फिल्म प्लांट": "fam_plastic_extrusion",
      "दाना मशीन": "fam_plastic_extrusion",
      "केबल एक्सट्रूज़न": "fam_plastic_extrusion",
      "शीट लाइन": "fam_plastic_extrusion",
      "टेप प्लांट": "fam_plastic_extrusion",
    });
  });

  it("T32 Rubber Moulding — 37 loaded phrases reach fam_rubber_moulding", () => {
    const routing = Object.fromEntries(
      [
        "rubber moulding",
        "rubber molding",
        "rubber press",
        "rubber press operator",
        "compression moulding",
        "compression press",
        "transfer moulding",
        "rubber injection machine",
        "mixing mill",
        "rubber mill operator",
        "banbury",
        "calender operator",
        "rubber extruder",
        "hose plant",
        "vulcanising",
        "vulcanizing press",
        "curing press",
        "tyre building",
        "tyre curing",
        "oil seal ka kaam",
        "o ring moulding",
        "gasket moulding",
        "rubber deflashing",
        "rubber trimming",
        "rubber compound mixing",
        "rubber technician",
        "rubber factory ka kaam",
        "रबर मोल्डिंग",
        "रबर प्रेस",
        "रबर प्रेस ऑपरेटर",
        "मिक्सिंग मिल",
        "रबर मिल",
        "टायर बिल्डिंग",
        "टायर क्योरिंग",
        "ऑयल सील",
        "ओ-रिंग",
        "वल्कनाइजिंग",
      ].map((p) => [p, familyFor(p)]),
    );
    expect(routing).toEqual({
      "rubber moulding": "fam_rubber_moulding",
      "rubber molding": "fam_rubber_moulding",
      "rubber press": "fam_rubber_moulding",
      "rubber press operator": "fam_rubber_moulding",
      "compression moulding": "fam_rubber_moulding",
      "compression press": "fam_rubber_moulding",
      "transfer moulding": "fam_rubber_moulding",
      "rubber injection machine": "fam_rubber_moulding",
      "mixing mill": "fam_rubber_moulding",
      "rubber mill operator": "fam_rubber_moulding",
      "banbury": "fam_rubber_moulding",
      "calender operator": "fam_rubber_moulding",
      "rubber extruder": "fam_rubber_moulding",
      "hose plant": "fam_rubber_moulding",
      "vulcanising": "fam_rubber_moulding",
      "vulcanizing press": "fam_rubber_moulding",
      "curing press": "fam_rubber_moulding",
      "tyre building": "fam_rubber_moulding",
      "tyre curing": "fam_rubber_moulding",
      "oil seal ka kaam": "fam_rubber_moulding",
      "o ring moulding": "fam_rubber_moulding",
      "gasket moulding": "fam_rubber_moulding",
      "rubber deflashing": "fam_rubber_moulding",
      "rubber trimming": "fam_rubber_moulding",
      "rubber compound mixing": "fam_rubber_moulding",
      "rubber technician": "fam_rubber_moulding",
      "rubber factory ka kaam": "fam_rubber_moulding",
      "रबर मोल्डिंग": "fam_rubber_moulding",
      "रबर प्रेस": "fam_rubber_moulding",
      "रबर प्रेस ऑपरेटर": "fam_rubber_moulding",
      "मिक्सिंग मिल": "fam_rubber_moulding",
      "रबर मिल": "fam_rubber_moulding",
      "टायर बिल्डिंग": "fam_rubber_moulding",
      "टायर क्योरिंग": "fam_rubber_moulding",
      "ऑयल सील": "fam_rubber_moulding",
      "ओ-रिंग": "fam_rubber_moulding",
      "वल्कनाइजिंग": "fam_rubber_moulding",
    });
  });

  it("T34 NDT — 36 loaded phrases reach fam_ndt", () => {
    const routing = Object.fromEntries(
      [
        "ndt",
        "ndt inspector",
        "ndt level 2",
        "ndt level ii",
        "asnt level 2",
        "asnt level ii",
        "isnt level 2",
        "pcn level 2",
        "ut technician",
        "ut testing",
        "ultrasonic testing",
        "rt technician",
        "radiography",
        "weld ka x-ray",
        "rtfi",
        "film interpreter",
        "mpt",
        "mpi",
        "magnetic particle",
        "dpt",
        "dp test",
        "dye penetrant",
        "lpt",
        "pt mt",
        "paut operator",
        "eddy current testing",
        "thickness gauging",
        "एनडीटी",
        "एनडीटी टेक्नीशियन",
        "एनडीटी लेवल 2",
        "अल्ट्रासोनिक टेस्टिंग",
        "यूटी टेक्नीशियन",
        "रेडियोग्राफी",
        "डीपी टेस्ट",
        "एमपीटी",
        "वेल्ड का एक्स-रे",
      ].map((p) => [p, familyFor(p)]),
    );
    expect(routing).toEqual({
      "ndt": "fam_ndt",
      "ndt inspector": "fam_ndt",
      "ndt level 2": "fam_ndt",
      "ndt level ii": "fam_ndt",
      "asnt level 2": "fam_ndt",
      "asnt level ii": "fam_ndt",
      "isnt level 2": "fam_ndt",
      "pcn level 2": "fam_ndt",
      "ut technician": "fam_ndt",
      "ut testing": "fam_ndt",
      "ultrasonic testing": "fam_ndt",
      "rt technician": "fam_ndt",
      "radiography": "fam_ndt",
      "weld ka x-ray": "fam_ndt",
      "rtfi": "fam_ndt",
      "film interpreter": "fam_ndt",
      "mpt": "fam_ndt",
      "mpi": "fam_ndt",
      "magnetic particle": "fam_ndt",
      "dpt": "fam_ndt",
      "dp test": "fam_ndt",
      "dye penetrant": "fam_ndt",
      "lpt": "fam_ndt",
      "pt mt": "fam_ndt",
      "paut operator": "fam_ndt",
      "eddy current testing": "fam_ndt",
      "thickness gauging": "fam_ndt",
      "एनडीटी": "fam_ndt",
      "एनडीटी टेक्नीशियन": "fam_ndt",
      "एनडीटी लेवल 2": "fam_ndt",
      "अल्ट्रासोनिक टेस्टिंग": "fam_ndt",
      "यूटी टेक्नीशियन": "fam_ndt",
      "रेडियोग्राफी": "fam_ndt",
      "डीपी टेस्ट": "fam_ndt",
      "एमपीटी": "fam_ndt",
      "वेल्ड का एक्स-रे": "fam_ndt",
    });
  });

  it("T35 Calibration / Metrology Lab — 30 loaded phrases reach fam_calibration", () => {
    const routing = Object.fromEntries(
      [
        "calibration",
        "calibration executive",
        "calibration lab",
        "caliberation",
        "calibrashan",
        "instrument calibration",
        "gauge calibration",
        "gauge room",
        "gauge incharge",
        "standard room",
        "standards room",
        "metrology lab",
        "nabl calibration lab",
        "dimensional calibration",
        "pressure gauge calibration",
        "torque wrench calibration",
        "on-site calibration",
        "slip gauge",
        "master instrument",
        "gauge r&r",
        "msa study",
        "iso 17025",
        "instrument checking lab",
        "कैलिब्रेशन",
        "कैलिब्रेशन टेक्नीशियन",
        "कैलिब्रेशन लैब",
        "स्टैंडर्ड रूम",
        "गेज कैलिब्रेशन",
        "मेट्रोलॉजी लैब",
        "इंस्ट्रूमेंट कैलिब्रेशन",
      ].map((p) => [p, familyFor(p)]),
    );
    expect(routing).toEqual({
      "calibration": "fam_calibration",
      "calibration executive": "fam_calibration",
      "calibration lab": "fam_calibration",
      "caliberation": "fam_calibration",
      "calibrashan": "fam_calibration",
      "instrument calibration": "fam_calibration",
      "gauge calibration": "fam_calibration",
      "gauge room": "fam_calibration",
      "gauge incharge": "fam_calibration",
      "standard room": "fam_calibration",
      "standards room": "fam_calibration",
      "metrology lab": "fam_calibration",
      "nabl calibration lab": "fam_calibration",
      "dimensional calibration": "fam_calibration",
      "pressure gauge calibration": "fam_calibration",
      "torque wrench calibration": "fam_calibration",
      "on-site calibration": "fam_calibration",
      "slip gauge": "fam_calibration",
      "master instrument": "fam_calibration",
      "gauge r&r": "fam_calibration",
      "msa study": "fam_calibration",
      "iso 17025": "fam_calibration",
      "instrument checking lab": "fam_calibration",
      "कैलिब्रेशन": "fam_calibration",
      "कैलिब्रेशन टेक्नीशियन": "fam_calibration",
      "कैलिब्रेशन लैब": "fam_calibration",
      "स्टैंडर्ड रूम": "fam_calibration",
      "गेज कैलिब्रेशन": "fam_calibration",
      "मेट्रोलॉजी लैब": "fam_calibration",
      "इंस्ट्रूमेंट कैलिब्रेशन": "fam_calibration",
    });
  });

  it("T36 Material Testing / Met Lab — 37 loaded phrases reach fam_material_lab", () => {
    const routing = Object.fromEntries(
      [
        "material testing",
        "material testing lab",
        "material lab",
        "met lab",
        "metallurgy lab",
        "metallurgical lab",
        "metallurgist",
        "lab chemist foundry",
        "spectro operator",
        "spectro ka kaam",
        "spectro lab",
        "spectrometer operator",
        "hardness testing",
        "hardness checker",
        "utm operator",
        "tensile test",
        "tensile testing",
        "microstructure",
        "metallography",
        "physical lab",
        "mechanical testing lab",
        "chemical lab foundry",
        "wet analysis",
        "sand testing",
        "sand lab",
        "salt spray test",
        "testing lab incharge",
        "lab technician metallurgy",
        "मटेरियल टेस्टिंग",
        "मेट लैब",
        "मेटलर्जी लैब",
        "स्पेक्ट्रो ऑपरेटर",
        "हार्डनेस टेस्टिंग",
        "टेंसाइल टेस्ट",
        "माइक्रोस्ट्रक्चर",
        "सैंड टेस्टिंग",
        "मटेरियल लैब टेक्नीशियन",
      ].map((p) => [p, familyFor(p)]),
    );
    expect(routing).toEqual({
      "material testing": "fam_material_lab",
      "material testing lab": "fam_material_lab",
      "material lab": "fam_material_lab",
      "met lab": "fam_material_lab",
      "metallurgy lab": "fam_material_lab",
      "metallurgical lab": "fam_material_lab",
      "metallurgist": "fam_material_lab",
      "lab chemist foundry": "fam_material_lab",
      "spectro operator": "fam_material_lab",
      "spectro ka kaam": "fam_material_lab",
      "spectro lab": "fam_material_lab",
      "spectrometer operator": "fam_material_lab",
      "hardness testing": "fam_material_lab",
      "hardness checker": "fam_material_lab",
      "utm operator": "fam_material_lab",
      "tensile test": "fam_material_lab",
      "tensile testing": "fam_material_lab",
      "microstructure": "fam_material_lab",
      "metallography": "fam_material_lab",
      "physical lab": "fam_material_lab",
      "mechanical testing lab": "fam_material_lab",
      "chemical lab foundry": "fam_material_lab",
      "wet analysis": "fam_material_lab",
      "sand testing": "fam_material_lab",
      "sand lab": "fam_material_lab",
      "salt spray test": "fam_material_lab",
      "testing lab incharge": "fam_material_lab",
      "lab technician metallurgy": "fam_material_lab",
      "मटेरियल टेस्टिंग": "fam_material_lab",
      "मेट लैब": "fam_material_lab",
      "मेटलर्जी लैब": "fam_material_lab",
      "स्पेक्ट्रो ऑपरेटर": "fam_material_lab",
      "हार्डनेस टेस्टिंग": "fam_material_lab",
      "टेंसाइल टेस्ट": "fam_material_lab",
      "माइक्रोस्ट्रक्चर": "fam_material_lab",
      "सैंड टेस्टिंग": "fam_material_lab",
      "मटेरियल लैब टेक्नीशियन": "fam_material_lab",
    });
  });

  it("T39 Robot Operator / Programmer — 37 loaded phrases reach fam_robotics", () => {
    const routing = Object.fromEntries(
      [
        "robot operator",
        "robot programmer",
        "robot ka kaam",
        "robotic welding",
        "robot welding",
        "welding robot",
        "robot teaching",
        "robot teacher",
        "teach pendant",
        "fanuc robot",
        "yaskawa robot",
        "motoman",
        "abb robot",
        "kuka robot",
        "kawasaki robot",
        "nachi robot",
        "panasonic robot",
        "spot welding robot",
        "mig robot",
        "robot cell",
        "robot touch up",
        "cobot",
        "palletizer robot",
        "pick and place robot",
        "roboguide",
        "robotstudio",
        "robo operator",
        "robot programer",
        "robotic operator",
        "रोबोट ऑपरेटर",
        "रोबोट प्रोग्रामर",
        "रोबोट वेल्डिंग",
        "रोबोटिक वेल्डिंग",
        "रोबोट टीचिंग",
        "टीच पेंडेंट",
        "फानुक रोबोट",
        "रोबोट सेल",
      ].map((p) => [p, familyFor(p)]),
    );
    expect(routing).toEqual({
      "robot operator": "fam_robotics",
      "robot programmer": "fam_robotics",
      "robot ka kaam": "fam_robotics",
      "robotic welding": "fam_robotics",
      "robot welding": "fam_robotics",
      "welding robot": "fam_robotics",
      "robot teaching": "fam_robotics",
      "robot teacher": "fam_robotics",
      "teach pendant": "fam_robotics",
      "fanuc robot": "fam_robotics",
      "yaskawa robot": "fam_robotics",
      "motoman": "fam_robotics",
      "abb robot": "fam_robotics",
      "kuka robot": "fam_robotics",
      "kawasaki robot": "fam_robotics",
      "nachi robot": "fam_robotics",
      "panasonic robot": "fam_robotics",
      "spot welding robot": "fam_robotics",
      "mig robot": "fam_robotics",
      "robot cell": "fam_robotics",
      "robot touch up": "fam_robotics",
      "cobot": "fam_robotics",
      "palletizer robot": "fam_robotics",
      "pick and place robot": "fam_robotics",
      "roboguide": "fam_robotics",
      "robotstudio": "fam_robotics",
      "robo operator": "fam_robotics",
      "robot programer": "fam_robotics",
      "robotic operator": "fam_robotics",
      "रोबोट ऑपरेटर": "fam_robotics",
      "रोबोट प्रोग्रामर": "fam_robotics",
      "रोबोट वेल्डिंग": "fam_robotics",
      "रोबोटिक वेल्डिंग": "fam_robotics",
      "रोबोट टीचिंग": "fam_robotics",
      "टीच पेंडेंट": "fam_robotics",
      "फानुक रोबोट": "fam_robotics",
      "रोबोट सेल": "fam_robotics",
    });
  });

  it("T40 Instrumentation — 34 loaded phrases reach fam_instrumentation", () => {
    const routing = Object.fromEntries(
      [
        "instrument technician",
        "instrumentation technician",
        "instrumentation",
        "instrument mechanic",
        "instrument fitter",
        "instrument ka kaam",
        "iti instrument mechanic",
        "field instrument",
        "transmitter calibration",
        "pressure transmitter",
        "level transmitter",
        "flow meter",
        "control valve ka kaam",
        "positioner",
        "loop checking",
        "hart communicator",
        "rtd thermocouple",
        "impulse line",
        "instrument tubing",
        "dcs instrument",
        "instrument shutdown",
        "e and i technician",
        "load cell ka kaam",
        "instument technician",
        "instrument mentenance",
        "instrumention",
        "इंस्ट्रूमेंट टेक्नीशियन",
        "इंस्ट्रूमेंटेशन",
        "इंस्ट्रूमेंट मैकेनिक",
        "इंस्ट्रूमेंट फिटर",
        "ट्रांसमीटर कैलिब्रेशन",
        "कंट्रोल वाल्व",
        "लूप चेकिंग",
        "फ्लो मीटर",
      ].map((p) => [p, familyFor(p)]),
    );
    expect(routing).toEqual({
      "instrument technician": "fam_instrumentation",
      "instrumentation technician": "fam_instrumentation",
      "instrumentation": "fam_instrumentation",
      "instrument mechanic": "fam_instrumentation",
      "instrument fitter": "fam_instrumentation",
      "instrument ka kaam": "fam_instrumentation",
      "iti instrument mechanic": "fam_instrumentation",
      "field instrument": "fam_instrumentation",
      "transmitter calibration": "fam_instrumentation",
      "pressure transmitter": "fam_instrumentation",
      "level transmitter": "fam_instrumentation",
      "flow meter": "fam_instrumentation",
      "control valve ka kaam": "fam_instrumentation",
      "positioner": "fam_instrumentation",
      "loop checking": "fam_instrumentation",
      "hart communicator": "fam_instrumentation",
      "rtd thermocouple": "fam_instrumentation",
      "impulse line": "fam_instrumentation",
      "instrument tubing": "fam_instrumentation",
      "dcs instrument": "fam_instrumentation",
      "instrument shutdown": "fam_instrumentation",
      "e and i technician": "fam_instrumentation",
      "load cell ka kaam": "fam_instrumentation",
      "instument technician": "fam_instrumentation",
      "instrument mentenance": "fam_instrumentation",
      "instrumention": "fam_instrumentation",
      "इंस्ट्रूमेंट टेक्नीशियन": "fam_instrumentation",
      "इंस्ट्रूमेंटेशन": "fam_instrumentation",
      "इंस्ट्रूमेंट मैकेनिक": "fam_instrumentation",
      "इंस्ट्रूमेंट फिटर": "fam_instrumentation",
      "ट्रांसमीटर कैलिब्रेशन": "fam_instrumentation",
      "कंट्रोल वाल्व": "fam_instrumentation",
      "लूप चेकिंग": "fam_instrumentation",
      "फ्लो मीटर": "fam_instrumentation",
    });
  });

  it("T41 Refrigeration & AC (HVAC) — 33 loaded phrases reach fam_hvac_rac", () => {
    const routing = Object.fromEntries(
      [
        "ac mistri",
        "hvac technician",
        "hvac",
        "hvac operator",
        "refrigeration",
        "fridge ac mechanic",
        "rac",
        "mrac",
        "iti rac",
        "chiller technician",
        "chiller operator",
        "ahu operator",
        "vrf",
        "vrv",
        "ductable ac",
        "package ac",
        "split ac",
        "cassette ac",
        "cold storage",
        "cold room",
        "ammonia plant",
        "gas charging",
        "ac servicing",
        "refrigration",
        "hvac techinician",
        "एसी टेक्नीशियन",
        "एसी मिस्त्री",
        "एचवीएसी",
        "रेफ्रिजरेशन",
        "चिलर ऑपरेटर",
        "कोल्ड स्टोरेज",
        "गैस चार्जिंग",
        "फ्रिज एसी मैकेनिक",
      ].map((p) => [p, familyFor(p)]),
    );
    expect(routing).toEqual({
      "ac mistri": "fam_hvac_rac",
      "hvac technician": "fam_hvac_rac",
      "hvac": "fam_hvac_rac",
      "hvac operator": "fam_hvac_rac",
      "refrigeration": "fam_hvac_rac",
      "fridge ac mechanic": "fam_hvac_rac",
      "rac": "fam_hvac_rac",
      "mrac": "fam_hvac_rac",
      "iti rac": "fam_hvac_rac",
      "chiller technician": "fam_hvac_rac",
      "chiller operator": "fam_hvac_rac",
      "ahu operator": "fam_hvac_rac",
      "vrf": "fam_hvac_rac",
      "vrv": "fam_hvac_rac",
      "ductable ac": "fam_hvac_rac",
      "package ac": "fam_hvac_rac",
      "split ac": "fam_hvac_rac",
      "cassette ac": "fam_hvac_rac",
      "cold storage": "fam_hvac_rac",
      "cold room": "fam_hvac_rac",
      "ammonia plant": "fam_hvac_rac",
      "gas charging": "fam_hvac_rac",
      "ac servicing": "fam_hvac_rac",
      "refrigration": "fam_hvac_rac",
      "hvac techinician": "fam_hvac_rac",
      "एसी टेक्नीशियन": "fam_hvac_rac",
      "एसी मिस्त्री": "fam_hvac_rac",
      "एचवीएसी": "fam_hvac_rac",
      "रेफ्रिजरेशन": "fam_hvac_rac",
      "चिलर ऑपरेटर": "fam_hvac_rac",
      "कोल्ड स्टोरेज": "fam_hvac_rac",
      "गैस चार्जिंग": "fam_hvac_rac",
      "फ्रिज एसी मैकेनिक": "fam_hvac_rac",
    });
  });

  it("T42 Utility — 35 loaded phrases reach fam_utility", () => {
    const routing = Object.fromEntries(
      [
        "boiler operator",
        "boiler man",
        "boiler ka kaam",
        "first class boiler attendant",
        "second class boiler attendant",
        "boe",
        "utility operator",
        "utility ka kaam",
        "compressor operator",
        "dg operator",
        "dg set operator",
        "generator operator",
        "etp operator",
        "stp operator",
        "wtp operator",
        "ro plant operator",
        "dm plant operator",
        "water treatment plant",
        "pump house operator",
        "thermopack operator",
        "thermic fluid heater",
        "cooling tower operator",
        "boilar operator",
        "boyler operator",
        "utillity operator",
        "बॉयलर ऑपरेटर",
        "बॉयलर अटेंडेंट",
        "बॉयलर फायरमैन",
        "यूटिलिटी ऑपरेटर",
        "कंप्रेसर ऑपरेटर",
        "डीजी ऑपरेटर",
        "जनरेटर ऑपरेटर",
        "ईटीपी ऑपरेटर",
        "आरओ प्लांट ऑपरेटर",
        "पंप ऑपरेटर",
      ].map((p) => [p, familyFor(p)]),
    );
    expect(routing).toEqual({
      "boiler operator": "fam_utility",
      "boiler man": "fam_utility",
      "boiler ka kaam": "fam_utility",
      "first class boiler attendant": "fam_utility",
      "second class boiler attendant": "fam_utility",
      "boe": "fam_utility",
      "utility operator": "fam_utility",
      "utility ka kaam": "fam_utility",
      "compressor operator": "fam_utility",
      "dg operator": "fam_utility",
      "dg set operator": "fam_utility",
      "generator operator": "fam_utility",
      "etp operator": "fam_utility",
      "stp operator": "fam_utility",
      "wtp operator": "fam_utility",
      "ro plant operator": "fam_utility",
      "dm plant operator": "fam_utility",
      "water treatment plant": "fam_utility",
      "pump house operator": "fam_utility",
      "thermopack operator": "fam_utility",
      "thermic fluid heater": "fam_utility",
      "cooling tower operator": "fam_utility",
      "boilar operator": "fam_utility",
      "boyler operator": "fam_utility",
      "utillity operator": "fam_utility",
      "बॉयलर ऑपरेटर": "fam_utility",
      "बॉयलर अटेंडेंट": "fam_utility",
      "बॉयलर फायरमैन": "fam_utility",
      "यूटिलिटी ऑपरेटर": "fam_utility",
      "कंप्रेसर ऑपरेटर": "fam_utility",
      "डीजी ऑपरेटर": "fam_utility",
      "जनरेटर ऑपरेटर": "fam_utility",
      "ईटीपी ऑपरेटर": "fam_utility",
      "आरओ प्लांट ऑपरेटर": "fam_utility",
      "पंप ऑपरेटर": "fam_utility",
    });
  });

  it("T56 Forklift / Reach Truck — 33 loaded phrases reach fam_forklift", () => {
    const routing = Object.fromEntries(
      [
        "forklift",
        "fork lift",
        "forklift operator",
        "forklift driver",
        "forklift chalata hoon",
        "forklifter",
        "forklit",
        "folklift",
        "reach truck",
        "reach truck operator",
        "stacker operator",
        "bopt",
        "bopt operator",
        "battery pallet truck",
        "pallet truck",
        "mhe operator",
        "material handling operator",
        "lifter gaadi",
        "tow truck operator",
        "order picker",
        "telehandler",
        "godrej forklift",
        "voltas forklift",
        "battery forklift",
        "diesel forklift",
        "फोर्कलिफ्ट",
        "फोर्कलिफ्ट ऑपरेटर",
        "फोर्कलिफ्ट ड्राइवर",
        "फोर्कलिफ्ट चलाना",
        "रीच ट्रक",
        "स्टैकर ऑपरेटर",
        "पैलेट ट्रक",
        "बैटरी फोर्कलिफ्ट",
      ].map((p) => [p, familyFor(p)]),
    );
    expect(routing).toEqual({
      "forklift": "fam_forklift",
      "fork lift": "fam_forklift",
      "forklift operator": "fam_forklift",
      "forklift driver": "fam_forklift",
      "forklift chalata hoon": "fam_forklift",
      "forklifter": "fam_forklift",
      "forklit": "fam_forklift",
      "folklift": "fam_forklift",
      "reach truck": "fam_forklift",
      "reach truck operator": "fam_forklift",
      "stacker operator": "fam_forklift",
      "bopt": "fam_forklift",
      "bopt operator": "fam_forklift",
      "battery pallet truck": "fam_forklift",
      "pallet truck": "fam_forklift",
      "mhe operator": "fam_forklift",
      "material handling operator": "fam_forklift",
      "lifter gaadi": "fam_forklift",
      "tow truck operator": "fam_forklift",
      "order picker": "fam_forklift",
      "telehandler": "fam_forklift",
      "godrej forklift": "fam_forklift",
      "voltas forklift": "fam_forklift",
      "battery forklift": "fam_forklift",
      "diesel forklift": "fam_forklift",
      "फोर्कलिफ्ट": "fam_forklift",
      "फोर्कलिफ्ट ऑपरेटर": "fam_forklift",
      "फोर्कलिफ्ट ड्राइवर": "fam_forklift",
      "फोर्कलिफ्ट चलाना": "fam_forklift",
      "रीच ट्रक": "fam_forklift",
      "स्टैकर ऑपरेटर": "fam_forklift",
      "पैलेट ट्रक": "fam_forklift",
      "बैटरी फोर्कलिफ्ट": "fam_forklift",
    });
  });

  it("T57 EOT Crane / Rigger — 30 loaded phrases reach fam_crane_rigging", () => {
    const routing = Object.fromEntries(
      [
        "eot operator",
        "eot crane",
        "overhead crane",
        "crane chalata hoon",
        "crane driver",
        "crane ka kaam",
        "crain operator",
        "cren operator",
        "rigar",
        "rigging",
        "khalasi",
        "signalman",
        "hydra operator",
        "hydra driver",
        "hydra crane",
        "farana operator",
        "gantry crane",
        "goliath crane",
        "tower crane operator",
        "pendant crane",
        "ladle crane",
        "क्रेन ऑपरेटर",
        "ईओटी क्रेन",
        "क्रेन चलाना",
        "क्रेन ड्राइवर",
        "रिगर",
        "खलासी",
        "हाइड्रा ऑपरेटर",
        "ओवरहेड क्रेन",
        "टावर क्रेन",
      ].map((p) => [p, familyFor(p)]),
    );
    expect(routing).toEqual({
      "eot operator": "fam_crane_rigging",
      "eot crane": "fam_crane_rigging",
      "overhead crane": "fam_crane_rigging",
      "crane chalata hoon": "fam_crane_rigging",
      "crane driver": "fam_crane_rigging",
      "crane ka kaam": "fam_crane_rigging",
      "crain operator": "fam_crane_rigging",
      "cren operator": "fam_crane_rigging",
      "rigar": "fam_crane_rigging",
      "rigging": "fam_crane_rigging",
      "khalasi": "fam_crane_rigging",
      "signalman": "fam_crane_rigging",
      "hydra operator": "fam_crane_rigging",
      "hydra driver": "fam_crane_rigging",
      "hydra crane": "fam_crane_rigging",
      "farana operator": "fam_crane_rigging",
      "gantry crane": "fam_crane_rigging",
      "goliath crane": "fam_crane_rigging",
      "tower crane operator": "fam_crane_rigging",
      "pendant crane": "fam_crane_rigging",
      "ladle crane": "fam_crane_rigging",
      "क्रेन ऑपरेटर": "fam_crane_rigging",
      "ईओटी क्रेन": "fam_crane_rigging",
      "क्रेन चलाना": "fam_crane_rigging",
      "क्रेन ड्राइवर": "fam_crane_rigging",
      "रिगर": "fam_crane_rigging",
      "खलासी": "fam_crane_rigging",
      "हाइड्रा ऑपरेटर": "fam_crane_rigging",
      "ओवरहेड क्रेन": "fam_crane_rigging",
      "टावर क्रेन": "fam_crane_rigging",
    });
  });

});
describe("Held phrases — #3016 (CEO pack v2, 23 Nov 2026)", () => {
  it("gear grinding stays with grinding: the pack says bare grinding asks", () => {
    // Ruled #2995 point 5 names it as a T18 move, but the grinding characterization pins
    // "gear grinding" to fam_cnc_grinding and the T18 sheet says bare "grinding" alone must ask
    // (CNC Grinding Operator). Retiring it off jd_nco_7223_2200 would flip a pinned Wave-1 row,
    // so the English row stays and the Devanagari sheet twin is not loaded either.
    expect(familyFor("gear grinding")).toBe("fam_cnc_grinding");
    expect(familyFor("गियर ग्राइंडिंग")).toBe("fam_cnc_grinding");
  });

  it("tie-loss holds: the published title on a live trade wins the exact span", () => {
    // Each is a sheet word, but the row would be dead weight: the rival is production-visible,
    // so production would ask rather than pin the trade. Held, not loaded.
    expect(familyFor("plater")).toBe("fam_handicraft");
    expect(familyFor("autoclave operator")).toBe("fam_chemical_plant");
    expect(familyFor("radiographer")).toBe("fam_universal");
    expect(familyFor("mobile crane operator")).toBe("fam_mobile_plant");
  });

  it("bare-stem hold: ac ka kaam would move a pinned fitter phrase", () => {
    // Its norm "ac" is a new 1-token key that steals pinned "ac fitter" (fam_fitter) and flips
    // pinned-null "ac maintenance" onto HVAC. Held for routing; the AC worker still reaches the
    // trade through "ac technician", "ac mechanic" and "ac fitting" (pre-existing rows).
    expect(familyFor("ac ka kaam")).toBeNull();
    expect(familyFor("ac fitter")).toBe("fam_fitter");
    expect(familyFor("ac maintenance")).toBeNull();
  });

  it("bare-stem hold: gear ka kaam would move must-not phrases onto the trade", () => {
    // The norms "gear" and "गियर" are new 1-token keys that steal must-not "gear oil" and
    // "gear change" (gaadi ka kaam) off domestic and flip the held hi twin "गियर ग्राइंडिंग"
    // off grinding. Held for routing; the gear worker still reaches the trade through
    // "gear cutting", "gear hobbing", "garari ka kaam" and the other rows above.
    expect(familyFor("gear ka kaam")).not.toBe("fam_gear_cutting");
    expect(familyFor("गियर का काम")).toBeNull();
    expect(familyFor("gear oil")).not.toBe("fam_gear_cutting");
    expect(familyFor("gear change")).not.toBe("fam_gear_cutting");
  });

  it("digits are rows now; shorts proved 0 moves so none held", () => {
    // Validator change #2995 point 2 (ruled 26 Nov 2026): the contact guard is @/URL/7+ digits,
    // so T34's levels and T35's "iso 17025" load (tables above). All 10 shorts reached their
    // trade with 0 moves across 9,924 phrases, so the Held list carries no short.
    for (const p of ["ndt level 2", "asnt level 2", "isnt level 2", "pcn level 2", "iso 17025", "boe"]) {
      expect(familyFor(p), p).not.toBeNull();
    }
    expect(familyFor("ndt level 2")).toBe("fam_ndt");
    expect(familyFor("iso 17025")).toBe("fam_calibration");
    expect(familyFor("boe")).toBe("fam_utility");
  });

  it("offline-divergent rows are loaded for production and pinned as-is here", () => {
    // "boring machine operator" and "crane operator" tie an exact ISCO-unit alias; this file
    // resolves through the offline index, where the ISCO row comes first. In production the
    // shadowed ISCO units are unsearchable, so the Wave 2 rows win and workers reach the trade.
    expect(familyFor("boring machine operator")).toBe("fam_machining");
    expect(familyFor("crane operator")).toBe("fam_mobile_plant");
  });
});

describe("Retirements — #3010 (CEO pack v2, 23 Nov 2026)", () => {
  const codeFor = (p: string): string | null => resolveOccupation(occupationIndex, p)?.jobDomainId ?? null;
  it("retires plant and breakdown maintenance off Maintenance Technician to routing", () => {
    // The pack gives them to T43 but also says bare "maintenance" must ask; retired from
    // the technician and left to routing (#3015) rather than pointed at T43.
    // Validator would refuse an occupation left empty: 7233.0101 keeps maintenance fitter,
    // machine maintenance etc, so no replacement phrase is needed in the same change.
    for (const p of ["plant maintenance", "breakdown maintenance"]) {
      expect(codeFor(p), p).toBeNull();
      expect(familyFor(p), p).toBeNull();
    }
    // cad designer already retired off 3118_0401 (2026-11-02) to jd_rvm_3d_cad_designer; pinned here
    // to prove #3010 needs no new row for it (duplicate would fail validation).
    expect(codeFor("cad designer"), "cad designer").toBe("jd_rvm_3d_cad_designer");
    expect(familyFor("cad designer"), "cad designer").toBe("fam_cad_design_3d");
  });
});

describe("Held phrases — #3010 (listed on #2995)", () => {
  it("digits reach Wave 1 families (loaded in #3082 per ruling #2995 point 2; T58 domain file grandfathered)", () => {
    // #3082: T21 2, T33 2 + 1 hi, T38 1, T58 1 hi — each proved 0 moves in-memory over
    // 9,916 phrases (9,792 aliases + 829 pinned, same pattern as #3010 point-3 shorts).
    expect(familyFor("3d carving"), "3d carving").toBe("fam_cnc_router");
    expect(familyFor("type3"), "type3").toBe("fam_cnc_router");
    expect(familyFor("3d scanner operator"), "3d scanner operator").toBe("fam_cmm");
    expect(familyFor("3d scanning"), "3d scanning").toBe("fam_cmm");
    expect(familyFor("3\u0921\u0940 \u0938\u094d\u0915\u0948\u0928\u0930"), "3D scanner hi").toBe("fam_cmm");
    expect(familyFor("s7 300"), "s7 300").toBe("fam_plc_automation");
    // T58 digits already loaded (domain file, not overlay): they reach the trade.
    for (const p of ["3d design", "3d designer", "3d modelling", "3d modeling", "fusion 360"]) {
      expect(familyFor(p), p).toBe("fam_cad_design_3d");
    }
    expect(familyFor("3\u0921\u0940 \u0921\u093f\u091c\u093c\u093e\u0907\u0928"), "3D design hi").toBe("fam_cad_design_3d");
  });

  it("shorts held: plc, ppc and plc ka kaam reach nothing (would misroute pinned live phrases)", () => {
    // Bare "plc" and "plc ka kaam" both normalize to "plc"; "police" null -> PLC. Bare "ppc"
    // moves "pcc panel" null -> PPC. The other 9 shorts (edm, znc, pdc, gdc, cht, cmm, vmm, tpm,
    // npd) proved 0 moves across 9,263 phrases and are loaded in the tables above.
    for (const p of ["plc", "ppc", "plc ka kaam"]) {
      expect(familyFor(p), p).toBeNull();
    }
    // Live-collision holds (would move a live pinned route, not listed): they stay on live.
    expect(familyFor("qc engineer"), "qc engineer").toBe("fam_quality_inspection");
    expect(familyFor("quality manager"), "quality manager").toBe("fam_quality_inspection");
    // Fettler stays on the metal plant (ISCO 8122), not the foundry.
    expect(familyFor("fettler"), "fettler").toBe("fam_metal_plant");
    expect(familyFor("fettler"), "fettler").not.toBe("fam_foundry_casting");
  });
});

/**
 * FOLDED ROLE WORDS + MUST-NOT (#3027, pack 10.1 + sheets).
 *
 * 10.1: every folded word that reached nothing now reaches its trade (live or Wave 1).
 * Words whose target is Wave 2/3 are held for #3016/#3017; words that already reached
 * the right trade need nothing; words that reached another live trade are preserved to
 * avoid a live touch (owner ruling pending). No digits, no shorts, no must-NOT phrases.
 */
describe("Folded role words (#3027 section 10.1) — every held-out word reaches its trade", () => {
  it("16 Wave 1/live folded words reach their trade", () => {
    const routing = Object.fromEntries(
      [
        "press-brake operator",
        "turret-punch operator",
        "shearing operator",
        "hydraulic and pneumatic technician",
        "DG electrician",
        "shot blasting",
        "heading",
        "bolt-former operator",
        "vision measuring",
        "DCS engineer",
        "mechatronics technician",
        "reliability engineer",
        "method engineer",
        "prototype engineer",
        "sourcing",
        "reverse engineering",
      ].map((p) => [p, familyFor(p)]),
    );
    expect(routing).toEqual({
      "press-brake operator": "fam_sheet_metal_fab",
      "turret-punch operator": "fam_sheet_metal_fab",
      "shearing operator": "fam_sheet_metal_fab",
      "hydraulic and pneumatic technician": "fam_maintenance_tech",
      "DG electrician": "fam_industrial_electrician",
      "shot blasting": "fam_foundry_casting",
      "heading": "fam_forging",
      "bolt-former operator": "fam_forging",
      "vision measuring": "fam_cmm",
      "DCS engineer": "fam_plc_automation",
      "mechatronics technician": "fam_plc_automation",
      "reliability engineer": "fam_maintenance_engineer",
      "method engineer": "fam_process_engineer",
      "prototype engineer": "fam_npd_engineer",
      "sourcing": "fam_purchase",
      "reverse engineering": "fam_cad_design_3d",
    });
  });
});


describe("Must NOT lead here — Wave 1 sheets (#3027)", () => {
  it("destination trades: phrase must NOT resolve to the sheet's own family (102 rows; safety supervisor + project planning + piping design held for Wave 3)", () => {
    // Entries that say "ask" are covered by the routing table test in #3015 and skipped here.
    // Qualified entries ("sparking" with welding) are excluded: bare "sparking" correctly
    // leads to its own trade (EDM); only the welding-qualified variant must go to Welder.
    const cases: Array<[string, string]> = [ // [phrase, ownFamily]
      ["die ka kaam", "fam_edm_wirecut"], // T17
      ["die polish", "fam_edm_wirecut"], // T17
      ["wire ka kaam", "fam_edm_wirecut"], // T17
      ["wiring", "fam_edm_wirecut"], // T17
      ["laser cutting", "fam_edm_wirecut"], // T17
      ["drill machine", "fam_edm_wirecut"], // T17
      ["CAM programmer", "fam_cnc_router"], // T21
      ["laser cutting", "fam_cnc_router"], // T21
      ["VMC", "fam_cnc_router"], // T21
      ["die casting", "fam_foundry_casting"], // T24
      ["PDC", "fam_foundry_casting"], // T24
      ["forging", "fam_foundry_casting"], // T24
      ["die ka kaam", "fam_die_casting"], // T25
      ["die fitter", "fam_die_casting"], // T25
      ["foundry", "fam_die_casting"], // T25
      ["dhalai", "fam_die_casting"], // T25
      ["foundry", "fam_forging"], // T26
      ["dhalai", "fam_forging"], // T26
      ["thread rolling", "fam_forging"], // T26
      ["hardness testing", "fam_heat_treatment"], // T27
      ["met lab", "fam_heat_treatment"], // T27
      ["boiler operator", "fam_heat_treatment"], // T27
      ["plating", "fam_heat_treatment"], // T27
      ["blackening", "fam_heat_treatment"], // T27
      ["bottle machine", "fam_injection_moulding"], // T29
      ["PET blowing", "fam_injection_moulding"], // T29
      ["pipe plant", "fam_injection_moulding"], // T29
      ["film plant", "fam_injection_moulding"], // T29
      ["die casting", "fam_injection_moulding"], // T29
      ["PDC machine", "fam_injection_moulding"], // T29
      ["mould banata hoon", "fam_injection_moulding"], // T29
      ["mould maker", "fam_injection_moulding"], // T29
      ["mould design", "fam_injection_moulding"], // T29
      ["inspector", "fam_cmm"], // T33
      ["inspection", "fam_cmm"], // T33
      ["calibration", "fam_cmm"], // T33
      ["profile projector", "fam_cmm"], // T33
      ["QC", "fam_quality_engineer"], // T37
      ["quality checker", "fam_quality_engineer"], // T37
      ["inspector", "fam_quality_engineer"], // T37
      ["CMM", "fam_quality_engineer"], // T37
      ["lab", "fam_quality_engineer"], // T37
      ["material testing", "fam_quality_engineer"], // T37
      ["calibration", "fam_quality_engineer"], // T37
      ["process engineer", "fam_quality_engineer"], // T37
      ["panel wiring", "fam_plc_automation"], // T38
      ["electrician", "fam_plc_automation"], // T38
      ["robot programmer", "fam_plc_automation"], // T38
      ["instrument ka kaam", "fam_plc_automation"], // T38
      ["maintenance fitter", "fam_maintenance_engineer"], // T43
      ["electrician", "fam_maintenance_engineer"], // T43
      ["service engineer", "fam_maintenance_engineer"], // T43
      ["PLC engineer", "fam_maintenance_engineer"], // T43
      ["utility operator", "fam_maintenance_engineer"], // T43
      ["AC maintenance", "fam_maintenance_engineer"], // T43
      ["quality supervisor", "fam_production_supervisor"], // T45
      ["maintenance supervisor", "fam_production_supervisor"], // T45
      ["store incharge", "fam_production_supervisor"], // T45
      ["production engineer", "fam_production_supervisor"], // T45
      ["production supervisor", "fam_production_engineer"], // T46
      ["line incharge", "fam_production_engineer"], // T46
      ["PPC", "fam_production_engineer"], // T46
      ["planning", "fam_production_engineer"], // T46
      ["process engineer", "fam_production_engineer"], // T46
      ["ME", "fam_production_engineer"], // T46
      ["quality engineer", "fam_production_engineer"], // T46
      ["process technician", "fam_process_engineer"], // T47
      ["production engineer", "fam_process_engineer"], // T47
      ["fixture design", "fam_process_engineer"], // T47
      ["tool design", "fam_process_engineer"], // T47
      ["NPD", "fam_process_engineer"], // T47
      ["development engineer", "fam_process_engineer"], // T47
      ["process quality", "fam_process_engineer"], // T47
      ["PQC", "fam_process_engineer"], // T47
      ["CNC programming", "fam_process_engineer"], // T47
      ["design engineer", "fam_npd_engineer"], // T48
      ["vendor development", "fam_npd_engineer"], // T48
      ["APQP quality", "fam_npd_engineer"], // T48
      ["NPD quality", "fam_npd_engineer"], // T48
      ["tool room", "fam_npd_engineer"], // T48
      ["production engineer", "fam_ppc"], // T52
      ["store incharge", "fam_ppc"], // T52
      ["vendor follow up", "fam_ppc"], // T52
      ["dispatch", "fam_ppc"], // T52
      ["vendor quality", "fam_purchase"], // T54
      ["SQA", "fam_purchase"], // T54
      ["material planning", "fam_purchase"], // T54
      ["marketing", "fam_purchase"], // T54
      ["export documentation", "fam_purchase"], // T54
      ["autocad", "fam_cad_design_3d"], // T58
      ["draughtsman", "fam_cad_design_3d"], // T58
      ["2d drawing", "fam_cad_design_3d"], // T58
      ["mastercam", "fam_cad_design_3d"], // T58
      ["powermill", "fam_cad_design_3d"], // T58
      ["delcam", "fam_cad_design_3d"], // T58
      ["ansys", "fam_cad_design_3d"], // T58
      ["hypermesh", "fam_cad_design_3d"], // T58
      ["analysis", "fam_cad_design_3d"], // T58
      ["pdms", "fam_cad_design_3d"], // T58
      ["artcam", "fam_cad_design_3d"], // T58
      ["npd", "fam_cad_design_3d"], // T58
      ["development engineer", "fam_cad_design_3d"], // T58
    ];
    for (const [phrase, ownFamily] of cases) {
      expect(familyFor(phrase), phrase).not.toBe(ownFamily);
    }
  });

  it("not this trade: phrase must NOT resolve to its sheet's family (7 rows)", () => {
    // Pure not-this-trade entries (no "ask" qualifier): borewell/garage/car AC/building lift
    // are Wave 2 examples held for #3016; Wave 1 equivalents below resolve to null/generic
    // non-trade (draughting router, universal, manufacturing labour), never to the sheet's
    // own family and never to a 60-trade family (verified: draughting/universal/labour/null
    // are not trade packs). "Ask again" purchase/tally entries deferred as known gap (needs
    // ask-again behavior, not a pin).
    expect(familyFor("haath ki nakkashi"), "haath ki nakkashi (T21)").not.toBe("fam_cnc_router"); // T21
    expect(familyFor("QA pharma"), "QA pharma (T37)").not.toBe("fam_quality_engineer"); // T37
    expect(familyFor("QC chemist"), "QC chemist (T37)").not.toBe("fam_quality_engineer"); // T37
    expect(familyFor("software QA"), "software QA (T37)").not.toBe("fam_quality_engineer"); // T37
    expect(familyFor("tester"), "tester (T37)").not.toBe("fam_quality_engineer"); // T37
    expect(familyFor("R&D"), "R&D (T48)").not.toBe("fam_npd_engineer"); // T48
    expect(familyFor("developer"), "developer (T48)").not.toBe("fam_npd_engineer"); // T48
  });
});

describe("Left-out guards — pack 10.2 (#3027)", () => {
  it("five left-out words resolve to no trade form", () => {
    // Civil, electronics, garment, helpers/housekeeping, plant head: left out on purpose.
    // No phrase from this pack may point at a trade form for these (pack 10.2). Verified:
    // universal/cleaning/null are not 60-trade families (generic fallback/router, not trade).
    expect(familyFor("civil engineer"), "civil engineer").toBe("fam_universal");
    expect(familyFor("soldering operator"), "soldering operator").toBeNull();
    expect(familyFor("garment designer"), "garment designer").toBeNull();
    expect(familyFor("housekeeping supervisor"), "housekeeping supervisor").toBe("fam_cleaning");
    expect(familyFor("plant head"), "plant head").toBeNull();
  });
});
