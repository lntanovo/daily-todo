-- CloudBase PG may grant table-owner privileges automatically for new tables.
-- Browser users only need CRUD; keep TRUNCATE / REFERENCES / TRIGGER unavailable.
REVOKE TRUNCATE, REFERENCES, TRIGGER
ON TABLE public.todo_tasks, public.todo_daily_completions
FROM authenticated;
