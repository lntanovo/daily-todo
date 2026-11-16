-- FoodLog adds isolated immutable backups; existing applications are untouched.
CREATE TABLE public.foodlog_backups (
    backup_id uuid PRIMARY KEY,
    owner_id text NOT NULL DEFAULT auth.uid(),
    created_at timestamptz NOT NULL DEFAULT now(),
    object_path text NOT NULL UNIQUE,
    sha256 text NOT NULL CHECK (sha256 ~ '^[0-9a-f]{64}$'),
    size_bytes bigint NOT NULL CHECK (size_bytes > 0 AND size_bytes <= 67108864),
    app_version text NOT NULL CHECK (length(app_version) BETWEEN 1 AND 40),
    schema_version integer NOT NULL CHECK (schema_version BETWEEN 1 AND 3),
    device_name text NOT NULL CHECK (length(device_name) BETWEEN 1 AND 80),
    dataset_id uuid NOT NULL,
    record_counts jsonb NOT NULL CHECK (jsonb_typeof(record_counts) = 'object'),
    first_date date,
    last_date date,
    client_revision bigint NOT NULL CHECK (client_revision >= 0),
    CHECK (object_path = owner_id || '/' || backup_id::text || '.foodlog.gz'),
    CHECK (first_date IS NULL OR last_date IS NULL OR first_date <= last_date)
);
CREATE INDEX foodlog_backups_owner_created_idx ON public.foodlog_backups (owner_id, created_at DESC, backup_id DESC);
REVOKE ALL ON public.foodlog_backups FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.foodlog_backups TO authenticated;
-- The server alone chooses ownership and creation time.
GRANT INSERT (backup_id, object_path, sha256, size_bytes, app_version, schema_version, device_name, dataset_id, record_counts, first_date, last_date, client_revision) ON public.foodlog_backups TO authenticated;
GRANT ALL ON public.foodlog_backups TO service_role;
ALTER TABLE public.foodlog_backups ENABLE ROW LEVEL SECURITY;
CREATE POLICY foodlog_backup_read ON public.foodlog_backups FOR SELECT TO authenticated USING (owner_id = auth.uid());
CREATE POLICY foodlog_backup_insert ON public.foodlog_backups FOR INSERT TO authenticated WITH CHECK (owner_id = auth.uid());
INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES ('foodlog-backups', 'foodlog-backups', false, 67108864, ARRAY['application/gzip']);
CREATE POLICY foodlog_backup_file_read ON storage.objects FOR SELECT TO authenticated
USING (bucket_id = 'foodlog-backups' AND (storage.foldername(name))[1] = auth.uid());
CREATE POLICY foodlog_backup_file_insert ON storage.objects FOR INSERT TO authenticated
WITH CHECK (bucket_id = 'foodlog-backups' AND (storage.foldername(name))[1] = auth.uid());