-- CloudBase grants EXECUTE to anon explicitly by default; remove that grant.
REVOKE EXECUTE ON FUNCTION public.restore_todo_backup_v1(JSONB) FROM anon;
