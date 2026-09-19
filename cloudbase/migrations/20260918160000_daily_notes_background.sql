-- Additive v1.3 migration; existing tasks and completions are untouched.
CREATE TABLE public.todo_daily_notes (
  owner_id TEXT NOT NULL DEFAULT auth.uid(),
  task_id TEXT NOT NULL,
  note_date DATE NOT NULL,
  content TEXT NOT NULL CHECK (char_length(btrim(content)) BETWEEN 1 AND 500),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (owner_id, task_id, note_date),
  FOREIGN KEY (owner_id, task_id) REFERENCES public.todo_tasks(owner_id,id) ON DELETE CASCADE
);
CREATE INDEX todo_daily_notes_owner_date_idx ON public.todo_daily_notes(owner_id,note_date);
CREATE TABLE public.todo_preferences (
  owner_id TEXT PRIMARY KEY DEFAULT auth.uid(),
  background_kind TEXT NOT NULL DEFAULT 'paper' CHECK (background_kind IN ('paper','preset','upload')),
  background_value TEXT NOT NULL DEFAULT '',
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK ((background_kind='paper' AND background_value='') OR
         (background_kind='preset' AND background_value ~ '^[A-Za-z0-9_-]{1,80}$') OR
         (background_kind='upload' AND split_part(background_value,'/',1)=owner_id
          AND background_value ~ '^[A-Za-z0-9_-]+/[A-Za-z0-9_-]+\.(webp|png|jpg|gif)$'))
);
REVOKE ALL ON public.todo_daily_notes, public.todo_preferences FROM anon;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.todo_daily_notes, public.todo_preferences TO authenticated;
GRANT ALL ON public.todo_daily_notes, public.todo_preferences TO service_role;
ALTER TABLE public.todo_daily_notes ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.todo_preferences ENABLE ROW LEVEL SECURITY;
CREATE POLICY todo_notes_own ON public.todo_daily_notes FOR ALL TO authenticated
  USING (owner_id=auth.uid()) WITH CHECK (owner_id=auth.uid());
CREATE POLICY todo_preferences_own ON public.todo_preferences FOR ALL TO authenticated
  USING (owner_id=auth.uid()) WITH CHECK (owner_id=auth.uid());

INSERT INTO storage.buckets (id,name,public,file_size_limit,allowed_mime_types)
VALUES ('todo-backgrounds','todo-backgrounds',false,10485760,ARRAY['image/jpeg','image/png','image/webp','image/gif']);
ALTER TABLE storage.objects ENABLE ROW LEVEL SECURITY;
CREATE POLICY todo_backgrounds_select ON storage.objects FOR SELECT TO authenticated
  USING (bucket_id='todo-backgrounds' AND (storage.foldername(name))[1]=auth.uid());
CREATE POLICY todo_backgrounds_insert ON storage.objects FOR INSERT TO authenticated
  WITH CHECK (bucket_id='todo-backgrounds' AND (storage.foldername(name))[1]=auth.uid());
CREATE POLICY todo_backgrounds_delete ON storage.objects FOR DELETE TO authenticated
  USING (bucket_id='todo-backgrounds' AND (storage.foldername(name))[1]=auth.uid());

-- No UPDATE policy for objects: uploads use unique keys, then replace the preference.
-- Rollback requires explicit approval; export notes/preferences first. Delete stored
-- objects through the Storage API, never by deleting rows in storage.objects.
