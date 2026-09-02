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
    for (const phrase of ["fusion welding", "fusion welder", "fusion weld", "seam fusion welder"]) {
      expect(familyFor(phrase), `"${phrase}" left the welding trade`).toBe("fam_welding");
    }
    expect(familyFor("fusion cutting")).toBe("fam_welding");
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
    for (const phrase of [...CAM_PHRASES, ...CAD_PHRASES, ...DRAUGHTING_PHRASES]) {
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
    expect(familyFor("machinist")).toBe("fam_machining");
  });
});
