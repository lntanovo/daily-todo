-- v1.5.1 倒计时与晚间收尾。
--
-- 目的：把「提前几天每天都提醒」和「今天还剩什么没做完」做成同一份每日汇总的
-- 两个区块，而不是给每条任务生成一串独立闹钟。
--
--   am 早报：今天要做的 + 已逾期 + 未来 N 天倒计时
--   pm 收尾：今天还没完成的 + 已逾期 + 未来 N 天倒计时
--
-- 纯增量且可重复执行：只加 3 列、扩展投递账本的 kind 取值、重写 3 个函数。
-- 必须排在 20261105120000_reminders.sql 之后执行。

/* ---------------- 设置项 ---------------- */

ALTER TABLE public.todo_reminder_settings
  ADD COLUMN IF NOT EXISTS remind_lead_days SMALLINT NOT NULL DEFAULT 3;

ALTER TABLE public.todo_reminder_settings
  ADD COLUMN IF NOT EXISTS evening_enabled BOOLEAN NOT NULL DEFAULT TRUE;

ALTER TABLE public.todo_reminder_settings
  ADD COLUMN IF NOT EXISTS evening_time TIME WITHOUT TIME ZONE NOT NULL DEFAULT '20:30';

COMMENT ON COLUMN public.todo_reminder_settings.remind_lead_days IS
  '提前多少天开始进入倒计时区块；0 表示只看当天与逾期。';
COMMENT ON COLUMN public.todo_reminder_settings.evening_enabled IS
  '是否在 evening_time 再发一次「今天还剩什么」的收尾提醒。';
COMMENT ON COLUMN public.todo_reminder_settings.evening_time IS
  '晚间收尾提醒时间，按 Asia/Shanghai 解释。';

ALTER TABLE public.todo_reminder_settings
  DROP CONSTRAINT IF EXISTS todo_reminder_settings_lead_check;
ALTER TABLE public.todo_reminder_settings
  ADD CONSTRAINT todo_reminder_settings_lead_check
  CHECK (remind_lead_days BETWEEN 0 AND 30);

/* ---------------- 投递账本：区分早报与晚间收尾 ---------------- */

-- 同一个 kind 一天只能发一次，所以晚间收尾必须是独立的 kind，
-- 否则它会被早报的 claim 直接判成重复。
ALTER TABLE public.todo_reminder_log
  DROP CONSTRAINT IF EXISTS todo_reminder_log_kind_check;
ALTER TABLE public.todo_reminder_log
  ADD CONSTRAINT todo_reminder_log_kind_check
  CHECK (kind IN ('task', 'digest', 'digest_pm'));

/* ---------------- 每日汇总批量 ---------------- */

-- 返回类型变了，CREATE OR REPLACE 不适用，先丢掉旧的两参版本。
DROP FUNCTION IF EXISTS public.reminder_digest_batch(TIMESTAMPTZ, INTEGER);

