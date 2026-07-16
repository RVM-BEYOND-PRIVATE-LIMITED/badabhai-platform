-- ADR-0032: worker profile photo — opaque Storage object-key pointer (nullable).
-- Additive + backward-compatible: no existing row changes, no default needed.
-- The photo BYTES live in the private WORKER_PHOTOS_BUCKET (Storage), never here.
--
-- Rollback (safe, pointer only — objects stay sweepable by `photos/{workerId}/` prefix):
--   ALTER TABLE "workers" DROP COLUMN "photo_storage_key";
ALTER TABLE "workers" ADD COLUMN "photo_storage_key" text;
