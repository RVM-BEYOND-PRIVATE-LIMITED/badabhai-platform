# Apply migrations 0196 and 0197 — trades v2 role kinds (#2999, #3003)

Two migrations widen the closed role-kind CHECK lists from 27 to 63 kinds. They are
**apply-before-deploy**: a new build on the old lists fails the first time a payer picks
a new role or a résumé-import summary writes one.

Run both files in one transaction per database. Both are additive DROP + ADD of
NULL-tolerant CHECKs; no column changes and no backfill. The scan is milliseconds on
these tables.

## Files to run, in order

1. `packages/db/migrations/0196_job_role_kind_trades_v2.sql`
   — `job_postings_role_kind_chk`, `jobs_role_kind_chk`
2. `packages/db/migrations/0197_wri_role_kind_trades_v2.sql`
   — `wri_association_kind_chk`, `wri_identity_role_kind_chk`

```sh
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 \
  -f packages/db/migrations/0196_job_role_kind_trades_v2.sql \
  -f packages/db/migrations/0197_wri_role_kind_trades_v2.sql
```

## Check queries

One per constraint. Each must list all 63 kinds and no other value. The expected count
is 63 on every row.

```sql
SELECT conname,
       array_length(regexp_split_to_array(pg_get_constraintdef(oid), ','), 1) AS listed_terms
FROM pg_constraint
WHERE conname IN (
  'job_postings_role_kind_chk',
  'jobs_role_kind_chk',
  'wri_association_kind_chk',
  'wri_identity_role_kind_chk'
)
ORDER BY conname;
```

Spot-check that the last appended kind is present:

```sql
SELECT conname, pg_get_constraintdef(oid)
FROM pg_constraint
WHERE conname IN (
  'job_postings_role_kind_chk',
  'jobs_role_kind_chk',
  'wri_association_kind_chk',
  'wri_identity_role_kind_chk'
)
AND pg_get_constraintdef(oid) LIKE '%''piping_designer''%';
```

Expect four rows.

## Rollback

A code rollback needs no schema change. A schema rollback is safe only after the code
naming the new kinds is rolled back and no row stores one of the 36 new kinds:

```sql
SELECT
  (SELECT count(*) FROM job_postings WHERE role_kind IN (
    'gear_cutting_operator','boring_machine_operator','spm_finishing_operator','cnc_router_operator',
    'fabricator','tube_bending_operator','foundry_operator','die_casting_operator','forging_operator',
    'plating_operator','plastic_extrusion_operator','cmm_operator','ndt_technician',
    'calibration_technician','material_lab_technician','quality_engineer',
    'robot_operator_programmer','instrumentation_technician','hvac_rac_technician','utility_operator',
    'maintenance_engineer','service_engineer','production_engineer','process_engineer','npd_engineer',
    'safety_officer','project_site_engineer','technical_sales_engineer','ppc_engineer','store_keeper',
    'purchase_engineer','dispatch_logistics_executive','forklift_operator','crane_operator',
    'cae_analyst','piping_designer'))
+ (SELECT count(*) FROM jobs WHERE role_kind IN (
    'gear_cutting_operator','boring_machine_operator','spm_finishing_operator','cnc_router_operator',
    'fabricator','tube_bending_operator','foundry_operator','die_casting_operator','forging_operator',
    'plating_operator','plastic_extrusion_operator','cmm_operator','ndt_technician',
    'calibration_technician','material_lab_technician','quality_engineer',
    'robot_operator_programmer','instrumentation_technician','hvac_rac_technician','utility_operator',
    'maintenance_engineer','service_engineer','production_engineer','process_engineer','npd_engineer',
    'safety_officer','project_site_engineer','technical_sales_engineer','ppc_engineer','store_keeper',
    'purchase_engineer','dispatch_logistics_executive','forklift_operator','crane_operator',
    'cae_analyst','piping_designer'))
+ (SELECT count(*) FROM worker_resume_import WHERE association_kind IN (
    'gear_cutting_operator','boring_machine_operator','spm_finishing_operator','cnc_router_operator',
    'fabricator','tube_bending_operator','foundry_operator','die_casting_operator','forging_operator',
    'plating_operator','plastic_extrusion_operator','cmm_operator','ndt_technician',
    'calibration_technician','material_lab_technician','quality_engineer',
    'robot_operator_programmer','instrumentation_technician','hvac_rac_technician','utility_operator',
    'maintenance_engineer','service_engineer','production_engineer','process_engineer','npd_engineer',
    'safety_officer','project_site_engineer','technical_sales_engineer','ppc_engineer','store_keeper',
    'purchase_engineer','dispatch_logistics_executive','forklift_operator','crane_operator',
    'cae_analyst','piping_designer'))
+ (SELECT count(*) FROM worker_resume_import WHERE identity_role_kind IN (
    'gear_cutting_operator','boring_machine_operator','spm_finishing_operator','cnc_router_operator',
    'fabricator','tube_bending_operator','foundry_operator','die_casting_operator','forging_operator',
    'plating_operator','plastic_extrusion_operator','cmm_operator','ndt_technician',
    'calibration_technician','material_lab_technician','quality_engineer',
    'robot_operator_programmer','instrumentation_technician','hvac_rac_technician','utility_operator',
    'maintenance_engineer','service_engineer','production_engineer','process_engineer','npd_engineer',
    'safety_officer','project_site_engineer','technical_sales_engineer','ppc_engineer','store_keeper',
    'purchase_engineer','dispatch_logistics_executive','forklift_operator','crane_operator',
    'cae_analyst','piping_designer'));   -- expect 0
```

Then re-run the 0151 and 0152 DROP + ADD pairs to restore the 27-kind lists.
