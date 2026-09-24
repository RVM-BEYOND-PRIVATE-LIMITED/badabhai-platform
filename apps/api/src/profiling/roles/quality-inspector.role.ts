import type { RoleFormDescriptor } from "./role-form-descriptor";

/**
 * QUALITY INSPECTOR / QC — CMM, profile projector, gauges, GD&T, PPAP and SPC documentation.
 *
 * DECLARED IN BATCH 2, SHIPPED IN PART TWO once the 2026-09-24 alias tranche made its words
 * reachable — "qc", "quality control" and "क्वालिटी" were NO MATCH before it (see the UPDATE note
 * at the end of this header).
 *
 * ═══ THE ONE ROLE IN THE PROGRAMME WHOSE VOCABULARY IS EVERY OTHER ROLE'S ═══
 *
 * Its instrument row — vernier, micrometer, height gauge, dial gauge, surface roughness tester — is
 * a subset of the machining pages almost word for word, and "Reads 2D drawings and GD&T" is on
 * eight reference sheets. That is a routing hazard rather than a curiosity: a measuring instrument
 * is something every skilled trade in this registry touches, so NOT ONE of them is a machine term
 * here. If "micrometer" corroborated this role, every turner who listed his instruments would be
 * pulled toward an inspection form.
 *
 * What is left is what only an inspector says: the CMM and the profile projector (instruments
 * nobody else on these pages owns), the standards, and the documents. `IATF 16949`, `PPAP` and
 * `8D` are not tools — they are the paperwork the job IS, and a man who names one is claiming the
 * trade.
 *
 * ═══ `production`, WITH THE ASSEMBLY LINE ═══
 *
 * See `assembly-line-worker.role.ts` for the argument. In short: both work on the line rather than
 * at a machine, both do first-off and patrol checking, and a cluster of one derives no veto at all.
 *
 * ═══ "inspector" IS THE FIRST RUNG OF THE LADDER AND ALSO A SECURITY GUARD'S TITLE ═══
 *
 * The taxonomy ladder is "Inspector → QC Engineer", so the bare word is a rung and lives with the
 * rungs. It is also what a man in `fam_protective_service` calls himself, so keeping it out of
 * `occupationTerms` avoids handing a plant guard a CMM form.
 *
 * ⚠ THIS PARAGRAPH USED TO CLAIM THE EXCLUSION "COSTS NOTHING — quality inspector, qc and quality
 * control all route". THAT WAS FALSE, and it was written without measuring. Resolved through the
 * production chain (`buildOccupationIndex` → `resolveOccupation` → `resolveFamily`):
 *
 *   "quality inspector"  → jd_isco_7543        → fam_other_craft
 *   "quality control"    → NO MATCH
 *   "qc"                 → NO MATCH
 *   "क्वालिटी"            → NO MATCH
 *
 * So the exclusion costs nothing only because NOTHING here routes yet. This role is one of the
 * seven in Batch 2 that binding alone cannot reach: the words are absent from the alias corpus,
 * and `rvm-aliases.jsonl` is ratified vernacular rather than something to invent. The form stays
 * disabled until that tranche ships — and the correction is recorded rather than quietly deleted,
 * because a confident unmeasured claim in a doc comment is what the next author would have built on.
 *
 * UPDATE 2026-09-24 — the tranche shipped (worksheet Part 5, items 6-10). "qc", "quality control",
 * "क्वालिटी" and the rest now reach jd_nco_7543_2001, and THE FORM NOW SHIPS (Batch 2 part two):
 * `fam_quality_inspection` binds that code and 7311.0500 "Viewer, Workshop / Examiner, Metal
 * Working", with `qp_quality_inspection@1` behind it, so those phrases get this pack instead of
 * `fam_other_craft`'s generic questions. Pinned in `packages/db/src/question-pack-reachability.test.ts`.
 *
 * ⚠ THE EXACT PHRASE "quality inspector" IS STILL NOT THIS FAMILY'S, and that is a known gap, not an
 * oversight. Its only alias row is on the ISCO node jd_isco_7543, which is deliberately unbound (it
 * carries wool classer, cloth examiner and product grader), so offline it resolves to
 * `fam_other_craft`. In production that node's aliases are SHADOWED — 7543 has selectable NCO
 * children (F4, `alias-lifecycle.ts`) — so the row is not searchable there at all. Moving the phrase
 * onto 7543.2001 is an alias change and needs an owner ruling. The occupation term below still
 * routes a worker whose LABEL says it, which is why the term stays.
 */
