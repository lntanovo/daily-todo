CREATE TABLE public.todo_completion_history (
  owner_id TEXT NOT NULL DEFAULT auth.uid(),
  task_id TEXT NOT NULL,
  task_title_snapshot TEXT NOT NULL CHECK (char_length(task_title_snapshot) BETWEEN 1 AND 160),
  completion_date DATE NOT NULL,
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  completed_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (owner_id, task_id, completion_date)
);

CREATE INDEX todo_completion_history_owner_date_idx
  ON public.todo_completion_history (owner_id, completion_date DESC)
  WHERE is_active = TRUE;

INSERT INTO public.todo_completion_history (
  owner_id, task_id, task_title_snapshot, completion_date, is_active, completed_at, updated_at
)
SELECT completion.owner_id, completion.task_id, task.title, completion.completion_date,
  completion.completed, completion.updated_at, completion.updated_at
FROM public.todo_daily_completions AS completion
JOIN public.todo_tasks AS task
  ON task.owner_id = completion.owner_id AND task.id = completion.task_id
ON CONFLICT (owner_id, task_id, completion_date) DO UPDATE SET
  task_title_snapshot = EXCLUDED.task_title_snapshot,
  is_active = EXCLUDED.is_active,
  updated_at = EXCLUDED.updated_at;

CREATE FUNCTION public.sync_todo_completion_history()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog, public
AS $$
DECLARE
  snapshot_title TEXT;
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF EXISTS (
      SELECT 1 FROM public.todo_tasks
      WHERE owner_id = OLD.owner_id AND id = OLD.task_id
    ) THEN
      UPDATE public.todo_completion_history
      SET is_active = FALSE, updated_at = now()
      WHERE owner_id = OLD.owner_id
        AND task_id = OLD.task_id
        AND completion_date = OLD.completion_date;
    END IF;
    RETURN OLD;
  END IF;

  IF TG_OP = 'UPDATE' AND (
    OLD.owner_id IS DISTINCT FROM NEW.owner_id
    OR OLD.task_id IS DISTINCT FROM NEW.task_id
    OR OLD.completion_date IS DISTINCT FROM NEW.completion_date
  ) THEN
    UPDATE public.todo_completion_history
    SET is_active = FALSE, updated_at = now()
    WHERE owner_id = OLD.owner_id
      AND task_id = OLD.task_id
      AND completion_date = OLD.completion_date;
  END IF;

  SELECT title INTO snapshot_title
  FROM public.todo_tasks
  WHERE owner_id = NEW.owner_id AND id = NEW.task_id;

  IF snapshot_title IS NULL THEN
    RETURN NEW;
  END IF;

  INSERT INTO public.todo_completion_history (
    owner_id, task_id, task_title_snapshot, completion_date, is_active, completed_at, updated_at
  ) VALUES (
    NEW.owner_id, NEW.task_id, snapshot_title, NEW.completion_date, NEW.completed,
    COALESCE(NEW.updated_at, now()), now()
  )
  ON CONFLICT (owner_id, task_id, completion_date) DO UPDATE SET
    task_title_snapshot = CASE
      WHEN public.todo_completion_history.is_active THEN public.todo_completion_history.task_title_snapshot
      ELSE EXCLUDED.task_title_snapshot
    END,
    is_active = EXCLUDED.is_active,
    completed_at = CASE
      WHEN EXCLUDED.is_active THEN now()
      ELSE public.todo_completion_history.completed_at
    END,
    updated_at = now();
  RETURN NEW;
END;
$$;

CREATE TRIGGER todo_completion_history_sync
AFTER INSERT OR UPDATE OR DELETE ON public.todo_daily_completions
FOR EACH ROW EXECUTE FUNCTION public.sync_todo_completion_history();

CREATE FUNCTION public.sync_todo_schedule_completions()
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

CREATE TRIGGER todo_schedule_completions_sync
AFTER UPDATE OF type, task_date, start_date, end_date ON public.todo_tasks
FOR EACH ROW EXECUTE FUNCTION public.sync_todo_schedule_completions();

GRANT SELECT, INSERT, UPDATE ON public.todo_completion_history TO authenticated;
GRANT ALL ON public.todo_completion_history TO service_role;

ALTER TABLE public.todo_completion_history ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.todo_completion_history FORCE ROW LEVEL SECURITY;

CREATE POLICY todo_completion_history_select_own ON public.todo_completion_history
  FOR SELECT TO authenticated USING (owner_id = auth.uid());
CREATE POLICY todo_completion_history_insert_own ON public.todo_completion_history
  FOR INSERT TO authenticated WITH CHECK (owner_id = auth.uid());
CREATE POLICY todo_completion_history_update_own ON public.todo_completion_history
  FOR UPDATE TO authenticated
  USING (owner_id = auth.uid()) WITH CHECK (owner_id = auth.uid());

-- Rollback reference (run only after explicit approval):
-- DROP TRIGGER todo_schedule_completions_sync ON public.todo_tasks;
-- DROP FUNCTION public.sync_todo_schedule_completions();
-- DROP TRIGGER todo_completion_history_sync ON public.todo_daily_completions;
-- DROP FUNCTION public.sync_todo_completion_history();
-- DROP TABLE public.todo_completion_history;
