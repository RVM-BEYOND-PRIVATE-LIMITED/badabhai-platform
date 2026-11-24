import { sql } from "drizzle-orm";
import { boolean, check, pgTable, text, timestamp } from "drizzle-orm/pg-core";

// ---------------------------------------------------------------------------
// trade_release — the per-trade release switch (#3002, migration 0198).
//
// Standing rule: everything ships switched off. 60 trades arrive in three waves, some held for a
// trade reviewer's sign-off, so each trade gets a switch the owner flips without a release. The
// migration seeds the 16 live posting kinds with `posting_enabled = true` (deploy-day behaviour is
// exactly today's); every other kind has no row and reads as off.
//
// `role_kind` names the same 63 declared kinds as the 0196/0197 CHECKs (CEO pack v2, #2999) — the
// list is spelled out here, not referenced, because a migration is a frozen record (the shape the
// `job_postings_role_kind_chk` model comment names).
//
// READ ONLY while the release readers exist; RLS forced, every role revoked (the migration's
// hand-written tail). No row is ever deleted: switching off is an UPDATE, so the table is the
// full history of who released what, when (via `updated_by` + `updated_at`).
// ---------------------------------------------------------------------------
export const tradeRelease = pgTable(
  "trade_release",
  {
    roleKind: text("role_kind").primaryKey(),
    postingEnabled: boolean("posting_enabled").notNull().default(false),
    formEnabled: boolean("form_enabled").notNull().default(false),
    updatedBy: text("updated_by"),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    check(
      "trade_release_role_kind_chk",
      sql`${t.roleKind} IN ('cnc_turner', 'vmc_milling', 'cnc_grinding', 'cam_programmer', 'cad_draughtsman', 'conventional_machinist', 'tool_die_maker', 'welder', 'sheet_metal_worker', 'press_operator', 'painter_coating', 'fitter', 'maintenance_technician', 'industrial_electrician', 'assembly_line_worker', 'quality_inspector', 'injection_moulding_operator', 'mould_die_maker', 'blow_moulding_operator', 'rubber_moulding_operator', 'plastic_process_technician', 'cad_designer_3d', 'plc_automation_technician', 'edm_wirecut_operator', 'heat_treatment_technician', 'production_supervisor', 'foundry_forging_operator', 'gear_cutting_operator', 'boring_machine_operator', 'spm_finishing_operator', 'cnc_router_operator', 'fabricator', 'tube_bending_operator', 'foundry_operator', 'die_casting_operator', 'forging_operator', 'plating_operator', 'plastic_extrusion_operator', 'cmm_operator', 'ndt_technician', 'calibration_technician', 'material_lab_technician', 'quality_engineer', 'robot_operator_programmer', 'instrumentation_technician', 'hvac_rac_technician', 'utility_operator', 'maintenance_engineer', 'service_engineer', 'production_engineer', 'process_engineer', 'npd_engineer', 'safety_officer', 'project_site_engineer', 'technical_sales_engineer', 'ppc_engineer', 'store_keeper', 'purchase_engineer', 'dispatch_logistics_executive', 'forklift_operator', 'crane_operator', 'cae_analyst', 'piping_designer')`,
    ),
  ],
).enableRLS(); // RLS tracked in the model; FORCE + four REVOKEs carried by the migration's tail

export type TradeReleaseRow = typeof tradeRelease.$inferSelect;
export type NewTradeReleaseRow = typeof tradeRelease.$inferInsert;
