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
const GRINDING_PHRASES = ["grinding machine", "ghisai", "घिसाई", "ग्राइंडिंग"] as const;

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
    // Read this as a report. All fifteen reach the pack, and every one of them is NEW — before
    // this batch the entire list was NO MATCH except "cnc programmer", which is the published NCO
    // title on 7223.6003 and therefore already an alias of it; retrieval reached the code and
    // `fam_machining` answered at unit level with six generic machining questions.
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
    expect(routing).toEqual({
      cad: "fam_cad_drafting",
      "cad operator": "fam_cad_drafting",
      "cad designer": "fam_cad_drafting",
      "mechanical designer": "fam_cad_drafting",
      "draughtsman mechanical": "fam_cad_drafting",
      "mechanical draughtsman": "fam_cad_drafting",
      autocad: "fam_cad_drafting",
      solidworks: "fam_cad_drafting",
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
    expect(familyFor("fusion cutting")).toBe("fam_welding_trade");
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
        "welder", "welding", "वेल्डर", "वेल्डिंग", "welding mistri", "jodai ka kaam", "जोड़ाई",
        "veldar", "arc welding", "mig welding", "tig welding", "gas welding", "gas cutting",
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
      "cylinder borer": "fam_conventional_machining",
      "tool maker": "fam_tool_die_making",
      "tool room": "fam_tool_die_making",
      "टूल रूम": "fam_tool_die_making",
      "टूल मेकर": "fam_tool_die_making",
      "डाई मेकर": "fam_tool_die_making",
      "jig borer": "fam_tool_die_making",
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
      "gas cutting": "fam_welding_trade",
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
        // shipped — so these five moved off the generic minor-721 pack in that change, by design.
        "sheet metal", "शीट मेटल", "press brake", "laser cutting", "chadar ka kaam", "fabricator",
        "fabrication ka kaam",
        // Quality inspection — items 6-10, all on 7543.2001.
        "qc", "qc inspector", "qa qc", "quality control", "क्वालिटी", "inspection ka kaam",
        "quality check karna", "quality wala",
        // Maintenance — items 12-14, on 7233.0101, the code ruling A1 gives Maintenance Technician.
        "machine ki marammat", "machine repair", "breakdown maintenance", "plant maintenance",
        // Industrial electrician — items 17-19, on 7412.0200, which fam_industrial_electrician binds
        // since its pack shipped — so these five moved off the generic minor-741 pack in that
        // change, by design.
        "panel wiring", "industrial electrician", "इंडस्ट्रियल इलेक्ट्रीशियन", "panel electrician",
        "plant electrician",
        // Press — items 20 and 22.
        "power press", "stamping",
        // Assembly line — item 25.
        "assembly ka kaam",
      ].map((p) => [p, familyFor(p)]),
    );
    expect(routing).toEqual({
      "sheet metal": "fam_sheet_metal_fab",
      "शीट मेटल": "fam_sheet_metal_fab",
      "press brake": "fam_sheet_metal_fab",
      "laser cutting": "fam_sheet_metal_fab",
      "chadar ka kaam": "fam_sheet_metal_fab",
      fabricator: "fam_sheet_metal_fab",
      "fabrication ka kaam": "fam_sheet_metal_fab",
      qc: "fam_other_craft",
      "qc inspector": "fam_other_craft",
      "qa qc": "fam_other_craft",
      "quality control": "fam_other_craft",
      "क्वालिटी": "fam_other_craft",
      "inspection ka kaam": "fam_other_craft",
      "quality check karna": "fam_other_craft",
      "quality wala": "fam_other_craft",
      "machine ki marammat": "fam_fitting",
      "machine repair": "fam_fitting",
      "breakdown maintenance": "fam_fitting",
      "plant maintenance": "fam_fitting",
      "panel wiring": "fam_industrial_electrician",
      "industrial electrician": "fam_industrial_electrician",
      "इंडस्ट्रियल इलेक्ट्रीशियन": "fam_industrial_electrician",
      "panel electrician": "fam_industrial_electrician",
      "plant electrician": "fam_industrial_electrician",
      "power press": "fam_machining",
      stamping: "fam_machining",
      "assembly ka kaam": "fam_assembly",
    });
  });

  it("every accepted phrase lands on the exact code the ruling chose", () => {
    // The family table above cannot see a phrase landing on the WRONG CODE inside the right unit,
    // and the code is what a role family will bind. Pinned by code for exactly that reason.
    const codeFor = (p: string): string | null => resolveOccupation(occupationIndex, p)?.jobDomainId ?? null;
    for (const p of ["sheet metal", "press brake", "chadar ka kaam", "fabricator"]) {
      expect(codeFor(p), p).toBe("jd_nco_7213_0101");
    }
    for (const p of ["qc", "quality control", "inspection ka kaam", "quality wala"]) {
      expect(codeFor(p), p).toBe("jd_nco_7543_2001");
    }
    for (const p of ["machine ki marammat", "machine repair", "breakdown maintenance"]) {
      expect(codeFor(p), p).toBe("jd_nco_7233_0101");
    }
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
    // "assembly" would have taken it at span 0. The worksheet ruled it stays.
    expect(familyFor("assembly fitter")).toBe("fam_fitting");
    // Longer rows another trade already owned keep winning on longest-first.
    expect(familyFor("pipe fitting")).toBe("fam_plumbing");
    expect(familyFor("silai machine repair")).toBe("fam_fitting");
    expect(familyFor("mobile repair")).toBe("fam_electronics");
    expect(familyFor("gas cutting")).toBe("fam_welding_trade");
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
    //    2026-09-24: it is not a factory-trade phrase, and it lands on a generic pack, not a form.
    expect(familyFor("vehicle inspection")).toBe("fam_other_craft");
    // 2. THE THREE RETIREMENTS ARE STILL PENDING, so their misroutes stand. These go green-to-red
    //    — deliberately — in the PR that builds the retirement path:
    //    A4: every bare "machine …" still reaches dairy through the junk "Machine" alias,
    expect(familyFor("machine operator")).toBe("fam_animal_rearing");
    //    21: "press operator" is still the woollen-cloth press,
    expect(familyFor("press operator")).toBe("fam_textile_machines");
    //    A1: plain "fitter" is still on 7233.0101, the maintenance-fitter code.
    expect(resolveOccupation(occupationIndex, "fitter")?.jobDomainId).toBe("jd_nco_7233_0101");
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
    for (const p of ["dent remover", "tinsmith", "tin coater", "panel beater", "boilersmith"]) {
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
    for (const p of [
      "automation specialist", // 7412.0101 — process-control systems
      "fitter-electrical and electronic assembly", // 7412.0201 — panels and electronics
      "mechanical fitter", // 7412.0202 — the alias every mechanical fitter says
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