export const QUALITY_INSPECTOR = {
  kind: "quality_inspector",
  packId: "qp_quality_inspection",
  familyId: "fam_quality_inspection",
  cluster: "production",
  formEnabled: true,
  displayName: "Quality Inspector / QC",
  offerName: "quality inspector",
  levelLadder: ["Inspector", "QC Engineer"],
  tenureQuestionKey: "inspection_experience",
  fresher: {
    // KEYED BY STORED `value_text`, read off `iti_workshop_machines` in qp_quality_inspection@1.
    // There is no ITI inspection trade: a QC fresher trained as a machinist, turner or fitter, so
    // these are that workshop's machines — plus the surface plate, the one station in it that is
    // inspection work.
    workshopMachines: {
      conventional_lathe: "Conventional lathe",
      milling: "Milling machine",
      drilling_machine: "Drilling machine",
      grinder: "Grinding machine",
      surface_plate: "Surface plate marking & measurement",
    },
    tradeTest: {
      passed: "Trade test passed",
      appeared: "Trade test taken, result awaited",
    },
    /**
     * "ITI workshop training" WOULD STATE A CREDENTIAL A LARGE PART OF THIS SUPPLY HAS NOT GOT. The
     * ratified page's own worker is a DIPLOMA holder (Mechanical, State Board), and a polytechnic
     * pass-out who answers the workshop question has trained in a workshop, not at an ITI. The
     * CAD draughtsman's `trainingLabel` is the precedent; "Workshop training" is true of both.
     */
    trainingLabel: "Workshop training",
  },
  /**
   * AUTOCOMPLETE, NOT A CLOSED SET. The ratified page carries two credentials — "Diploma in
   * Mechanical Engineering" and "Internal Auditor — IATF 16949" — and both lead the list; the rest
   * are what a machine-shop QC department asks about.
   */
  suggestedCertificates: [
    "Internal Auditor — IATF 16949",
    "Diploma in Mechanical Engineering",
    "Internal Auditor — ISO 9001",
    "Core Tools — APQP, PPAP, FMEA, MSA, SPC",
    "CMM Operation & Programming",
    "GD&T",
    "Six Sigma Green Belt",
  ],
  detection: {
    occupationTerms: [
      "quality inspector",
      "quality control",
      "qc",
      "qa qc",
      "quality engineer",
      "क्वालिटी",
    ],
    /**
     * DELIBERATELY NARROW. A vernier or a micrometer is on every machining page in the corpus and
     * must never corroborate this role — see the header. Only instruments and documents that
     * belong to inspection alone are listed.
     */
    machineTerms: [
      "cmm",
      "profile projector",
      "iatf",
      "ppap",
      "spc",
      "gauge r and r",
      "layout inspection",
      "control plan",
    ],
    levelTerms: ["inspector", "qc engineer", "इंस्पेक्टर"],
    /**
     * THE QC LINES THIS FORM DOES NOT SERVE — the field's second kind of extra conflict, a
     * competing trade we do not model. Bare "qc" is ratified onto the machine-shop code and is
     * this role's own occupation term, so a garment checker or a pharma QC chemist who says it
     * would be handed a CMM form. The 2026-09-24 guard aliases in `rvm-aliases.jsonl` move those
     * phrases' FAMILY off `fam_quality_inspection` — but they also become their target codes'
     * chip labels ("garment qc", "pharma qc"), and a pinned label is routing evidence that still
     * contains "qc". These four words are what keep that worker talking instead; without them the
     * guard rows would have moved the family and left the form handover exactly where it was.
     */
    extraConflictTerms: ["garment", "sewing", "pharma", "chemist"],
  },
} as const satisfies RoleFormDescriptor;
