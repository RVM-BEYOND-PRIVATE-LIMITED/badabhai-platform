/**
 * Which question-pack versions may be READ ALOUD (#3018).
 *
 * THE RULING. A CEO pack v2 sheet may go live for chips and typing before a practising worker or
 * trainer of the trade has signed its wording (#3029); only its VOICE is held. Devanagari twins
 * (`apps/api/src/profiling/question-tts-text.ts`) are written once, after sign-off, so an unsigned
 * form's lines have no twin and must not be read aloud by the phone's Hindi voice from the
 * romanized text.
 *
 * THE TABLE. One row per non-live catalogue form (the 44 of CEO pack v2): the highest version that
 * is voice ready. `0` means none yet (the 37 new trades, and T24's new form id); `1` means the
 * deepened form's live version 1 stays voice ready and its compiled version 2 waits for sign-off.
 * A form NOT in this table (the 16 live trades, the universal pack, every pre-catalogue form) is
 * voice ready at every version, as today.
 *
 * WHEN A SHEET IS SIGNED: write its twins, raise its row to the signed version, regenerate the
 * reply-closure golden. `question-tts-text.test.ts` then holds every string of that version to a
 * twin.
 */
export const VOICE_READY_THROUGH_VERSION: Readonly<Record<string, number>> = {
  qp_edm_wirecut: 1, // T17 deepened
  qp_cnc_router: 0, // T21 new
  qp_foundry_casting: 0, // T24 deepened, but a new form id: the live form is qp_foundry_forging
  qp_die_casting: 0, // T25 new
  qp_forging: 0, // T26 new
  qp_heat_treatment: 1, // T27 deepened
  qp_injection_moulding: 1, // T29 deepened
  qp_cmm: 0, // T33 new
  qp_quality_engineer: 0, // T37 new
  qp_plc_automation: 1, // T38 deepened
  qp_maintenance_engineer: 0, // T43 new
  qp_production_supervisor: 1, // T45 deepened
  qp_production_engineer: 0, // T46 new
  qp_process_engineer: 0, // T47 new
  qp_npd_engineer: 0, // T48 new
  qp_ppc: 0, // T52 new
  qp_purchase: 0, // T54 new
  qp_cad_design_3d: 1, // T58 deepened
  qp_gear_cutting: 0, // T18 new
  qp_boring_machine: 0, // T19 new
  qp_spm_finishing: 0, // T20 new
  qp_fabrication: 0, // T22 new
  qp_tube_forming: 0, // T23 new
  qp_surface_treatment: 0, // T28 new
  qp_blow_moulding: 0, // T30 new
  qp_plastic_extrusion: 0, // T31 new
  qp_rubber_moulding: 0, // T32 new
  qp_ndt: 0, // T34 new
  qp_calibration: 0, // T35 new
  qp_material_lab: 0, // T36 new
  qp_robotics: 0, // T39 new
  qp_instrumentation: 0, // T40 new
  qp_hvac_rac: 0, // T41 new
  qp_utility: 0, // T42 new
  qp_forklift: 0, // T56 new
  qp_crane_rigging: 0, // T57 new
  qp_service_engineer: 0, // T44 new
  qp_safety_ehs: 0, // T49 new
  qp_project_site: 0, // T50 new
  qp_technical_sales: 0, // T51 new
  qp_stores: 0, // T53 new
  qp_dispatch_logistics: 0, // T55 new
  qp_cae_fea: 0, // T59 new
  qp_piping_design: 0, // T60 new
};

/** Whether `packId@version` may be read aloud: true unless the table holds that version back. */
export function isPackVersionVoiceReady(packId: string, version: number): boolean {
  const through = VOICE_READY_THROUGH_VERSION[packId];
  return through === undefined || version <= through;
}
