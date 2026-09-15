-- Run through managePgDatabase (not the browser) to operate public registration.
-- Current production values:
update public.friend_registration_settings
set enabled = true, daily_limit = 20, total_limit = 100
where id = 1;

-- Emergency stop:
-- update public.friend_registration_settings set enabled = false where id = 1;
