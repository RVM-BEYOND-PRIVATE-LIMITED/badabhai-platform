import type { RoleFormDescriptor } from "./role-form-descriptor";

/**
 * CNC ROUTER / ENGRAVING OPERATOR (ArtCAM) — routing and engraving wood, acrylic, ACP and
 * stone: ArtCAM toolpaths, jali cutting, and machine setting on gantry routers.
 *
 * DECLARED FOR CEO PACK v2 (#3004, sheet T21) AND FORMLESS, like SPM: it supplies the vocabulary
 * its `machining`-cluster siblings veto on, and its family (`fam_cnc_router`) is what the chat
 * interview serves through retrieval once #3008 binds it.
 *
 * THE ROUTER, NOT THE DESIGN DESK. Bare "designer" is the 3D CAD Designer's word, and a VMC
 * "CAM programmer" (Mastercam, NX) programs mills, not routers — but neither can be a veto
 * here: "designer" sits inside this role's own "artcam designer", and a veto on it would veto
 * the role itself. The bare word matches none of this role's terms, so it already keeps
 * talking; only the unambiguous cross-cluster rivals are listed.
 */
export const CNC_ROUTER_OPERATOR = {
  kind: "cnc_router_operator",
  packId: "qp_cnc_router",
  familyId: "fam_cnc_router",
  cluster: "machining",
  formEnabled: false,
  displayName: "CNC Router / Engraving Operator (ArtCAM)",
  offerName: "CNC router / engraving operator (ArtCAM)",
  levelLadder: ["Trainee", "Operator", "Setter", "Programmer", "Supervisor"],
  tenureQuestionKey: "router_experience",
  detection: {
    occupationTerms: [
      "cnc router operator",
      "engraving operator",
      "artcam operator",
      "artcam designer",
      "cnc wood carving",
      "सीएनसी राउटर",
      "आर्टकैम ऑपरेटर",
    ],
    machineTerms: [
      // Sheet T21 "Words": the router shop: routers, carving and engraving kit. Corroborate a pin; never route alone.
      "router machine",
      "wood router",
      "wood cnc",
      "carving machine",
      "engraving machine",
      "cnc engraving",
      "artcam",
      "art cam",
      "aspire software",
      "vcarve",
      "jdpaint",
      "mdf cutting",
      "acrylic cutting",
      "acp cutting",
      "stone cnc",
      "marble cnc",
      "die engraving",
      "laser engraving",
      "cnc rauter",
    ],
    levelTerms: ["trainee", "operator", "setter", "programmer", "supervisor"],
    /**
     * Cross-cluster and unmodeled rivals from the sheet's
     * "must NOT lead here" line — different clusters derive nothing.
     */
    extraConflictTerms: ["cam programmer", "carpenter", "laser cutting", "haath ki nakkashi"],
  },
} as const satisfies RoleFormDescriptor;
