-- Atomic, merge-only backup restoration. Invoker privileges and table RLS apply.
CREATE FUNCTION public.restore_todo_backup_v1(p_data JSONB)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog, public
AS $$
DECLARE
  item JSONB;
  inserted INTEGER := 0;
  affected INTEGER;
  current_uid TEXT := auth.uid();
BEGIN
  IF current_uid IS NULL OR auth.role() <> 'authenticated' THEN
    RAISE EXCEPTION 'A signed-in account is required';
  END IF;
  IF jsonb_typeof(p_data) IS DISTINCT FROM 'object' THEN
    RAISE EXCEPTION 'Invalid backup payload';
  END IF;

  FOR item IN SELECT value FROM jsonb_array_elements(COALESCE(p_data->'todo_tasks', '[]'::JSONB)) LOOP
    INSERT INTO public.todo_tasks (
      owner_id, id, title, type, task_date, start_date, end_date,
      priority, start_time, end_time, deleted_at, created_at, updated_at
    ) VALUES (
      current_uid, item->>'id', item->>'title', item->>'type',
      (item->>'task_date')::DATE, (item->>'start_date')::DATE, (item->>'end_date')::DATE,
      COALESCE(item->>'priority', 'normal'), (item->>'start_time')::TIME,
      (item->>'end_time')::TIME, (item->>'deleted_at')::TIMESTAMPTZ,
      COALESCE((item->>'created_at')::TIMESTAMPTZ, now()),
      COALESCE((item->>'updated_at')::TIMESTAMPTZ, now())
    ) ON CONFLICT (owner_id, id) DO NOTHING;
    GET DIAGNOSTICS affected = ROW_COUNT; inserted := inserted + affected;
  END LOOP;

  FOR item IN SELECT value FROM jsonb_array_elements(COALESCE(p_data->'todo_task_recurrences', '[]'::JSONB)) LOOP
    INSERT INTO public.todo_task_recurrences (
      owner_id, task_id, frequency, weekdays, month_day, start_date, end_date,
      created_at, updated_at
    ) VALUES (
      current_uid, item->>'task_id', item->>'frequency',
      CASE WHEN item->'weekdays' IS NULL OR item->'weekdays' = 'null'::JSONB
        THEN NULL ELSE ARRAY(SELECT jsonb_array_elements_text(item->'weekdays')::SMALLINT) END,
      (item->>'month_day')::SMALLINT, (item->>'start_date')::DATE,
      (item->>'end_date')::DATE,
      COALESCE((item->>'created_at')::TIMESTAMPTZ, now()),
      COALESCE((item->>'updated_at')::TIMESTAMPTZ, now())
    ) ON CONFLICT (owner_id, task_id) DO NOTHING;
    GET DIAGNOSTICS affected = ROW_COUNT; inserted := inserted + affected;
  END LOOP;

  FOR item IN SELECT value FROM jsonb_array_elements(COALESCE(p_data->'todo_daily_notes', '[]'::JSONB)) LOOP
    INSERT INTO public.todo_daily_notes (owner_id, task_id, note_date, content, updated_at)
    VALUES (current_uid, item->>'task_id', (item->>'note_date')::DATE,
      item->>'content', COALESCE((item->>'updated_at')::TIMESTAMPTZ, now()))
    ON CONFLICT (owner_id, task_id, note_date) DO NOTHING;
    GET DIAGNOSTICS affected = ROW_COUNT; inserted := inserted + affected;
  END LOOP;

  FOR item IN SELECT value FROM jsonb_array_elements(COALESCE(p_data->'todo_daily_completions', '[]'::JSONB)) LOOP
    INSERT INTO public.todo_daily_completions (owner_id, task_id, completion_date, completed, updated_at)
    VALUES (current_uid, item->>'task_id', (item->>'completion_date')::DATE,
      COALESCE((item->>'completed')::BOOLEAN, true),
      COALESCE((item->>'updated_at')::TIMESTAMPTZ, now()))
    ON CONFLICT (owner_id, task_id, completion_date) DO NOTHING;
    GET DIAGNOSTICS affected = ROW_COUNT; inserted := inserted + affected;
  END LOOP;

  FOR item IN SELECT value FROM jsonb_array_elements(COALESCE(p_data->'todo_completion_history', '[]'::JSONB)) LOOP
    INSERT INTO public.todo_completion_history (
      owner_id, task_id, task_title_snapshot, completion_date,
      is_active, completed_at, updated_at
    ) VALUES (
      current_uid, item->>'task_id', item->>'task_title_snapshot',
      (item->>'completion_date')::DATE,
      COALESCE((item->>'is_active')::BOOLEAN, false),
      COALESCE((item->>'completed_at')::TIMESTAMPTZ, now()),
      COALESCE((item->>'updated_at')::TIMESTAMPTZ, now())
    ) ON CONFLICT (owner_id, task_id, completion_date) DO NOTHING;
    GET DIAGNOSTICS affected = ROW_COUNT; inserted := inserted + affected;
  END LOOP;

  FOR item IN SELECT value FROM jsonb_array_elements(COALESCE(p_data->'todo_focus_sessions', '[]'::JSONB)) LOOP
    INSERT INTO public.todo_focus_sessions (
      owner_id, id, phase, status, planned_seconds, elapsed_seconds,
      task_id, task_title_snapshot, started_at, running_since, deadline_at,
      ended_at, segments, revision, created_at, updated_at
    ) VALUES (
      current_uid, item->>'id', item->>'phase', item->>'status',
      (item->>'planned_seconds')::INTEGER, COALESCE((item->>'elapsed_seconds')::INTEGER, 0),
      item->>'task_id', item->>'task_title_snapshot',
      (item->>'started_at')::TIMESTAMPTZ, (item->>'running_since')::TIMESTAMPTZ,
      (item->>'deadline_at')::TIMESTAMPTZ, (item->>'ended_at')::TIMESTAMPTZ,
      COALESCE(item->'segments', '[]'::JSONB),
      COALESCE((item->>'revision')::BIGINT, 1),
      COALESCE((item->>'created_at')::TIMESTAMPTZ, now()),
      COALESCE((item->>'updated_at')::TIMESTAMPTZ, now())
    ) ON CONFLICT (owner_id, id) DO NOTHING;
    GET DIAGNOSTICS affected = ROW_COUNT; inserted := inserted + affected;
  END LOOP;

  FOR item IN SELECT value FROM jsonb_array_elements(COALESCE(p_data->'todo_task_templates', '[]'::JSONB)) LOOP
    INSERT INTO public.todo_task_templates (
      owner_id, id, name, title, priority, start_time, end_time,
      created_at, updated_at
    ) VALUES (
      current_uid, item->>'id', item->>'name', item->>'title',
      COALESCE(item->>'priority', 'normal'),
      (item->>'start_time')::TIME, (item->>'end_time')::TIME,
      COALESCE((item->>'created_at')::TIMESTAMPTZ, now()),
      COALESCE((item->>'updated_at')::TIMESTAMPTZ, now())
    ) ON CONFLICT (owner_id, id) DO NOTHING;
    GET DIAGNOSTICS affected = ROW_COUNT; inserted := inserted + affected;
  END LOOP;

  FOR item IN SELECT value FROM jsonb_array_elements(COALESCE(p_data->'todo_preferences', '[]'::JSONB)) LOOP
    IF item->>'background_kind' IN ('paper', 'preset') THEN
      INSERT INTO public.todo_preferences (owner_id, background_kind, background_value, updated_at)
      VALUES (current_uid, item->>'background_kind',
        COALESCE(item->>'background_value', ''),
        COALESCE((item->>'updated_at')::TIMESTAMPTZ, now()))
      ON CONFLICT (owner_id) DO NOTHING;
      GET DIAGNOSTICS affected = ROW_COUNT; inserted := inserted + affected;
    END IF;
  END LOOP;

  RETURN jsonb_build_object('inserted', inserted);
END;
$$;

REVOKE ALL ON FUNCTION public.restore_todo_backup_v1(JSONB) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.restore_todo_backup_v1(JSONB) TO authenticated;

-- Rollback reference: DROP FUNCTION public.restore_todo_backup_v1(JSONB);
