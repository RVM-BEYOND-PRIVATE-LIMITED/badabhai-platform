import type { RoleFormDescriptor } from "./role-form-descriptor";

/**
 * PROCESS / MANUFACTURING ENGINEER — process engineering: the line's method arm — PFMEA, control
 * plans, time study and layout, the paper a line runs on.
 *
 * DECLARED FOR CEO PACK v2 (#3004, sheet T47) AND FORMLESS, like the production desk: it supplies
 * the vocabulary its desk siblings veto on, and its family (`fam_process_engineer`) is what the
 * chat interview serves through retrieval once #3008 binds it.
 *
 * THE METHOD, NOT THE MODEL. Fixture and tool design are the 3D CAD Designer's desk (design
 * cluster); CNC programming the CAM Programmer's. "npd" is too short to route (#3010 holds
 * it) but long enough to veto with; chemical process work is not this trade at all. The
 * production engineer and the NPD desk veto from the cluster derivation.
 */
export const PROCESS_ENGINEER = {
  kind: "process_engineer",
  packId: "qp_process_engineer",
  familyId: "fam_process_engineer",
  cluster: "engineering_desk",
  formEnabled: false,
  displayName: "Process / Manufacturing Engineer",
  offerName: "process / manufacturing engineer",
  levelLadder: [
    "Trainee (GET / DET)",
    "Engineer",
    "Senior Engineer",
    "Lead / Asst. Manager",
    "Manager / HOD",
  ],
  tenureQuestionKey: "proc_experience",
  detection: {
    occupationTerms: [
      "process engineer",
      "manufacturing engineer",
      "me engineer",
      "mfg engineer",
      "industrial engineer",
      "ie engineer",
      "methods engineer",
      "production engineering department",
      "pe department",
      "process planning engineer",
      "tooling engineer",
      "time study engineer",
      "layout planning engineer",
      "lean engineer",
      "cost reduction engineer",
      "vave engineer",
      "new line setup",
      "प्रोसेस इंजीनियर",
      "मैन्युफैक्चरिंग इंजीनियर",
    ],
    machineTerms: [
      // Sheet T47 "Words": the process desk: PFMEA, time study and layout. Corroborate a pin; never route alone.
      "pfmea",
      "control plan",
      "time study",
      "line balancing",
    ],
    levelTerms: ["trainee", "engineer", "senior engineer", "lead", "supervisor"],
    /**
     * Cross-cluster and unmodeled rivals from the sheet's
     * "must NOT lead here" line — different clusters derive nothing.
     */
    extraConflictTerms: [
      "fixture design",
      "tool design",
      "npd",
      "chemical process",
      "cnc programming",
    ],
  },
  fresher: {
    workshopMachines: {
      internship: "Internship",
      apprenticeship: "Apprenticeship (NATS / NAPS)",
      vocational_training: "Vocational training in plant",
      college_project: "College major project",
      industrial_visit: "Industrial visit",
    },
    // The pack asks no trade-test question, so no status ever maps here.
    tradeTest: {},
    trainingLabel: "Training and projects",
  },
} as const satisfies RoleFormDescriptor;
