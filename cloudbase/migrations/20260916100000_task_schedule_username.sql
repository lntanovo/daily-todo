-- v1.1: optional daily time window, task priority, and user-chosen registration names.
-- Existing tasks remain normal priority with no time window.

ALTER TABLE public.todo_tasks
  ADD COLUMN priority TEXT NOT NULL DEFAULT 'normal';

ALTER TABLE public.todo_tasks
  ADD CONSTRAINT todo_tasks_priority_check
  CHECK (priority IN ('normal', 'urgent'));

ALTER TABLE public.todo_tasks
  ADD COLUMN start_time TIME WITHOUT TIME ZONE;

ALTER TABLE public.todo_tasks
  ADD COLUMN end_time TIME WITHOUT TIME ZONE;

ALTER TABLE public.todo_tasks
  ADD CONSTRAINT todo_tasks_time_window_check
  CHECK (
    (start_time IS NULL AND end_time IS NULL)
    OR
    (start_time IS NOT NULL AND end_time IS NOT NULL AND start_time < end_time)
  );

CREATE FUNCTION public.reserve_friend_registration_v2(
  p_request_hash TEXT,
  p_payload_hash TEXT,
  p_username TEXT,
  p_nickname TEXT,
  p_relation TEXT
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog, public
AS $$
DECLARE
  cfg public.friend_registration_settings%rowtype;
  entry public.friend_registrations%rowtype;
  today_start timestamptz := date_trunc('day', now() at time zone 'Asia/Shanghai') at time zone 'Asia/Shanghai';
BEGIN
  IF p_username !~ '^[a-z][a-z0-9_]{4,23}$' THEN
    RETURN jsonb_build_object('code', 'INVALID');
  END IF;

  SELECT * INTO cfg FROM public.friend_registration_settings WHERE id = 1 FOR UPDATE;
  IF NOT FOUND OR NOT cfg.enabled THEN RETURN jsonb_build_object('code', 'CLOSED'); END IF;
  IF cfg.minute_start < now() - interval '1 minute' THEN
    UPDATE public.friend_registration_settings SET minute_start = now(), minute_requests = 1 WHERE id = 1;
  ELSIF cfg.minute_requests >= 30 THEN
    RETURN jsonb_build_object('code', 'RATE_LIMIT');
  ELSE
    UPDATE public.friend_registration_settings SET minute_requests = minute_requests + 1 WHERE id = 1;
  END IF;

  SELECT * INTO entry FROM public.friend_registrations WHERE request_hash = p_request_hash FOR UPDATE;
  IF FOUND THEN
    IF entry.payload_hash <> p_payload_hash THEN RETURN jsonb_build_object('code', 'CHANGED'); END IF;
    IF entry.status = 'succeeded' THEN RETURN jsonb_build_object('code', 'DONE', 'username', entry.username); END IF;
    IF entry.lease_until > now() THEN RETURN jsonb_build_object('code', 'BUSY'); END IF;
    UPDATE public.friend_registrations SET lease_until = now() + interval '90 seconds' WHERE request_hash = p_request_hash;
    RETURN jsonb_build_object('code', 'RESERVED', 'username', entry.username, 'uid', entry.user_id, 'retry', true);
  END IF;

  IF (SELECT count(*) FROM public.friend_registrations) >= cfg.total_limit THEN RETURN jsonb_build_object('code', 'TOTAL_LIMIT'); END IF;
  IF (SELECT count(*) FROM public.friend_registrations WHERE created_at >= today_start) >= cfg.daily_limit THEN RETURN jsonb_build_object('code', 'DAILY_LIMIT'); END IF;

  BEGIN
    INSERT INTO public.friend_registrations (request_hash, payload_hash, username, user_id, nickname, relation)
    VALUES (p_request_hash, p_payload_hash, p_username, 'lnreg_' || substr(p_request_hash, 1, 48), p_nickname, p_relation)
    RETURNING * INTO entry;
  EXCEPTION WHEN unique_violation THEN
    RETURN jsonb_build_object('code', 'USERNAME_TAKEN');
  END;

  RETURN jsonb_build_object('code', 'RESERVED', 'username', entry.username, 'uid', entry.user_id, 'retry', false);
END;
$$;

CREATE FUNCTION public.cancel_friend_registration(
  p_request_hash TEXT,
  p_user_id TEXT
)
RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog, public
AS $$
BEGIN
  DELETE FROM public.friend_registrations
  WHERE request_hash = p_request_hash
    AND user_id = p_user_id
    AND status = 'pending';
  RETURN FOUND;
END;
$$;

REVOKE ALL ON FUNCTION public.reserve_friend_registration_v2(TEXT, TEXT, TEXT, TEXT, TEXT) FROM public, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.reserve_friend_registration_v2(TEXT, TEXT, TEXT, TEXT, TEXT) TO service_role;

REVOKE ALL ON FUNCTION public.cancel_friend_registration(TEXT, TEXT) FROM public, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.cancel_friend_registration(TEXT, TEXT) TO service_role;

-- Rollback reference (run only after explicit approval):
-- DROP FUNCTION public.cancel_friend_registration(TEXT, TEXT);
-- DROP FUNCTION public.reserve_friend_registration_v2(TEXT, TEXT, TEXT, TEXT, TEXT);
-- ALTER TABLE public.todo_tasks DROP CONSTRAINT todo_tasks_time_window_check;
-- ALTER TABLE public.todo_tasks DROP COLUMN end_time;
-- ALTER TABLE public.todo_tasks DROP COLUMN start_time;
-- ALTER TABLE public.todo_tasks DROP CONSTRAINT todo_tasks_priority_check;
-- ALTER TABLE public.todo_tasks DROP COLUMN priority;
