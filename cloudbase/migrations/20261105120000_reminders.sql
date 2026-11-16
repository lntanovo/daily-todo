-- v1.5 reminder delivery: task reminder time, per-account channel settings,
-- an idempotent delivery ledger, and one-click completion tokens.
-- Additive only: existing tasks keep working and simply have no to-the-minute
-- reminder until a remind_time (or start_time) is set.
--
-- Delivery is performed by the `reminder-tick` cloud function every minute and
-- by `reminder-done` for the tokenized "标记完成" link. Both call the SECURITY
-- DEFINER functions below with the service_role key; no browser can execute them.

ALTER TABLE public.todo_tasks
  ADD COLUMN IF NOT EXISTS remind_time TIME WITHOUT TIME ZONE;

ALTER TABLE public.todo_tasks
  ADD COLUMN IF NOT EXISTS remind_enabled BOOLEAN NOT NULL DEFAULT TRUE;

COMMENT ON COLUMN public.todo_tasks.remind_time IS
  '到点提醒时间。为空时回退 start_time；两者都为空时只出现在每日早报里。';
COMMENT ON COLUMN public.todo_tasks.remind_enabled IS
  '关闭后既不单独提醒也不进入早报。';

CREATE INDEX IF NOT EXISTS todo_tasks_owner_remind_idx
  ON public.todo_tasks (owner_id, (COALESCE(remind_time, start_time)))
  WHERE deleted_at IS NULL AND remind_enabled;

/* ---------------- 每账号推送设置 ---------------- */

CREATE TABLE IF NOT EXISTS public.todo_reminder_settings (
  owner_id TEXT PRIMARY KEY DEFAULT auth.uid(),
  feishu_webhook TEXT CHECK (
    feishu_webhook IS NULL
    OR feishu_webhook ~ '^https://(open\.feishu\.cn|open\.larksuite\.com)/open-apis/bot/v2/hook/[A-Za-z0-9-]+$'
  ),
  wecom_webhook TEXT CHECK (
    wecom_webhook IS NULL
    OR wecom_webhook ~ '^https://qyapi\.weixin\.qq\.com/cgi-bin/webhook/send\?key=[A-Za-z0-9-]+$'
  ),
  digest_enabled BOOLEAN NOT NULL DEFAULT TRUE,
  digest_time TIME WITHOUT TIME ZONE NOT NULL DEFAULT '08:00',
  grace_minutes SMALLINT NOT NULL DEFAULT 60
    CHECK (grace_minutes BETWEEN 0 AND 1440),
  quiet_start TIME WITHOUT TIME ZONE,
  quiet_end TIME WITHOUT TIME ZONE,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT todo_reminder_settings_quiet_pair CHECK (
    (quiet_start IS NULL AND quiet_end IS NULL)
    OR (quiet_start IS NOT NULL AND quiet_end IS NOT NULL)
  )
);

-- Webhook 等于 bearer 密钥：表本身永远不对浏览器开放，只能经下面的受控函数读掩码。
ALTER TABLE public.todo_reminder_settings ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.todo_reminder_settings FROM public, anon, authenticated;
GRANT ALL ON public.todo_reminder_settings TO service_role;

/* ---------------- 幂等投递账本 ---------------- */

CREATE TABLE IF NOT EXISTS public.todo_reminder_log (
  owner_id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('task', 'digest')),
  ref_id TEXT NOT NULL,
  remind_date DATE NOT NULL,
  channel TEXT NOT NULL CHECK (channel IN ('feishu', 'wecom', 'desktop')),
  device_id TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'claimed'
    CHECK (status IN ('claimed', 'sent', 'failed', 'skipped')),
  attempts SMALLINT NOT NULL DEFAULT 1 CHECK (attempts BETWEEN 1 AND 99),
  claimed_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  sent_at TIMESTAMPTZ,
  last_error TEXT,
  -- device_id 只对桌面通道有意义：同账号两台电脑各弹各的，不能互相抢锁。
  PRIMARY KEY (owner_id, kind, ref_id, remind_date, channel, device_id)
);

CREATE INDEX IF NOT EXISTS todo_reminder_log_date_idx
  ON public.todo_reminder_log (remind_date);

ALTER TABLE public.todo_reminder_log ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.todo_reminder_log FROM public, anon, authenticated;
GRANT ALL ON public.todo_reminder_log TO service_role;

/* ---------------- 桌面设备配对 ---------------- */

