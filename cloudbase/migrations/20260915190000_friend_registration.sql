-- Private registration ledger: never expose these tables or RPCs to website users.
create table public.friend_registration_settings (
  id integer primary key check (id = 1),
  enabled boolean not null default false,
  daily_limit integer not null default 5 check (daily_limit between 0 and 100),
  total_limit integer not null default 100 check (total_limit between 0 and 10000),
  minute_start timestamptz not null default now(),
  minute_requests integer not null default 0
);
insert into public.friend_registration_settings (id) values (1);
create table public.friend_registrations (
  request_hash text primary key check (request_hash ~ '^[a-f0-9]{64}$'),
  payload_hash text not null check (payload_hash ~ '^[a-f0-9]{64}$'),
  username text unique not null,
  user_id text unique not null,
  nickname text not null check (char_length(nickname) between 2 and 32),
  relation text not null check (char_length(relation) between 1 and 80),
  status text not null default 'pending' check (status in ('pending', 'succeeded')),
  created_at timestamptz not null default now(),
  lease_until timestamptz not null default now() + interval '90 seconds',
  completed_at timestamptz
);
create index friend_registrations_created on public.friend_registrations (created_at);
alter table public.friend_registration_settings enable row level security;
alter table public.friend_registrations enable row level security;
revoke all on public.friend_registration_settings, public.friend_registrations from public, anon, authenticated;
grant all on public.friend_registration_settings, public.friend_registrations to service_role;

create function public.reserve_friend_registration(p_request_hash text, p_payload_hash text, p_nickname text, p_relation text)
returns jsonb language plpgsql security invoker set search_path = pg_catalog, public as $$
declare
  cfg public.friend_registration_settings%rowtype;
  entry public.friend_registrations%rowtype;
  today_start timestamptz := date_trunc('day', now() at time zone 'Asia/Shanghai') at time zone 'Asia/Shanghai';
begin
  select * into cfg from public.friend_registration_settings where id = 1 for update;
  if not found or not cfg.enabled then return jsonb_build_object('code', 'CLOSED'); end if;
  if cfg.minute_start < now() - interval '1 minute' then
    update public.friend_registration_settings set minute_start = now(), minute_requests = 1 where id = 1;
  elsif cfg.minute_requests >= 30 then
    return jsonb_build_object('code', 'RATE_LIMIT');
  else
    update public.friend_registration_settings set minute_requests = minute_requests + 1 where id = 1;
  end if;
  select * into entry from public.friend_registrations where request_hash = p_request_hash for update;
  if found then
    if entry.payload_hash <> p_payload_hash then return jsonb_build_object('code', 'CHANGED'); end if;
    if entry.status = 'succeeded' then return jsonb_build_object('code', 'DONE', 'username', entry.username); end if;
    if entry.lease_until > now() then return jsonb_build_object('code', 'BUSY'); end if;
    update public.friend_registrations set lease_until = now() + interval '90 seconds' where request_hash = p_request_hash;
    return jsonb_build_object('code', 'RESERVED', 'username', entry.username, 'uid', entry.user_id, 'retry', true);
  end if;
  if (select count(*) from public.friend_registrations) >= cfg.total_limit then return jsonb_build_object('code', 'TOTAL_LIMIT'); end if;
  if (select count(*) from public.friend_registrations where created_at >= today_start) >= cfg.daily_limit then return jsonb_build_object('code', 'DAILY_LIMIT'); end if;
  insert into public.friend_registrations (request_hash, payload_hash, username, user_id, nickname, relation)
  values (p_request_hash, p_payload_hash, 'ln_' || substr(p_request_hash, 1, 16), 'lnreg_' || substr(p_request_hash, 1, 48), p_nickname, p_relation)
  returning * into entry;
  return jsonb_build_object('code', 'RESERVED', 'username', entry.username, 'uid', entry.user_id, 'retry', false);
end;
$$;

create function public.complete_friend_registration(p_request_hash text, p_user_id text)
returns boolean language plpgsql security invoker set search_path = pg_catalog, public as $$
begin
  update public.friend_registrations set status = 'succeeded', completed_at = now()
  where request_hash = p_request_hash and user_id = p_user_id;
  return found;
end;
$$;
revoke all on function public.reserve_friend_registration(text,text,text,text), public.complete_friend_registration(text,text) from public, anon, authenticated;
grant execute on function public.reserve_friend_registration(text,text,text,text), public.complete_friend_registration(text,text) to service_role;
