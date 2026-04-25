-- Master/Viewer playback coordination primitives.
-- Single global row in playback_control acts as source-of-truth for current
-- media/status and active master instance heartbeat.

create table if not exists public.playback_control (
  id integer primary key default 1 check (id = 1),
  current_video_id uuid references public.media_items(id) on delete set null,
  current_status text check (current_status in ('IDLE', 'LOADING', 'PLAYING', 'PAUSED', 'ENDED')),
  master_instance_id uuid,
  master_last_seen timestamptz not null default now(),
  playback_position double precision not null default 0,
  last_updated timestamptz not null default now()
);

create table if not exists public.player_instances (
  instance_id uuid primary key default gen_random_uuid(),
  connection_status text not null default 'ONLINE' check (connection_status in ('ONLINE', 'OFFLINE')),
  is_master boolean not null default false,
  last_seen timestamptz not null default now(),
  user_agent text,
  ip_address text,
  connected_at timestamptz not null default now(),
  last_heartbeat timestamptz
);

create table if not exists public.player_logs (
  id bigserial primary key,
  "timestamp" timestamptz not null default now(),
  event_type text not null,
  instance_id uuid,
  message text not null,
  details jsonb not null default '{}'::jsonb
);

alter table public.playback_control enable row level security;
alter table public.player_instances enable row level security;
alter table public.player_logs enable row level security;

drop policy if exists "Admin full access" on public.playback_control;
drop policy if exists "Admin full access" on public.player_instances;
drop policy if exists "Admin full access" on public.player_logs;

create policy "Admin full access" on public.playback_control for all using (true) with check (true);
create policy "Admin full access" on public.player_instances for all using (true) with check (true);
create policy "Admin full access" on public.player_logs for all using (true) with check (true);

insert into public.playback_control (id, current_status, master_last_seen, last_updated)
values (1, 'IDLE', now(), now())
on conflict (id) do nothing;

create or replace function public.log_player_event(
  p_event_type text,
  p_instance_id uuid,
  p_message text,
  p_details jsonb default '{}'::jsonb
)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.player_logs(event_type, instance_id, message, details)
  values (coalesce(p_event_type, 'info'), p_instance_id, coalesce(p_message, ''), coalesce(p_details, '{}'::jsonb));
end;
$$;

create or replace function public.claim_playback_master(
  p_instance_id uuid,
  p_reason text default 'heartbeat_claim'
)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  v_current_master uuid;
  v_master_last_seen timestamptz;
  v_claimed boolean := false;
begin
  select master_instance_id, master_last_seen
  into v_current_master, v_master_last_seen
  from public.playback_control
  where id = 1
  for update;

  if v_current_master is null
     or v_current_master = p_instance_id
     or v_master_last_seen < now() - interval '20 seconds'
  then
    update public.playback_control
    set master_instance_id = p_instance_id,
        master_last_seen = now(),
        last_updated = now()
    where id = 1;

    update public.player_instances
    set is_master = (instance_id = p_instance_id),
        connection_status = 'ONLINE',
        last_seen = now(),
        last_heartbeat = now()
    where instance_id = p_instance_id or is_master = true;

    perform public.log_player_event(
      'master_change',
      p_instance_id,
      format('Player %s became master (%s)', p_instance_id, coalesce(p_reason, 'unknown')),
      jsonb_build_object('previous_master', v_current_master, 'reason', p_reason)
    );
    v_claimed := true;
  end if;

  return v_claimed;
end;
$$;

create or replace function public.heartbeat_playback_master(p_instance_id uuid)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  v_updated integer := 0;
begin
  update public.playback_control
  set master_last_seen = now(),
      last_updated = now()
  where id = 1 and master_instance_id = p_instance_id;
  get diagnostics v_updated = row_count;

  update public.player_instances
  set connection_status = 'ONLINE',
      last_seen = now(),
      last_heartbeat = now(),
      is_master = (p_instance_id = (select master_instance_id from public.playback_control where id = 1))
  where instance_id = p_instance_id;

  return v_updated > 0;
end;
$$;

create or replace function public.force_master_instance(
  p_instance_id uuid,
  p_message text default 'admin_forced'
)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  update public.playback_control
  set master_instance_id = p_instance_id,
      master_last_seen = now(),
      last_updated = now()
  where id = 1;

  update public.player_instances
  set is_master = (instance_id = p_instance_id),
      connection_status = case when instance_id = p_instance_id then 'ONLINE' else connection_status end,
      last_seen = case when instance_id = p_instance_id then now() else last_seen end
  where instance_id = p_instance_id or is_master = true;

  perform public.log_player_event(
    'master_forced',
    p_instance_id,
    format('Admin forced %s as master (%s)', p_instance_id, coalesce(p_message, 'manual')),
    jsonb_build_object('reason', p_message)
  );
end;
$$;

grant execute on function public.log_player_event(text, uuid, text, jsonb) to anon, authenticated, service_role;
grant execute on function public.claim_playback_master(uuid, text) to anon, authenticated, service_role;
grant execute on function public.heartbeat_playback_master(uuid) to anon, authenticated, service_role;
grant execute on function public.force_master_instance(uuid, text) to authenticated, service_role;

do $$
begin
  begin
    alter publication supabase_realtime add table public.playback_control;
  exception when duplicate_object then
    null;
  end;
  begin
    alter publication supabase_realtime add table public.player_instances;
  exception when duplicate_object then
    null;
  end;
  begin
    alter publication supabase_realtime add table public.player_logs;
  exception when duplicate_object then
    null;
  end;
end $$;