-- 桌面程序不能持有服务端密钥，所以每台机器领取一个可吊销的随机令牌，
-- 只存 sha256。配对码由浏览器生成并显示，用户在本机输入一次即可。
CREATE TABLE IF NOT EXISTS public.todo_reminder_devices (
  owner_id TEXT NOT NULL,
  id TEXT NOT NULL,
  name TEXT NOT NULL CHECK (char_length(btrim(name)) BETWEEN 1 AND 60),
  token_hash TEXT NOT NULL UNIQUE CHECK (token_hash ~ '^[a-f0-9]{64}$'),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_seen_at TIMESTAMPTZ,
  revoked_at TIMESTAMPTZ,
  PRIMARY KEY (owner_id, id)
);

CREATE INDEX IF NOT EXISTS todo_reminder_devices_token_idx
  ON public.todo_reminder_devices (token_hash)
  WHERE revoked_at IS NULL;

ALTER TABLE public.todo_reminder_devices ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.todo_reminder_devices FROM public, anon, authenticated;
GRANT ALL ON public.todo_reminder_devices TO service_role;

CREATE TABLE IF NOT EXISTS public.todo_reminder_pairings (
  code_hash TEXT PRIMARY KEY CHECK (code_hash ~ '^[a-f0-9]{64}$'),
  owner_id TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at TIMESTAMPTZ NOT NULL,
  used_at TIMESTAMPTZ,
  device_id TEXT
);

CREATE INDEX IF NOT EXISTS todo_reminder_pairings_owner_idx
  ON public.todo_reminder_pairings (owner_id, created_at DESC);

ALTER TABLE public.todo_reminder_pairings ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.todo_reminder_pairings FROM public, anon, authenticated;
GRANT ALL ON public.todo_reminder_pairings TO service_role;

/* ---------------- 桌面设备：配对、拉取、完成、心跳 ---------------- */

-- 浏览器侧调用：生成一次性配对码（6 位数字），10 分钟内有效。
-- 只存哈希，原文只返回给当前登录页面一次。
CREATE OR REPLACE FUNCTION public.reminder_pairing_create()
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  uid TEXT := auth.uid();
  raw_code TEXT;
  code_hash TEXT;
BEGIN
  IF uid IS NULL OR auth.role() <> 'authenticated' THEN
    RAISE EXCEPTION 'A signed-in account is required';
  END IF;

  -- 先清掉该账号过期未用的配对码，避免堆积。
  DELETE FROM public.todo_reminder_pairings
  WHERE owner_id = uid AND (expires_at < now() OR used_at IS NOT NULL);

  raw_code := lpad((floor(random() * 1000000))::INTEGER::TEXT, 6, '0');
  code_hash := encode(digest(raw_code, 'sha256'), 'hex');

  INSERT INTO public.todo_reminder_pairings (code_hash, owner_id, expires_at)
  VALUES (code_hash, uid, now() + interval '10 minutes');

  RETURN jsonb_build_object(
    'code', raw_code,
    'expires_at', (now() + interval '10 minutes')
  );
END;
$$;

