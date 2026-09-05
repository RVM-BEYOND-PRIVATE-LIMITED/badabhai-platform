import type { RoleFormDescriptor } from "./role-form-descriptor";

/**
 * QUALITY INSPECTOR / QC — CMM, profile projector, gauges, GD&T, PPAP and SPC documentation.
 *
 * DECLARED IN BATCH 2, form to follow.
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
 * rungs. It is also what a man in `fam_protective_service` calls himself. Keeping it out of
 * `occupationTerms` costs nothing — "quality inspector", "qc" and "quality control" all route —
 * and avoids handing a plant guard a CMM form.
 */
export const QUALITY_INSPECTOR = {
  kind: "quality_inspector",
  packId: "qp_quality_inspection",
  familyId: "fam_quality_inspection",
  cluster: "production",
  formEnabled: false,
  displayName: "Quality Inspector / QC",
  offerName: "quality inspector",
  levelLadder: ["Inspector", "QC Engineer"],
  tenureQuestionKey: "inspection_experience",
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
  },
} as const satisfies RoleFormDescriptor;
