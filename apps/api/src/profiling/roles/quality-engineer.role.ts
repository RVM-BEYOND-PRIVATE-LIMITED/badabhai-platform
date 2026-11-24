import type { RoleFormDescriptor } from "./role-form-descriptor";

/**
 * QUALITY ENGINEER (QA / QC / SQA) — quality engineering across the plant: incoming, line and
 * supplier quality, APQP/PPAP, and the MR's chair. The desk trade the QC inspector promotes to.
 *
 * DECLARED FOR CEO PACK v2 (#3004, sheet T37) AND FORMLESS: the first `engineering_desk` role, it
 * supplies the vocabulary its eleven desk siblings veto on, and its family (`fam_quality_engineer`)
 * is what the chat interview serves through retrieval once #3008 binds it.
 *
 * THE ENGINEER, NOT THE INSPECTOR. "QC inspector" and "quality checker" are the Quality
 * Inspector's words (production cluster); a pharma QA, a QC chemist and a software tester are
 * not this trade at all. The process engineer, the calibration lab and the met lab veto from
 * the cluster derivation.
 */
export const QUALITY_ENGINEER = {
  kind: "quality_engineer",
  packId: "qp_quality_engineer",
  familyId: "fam_quality_engineer",
  cluster: "engineering_desk",
  formEnabled: false,
  displayName: "Quality Engineer (QA / QC / SQA)",
  offerName: "quality engineer (QA / QC / SQA)",
  levelLadder: [
    "Trainee (GET / DET)",
    "Engineer",
    "Senior Engineer",
    "Lead / Asst. Manager",
    "Manager / HOD",
  ],
  tenureQuestionKey: "qe_experience",
  detection: {
    occupationTerms: [
      "quality engineer",
      "qa engineer",
      "qc engineer",
      "qa qc engineer",
      "sqa engineer",
      "supplier quality",
      "customer quality",
      "cqa engineer",
      "line quality engineer",
      "incoming quality engineer",
      "iqc engineer",
      "pdi engineer",
      "ppap engineer",
      "mr quality",
      "npd quality",
      "क्वालिटी इंजीनियर",
      "क्यूए इंजीनियर",
      "क्यूसी इंजीनियर",
    ],
    machineTerms: [
      // Sheet T37 "Words": the quality desk: assurance, control and systems. Corroborate a pin; never route alone.
      "quality assurance",
      "quality control",
      "apqp",
      "ppap",
    ],
    levelTerms: ["trainee", "engineer", "senior engineer", "lead", "supervisor"],
    /**
     * Cross-cluster and unmodeled rivals from the sheet's
     * "must NOT lead here" line — different clusters derive nothing.
     */
    extraConflictTerms: ["quality inspector", "tester"],
  },
} as const satisfies RoleFormDescriptor;
