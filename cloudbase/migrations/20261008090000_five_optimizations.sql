-- Five optimizations: recurring tasks, focus sync, templates and recoverable deletion.
-- This migration is additive except for widening the existing task schedule checks.

ALTER TABLE public.todo_tasks
  ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ;

ALTER TABLE public.todo_tasks DROP CONSTRAINT IF EXISTS todo_tasks_type_check;
ALTER TABLE public.todo_tasks DROP CONSTRAINT IF EXISTS todo_tasks_dates_check;

ALTER TABLE public.todo_tasks
  ADD CONSTRAINT todo_tasks_type_check
  CHECK (type IN ('single', 'range', 'recurring'));

ALTER TABLE public.todo_tasks
  ADD CONSTRAINT todo_tasks_dates_check CHECK (
    (type = 'single' AND task_date IS NOT NULL AND start_date IS NULL AND end_date IS NULL)
    OR
    (type = 'range' AND task_date IS NULL AND start_date IS NOT NULL AND end_date IS NOT NULL AND end_date >= start_date)
    OR
    (type = 'recurring' AND task_date IS NULL AND start_date IS NULL AND end_date IS NULL)
  );

CREATE INDEX IF NOT EXISTS todo_tasks_owner_active_idx
  ON public.todo_tasks (owner_id, created_at DESC)
  WHERE deleted_at IS NULL;

CREATE TABLE public.todo_task_recurrences (
  owner_id TEXT NOT NULL DEFAULT auth.uid(),
  task_id TEXT NOT NULL,
  frequency TEXT NOT NULL CHECK (frequency IN ('weekly', 'monthly')),
  weekdays SMALLINT[],
  month_day SMALLINT,
  start_date DATE NOT NULL,
  end_date DATE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (owner_id, task_id),
  CONSTRAINT todo_task_recurrences_task_fk
    FOREIGN KEY (owner_id, task_id)
    REFERENCES public.todo_tasks (owner_id, id)
    ON DELETE CASCADE,
  CONSTRAINT todo_task_recurrences_window_check
    CHECK (end_date IS NULL OR end_date >= start_date),
  CONSTRAINT todo_task_recurrences_rule_check CHECK (
    (
      frequency = 'weekly'
      AND weekdays IS NOT NULL
      AND cardinality(weekdays) BETWEEN 1 AND 7
      AND weekdays <@ ARRAY[1,2,3,4,5,6,7]::SMALLINT[]
      AND month_day IS NULL
    )
    OR
    (
      frequency = 'monthly'
      AND weekdays IS NULL
      AND month_day BETWEEN 1 AND 31
    )
  )
);

CREATE INDEX todo_task_recurrences_owner_window_idx
  ON public.todo_task_recurrences (owner_id, start_date, end_date);

CREATE TABLE public.todo_task_templates (
  owner_id TEXT NOT NULL DEFAULT auth.uid(),
  id TEXT NOT NULL,
  name TEXT NOT NULL CHECK (char_length(name) BETWEEN 1 AND 80),
  title TEXT NOT NULL CHECK (char_length(title) BETWEEN 1 AND 160),
  priority TEXT NOT NULL DEFAULT 'normal' CHECK (priority IN ('normal', 'urgent')),
  start_time TIME,
  end_time TIME,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (owner_id, id),
  CONSTRAINT todo_task_templates_time_check CHECK (
    start_time IS NULL OR end_time IS NULL OR end_time > start_time
  )
);

CREATE INDEX todo_task_templates_owner_updated_idx
  ON public.todo_task_templates (owner_id, updated_at DESC);

CREATE TABLE public.todo_focus_sessions (
  owner_id TEXT NOT NULL DEFAULT auth.uid(),
  id TEXT NOT NULL,
  phase TEXT NOT NULL CHECK (phase IN ('focus', 'break')),
  status TEXT NOT NULL CHECK (status IN ('running', 'paused', 'completed', 'ended')),
  planned_seconds INTEGER NOT NULL CHECK (planned_seconds BETWEEN 60 AND 86400),
  elapsed_seconds INTEGER NOT NULL DEFAULT 0 CHECK (elapsed_seconds >= 0),
  task_id TEXT,
  task_title_snapshot TEXT CHECK (task_title_snapshot IS NULL OR char_length(task_title_snapshot) BETWEEN 1 AND 160),
  started_at TIMESTAMPTZ NOT NULL,
  running_since TIMESTAMPTZ,
  deadline_at TIMESTAMPTZ,
  ended_at TIMESTAMPTZ,
  segments JSONB NOT NULL DEFAULT '[]'::JSONB CHECK (jsonb_typeof(segments) = 'array'),
  revision BIGINT NOT NULL DEFAULT 1 CHECK (revision > 0),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (owner_id, id)
);

CREATE UNIQUE INDEX todo_focus_sessions_one_active_per_owner_idx
  ON public.todo_focus_sessions (owner_id)
  WHERE status IN ('running', 'paused');

CREATE INDEX todo_focus_sessions_owner_started_idx
  ON public.todo_focus_sessions (owner_id, started_at DESC);

CREATE OR REPLACE FUNCTION public.validate_todo_task_recurrence()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog, public
AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM public.todo_tasks
    WHERE owner_id = NEW.owner_id AND id = NEW.task_id AND type = 'recurring'
  ) THEN
    RAISE EXCEPTION 'recurrence requires a recurring task owned by the same account';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER todo_task_recurrences_validate
