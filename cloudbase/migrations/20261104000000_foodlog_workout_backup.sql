-- Allow full-backup v4 (exercise definitions + per-set workout snapshots).
-- record_counts is already a JSON object without a fixed-key constraint.
-- Ownership, RLS, storage policies and all existing rows remain unchanged.
BEGIN;
ALTER TABLE public.foodlog_backups DROP CONSTRAINT foodlog_backups_schema_version_check;
ALTER TABLE public.foodlog_backups ADD CONSTRAINT foodlog_backups_schema_version_check
    CHECK (schema_version BETWEEN 1 AND 4);
COMMIT;