CREATE OR REPLACE FUNCTION public.reminder_digest_batch(
  p_now TIMESTAMPTZ,
  p_grace_minutes INTEGER DEFAULT 180,
  p_slot TEXT DEFAULT 'am'
)
RETURNS TABLE (
  owner_id TEXT,
  slot TEXT,
  remind_date DATE,
  sections JSONB,
  quiet_active BOOLEAN,
  feishu_webhook TEXT,
  wecom_webhook TEXT
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
WITH ctx AS (
  SELECT
    (p_now AT TIME ZONE 'Asia/Shanghai')::DATE AS local_date,
    (p_now AT TIME ZONE 'Asia/Shanghai')::TIME AS local_time
),
win AS (
  SELECT
    s.owner_id,
    s.feishu_webhook,
    s.wecom_webhook,
    s.quiet_start,
    s.quiet_end,
    s.remind_lead_days,
    ctx.local_date,
    ctx.local_time,
    (ctx.local_date + CASE WHEN p_slot = 'pm' THEN s.evening_time ELSE s.digest_time END)
      AT TIME ZONE 'Asia/Shanghai' AS fire_at
  FROM public.todo_reminder_settings s
  CROSS JOIN ctx
  WHERE (s.feishu_webhook IS NOT NULL OR s.wecom_webhook IS NOT NULL)
    AND (CASE WHEN p_slot = 'pm' THEN s.evening_enabled ELSE s.digest_enabled END)
)
SELECT
  w.owner_id,
  p_slot,
  w.local_date,
  jsonb_build_object(
    'today', COALESCE(td.list, '[]'::JSONB),
    'overdue', COALESCE(od.list, '[]'::JSONB),
    'countdown', COALESCE(cd.list, '[]'::JSONB)
  ),
  public.reminder_quiet_active(w.quiet_start, w.quiet_end, w.local_time),
  w.feishu_webhook,
  w.wecom_webhook
FROM win w
LEFT JOIN LATERAL (
  SELECT jsonb_agg(
    jsonb_build_object(
      'id', t.id,
      'title', t.title,
      'date', to_char(w.local_date, 'YYYY-MM-DD'),
      'time', COALESCE(to_char(COALESCE(t.remind_time, t.start_time), 'HH24:MI'), ''),
      'days', 0,
      'urgent', t.priority = 'urgent'
    )
    ORDER BY COALESCE(t.remind_time, t.start_time) NULLS LAST, t.title
  ) AS list
  FROM public.todo_tasks t
  WHERE t.owner_id = w.owner_id
    AND t.deleted_at IS NULL
    AND t.remind_enabled
    AND public.todo_task_appears_on(t.owner_id, t.id, w.local_date)
    AND NOT EXISTS (
      SELECT 1
      FROM public.todo_daily_completions c
      WHERE c.owner_id = t.owner_id
        AND c.task_id = t.id
        AND c.completion_date = w.local_date
        AND c.completed
    )
) td ON TRUE
LEFT JOIN LATERAL (
  -- 逾期只看单日任务：它在某一天到期，过了那天没打勾就是没做完。
  -- 跨天任务与重复任务按日展开，逾期语义不同，这里刻意不猜。
  SELECT jsonb_agg(
    jsonb_build_object(
      'id', t.id,
      'title', t.title,
      'date', to_char(t.task_date, 'YYYY-MM-DD'),
      'time', '',
      'days', (t.task_date - w.local_date),
      'urgent', t.priority = 'urgent'
    )
    ORDER BY t.task_date DESC, t.title
  ) AS list
  FROM public.todo_tasks t
  WHERE t.owner_id = w.owner_id
    AND t.deleted_at IS NULL
    AND t.remind_enabled
    AND t.type = 'single'
    AND t.task_date IS NOT NULL
    AND t.task_date < w.local_date
    AND t.task_date >= w.local_date - 30
    AND NOT EXISTS (
      SELECT 1
      FROM public.todo_daily_completions c
      WHERE c.owner_id = t.owner_id
        AND c.task_id = t.id
        AND c.completion_date = t.task_date
        AND c.completed
    )
) od ON TRUE
LEFT JOIN LATERAL (
  -- 倒计时按「未来第 n 天实际会出现」展开，单日与重复任务用同一套规则，
  -- 跨天任务不参与，避免一个持续三周的项目天天喊「还有 N 天」。
  SELECT jsonb_agg(entry ORDER BY (entry->>'date'), (entry->>'time')) AS list
  FROM (
    SELECT jsonb_build_object(
      'id', t.id,
      'title', t.title,
      'date', to_char(day.d, 'YYYY-MM-DD'),
      'time', COALESCE(to_char(COALESCE(t.remind_time, t.start_time), 'HH24:MI'), ''),
      'days', (day.d - w.local_date),
      'urgent', t.priority = 'urgent'
    ) AS entry
    FROM generate_series(1, LEAST(GREATEST(w.remind_lead_days, 0), 30)) AS n
    CROSS JOIN LATERAL (SELECT w.local_date + n::INTEGER AS d) AS day
    JOIN public.todo_tasks t ON t.owner_id = w.owner_id
    WHERE t.deleted_at IS NULL
      AND t.remind_enabled
      AND t.type IN ('single', 'recurring')
      AND public.todo_task_appears_on(t.owner_id, t.id, day.d)
      AND NOT EXISTS (
        SELECT 1
        FROM public.todo_daily_completions c
        WHERE c.owner_id = t.owner_id
          AND c.task_id = t.id
          AND c.completion_date = day.d
          AND c.completed
      )
    ORDER BY day.d, COALESCE(t.remind_time, t.start_time) NULLS LAST, t.title
    LIMIT 20
  ) AS rows
) cd ON TRUE
WHERE (td.list IS NOT NULL OR od.list IS NOT NULL OR cd.list IS NOT NULL)
  AND w.fire_at <= p_now
  AND w.fire_at >= p_now - make_interval(mins => GREATEST(p_grace_minutes, 0));
$$;

REVOKE ALL ON FUNCTION public.reminder_digest_batch(TIMESTAMPTZ, INTEGER, TEXT)
  FROM public, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.reminder_digest_batch(TIMESTAMPTZ, INTEGER, TEXT)
  TO service_role;

/* ---------------- 领取：放行新的晚间 kind ---------------- */

-- 原来的白名单只有 task / digest，多出来的 kind 会在领取阶段直接抛错，
-- 所以这里必须同步放开，否则晚间收尾永远发不出去。
CREATE OR REPLACE FUNCTION public.reminder_claim(
  p_owner_id TEXT,
  p_kind TEXT,
  p_ref_id TEXT,
  p_remind_date DATE,
  p_channel TEXT,
  p_device_id TEXT DEFAULT ''
)
RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  claimed BOOLEAN := FALSE;
BEGIN
  IF p_kind NOT IN ('task', 'digest', 'digest_pm')
    OR p_channel NOT IN ('feishu', 'wecom', 'desktop') THEN
    RAISE EXCEPTION 'Unsupported reminder claim';
  END IF;
  IF p_channel = 'desktop' AND btrim(COALESCE(p_device_id, '')) = '' THEN
    RAISE EXCEPTION 'Desktop claims require a device id';
  END IF;

  INSERT INTO public.todo_reminder_log (
    owner_id, kind, ref_id, remind_date, channel, device_id, status, attempts, claimed_at
  ) VALUES (
    p_owner_id, p_kind, p_ref_id, p_remind_date, p_channel,
    COALESCE(p_device_id, ''), 'claimed', 1, now()
  )
  ON CONFLICT (owner_id, kind, ref_id, remind_date, channel, device_id) DO UPDATE
    SET status = 'claimed',
        attempts = public.todo_reminder_log.attempts + 1,
        claimed_at = now()
    WHERE public.todo_reminder_log.attempts < 3
      AND (
        public.todo_reminder_log.status = 'failed'
        OR (
          public.todo_reminder_log.status = 'claimed'
          AND public.todo_reminder_log.claimed_at < now() - interval '10 minutes'
        )
      )
  RETURNING TRUE INTO claimed;

  RETURN COALESCE(claimed, FALSE);
END;
$$;

/* ---------------- 设置读写：带上新字段 ---------------- */

CREATE OR REPLACE FUNCTION public.reminder_settings_read()
RETURNS JSONB
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  uid TEXT := auth.uid();
  settings_row public.todo_reminder_settings%ROWTYPE;
BEGIN
  IF uid IS NULL OR auth.role() <> 'authenticated' THEN
    RAISE EXCEPTION 'A signed-in account is required';
  END IF;

  SELECT * INTO settings_row FROM public.todo_reminder_settings WHERE owner_id = uid;

  IF NOT FOUND THEN
    RETURN jsonb_build_object(
      'feishu_set', FALSE, 'feishu_hint', '',
      'wecom_set', FALSE, 'wecom_hint', '',
      'digest_enabled', TRUE, 'digest_time', '08:00',
      'evening_enabled', TRUE, 'evening_time', '20:30',
      'remind_lead_days', 3,
      'grace_minutes', 60, 'quiet_start', NULL, 'quiet_end', NULL
    );
  END IF;

  RETURN jsonb_build_object(
    'feishu_set', settings_row.feishu_webhook IS NOT NULL,
    'feishu_hint', public.reminder_mask_url(settings_row.feishu_webhook),
    'wecom_set', settings_row.wecom_webhook IS NOT NULL,
    'wecom_hint', public.reminder_mask_url(settings_row.wecom_webhook),
    'digest_enabled', settings_row.digest_enabled,
    'digest_time', to_char(settings_row.digest_time, 'HH24:MI'),
    'evening_enabled', settings_row.evening_enabled,
    'evening_time', to_char(settings_row.evening_time, 'HH24:MI'),
    'remind_lead_days', settings_row.remind_lead_days,
    'grace_minutes', settings_row.grace_minutes,
    'quiet_start', CASE WHEN settings_row.quiet_start IS NULL THEN NULL ELSE to_char(settings_row.quiet_start, 'HH24:MI') END,
    'quiet_end', CASE WHEN settings_row.quiet_end IS NULL THEN NULL ELSE to_char(settings_row.quiet_end, 'HH24:MI') END
  );
END;
$$;

CREATE OR REPLACE FUNCTION public.reminder_settings_save(p_settings JSONB)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  uid TEXT := auth.uid();
  existing public.todo_reminder_settings%ROWTYPE;
  next public.todo_reminder_settings%ROWTYPE;
BEGIN
  IF uid IS NULL OR auth.role() <> 'authenticated' THEN
    RAISE EXCEPTION 'A signed-in account is required';
  END IF;
  IF jsonb_typeof(p_settings) IS DISTINCT FROM 'object' THEN
    RAISE EXCEPTION 'Invalid reminder settings payload';
  END IF;

  SELECT * INTO existing FROM public.todo_reminder_settings WHERE owner_id = uid;

  next.owner_id := uid;
  next.feishu_webhook := existing.feishu_webhook;
  next.wecom_webhook := existing.wecom_webhook;
  next.digest_enabled := COALESCE(existing.digest_enabled, TRUE);
  next.digest_time := COALESCE(existing.digest_time, '08:00');
  next.evening_enabled := COALESCE(existing.evening_enabled, TRUE);
  next.evening_time := COALESCE(existing.evening_time, '20:30');
  next.remind_lead_days := COALESCE(existing.remind_lead_days, 3);
  next.grace_minutes := COALESCE(existing.grace_minutes, 60);
  next.quiet_start := existing.quiet_start;
  next.quiet_end := existing.quiet_end;

  IF p_settings ? 'feishu_webhook' THEN
    next.feishu_webhook := NULLIF(btrim(p_settings->>'feishu_webhook'), '');
  END IF;
  IF p_settings ? 'wecom_webhook' THEN
    next.wecom_webhook := NULLIF(btrim(p_settings->>'wecom_webhook'), '');
  END IF;
  IF p_settings ? 'digest_enabled' THEN
    next.digest_enabled := COALESCE((p_settings->>'digest_enabled')::BOOLEAN, next.digest_enabled);
  END IF;
  IF p_settings ? 'digest_time' THEN
    IF (p_settings->>'digest_time') !~ '^([01]\d|2[0-3]):[0-5]\d$' THEN
      RAISE EXCEPTION '早报时间格式应为 HH:mm';
    END IF;
    next.digest_time := (p_settings->>'digest_time')::TIME;
  END IF;
  IF p_settings ? 'evening_enabled' THEN
    next.evening_enabled := COALESCE((p_settings->>'evening_enabled')::BOOLEAN, next.evening_enabled);
  END IF;
  IF p_settings ? 'evening_time' THEN
    IF (p_settings->>'evening_time') !~ '^([01]\d|2[0-3]):[0-5]\d$' THEN
      RAISE EXCEPTION '晚间收尾时间格式应为 HH:mm';
    END IF;
    next.evening_time := (p_settings->>'evening_time')::TIME;
  END IF;
  IF p_settings ? 'remind_lead_days' THEN
    IF (p_settings->>'remind_lead_days') !~ '^\d{1,2}$'
      OR (p_settings->>'remind_lead_days')::INTEGER > 30 THEN
      RAISE EXCEPTION '提前提醒天数应为 0—30';
    END IF;
    next.remind_lead_days := (p_settings->>'remind_lead_days')::SMALLINT;
  END IF;
  IF p_settings ? 'grace_minutes' THEN
    IF (p_settings->>'grace_minutes') !~ '^\d{1,4}$'
      OR (p_settings->>'grace_minutes')::INTEGER > 1440 THEN
      RAISE EXCEPTION '宽限时间应为 0—1440 分钟';
    END IF;
    next.grace_minutes := (p_settings->>'grace_minutes')::SMALLINT;
  END IF;
  IF p_settings ? 'quiet_start' THEN
    IF btrim(COALESCE(p_settings->>'quiet_start', '')) <> ''
      AND (p_settings->>'quiet_start') !~ '^([01]\d|2[0-3]):[0-5]\d$' THEN
      RAISE EXCEPTION '免打扰开始时间格式应为 HH:mm';
    END IF;
    next.quiet_start := NULLIF(btrim(p_settings->>'quiet_start'), '')::TIME;
  END IF;
  IF p_settings ? 'quiet_end' THEN
    IF btrim(COALESCE(p_settings->>'quiet_end', '')) <> ''
      AND (p_settings->>'quiet_end') !~ '^([01]\d|2[0-3]):[0-5]\d$' THEN
      RAISE EXCEPTION '免打扰结束时间格式应为 HH:mm';
    END IF;
    next.quiet_end := NULLIF(btrim(p_settings->>'quiet_end'), '')::TIME;
  END IF;

  IF (next.quiet_start IS NULL) <> (next.quiet_end IS NULL) THEN
    RAISE EXCEPTION '免打扰开始和结束需要同时填写';
  END IF;
  IF next.feishu_webhook IS NOT NULL
    AND next.feishu_webhook !~ '^https://(open\.feishu\.cn|open\.larksuite\.com)/open-apis/bot/v2/hook/[A-Za-z0-9-]+$' THEN
    RAISE EXCEPTION '飞书 Webhook 格式不正确';
  END IF;
  IF next.wecom_webhook IS NOT NULL
    AND next.wecom_webhook !~ '^https://qyapi\.weixin\.qq\.com/cgi-bin/webhook/send\?key=[A-Za-z0-9-]+$' THEN
    RAISE EXCEPTION '企业微信 Webhook 格式不正确';
  END IF;

  INSERT INTO public.todo_reminder_settings (
    owner_id, feishu_webhook, wecom_webhook, digest_enabled, digest_time,
    evening_enabled, evening_time, remind_lead_days,
    grace_minutes, quiet_start, quiet_end, updated_at
  ) VALUES (
    next.owner_id, next.feishu_webhook, next.wecom_webhook, next.digest_enabled,
    next.digest_time, next.evening_enabled, next.evening_time, next.remind_lead_days,
    next.grace_minutes, next.quiet_start, next.quiet_end, now()
  )
  ON CONFLICT (owner_id) DO UPDATE
    SET feishu_webhook = EXCLUDED.feishu_webhook,
        wecom_webhook = EXCLUDED.wecom_webhook,
        digest_enabled = EXCLUDED.digest_enabled,
        digest_time = EXCLUDED.digest_time,
        evening_enabled = EXCLUDED.evening_enabled,
        evening_time = EXCLUDED.evening_time,
        remind_lead_days = EXCLUDED.remind_lead_days,
        grace_minutes = EXCLUDED.grace_minutes,
        quiet_start = EXCLUDED.quiet_start,
        quiet_end = EXCLUDED.quiet_end,
        updated_at = now();

  RETURN public.reminder_settings_read();
END;
$$;

REVOKE ALL ON FUNCTION public.reminder_settings_read() FROM public, anon;
GRANT EXECUTE ON FUNCTION public.reminder_settings_read() TO authenticated;
GRANT EXECUTE ON FUNCTION public.reminder_settings_read() TO service_role;

REVOKE ALL ON FUNCTION public.reminder_settings_save(JSONB) FROM public, anon;
GRANT EXECUTE ON FUNCTION public.reminder_settings_save(JSONB) TO authenticated;
GRANT EXECUTE ON FUNCTION public.reminder_settings_save(JSONB) TO service_role;

-- 网关（PostgREST）会缓存函数签名；不重载的话，刚建好的三参版本仍会 404 一段时间。
NOTIFY pgrst, 'reload schema';
