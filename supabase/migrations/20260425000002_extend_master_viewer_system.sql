-- Extend existing master/viewer system with additional fields and functions
-- This migration adds the missing pieces from the implementation guide

-- Add missing fields to playback_control
alter table public.playback_control 
  add column if not exists video_url text,
  add column if not exists video_title text,
  add column if not exists video_artist text,
  add column if not exists version integer default 0;

-- Add missing fields to player_instances (renamed from player_connections in spec)
alter table public.player_instances 
  add column if not exists player_id uuid references public.players(id) on delete set null,
  add column if not exists tab_id text,
  add column if not exists viewport_width integer,
  add column if not exists viewport_height integer,
  add column if not exists disconnected_at timestamptz,
  add column if not exists connection_status text check (connection_status in ('ONLINE', 'OFFLINE', 'STALE'));

-- Update existing connection_status values if they don't match the new constraint
update public.player_instances 
set connection_status = 'ONLINE' 
where connection_status not in ('ONLINE', 'OFFLINE', 'STALE');

-- Add indexes for player_logs
create index if not exists idx_player_logs_timestamp on public.player_logs("timestamp" desc);
create index if not exists idx_player_logs_event_type on public.player_logs(event_type);
create index if not exists idx_player_logs_instance_id on public.player_logs(instance_id);

-- Function to release master role (graceful shutdown)
create or replace function public.release_master_role(p_instance_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  update public.playback_control 
  set master_instance_id = null,
      master_last_seen = null,
      last_updated = now()
  where id = 1 and master_instance_id = p_instance_id;

  if found then
    update public.player_instances 
    set is_master = false,
        disconnected_at = now(),
        connection_status = 'OFFLINE'
    where instance_id = p_instance_id;

    perform public.log_player_event(
      'MASTER_RELEASED',
      p_instance_id,
      'Master role released gracefully',
      jsonb_build_object('reason', 'graceful_shutdown')
    );
  end if;
end;
$$;

-- Function to mark stale connections offline
create or replace function public.cleanup_stale_connections()
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  stale_count integer;
begin
  update public.player_instances 
  set connection_status = 'STALE',
      is_master = false
  where last_heartbeat < now() - interval '30 seconds'
    and connection_status = 'ONLINE';

  get diagnostics stale_count = row_count;

  -- Also clear master if it's stale
  update public.playback_control 
  set master_instance_id = null,
      master_last_seen = null,
      last_updated = now()
  where id = 1 
    and master_last_seen < now() - interval '30 seconds';

  return stale_count;
end;
$$;

-- Function for admin refresh request (broadcast to all)
create or replace function public.request_player_refresh(
  p_requester text,
  p_player_id uuid
)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  perform public.log_player_event(
    'REFRESH_REQUEST',
    null,
    format('Admin refresh requested by %s', p_requester),
    jsonb_build_object('requested_by', p_requester, 'timestamp', now(), 'player_id', p_player_id)
  );
end;
$$;

-- Function to log player state response
create or replace function public.log_player_response(
  p_instance_id uuid,
  p_player_id uuid,
  p_state jsonb
)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  perform public.log_player_event(
    'REFRESH_RESPONSE',
    p_instance_id,
    'Player responded to refresh request',
    jsonb_build_object('state', p_state, 'responded_at', now(), 'player_id', p_player_id)
  );

  update public.player_instances 
  set last_seen = now()
  where instance_id = p_instance_id;
end;
$$;

-- Enhanced claim function with additional parameters
create or replace function public.claim_playback_master(
  p_instance_id uuid,
  p_player_id uuid default null,
  p_user_agent text default null,
  p_ip_address text default null,
  p_tab_id text default null,
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
        last_updated = now(),
        version = version + 1
    where id = 1;

    -- Insert or update player_instances with full details
    insert into public.player_instances (
      instance_id, player_id, is_master, user_agent, 
      ip_address, last_seen, last_heartbeat, tab_id, connection_status
    )
    values (
      p_instance_id, p_player_id, true, p_user_agent,
      p_ip_address, now(), now(), p_tab_id, 'ONLINE'
    )
    on conflict (instance_id) 
    do update set 
      is_master = true,
      player_id = coalesce(excluded.player_id, player_instances.player_id),
      user_agent = coalesce(excluded.user_agent, player_instances.user_agent),
      ip_address = coalesce(excluded.ip_address, player_instances.ip_address),
      tab_id = coalesce(excluded.tab_id, player_instances.tab_id),
      last_seen = now(),
      last_heartbeat = now(),
      connection_status = 'ONLINE';

    -- Ensure only one master
    update public.player_instances
    set is_master = false
    where instance_id != p_instance_id and is_master = true;

    perform public.log_player_event(
      'MASTER_CLAIMED',
      p_instance_id,
      format('Instance %s claimed master role (previous master was %s)', 
             p_instance_id, coalesce(v_current_master::text, 'none')),
      jsonb_build_object(
        'previous_master', v_current_master,
        'previous_master_last_seen', v_master_last_seen,
        'reason', case 
          when v_current_master is null then 'no_previous_master'
          when v_master_last_seen < now() - interval '20 seconds' then 'master_stale'
          else 'race_won'
        end,
        'player_id', p_player_id
      )
    );
    v_claimed := true;
  end if;

  return v_claimed;
end;
$$;

-- Enhanced heartbeat function with status and position
create or replace function public.heartbeat_playback_master(
  p_instance_id uuid,
  p_player_id uuid default null,
  p_status text default null,
  p_position double precision default null
)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  v_updated integer := 0;
  v_is_current_master boolean;
begin
  -- Verify this instance is the current master
  select master_instance_id = p_instance_id 
  into v_is_current_master
  from public.playback_control 
  where id = 1;

  if v_is_current_master then
    update public.playback_control 
    set master_last_seen = now(),
        last_updated = now(),
        current_status = coalesce(p_status, current_status),
        playback_position = coalesce(p_position, playback_position)
    where id = 1;

    get diagnostics v_updated = row_count;

    update public.player_instances 
    set last_heartbeat = now(),
        last_seen = now(),
        player_id = coalesce(p_player_id, player_id)
    where instance_id = p_instance_id;

    -- Log heartbeat periodically (every 10th call) to avoid spam
    if random() < 0.1 then
      perform public.log_player_event(
        'HEARTBEAT',
        p_instance_id,
        'Master heartbeat received',
        jsonb_build_object('status', p_status, 'position', p_position, 'player_id', p_player_id)
      );
    end if;

    return true;
  else
    -- This instance is no longer master - log it
    perform public.log_player_event(
      'ERROR',
      p_instance_id,
      'Heartbeat rejected - instance is not current master',
      jsonb_build_object(
        'current_master', (select master_instance_id from public.playback_control where id = 1)
      )
    );

    -- Update connection to show it's no longer master
    update public.player_instances 
    set is_master = false
    where instance_id = p_instance_id;

    return false;
  end if;
end;
$$;

-- Grant execute permissions on new functions
grant execute on function public.release_master_role(uuid) to anon, authenticated, service_role;
grant execute on function public.cleanup_stale_connections() to authenticated, service_role;
grant execute on function public.request_player_refresh(text, uuid) to authenticated, service_role;
grant execute on function public.log_player_response(uuid, uuid, jsonb) to anon, authenticated, service_role;
