-- Compatibility cleanup for a live Supabase drift seen before the current `payers`
-- schema became the source of truth. Some environments still have a legacy
-- `payer_type` column (`employer` | `agency`) that is NOT NULL but is no longer
-- written by the app, which breaks payer signup before OTP delivery.
--
-- Keep this idempotent so normal local databases, where the column never existed,
-- migrate cleanly. The legacy column is intentionally not dropped here; we only stop
-- it from blocking current inserts.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'payers'
      AND column_name = 'payer_type'
  ) THEN
    ALTER TABLE "payers" ALTER COLUMN "payer_type" DROP NOT NULL;
  END IF;
END $$;
