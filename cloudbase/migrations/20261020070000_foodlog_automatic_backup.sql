-- Serialize every FoodLog manifest insert; existing immutable backup rows are retained.
CREATE FUNCTION public.foodlog_serialize_backup_insert() RETURNS trigger
LANGUAGE plpgsql SECURITY INVOKER SET search_path = public, pg_temp AS $$
DECLARE latest_time timestamptz;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended('foodlog:' || NEW.owner_id, 0));
  SELECT created_at INTO latest_time FROM public.foodlog_backups
    WHERE owner_id = NEW.owner_id ORDER BY created_at DESC, backup_id DESC LIMIT 1;
  NEW.created_at := greatest(clock_timestamp(), coalesce(latest_time + interval '1 microsecond', '-infinity'::timestamptz));
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION public.foodlog_serialize_backup_insert() FROM PUBLIC;
CREATE TRIGGER foodlog_serialize_backup_insert BEFORE INSERT ON public.foodlog_backups
  FOR EACH ROW EXECUTE FUNCTION public.foodlog_serialize_backup_insert();
-- Compare-and-append in one transaction. A stale device cannot advance the cloud head.
CREATE FUNCTION public.foodlog_commit_backup(payload jsonb, expected_head uuid) RETURNS jsonb
LANGUAGE plpgsql SECURITY INVOKER SET search_path = public, pg_temp AS $$
DECLARE caller text := auth.uid(); head uuid; saved public.foodlog_backups;
BEGIN
  IF caller IS NULL OR caller = '' THEN RAISE EXCEPTION 'Authentication required'; END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('foodlog:' || caller, 0));
  SELECT * INTO saved FROM public.foodlog_backups
    WHERE owner_id = caller AND backup_id = (payload->>'backup_id')::uuid;
  IF FOUND THEN RETURN jsonb_build_object('status', 'saved', 'record', to_jsonb(saved)); END IF;
  SELECT backup_id INTO head FROM public.foodlog_backups
    WHERE owner_id = caller ORDER BY created_at DESC, backup_id DESC LIMIT 1;
  IF head IS DISTINCT FROM expected_head THEN
    RETURN jsonb_build_object('status', 'conflict', 'head', head);
  END IF;
  INSERT INTO public.foodlog_backups
    (backup_id, object_path, sha256, size_bytes, app_version, schema_version, device_name,
     dataset_id, record_counts, first_date, last_date, client_revision)
  VALUES
    ((payload->>'backup_id')::uuid, payload->>'object_path', payload->>'sha256',
     (payload->>'size_bytes')::bigint, payload->>'app_version', (payload->>'schema_version')::integer,
     payload->>'device_name', (payload->>'dataset_id')::uuid, payload->'record_counts',
     (payload->>'first_date')::date, (payload->>'last_date')::date, (payload->>'client_revision')::bigint)
  RETURNING * INTO saved;
  RETURN jsonb_build_object('status', 'saved', 'record', to_jsonb(saved));
END;
$$;
REVOKE ALL ON FUNCTION public.foodlog_commit_backup(jsonb, uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.foodlog_commit_backup(jsonb, uuid) TO authenticated;