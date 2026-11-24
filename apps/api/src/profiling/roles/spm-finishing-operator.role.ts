import type { RoleFormDescriptor } from "./role-form-descriptor";

/**
 * HONING / BROACHING / SPM OPERATOR — honing, broaching, lapping and special-purpose finishing:
 * bore finish, keyways, gun-drilled holes and rolled threads, on dedicated machines.
 *
 * DECLARED FOR CEO PACK v2 (#3004, sheet T20) AND FORMLESS, like boring: it supplies the
 * vocabulary its `machining`-cluster siblings veto on, and its family (`fam_spm_finishing`)
 * is what the chat interview serves through retrieval.
 *
 * THE FINISHING MACHINE, NOT EVERY SPM. A welding SPM is the Welder's line and an assembly SPM
 * the Assembly Line Worker's — different clusters, so the veto is authored here. "SPM" alone
 * is never a term: the sheet makes the operator name which SPM first.
 */
export const SPM_FINISHING_OPERATOR = {
  kind: "spm_finishing_operator",
  packId: "qp_spm_finishing",
  familyId: "fam_spm_finishing",
  cluster: "machining",
  formEnabled: false,
  displayName: "Honing / Broaching / SPM Operator",
  offerName: "honing / broaching / spm operator",
  levelLadder: ["Trainee", "Operator", "Setter", "Senior", "Supervisor"],
  tenureQuestionKey: "spm_experience",
  detection: {
    occupationTerms: [
      "honing operator",
      "broaching operator",
      "spm operator",
      "lapping operator",
      "honing ka kaam",
      "broaching ka kaam",
      "होनिंग ऑपरेटर",
      "ब्रोचिंग ऑपरेटर",
    ],
    machineTerms: [
      // Sheet T20 "Words": the finishing machines: honing, broaching and SPMs. Corroborate a pin; never route alone.
      "honing machine",
      "broaching machine",
      "broach machine",
      "lapping machine",
      "superfinishing",
      "super finish machine",
      "gun drilling",
      "gun drill machine",
      "deep hole drilling",
      "thread rolling",
      "thread rolling machine",
      "special purpose machine",
      "facing centring machine",
      "multi spindle drilling",
      "vertical honing",
      "horizontal honing",
      "liner honing",
      "keyway broaching",
    ],
    levelTerms: ["trainee", "operator", "setter", "senior", "supervisor"],
    /**
     * Cross-cluster and unmodeled rivals from the sheet's
     * "must NOT lead here" line — different clusters derive nothing.
     */
    extraConflictTerms: ["welding spm", "assembly spm", "engine honing", "buffing"],
  },
} as const satisfies RoleFormDescriptor;
