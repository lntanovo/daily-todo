-- 修复 reminder_device_complete / reminder_complete_by_token 中
-- PL/pgSQL 变量名 completion_date 与目标表列名同名，导致
-- ON CONFLICT (owner_id, task_id, completion_date) 报
-- DATABASE_42702 "column reference completion_date is ambiguous"。
--
-- 做法：把局部变量重命名为 v_completion_date，INSERT 的列名保持不变。
-- 纯 CREATE OR REPLACE，无表结构变更，可安全重复执行。

CREATE OR REPLACE FUNCTION public.reminder_device_complete(
  p_token_hash TEXT,
  p_task_id TEXT,
  p_remind_date DATE
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_device public.todo_reminder_devices%ROWTYPE;
  v_task public.todo_tasks%ROWTYPE;
  v_completion_date DATE;
BEGIN
  IF p_token_hash IS NULL OR p_token_hash !~ '^[a-f0-9]{64}$' THEN
    RETURN jsonb_build_object('ok', FALSE, 'code', 'INVALID');
  END IF;

  SELECT * INTO v_device
  FROM public.todo_reminder_devices d
  WHERE d.token_hash = p_token_hash AND d.revoked_at IS NULL;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', FALSE, 'code', 'UNAUTHORIZED');
  END IF;

  SELECT * INTO v_task
  FROM public.todo_tasks t
  WHERE t.owner_id = v_device.owner_id AND t.id = p_task_id;

  IF NOT FOUND OR v_task.deleted_at IS NOT NULL THEN
    RETURN jsonb_build_object('ok', TRUE, 'skipped', 'removed');
  END IF;
  IF NOT public.todo_task_appears_on(v_device.owner_id, p_task_id, p_remind_date) THEN
    RETURN jsonb_build_object('ok', TRUE, 'skipped', 'rescheduled', 'title', v_task.title);
  END IF;

  v_completion_date := CASE WHEN v_task.type = 'single' THEN v_task.task_date ELSE p_remind_date END;

  INSERT INTO public.todo_daily_completions (
    owner_id, task_id, completion_date, completed, updated_at
  ) VALUES (
    v_device.owner_id, p_task_id, v_completion_date, TRUE, now()
  )
  ON CONFLICT (owner_id, task_id, completion_date) DO UPDATE
    SET completed = TRUE, updated_at = now();

  RETURN jsonb_build_object('ok', TRUE, 'title', v_task.title, 'date', v_completion_date);
END;
$$;

CREATE OR REPLACE FUNCTION public.reminder_complete_by_token(p_token_hash TEXT)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  token public.todo_reminder_tokens%ROWTYPE;
  task public.todo_tasks%ROWTYPE;
  v_completion_date DATE;
BEGIN
  IF p_token_hash IS NULL OR p_token_hash !~ '^[a-f0-9]{64}$' THEN
    RETURN jsonb_build_object('ok', FALSE, 'code', 'INVALID');
  END IF;

  SELECT * INTO token
  FROM public.todo_reminder_tokens
  WHERE token_hash = p_token_hash
  FOR UPDATE;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', FALSE, 'code', 'INVALID');
  END IF;

  IF token.used_at IS NOT NULL THEN
    RETURN jsonb_build_object('ok', TRUE, 'already', TRUE);
  END IF;

  IF token.expires_at < now() THEN
    RETURN jsonb_build_object('ok', FALSE, 'code', 'EXPIRED');
  END IF;

  UPDATE public.todo_reminder_tokens
  SET used_at = now()
  WHERE token_hash = p_token_hash;

  SELECT * INTO task
  FROM public.todo_tasks
  WHERE owner_id = token.owner_id AND id = token.task_id;

  IF NOT FOUND OR task.deleted_at IS NOT NULL THEN
    RETURN jsonb_build_object('ok', TRUE, 'skipped', 'removed', 'title', task.title);
  END IF;

  IF NOT public.todo_task_appears_on(token.owner_id, token.task_id, token.remind_date) THEN
    RETURN jsonb_build_object('ok', TRUE, 'skipped', 'rescheduled', 'title', task.title);
  END IF;

  v_completion_date := CASE
    WHEN task.type = 'single' THEN task.task_date
    ELSE token.remind_date
  END;

  INSERT INTO public.todo_daily_completions (
    owner_id, task_id, completion_date, completed, updated_at
  ) VALUES (
    token.owner_id, token.task_id, v_completion_date, TRUE, now()
  )
  ON CONFLICT (owner_id, task_id, completion_date) DO UPDATE
    SET completed = TRUE, updated_at = now();

  RETURN jsonb_build_object(
    'ok', TRUE,
    'title', task.title,
    'date', v_completion_date
  );
END;
$$;

-- 权限保持与原迁移一致
REVOKE ALL ON FUNCTION public.reminder_device_complete(TEXT, TEXT, DATE)
  FROM public, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.reminder_device_complete(TEXT, TEXT, DATE) TO service_role;

REVOKE ALL ON FUNCTION public.reminder_complete_by_token(TEXT)
  FROM public, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.reminder_complete_by_token(TEXT) TO service_role;