BEFORE INSERT OR UPDATE ON public.todo_task_recurrences
FOR EACH ROW EXECUTE FUNCTION public.validate_todo_task_recurrence();

CREATE OR REPLACE FUNCTION public.sync_todo_schedule_completions()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog, public
AS $$
DECLARE
  had_completion BOOLEAN;
BEGIN
  IF (OLD.type, OLD.task_date, OLD.start_date, OLD.end_date)
    IS NOT DISTINCT FROM
    (NEW.type, NEW.task_date, NEW.start_date, NEW.end_date) THEN
    RETURN NEW;
  END IF;

  -- Recurring completions are independent occurrences. Keep them as history when
  -- entering or leaving recurring mode; the UI only renders dates matching the rule.
  IF OLD.type = 'recurring' OR NEW.type = 'recurring' THEN
    RETURN NEW;
  END IF;

  IF OLD.type = 'single' AND NEW.type = 'single' THEN
    UPDATE public.todo_daily_completions
    SET completion_date = NEW.task_date, updated_at = now()
    WHERE owner_id = NEW.owner_id AND task_id = NEW.id;
  ELSIF OLD.type = 'range' AND NEW.type = 'range' THEN
    DELETE FROM public.todo_daily_completions
    WHERE owner_id = NEW.owner_id AND task_id = NEW.id
      AND (completion_date < NEW.start_date OR completion_date > NEW.end_date);
  ELSIF OLD.type = 'single' AND NEW.type = 'range' THEN
    DELETE FROM public.todo_daily_completions
    WHERE owner_id = NEW.owner_id AND task_id = NEW.id
      AND (completion_date < NEW.start_date OR completion_date > NEW.end_date);
  ELSE
    SELECT EXISTS (
      SELECT 1 FROM public.todo_daily_completions
      WHERE owner_id = NEW.owner_id AND task_id = NEW.id AND completed = TRUE
    ) INTO had_completion;
    DELETE FROM public.todo_daily_completions
    WHERE owner_id = NEW.owner_id AND task_id = NEW.id;
    IF had_completion THEN
      INSERT INTO public.todo_daily_completions (owner_id, task_id, completion_date, completed, updated_at)
      VALUES (NEW.owner_id, NEW.id, NEW.task_date, TRUE, now());
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

GRANT SELECT, INSERT, UPDATE, DELETE ON public.todo_task_recurrences TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.todo_task_templates TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.todo_focus_sessions TO authenticated;
GRANT ALL ON public.todo_task_recurrences, public.todo_task_templates, public.todo_focus_sessions TO service_role;

ALTER TABLE public.todo_task_recurrences ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.todo_task_recurrences FORCE ROW LEVEL SECURITY;
ALTER TABLE public.todo_task_templates ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.todo_task_templates FORCE ROW LEVEL SECURITY;
ALTER TABLE public.todo_focus_sessions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.todo_focus_sessions FORCE ROW LEVEL SECURITY;

CREATE POLICY todo_task_recurrences_select_own ON public.todo_task_recurrences
  FOR SELECT TO authenticated USING (owner_id = auth.uid());
CREATE POLICY todo_task_recurrences_insert_own ON public.todo_task_recurrences
  FOR INSERT TO authenticated WITH CHECK (owner_id = auth.uid());
CREATE POLICY todo_task_recurrences_update_own ON public.todo_task_recurrences
  FOR UPDATE TO authenticated USING (owner_id = auth.uid()) WITH CHECK (owner_id = auth.uid());
CREATE POLICY todo_task_recurrences_delete_own ON public.todo_task_recurrences
  FOR DELETE TO authenticated USING (owner_id = auth.uid());

CREATE POLICY todo_task_templates_select_own ON public.todo_task_templates
  FOR SELECT TO authenticated USING (owner_id = auth.uid());
CREATE POLICY todo_task_templates_insert_own ON public.todo_task_templates
  FOR INSERT TO authenticated WITH CHECK (owner_id = auth.uid());
CREATE POLICY todo_task_templates_update_own ON public.todo_task_templates
  FOR UPDATE TO authenticated USING (owner_id = auth.uid()) WITH CHECK (owner_id = auth.uid());
CREATE POLICY todo_task_templates_delete_own ON public.todo_task_templates
  FOR DELETE TO authenticated USING (owner_id = auth.uid());

CREATE POLICY todo_focus_sessions_select_own ON public.todo_focus_sessions
  FOR SELECT TO authenticated USING (owner_id = auth.uid());
CREATE POLICY todo_focus_sessions_insert_own ON public.todo_focus_sessions
  FOR INSERT TO authenticated WITH CHECK (owner_id = auth.uid());
CREATE POLICY todo_focus_sessions_update_own ON public.todo_focus_sessions
  FOR UPDATE TO authenticated USING (owner_id = auth.uid()) WITH CHECK (owner_id = auth.uid());
CREATE POLICY todo_focus_sessions_delete_own ON public.todo_focus_sessions
  FOR DELETE TO authenticated USING (owner_id = auth.uid());

-- Rollback reference (run only after explicit approval and after exporting data):
-- DROP TABLE public.todo_focus_sessions;
-- DROP TABLE public.todo_task_templates;
-- DROP TABLE public.todo_task_recurrences;
-- ALTER TABLE public.todo_tasks DROP COLUMN deleted_at;
