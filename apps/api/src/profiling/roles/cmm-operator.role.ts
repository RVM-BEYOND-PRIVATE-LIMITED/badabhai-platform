import type { RoleFormDescriptor } from "./role-form-descriptor";

/**
 * CMM OPERATOR / PROGRAMMER — coordinate measuring: operating and programming the CMM, from
 * part setup and probing to the report the inspector reads.
 *
 * DECLARED FOR CEO PACK v2 (#3004, sheet T33) AND FORMLESS: the first `quality_lab` role, it
 * supplies the vocabulary its three lab siblings veto on, and its family (`fam_cmm`) is what
 * the chat interview serves through retrieval.
 *
 * THE CMM ROOM, NOT THE QC BAY. Bare "quality" is the Quality Inspector's question, "CNC
 * programming" the CAM Programmer's (design cluster) — both keep the worker talking. "cmm"
 * alone is too short to route (#3010 holds it) and corroborates the pin; so do the makes and
 * the software.
 */
export const CMM_OPERATOR = {
  kind: "cmm_operator",
  packId: "qp_cmm",
  familyId: "fam_cmm",
  cluster: "quality_lab",
  formEnabled: false,
  displayName: "CMM Operator / Programmer",
  offerName: "CMM operator / programmer",
  levelLadder: ["Trainee", "Operator", "Programmer", "Senior", "Supervisor"],
  tenureQuestionKey: "cmm_experience",
  detection: {
    occupationTerms: [
      "cmm operator",
      "cmm programmer",
      "cmm inspector",
      "cmm engineer",
      "सीएमएम ऑपरेटर",
      "सीएमएम प्रोग्रामर",
    ],
    machineTerms: [
      // Sheet T33 "Words": the CMM room: machines, software and probes. Corroborate a pin; never route alone.
      "cmm machine",
      "cmm room",
      "cmm ka kaam",
      "zeiss cmm",
      "calypso",
      "pc dmis",
      "pcdmis",
      "mcosmos",
      "mitutoyo cmm",
      "hexagon cmm",
      "accurate cmm",
      "faro arm",
      "cmm report",
      "cmm programming",
      "coordinate measuring machine",
    ],
    levelTerms: ["trainee", "operator", "programmer", "senior", "supervisor"],
    /**
     * Cross-cluster and unmodeled rivals from the sheet's
     * "must NOT lead here" line — different clusters derive nothing.
     */
    extraConflictTerms: ["quality", "cnc programming", "profile projector"],
  },
} as const satisfies RoleFormDescriptor;
