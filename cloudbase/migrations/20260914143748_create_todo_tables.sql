-- Daily Todo initial PostgreSQL schema.
-- CloudBase Auth supplies auth.uid(); browser inserts must not send owner_id.

CREATE TABLE public.todo_tasks (
  owner_id  TEXT        NOT NULL DEFAULT auth.uid(),
  id        TEXT        NOT NULL,
  title     TEXT        NOT NULL,
  type      TEXT        NOT NULL,
  task_date DATE,
  start_date DATE,
  end_date   DATE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT todo_tasks_pkey PRIMARY KEY (owner_id, id),
  CONSTRAINT todo_tasks_title_check
    CHECK (char_length(btrim(title)) BETWEEN 1 AND 160),
  CONSTRAINT todo_tasks_type_check
    CHECK (type IN ('single', 'range')),
  CONSTRAINT todo_tasks_dates_check CHECK (
    (
      type = 'single'
      AND task_date IS NOT NULL
      AND start_date IS NULL
      AND end_date IS NULL
    )
    OR
    (
      type = 'range'
      AND task_date IS NULL
      AND start_date IS NOT NULL
      AND end_date IS NOT NULL
      AND start_date <= end_date
    )
  )
);

CREATE INDEX todo_tasks_owner_task_date_idx
  ON public.todo_tasks (owner_id, task_date);

CREATE INDEX todo_tasks_owner_range_idx
  ON public.todo_tasks (owner_id, start_date, end_date);

CREATE TABLE public.todo_daily_completions (
  owner_id       TEXT        NOT NULL DEFAULT auth.uid(),
  task_id        TEXT        NOT NULL,
  completion_date DATE       NOT NULL,
  completed      BOOLEAN     NOT NULL DEFAULT TRUE,
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT todo_daily_completions_pkey
    PRIMARY KEY (owner_id, task_id, completion_date),
  CONSTRAINT todo_daily_completions_task_fkey
    FOREIGN KEY (owner_id, task_id)
    REFERENCES public.todo_tasks (owner_id, id)
    ON DELETE CASCADE
);

CREATE INDEX todo_daily_completions_owner_date_idx
  ON public.todo_daily_completions (owner_id, completion_date);

GRANT USAGE ON SCHEMA public TO authenticated, service_role;

GRANT SELECT, INSERT, UPDATE, DELETE
  ON public.todo_tasks, public.todo_daily_completions
  TO authenticated;

GRANT ALL
  ON public.todo_tasks, public.todo_daily_completions
  TO service_role;

ALTER TABLE public.todo_tasks ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.todo_daily_completions ENABLE ROW LEVEL SECURITY;

CREATE POLICY todo_tasks_select_own ON public.todo_tasks
  FOR SELECT TO authenticated
  USING (owner_id = auth.uid());

CREATE POLICY todo_tasks_insert_own ON public.todo_tasks
  FOR INSERT TO authenticated
  WITH CHECK (owner_id = auth.uid());

CREATE POLICY todo_tasks_update_own ON public.todo_tasks
  FOR UPDATE TO authenticated
  USING (owner_id = auth.uid())
  WITH CHECK (owner_id = auth.uid());

CREATE POLICY todo_tasks_delete_own ON public.todo_tasks
  FOR DELETE TO authenticated
  USING (owner_id = auth.uid());

CREATE POLICY todo_completions_select_own ON public.todo_daily_completions
  FOR SELECT TO authenticated
  USING (owner_id = auth.uid());

CREATE POLICY todo_completions_insert_own ON public.todo_daily_completions
  FOR INSERT TO authenticated
  WITH CHECK (owner_id = auth.uid());

CREATE POLICY todo_completions_update_own ON public.todo_daily_completions
  FOR UPDATE TO authenticated
  USING (owner_id = auth.uid())
  WITH CHECK (owner_id = auth.uid());

CREATE POLICY todo_completions_delete_own ON public.todo_daily_completions
  FOR DELETE TO authenticated
  USING (owner_id = auth.uid());

-- Rollback reference (run only after explicit approval):
-- DROP TABLE public.todo_daily_completions;
-- DROP TABLE public.todo_tasks;
