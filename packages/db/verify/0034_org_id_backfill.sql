-- =====================================================================================
-- Verify: ADR-0027 B5.x Increment 0 org_id backfill (migration 0034).
--
-- Pure-SQL assertion — RAISEs (aborts, non-zero exit) on the FIRST violation, prints
-- 'OK' at the end otherwise. Read-only (no writes). Run against a DB that has 0034
-- applied:
--
--     psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f verify/0034_org_id_backfill.sql
--
-- Or via the package script:  pnpm --filter @badabhai/db db:verify:org-id
--
-- Asserts:
--   (a) ZERO NULL org_id on the 7 NOT-NULL tables.
--   (b) every org_id = payer_orgs.id WHERE root_payer_id = payer_id (backfill correct),
--       AND, on the 2 nullable-payer tables, a NULL payer_id row has NULL org_id and a
--       NON-NULL payer_id row has a correct org_id (the partial-CHECK invariant).
--   (c) org-scoped uniqueness holds: no duplicate (org_id, worker_id) in unlocks and no
--       duplicate (org_id, worker_id, job_posting_id) in resume_disclosures.
-- =====================================================================================

DO $$
DECLARE
  bad bigint;
  t   text;
  seven text[] := ARRAY[
    'unlocks','payer_credits','credit_ledger','posting_plans',
    'posting_boosts','payer_capacity','resume_disclosures'
  ];
BEGIN
  -- (a) ZERO NULL org_id on each of the 7 NOT-NULL tables.
  FOREACH t IN ARRAY seven LOOP
    EXECUTE format('SELECT count(*) FROM %I WHERE org_id IS NULL', t) INTO bad;
    IF bad <> 0 THEN
      RAISE EXCEPTION '(a) FAIL: % has % NULL org_id row(s) (expected 0)', t, bad;
    END IF;
  END LOOP;

  -- (b) Every org_id resolves to the payer's solo org, on ALL 9 tables. A mismatch is a
  --     row whose (payer_id, org_id) is not the (root_payer_id, id) of some payer_orgs
  --     row. NULL payer_id rows (job_postings/jobs ops+seed) are exempt via the LEFT JOIN
  --     shape below: they must have NULL org_id (checked separately by the CHECK + (c)).
  FOR t IN SELECT unnest(seven || ARRAY['job_postings','jobs']) LOOP
    EXECUTE format($q$
      SELECT count(*) FROM %I x
      WHERE x.payer_id IS NOT NULL
        AND NOT EXISTS (
          SELECT 1 FROM payer_orgs po
          WHERE po.root_payer_id = x.payer_id AND po.id = x.org_id
        )
    $q$, t) INTO bad;
    IF bad <> 0 THEN
      RAISE EXCEPTION '(b) FAIL: % has % row(s) whose org_id != payer_orgs.id for its payer_id', t, bad;
    END IF;
  END LOOP;

  -- (b') The 2 nullable-payer tables: a NULL payer_id row MUST have NULL org_id (the
  --      org_id_when_payer CHECK guarantees the reverse; this guards the backfill did not
  --      stamp an org onto an ops/seed row).
  FOR t IN SELECT unnest(ARRAY['job_postings','jobs']) LOOP
    EXECUTE format('SELECT count(*) FROM %I WHERE payer_id IS NULL AND org_id IS NOT NULL', t) INTO bad;
    IF bad <> 0 THEN
      RAISE EXCEPTION '(b'') FAIL: % has % NULL-payer row(s) with a non-NULL org_id', t, bad;
    END IF;
  END LOOP;

  -- (c) Org-scoped uniqueness: unlocks (org_id, worker_id).
  SELECT count(*) INTO bad FROM (
    SELECT 1 FROM unlocks GROUP BY org_id, worker_id HAVING count(*) > 1
  ) d;
  IF bad <> 0 THEN
    RAISE EXCEPTION '(c) FAIL: unlocks has % duplicate (org_id, worker_id) group(s)', bad;
  END IF;

  -- (c) Org-scoped uniqueness: resume_disclosures (org_id, worker_id, job_posting_id).
  SELECT count(*) INTO bad FROM (
    SELECT 1 FROM resume_disclosures GROUP BY org_id, worker_id, job_posting_id HAVING count(*) > 1
  ) d;
  IF bad <> 0 THEN
    RAISE EXCEPTION '(c) FAIL: resume_disclosures has % duplicate (org_id, worker_id, job_posting_id) group(s)', bad;
  END IF;

  RAISE NOTICE 'verify:0034 PASS — org_id backfill correct, NOT-NULL holds, org-scoped uniqueness holds.';
END $$;