-- 桌面程序调用：用配对码换取长期设备令牌。令牌原文只在这里出现一次。
CREATE OR REPLACE FUNCTION public.reminder_device_pair(
  p_code TEXT,
  p_name TEXT,
  p_token_hash TEXT
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_hash TEXT;
  v_pairing public.todo_reminder_pairings%ROWTYPE;
  v_device_id TEXT;
  v_name TEXT := left(btrim(COALESCE(p_name, '')), 60);
BEGIN
  IF p_code IS NULL OR p_code !~ '^\d{6}$' THEN
    RETURN jsonb_build_object('ok', FALSE, 'code', 'INVALID');
  END IF;
  IF p_token_hash IS NULL OR p_token_hash !~ '^[a-f0-9]{64}$' THEN
    RETURN jsonb_build_object('ok', FALSE, 'code', 'INVALID');
  END IF;
  IF v_name = '' THEN
    RETURN jsonb_build_object('ok', FALSE, 'code', 'INVALID');
  END IF;

  -- 用 digest() 而不是 encode(sha256(...))：后者在部分环境里没有 pgcrypto 就会失败。
  v_hash := encode(digest(p_code, 'sha256'), 'hex');

  SELECT * INTO v_pairing
  FROM public.todo_reminder_pairings p
  WHERE p.code_hash = v_hash
  FOR UPDATE;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', FALSE, 'code', 'INVALID');
  END IF;
  IF v_pairing.used_at IS NOT NULL THEN
    RETURN jsonb_build_object('ok', FALSE, 'code', 'USED');
  END IF;
  IF v_pairing.expires_at < now() THEN
    RETURN jsonb_build_object('ok', FALSE, 'code', 'EXPIRED');
  END IF;

  v_device_id := 'dev_' || encode(gen_random_bytes(8), 'hex');

  INSERT INTO public.todo_reminder_devices (
    owner_id, id, name, token_hash, last_seen_at
  ) VALUES (
    v_pairing.owner_id, v_device_id, v_name, p_token_hash, now()
  );

  UPDATE public.todo_reminder_pairings p
  SET used_at = now(), device_id = v_device_id
  WHERE p.code_hash = v_hash;

  RETURN jsonb_build_object('ok', TRUE, 'device_id', v_device_id);
END;
$$;

-- 桌面程序每次轮询都调用：校验令牌、刷新心跳、返回今天到点的事项。
CREATE OR REPLACE FUNCTION public.reminder_device_feed(
  p_token_hash TEXT,
  p_now TIMESTAMPTZ
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_device public.todo_reminder_devices%ROWTYPE;
  ctx RECORD;
  items JSONB;
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

  UPDATE public.todo_reminder_devices d
  SET last_seen_at = now()
  WHERE d.owner_id = v_device.owner_id AND d.id = v_device.id;

  SELECT
    (p_now AT TIME ZONE 'Asia/Shanghai')::DATE AS local_date,
    (p_now AT TIME ZONE 'Asia/Shanghai')::TIME AS local_time
  INTO ctx;

  SELECT COALESCE(jsonb_agg(entry ORDER BY entry->>'due_at'), '[]'::JSONB) INTO items
  FROM (
    SELECT jsonb_build_object(
      'task_id', t.id,
      'title', t.title,
      'note', COALESCE(n.content, ''),
      'clock', to_char(COALESCE(t.remind_time, t.start_time), 'HH24:MI'),
      'due_at', ((ctx.local_date + COALESCE(t.remind_time, t.start_time)) AT TIME ZONE 'Asia/Shanghai'),
      'urgent', t.priority = 'urgent'
    ) AS entry
    FROM public.todo_tasks t
    LEFT JOIN public.todo_daily_notes n
      ON n.owner_id = t.owner_id AND n.task_id = t.id AND n.note_date = ctx.local_date
    WHERE t.owner_id = v_device.owner_id
      AND t.deleted_at IS NULL
      AND t.remind_enabled
      AND COALESCE(t.remind_time, t.start_time) IS NOT NULL
      AND public.todo_task_appears_on(t.owner_id, t.id, ctx.local_date)
      AND NOT EXISTS (
        SELECT 1
        FROM public.todo_daily_completions c
        WHERE c.owner_id = t.owner_id
          AND c.task_id = t.id
          AND c.completion_date = ctx.local_date
          AND c.completed
      )
      AND NOT EXISTS (
        SELECT 1
        FROM public.todo_reminder_log l
        WHERE l.owner_id = t.owner_id
          AND l.kind = 'task'
          AND l.ref_id = t.id
          AND l.remind_date = ctx.local_date
          AND l.channel = 'desktop'
          AND l.device_id = v_device.id
          AND l.status IN ('sent', 'skipped')
      )
  ) AS pending;

  RETURN jsonb_build_object(
    'ok', TRUE,
    'device_id', v_device.id,
    'date', ctx.local_date,
    'local_time', to_char(ctx.local_time, 'HH24:MI'),
    'items', items
  );
END;
$$;

-- 桌面程序弹完通知后回执，避免同一台机器重复弹。
CREATE OR REPLACE FUNCTION public.reminder_device_ack(
  p_token_hash TEXT,
  p_task_id TEXT,
  p_remind_date DATE,
  p_status TEXT DEFAULT 'sent'
)
RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_device public.todo_reminder_devices%ROWTYPE;
BEGIN
  IF p_token_hash IS NULL OR p_token_hash !~ '^[a-f0-9]{64}$' THEN
    RETURN FALSE;
  END IF;
  IF p_status NOT IN ('sent', 'failed', 'skipped') THEN
    RAISE EXCEPTION 'Unsupported reminder status';
  END IF;

  SELECT * INTO v_device
  FROM public.todo_reminder_devices d
  WHERE d.token_hash = p_token_hash AND d.revoked_at IS NULL;
  IF NOT FOUND THEN
    RETURN FALSE;
  END IF;

  INSERT INTO public.todo_reminder_log (
    owner_id, kind, ref_id, remind_date, channel, device_id, status, attempts, claimed_at, sent_at
  ) VALUES (
    v_device.owner_id, 'task', p_task_id, p_remind_date, 'desktop', v_device.id,
    p_status, 1, now(), CASE WHEN p_status = 'sent' THEN now() ELSE NULL END
  )
  ON CONFLICT (owner_id, kind, ref_id, remind_date, channel, device_id) DO UPDATE
    SET status = EXCLUDED.status,
        sent_at = EXCLUDED.sent_at,
        claimed_at = now();

  RETURN TRUE;
END;
$$;

-- 桌面程序点「标记完成」：用设备令牌直接写完成记录，无需网页登录。
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
  completion_date DATE;
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

  completion_date := CASE WHEN v_task.type = 'single' THEN v_task.task_date ELSE p_remind_date END;

  INSERT INTO public.todo_daily_completions (
    owner_id, task_id, completion_date, completed, updated_at
  ) VALUES (
    v_device.owner_id, p_task_id, completion_date, TRUE, now()
  )
  ON CONFLICT (owner_id, task_id, completion_date) DO UPDATE
    SET completed = TRUE, updated_at = now();

  RETURN jsonb_build_object('ok', TRUE, 'title', v_task.title, 'date', completion_date);
END;
$$;

-- 浏览器侧：查看并吊销已配对设备（只返回名称与时间，不返回令牌）。
CREATE OR REPLACE FUNCTION public.reminder_devices_list()
RETURNS JSONB
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  uid TEXT := auth.uid();
BEGIN
  IF uid IS NULL OR auth.role() <> 'authenticated' THEN
    RAISE EXCEPTION 'A signed-in account is required';
  END IF;

  RETURN jsonb_build_object('devices', COALESCE((
    SELECT jsonb_agg(jsonb_build_object(
      'id', d.id,
      'name', d.name,
      'created_at', d.created_at,
      'last_seen_at', d.last_seen_at
    ) ORDER BY d.created_at DESC)
    FROM public.todo_reminder_devices d
    WHERE d.owner_id = uid AND d.revoked_at IS NULL
  ), '[]'::JSONB));
END;
$$;

CREATE OR REPLACE FUNCTION public.reminder_device_revoke(p_device_id TEXT)
RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  uid TEXT := auth.uid();
BEGIN
  IF uid IS NULL OR auth.role() <> 'authenticated' THEN
    RAISE EXCEPTION 'A signed-in account is required';
  END IF;

  UPDATE public.todo_reminder_devices d
  SET revoked_at = now()
  WHERE d.owner_id = uid AND d.id = p_device_id AND d.revoked_at IS NULL;
  RETURN FOUND;
END;
$$;

/* ---------------- 一键完成令牌 ---------------- */

CREATE TABLE IF NOT EXISTS public.todo_reminder_tokens (
  token_hash TEXT PRIMARY KEY CHECK (token_hash ~ '^[a-f0-9]{64}$'),
  owner_id TEXT NOT NULL,
  task_id TEXT NOT NULL,
  remind_date DATE NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at TIMESTAMPTZ NOT NULL,
  used_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS todo_reminder_tokens_expiry_idx
  ON public.todo_reminder_tokens (expires_at);

ALTER TABLE public.todo_reminder_tokens ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.todo_reminder_tokens FROM public, anon, authenticated;
GRANT ALL ON public.todo_reminder_tokens TO service_role;

/* ---------------- 纯函数：是否出现、是否免打扰、网址掩码 ---------------- */

CREATE OR REPLACE FUNCTION public.reminder_quiet_active(
  p_start TIME,
  p_end TIME,
  p_local_time TIME
)
RETURNS BOOLEAN
LANGUAGE sql
IMMUTABLE
SET search_path = pg_catalog
AS $$
  SELECT CASE
    WHEN p_start IS NULL OR p_end IS NULL THEN FALSE
    WHEN p_start = p_end THEN FALSE
    WHEN p_start < p_end THEN p_local_time >= p_start AND p_local_time < p_end
    ELSE p_local_time >= p_start OR p_local_time < p_end
  END;
$$;

CREATE OR REPLACE FUNCTION public.reminder_mask_url(p_url TEXT)
RETURNS TEXT
LANGUAGE sql
IMMUTABLE
SET search_path = pg_catalog
AS $$
  SELECT CASE
    WHEN p_url IS NULL OR btrim(p_url) = '' THEN ''
    ELSE '…' || right(p_url, 4)
  END;
$$;

-- 与 src/recurrence-core.js 的 taskAppearsOn 保持同一语义：
-- single 按 task_date；range 含首尾；recurring 每周/每月，月底缺失日期自然跳过。
CREATE OR REPLACE FUNCTION public.todo_task_appears_on(
  p_owner_id TEXT,
  p_task_id TEXT,
  p_on_date DATE
)
RETURNS BOOLEAN
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
  SELECT COALESCE((
    SELECT CASE
      WHEN t.type = 'single' THEN t.task_date = p_on_date
      WHEN t.type = 'range' THEN p_on_date BETWEEN t.start_date AND t.end_date
      WHEN t.type = 'recurring' THEN COALESCE(
        r.start_date <= p_on_date
        AND (r.end_date IS NULL OR p_on_date <= r.end_date)
        AND (
          (
            r.frequency = 'weekly'
            AND EXTRACT(ISODOW FROM p_on_date)::SMALLINT = ANY (r.weekdays)
          )
          OR (
            r.frequency = 'monthly'
            AND EXTRACT(DAY FROM p_on_date)::SMALLINT = r.month_day
          )
        ),
        FALSE
      )
      ELSE FALSE
    END
    FROM public.todo_tasks t
    LEFT JOIN public.todo_task_recurrences r
      ON r.owner_id = t.owner_id AND r.task_id = t.id
    WHERE t.owner_id = p_owner_id
      AND t.id = p_task_id
      AND t.deleted_at IS NULL
  ), FALSE);
$$;

/* ---------------- 到点批量 ---------------- */

-- range 任务按设计只进早报，避免一个长任务连续轰炸数周。
CREATE OR REPLACE FUNCTION public.reminder_due_batch(p_now TIMESTAMPTZ)
RETURNS TABLE (
  owner_id TEXT,
  task_id TEXT,
  task_title TEXT,
  remind_date DATE,
  remind_clock TEXT,
  remind_at TIMESTAMPTZ,
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
    (p_now AT TIME ZONE 'Asia/Shanghai') AS local_ts,
    (p_now AT TIME ZONE 'Asia/Shanghai')::DATE AS local_date,
    (p_now AT TIME ZONE 'Asia/Shanghai')::TIME AS local_time
)
SELECT
  s.owner_id,
  t.id,
  t.title,
  ctx.local_date,
  to_char(COALESCE(t.remind_time, t.start_time), 'HH24:MI'),
  (ctx.local_date + COALESCE(t.remind_time, t.start_time)) AT TIME ZONE 'Asia/Shanghai',
  public.reminder_quiet_active(s.quiet_start, s.quiet_end, ctx.local_time),
  s.feishu_webhook,
  s.wecom_webhook
FROM public.todo_tasks t
JOIN public.todo_reminder_settings s ON s.owner_id = t.owner_id
CROSS JOIN ctx
WHERE t.deleted_at IS NULL
  AND t.remind_enabled
  AND COALESCE(t.remind_time, t.start_time) IS NOT NULL
  AND t.type IN ('single', 'recurring')
  AND public.todo_task_appears_on(t.owner_id, t.id, ctx.local_date)
  AND ((ctx.local_date + COALESCE(t.remind_time, t.start_time)) AT TIME ZONE 'Asia/Shanghai') <= p_now
  AND p_now - ((ctx.local_date + COALESCE(t.remind_time, t.start_time)) AT TIME ZONE 'Asia/Shanghai')
      <= s.grace_minutes * interval '1 minute'
  AND NOT EXISTS (
    SELECT 1
    FROM public.todo_daily_completions c
    WHERE c.owner_id = t.owner_id
      AND c.task_id = t.id
      AND c.completion_date = ctx.local_date
      AND c.completed
  );
$$;

/* ---------------- 每日早报批量 ---------------- */

CREATE OR REPLACE FUNCTION public.reminder_digest_batch(
  p_now TIMESTAMPTZ,
  p_grace_minutes INTEGER DEFAULT 180
)
RETURNS TABLE (
  owner_id TEXT,
  remind_date DATE,
  tasks JSONB,
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
    (p_now AT TIME ZONE 'Asia/Shanghai') AS local_ts,
    (p_now AT TIME ZONE 'Asia/Shanghai')::DATE AS local_date,
    (p_now AT TIME ZONE 'Asia/Shanghai')::TIME AS local_time
)
SELECT
  s.owner_id,
  ctx.local_date,
  COALESCE(items.list, '[]'::JSONB),
  public.reminder_quiet_active(s.quiet_start, s.quiet_end, ctx.local_time),
  s.feishu_webhook,
  s.wecom_webhook
FROM public.todo_reminder_settings s
CROSS JOIN ctx
LEFT JOIN LATERAL (
  SELECT jsonb_agg(
    jsonb_build_object(
      'id', t.id,
      'time', COALESCE(to_char(COALESCE(t.remind_time, t.start_time), 'HH24:MI'), ''),
      'title', t.title,
      'urgent', t.priority = 'urgent'
    )
    ORDER BY COALESCE(t.remind_time, t.start_time) NULLS LAST, t.title
  ) AS list
  FROM public.todo_tasks t
  WHERE t.owner_id = s.owner_id
    AND t.deleted_at IS NULL
    AND t.remind_enabled
    AND public.todo_task_appears_on(t.owner_id, t.id, ctx.local_date)
    AND NOT EXISTS (
      SELECT 1
      FROM public.todo_daily_completions c
      WHERE c.owner_id = t.owner_id
        AND c.task_id = t.id
        AND c.completion_date = ctx.local_date
        AND c.completed
    )
) items ON TRUE
WHERE (s.feishu_webhook IS NOT NULL OR s.wecom_webhook IS NOT NULL)
  AND s.digest_enabled
  AND items.list IS NOT NULL
  AND (ctx.local_date + s.digest_time) AT TIME ZONE 'Asia/Shanghai'
      >= p_now - make_interval(mins => GREATEST(p_grace_minutes, 0))
  AND (ctx.local_date + s.digest_time) AT TIME ZONE 'Asia/Shanghai' <= p_now;
$$;

/* ---------------- 领取 / 记账 / 清理 ---------------- */

-- 返回 true 表示本次确实由调用方领取；重复调用或超过重试上限返回 false。
-- p_device_id 只对桌面通道有值：同账号多台电脑各弹各的，互不抢锁。
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
  IF p_kind NOT IN ('task', 'digest') OR p_channel NOT IN ('feishu', 'wecom', 'desktop') THEN
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

CREATE OR REPLACE FUNCTION public.reminder_mark(
  p_owner_id TEXT,
  p_kind TEXT,
  p_ref_id TEXT,
  p_remind_date DATE,
  p_channel TEXT,
  p_status TEXT,
  p_error TEXT DEFAULT NULL,
  p_device_id TEXT DEFAULT ''
)
RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
BEGIN
  IF p_status NOT IN ('sent', 'failed', 'skipped') THEN
    RAISE EXCEPTION 'Unsupported reminder status';
  END IF;

  UPDATE public.todo_reminder_log
  SET status = p_status,
      sent_at = CASE WHEN p_status = 'sent' THEN now() ELSE sent_at END,
      last_error = CASE
        WHEN p_status = 'sent' THEN NULL
        ELSE left(COALESCE(p_error, ''), 300)
      END
  WHERE owner_id = p_owner_id
    AND kind = p_kind
    AND ref_id = p_ref_id
    AND remind_date = p_remind_date
    AND channel = p_channel
    AND device_id = COALESCE(p_device_id, '');
  RETURN FOUND;
END;
$$;

CREATE OR REPLACE FUNCTION public.reminder_purge(p_days INTEGER DEFAULT 60)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  logs INTEGER;
  tokens INTEGER;
BEGIN
  DELETE FROM public.todo_reminder_log
  WHERE remind_date < (now() AT TIME ZONE 'Asia/Shanghai')::DATE - GREATEST(p_days, 7);
  GET DIAGNOSTICS logs = ROW_COUNT;

  DELETE FROM public.todo_reminder_tokens
  WHERE expires_at < now() - interval '7 days';
  GET DIAGNOSTICS tokens = ROW_COUNT;

  RETURN jsonb_build_object('logs', logs, 'tokens', tokens);
END;
$$;

/* ---------------- 令牌 ---------------- */

CREATE OR REPLACE FUNCTION public.reminder_token_issue(
  p_owner_id TEXT,
  p_task_id TEXT,
  p_remind_date DATE,
  p_token_hash TEXT,
  p_ttl_hours INTEGER DEFAULT 168
)
RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
BEGIN
  INSERT INTO public.todo_reminder_tokens (
    token_hash, owner_id, task_id, remind_date, expires_at
  ) VALUES (
    p_token_hash, p_owner_id, p_task_id, p_remind_date,
    now() + make_interval(hours => LEAST(GREATEST(p_ttl_hours, 1), 720))
  )
  ON CONFLICT (token_hash) DO NOTHING;
  RETURN FOUND;
END;
$$;

-- 幂等：同一链接点第二次只返回 already = true，不会重复写完成记录。
CREATE OR REPLACE FUNCTION public.reminder_complete_by_token(p_token_hash TEXT)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  token public.todo_reminder_tokens%ROWTYPE;
  task public.todo_tasks%ROWTYPE;
  completion_date DATE;
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

  completion_date := CASE
    WHEN task.type = 'single' THEN task.task_date
    ELSE token.remind_date
  END;

  INSERT INTO public.todo_daily_completions (
    owner_id, task_id, completion_date, completed, updated_at
  ) VALUES (
    token.owner_id, token.task_id, completion_date, TRUE, now()
  )
  ON CONFLICT (owner_id, task_id, completion_date) DO UPDATE
    SET completed = TRUE, updated_at = now();

  RETURN jsonb_build_object(
    'ok', TRUE,
    'title', task.title,
    'date', completion_date
  );
END;
$$;

/* ---------------- 浏览器可调用的设置读写 ---------------- */

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
    'grace_minutes', settings_row.grace_minutes,
    'quiet_start', CASE WHEN settings_row.quiet_start IS NULL THEN NULL ELSE to_char(settings_row.quiet_start, 'HH24:MI') END,
    'quiet_end', CASE WHEN settings_row.quiet_end IS NULL THEN NULL ELSE to_char(settings_row.quiet_end, 'HH24:MI') END
  );
END;
$$;

-- 只覆盖调用方明确给出的字段；空字符串表示清除该通道。
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
    grace_minutes, quiet_start, quiet_end, updated_at
  ) VALUES (
    next.owner_id, next.feishu_webhook, next.wecom_webhook, next.digest_enabled,
    next.digest_time, next.grace_minutes, next.quiet_start, next.quiet_end, now()
  )
  ON CONFLICT (owner_id) DO UPDATE
    SET feishu_webhook = EXCLUDED.feishu_webhook,
        wecom_webhook = EXCLUDED.wecom_webhook,
        digest_enabled = EXCLUDED.digest_enabled,
        digest_time = EXCLUDED.digest_time,
        grace_minutes = EXCLUDED.grace_minutes,
        quiet_start = EXCLUDED.quiet_start,
        quiet_end = EXCLUDED.quiet_end,
        updated_at = now();

  RETURN public.reminder_settings_read();
END;
$$;

/* ---------------- 备份恢复：补上提醒字段 ---------------- */

-- 导出端用 select("*")，会带上 remind_time / remind_enabled；恢复端必须同步写入，
-- 否则从备份恢复后提醒设置会静默丢失。旧备份缺少这两个字段时回落为无提醒时间、默认开启。
CREATE OR REPLACE FUNCTION public.restore_todo_backup_v1(p_data JSONB)
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
      priority, start_time, end_time, remind_time, remind_enabled,
      deleted_at, created_at, updated_at
    ) VALUES (
      current_uid, item->>'id', item->>'title', item->>'type',
      (item->>'task_date')::DATE, (item->>'start_date')::DATE, (item->>'end_date')::DATE,
      COALESCE(item->>'priority', 'normal'), (item->>'start_time')::TIME,
      (item->>'end_time')::TIME, (item->>'remind_time')::TIME,
      COALESCE((item->>'remind_enabled')::BOOLEAN, TRUE),
      (item->>'deleted_at')::TIMESTAMPTZ,
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

/* ---------------- 权限：服务端函数只给 service_role ---------------- */
REVOKE ALL ON FUNCTION public.todo_task_appears_on(TEXT, TEXT, DATE)
  FROM public, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.todo_task_appears_on(TEXT, TEXT, DATE) TO service_role;

REVOKE ALL ON FUNCTION public.reminder_quiet_active(TIME, TIME, TIME)
  FROM public, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.reminder_quiet_active(TIME, TIME, TIME) TO service_role;

REVOKE ALL ON FUNCTION public.reminder_mask_url(TEXT)
  FROM public, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.reminder_mask_url(TEXT) TO service_role;

REVOKE ALL ON FUNCTION public.reminder_due_batch(TIMESTAMPTZ)
  FROM public, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.reminder_due_batch(TIMESTAMPTZ) TO service_role;

REVOKE ALL ON FUNCTION public.reminder_digest_batch(TIMESTAMPTZ, INTEGER)
  FROM public, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.reminder_digest_batch(TIMESTAMPTZ, INTEGER) TO service_role;

REVOKE ALL ON FUNCTION public.reminder_claim(TEXT, TEXT, TEXT, DATE, TEXT, TEXT)
  FROM public, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.reminder_claim(TEXT, TEXT, TEXT, DATE, TEXT, TEXT) TO service_role;

REVOKE ALL ON FUNCTION public.reminder_mark(TEXT, TEXT, TEXT, DATE, TEXT, TEXT, TEXT, TEXT)
  FROM public, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.reminder_mark(TEXT, TEXT, TEXT, DATE, TEXT, TEXT, TEXT, TEXT) TO service_role;

REVOKE ALL ON FUNCTION public.reminder_purge(INTEGER)
  FROM public, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.reminder_purge(INTEGER) TO service_role;

REVOKE ALL ON FUNCTION public.reminder_token_issue(TEXT, TEXT, DATE, TEXT, INTEGER)
  FROM public, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.reminder_token_issue(TEXT, TEXT, DATE, TEXT, INTEGER) TO service_role;

REVOKE ALL ON FUNCTION public.reminder_complete_by_token(TEXT)
  FROM public, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.reminder_complete_by_token(TEXT) TO service_role;

-- 桌面设备端函数：由 SCF 代理，使用 service_role 调用
REVOKE ALL ON FUNCTION public.reminder_device_pair(TEXT, TEXT, TEXT)
  FROM public, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.reminder_device_pair(TEXT, TEXT, TEXT) TO service_role;

REVOKE ALL ON FUNCTION public.reminder_device_feed(TEXT, TIMESTAMPTZ)
  FROM public, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.reminder_device_feed(TEXT, TIMESTAMPTZ) TO service_role;

REVOKE ALL ON FUNCTION public.reminder_device_ack(TEXT, TEXT, DATE, TEXT)
  FROM public, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.reminder_device_ack(TEXT, TEXT, DATE, TEXT) TO service_role;

REVOKE ALL ON FUNCTION public.reminder_device_complete(TEXT, TEXT, DATE)
  FROM public, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.reminder_device_complete(TEXT, TEXT, DATE) TO service_role;

-- 浏览器侧管理配对与设备：校验 auth.uid() 与 authenticated
REVOKE ALL ON FUNCTION public.reminder_pairing_create() FROM public, anon;
GRANT EXECUTE ON FUNCTION public.reminder_pairing_create() TO authenticated;
GRANT EXECUTE ON FUNCTION public.reminder_pairing_create() TO service_role;

REVOKE ALL ON FUNCTION public.reminder_devices_list() FROM public, anon;
GRANT EXECUTE ON FUNCTION public.reminder_devices_list() TO authenticated;
GRANT EXECUTE ON FUNCTION public.reminder_devices_list() TO service_role;

REVOKE ALL ON FUNCTION public.reminder_device_revoke(TEXT) FROM public, anon;
GRANT EXECUTE ON FUNCTION public.reminder_device_revoke(TEXT) TO authenticated;
GRANT EXECUTE ON FUNCTION public.reminder_device_revoke(TEXT) TO service_role;

-- 浏览器只需要这两个；它们内部强制校验 auth.uid() 与 authenticated 角色。
REVOKE ALL ON FUNCTION public.reminder_settings_read() FROM public, anon;
GRANT EXECUTE ON FUNCTION public.reminder_settings_read() TO authenticated;
GRANT EXECUTE ON FUNCTION public.reminder_settings_read() TO service_role;

REVOKE ALL ON FUNCTION public.reminder_settings_save(JSONB) FROM public, anon;
GRANT EXECUTE ON FUNCTION public.reminder_settings_save(JSONB) TO authenticated;
GRANT EXECUTE ON FUNCTION public.reminder_settings_save(JSONB) TO service_role;

-- Rollback reference (run only after explicit approval):
-- DROP FUNCTION public.reminder_device_revoke(TEXT);
-- DROP FUNCTION public.reminder_devices_list();
-- DROP FUNCTION public.reminder_device_complete(TEXT, TEXT, DATE);
-- DROP FUNCTION public.reminder_device_ack(TEXT, TEXT, DATE, TEXT);
-- DROP FUNCTION public.reminder_device_feed(TEXT, TIMESTAMPTZ);
-- DROP FUNCTION public.reminder_device_pair(TEXT, TEXT, TEXT);
-- DROP FUNCTION public.reminder_pairing_create();
-- DROP FUNCTION public.reminder_settings_save(JSONB);
-- DROP FUNCTION public.reminder_settings_read();
-- DROP FUNCTION public.reminder_complete_by_token(TEXT);
-- DROP FUNCTION public.reminder_token_issue(TEXT, TEXT, DATE, TEXT, INTEGER);
-- DROP FUNCTION public.reminder_purge(INTEGER);
-- DROP FUNCTION public.reminder_mark(TEXT, TEXT, TEXT, DATE, TEXT, TEXT, TEXT, TEXT);
-- DROP FUNCTION public.reminder_claim(TEXT, TEXT, TEXT, DATE, TEXT, TEXT);
-- DROP FUNCTION public.reminder_digest_batch(TIMESTAMPTZ, INTEGER);
-- DROP FUNCTION public.reminder_due_batch(TIMESTAMPTZ);
-- DROP FUNCTION public.reminder_mask_url(TEXT);
-- DROP FUNCTION public.reminder_quiet_active(TIME, TIME, TIME);
-- DROP FUNCTION public.todo_task_appears_on(TEXT, TEXT, DATE);
-- DROP TABLE public.todo_reminder_tokens;
-- DROP TABLE public.todo_reminder_pairings;
-- DROP TABLE public.todo_reminder_devices;
-- DROP TABLE public.todo_reminder_log;
-- DROP TABLE public.todo_reminder_settings;
-- DROP INDEX public.todo_tasks_owner_remind_idx;
-- ALTER TABLE public.todo_tasks DROP COLUMN remind_enabled;
-- ALTER TABLE public.todo_tasks DROP COLUMN remind_time;
