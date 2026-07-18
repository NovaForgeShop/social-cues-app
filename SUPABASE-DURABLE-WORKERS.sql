-- Social Cues durable worker foundation
-- Supabase is the authoritative job ledger. Vercel Cron or another trusted
-- dispatcher may claim bounded batches, but no job exists only in memory.

create extension if not exists pgcrypto;

create table if not exists public.worker_jobs (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  user_id uuid not null,
  kind text not null,
  status text not null default 'queued'
    check (status in ('queued', 'claimed', 'retrying', 'completed', 'blocked', 'dead', 'cancelled')),
  idempotency_key text not null,
  priority smallint not null default 50 check (priority between 0 and 100),
  payload jsonb not null default '{}'::jsonb,
  result jsonb not null default '{}'::jsonb,
  run_at timestamptz not null default now(),
  attempts integer not null default 0 check (attempts >= 0),
  max_attempts integer not null default 5 check (max_attempts between 1 and 20),
  lease_owner text,
  lease_expires_at timestamptz,
  heartbeat_at timestamptz,
  last_error text,
  estimated_cost_microusd bigint not null default 0 check (estimated_cost_microusd >= 0),
  actual_cost_microusd bigint not null default 0 check (actual_cost_microusd >= 0),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  completed_at timestamptz,
  unique (workspace_id, idempotency_key)
);

create table if not exists public.worker_runs (
  id uuid primary key default gen_random_uuid(),
  worker_id text not null,
  trigger text not null default 'cron',
  status text not null default 'running'
    check (status in ('running', 'completed', 'partial', 'failed')),
  started_at timestamptz not null default now(),
  completed_at timestamptz,
  claimed integer not null default 0,
  succeeded integer not null default 0,
  retried integer not null default 0,
  blocked integer not null default 0,
  dead integer not null default 0,
  metadata jsonb not null default '{}'::jsonb,
  last_error text
);

alter table public.worker_jobs enable row level security;
alter table public.worker_runs enable row level security;

revoke all on table public.worker_jobs, public.worker_runs from public, anon, authenticated;
grant select, insert, update, delete on table public.worker_jobs, public.worker_runs to service_role;
drop policy if exists "worker jobs are service role only" on public.worker_jobs;
create policy "worker jobs are service role only" on public.worker_jobs
  for all to anon, authenticated using (false) with check (false);
drop policy if exists "worker runs are service role only" on public.worker_runs;
create policy "worker runs are service role only" on public.worker_runs
  for all to anon, authenticated using (false) with check (false);

create index if not exists worker_jobs_claim_idx
  on public.worker_jobs(status, run_at, priority desc, created_at)
  where status in ('queued', 'claimed', 'retrying');
create index if not exists worker_jobs_workspace_idx
  on public.worker_jobs(workspace_id, created_at desc);
create index if not exists worker_jobs_lease_idx
  on public.worker_jobs(lease_expires_at)
  where status = 'claimed';
create index if not exists worker_jobs_kind_status_idx
  on public.worker_jobs(kind, status, run_at);
create index if not exists worker_runs_started_idx
  on public.worker_runs(started_at desc);

create or replace function public.social_cues_claim_worker_jobs(
  p_worker_id text,
  p_limit integer default 10,
  p_lease_seconds integer default 180,
  p_kinds text[] default null
)
returns setof public.worker_jobs
language plpgsql
security invoker
set search_path = public
as $$
begin
  if coalesce(trim(p_worker_id), '') = '' then
    raise exception 'worker id is required';
  end if;

  return query
  with eligible as materialized (
    select
      job.id,
      job.priority,
      job.run_at,
      job.created_at,
      row_number() over (
        partition by job.workspace_id
        order by job.priority desc, job.run_at asc, job.created_at asc
      ) as workspace_rank
    from public.worker_jobs job
    where job.run_at <= now()
      and job.attempts < job.max_attempts
      and (
        job.status in ('queued', 'retrying')
        or (job.status = 'claimed' and job.lease_expires_at < now())
      )
      and (p_kinds is null or job.kind = any(p_kinds))
  ), candidates as (
    select job.id
    from public.worker_jobs job
    join eligible on eligible.id = job.id
    where eligible.workspace_rank <= 2
    order by eligible.priority desc, eligible.run_at asc, eligible.created_at asc
    for update of job skip locked
    limit greatest(1, least(coalesce(p_limit, 10), 50))
  ), claimed as (
    update public.worker_jobs job
    set status = 'claimed',
        attempts = job.attempts + 1,
        lease_owner = p_worker_id,
        lease_expires_at = now() + make_interval(secs => greatest(30, least(coalesce(p_lease_seconds, 180), 3600))),
        heartbeat_at = now(),
        updated_at = now()
    from candidates
    where job.id = candidates.id
    returning job.*
  )
  select * from claimed;
end;
$$;

create or replace function public.social_cues_heartbeat_worker_job(
  p_job_id uuid,
  p_worker_id text,
  p_lease_seconds integer default 180
)
returns boolean
language sql
security invoker
set search_path = public
as $$
  update public.worker_jobs
  set heartbeat_at = now(),
      lease_expires_at = now() + make_interval(secs => greatest(30, least(coalesce(p_lease_seconds, 180), 3600))),
      updated_at = now()
  where id = p_job_id
    and status = 'claimed'
    and lease_owner = p_worker_id
  returning true;
$$;

create or replace function public.social_cues_finish_worker_job(
  p_job_id uuid,
  p_worker_id text,
  p_status text,
  p_result jsonb default '{}'::jsonb,
  p_error text default null,
  p_run_at timestamptz default null,
  p_actual_cost_microusd bigint default 0
)
returns setof public.worker_jobs
language plpgsql
security invoker
set search_path = public
as $$
begin
  if p_status not in ('completed', 'retrying', 'blocked', 'dead', 'cancelled') then
    raise exception 'invalid terminal worker status: %', p_status;
  end if;

  return query
  update public.worker_jobs job
  set status = p_status,
      result = coalesce(p_result, '{}'::jsonb),
      last_error = nullif(left(coalesce(p_error, ''), 2000), ''),
      run_at = case when p_status = 'retrying' then coalesce(p_run_at, now() + interval '1 minute') else job.run_at end,
      lease_owner = null,
      lease_expires_at = null,
      heartbeat_at = now(),
      actual_cost_microusd = greatest(0, coalesce(p_actual_cost_microusd, 0)),
      updated_at = now(),
      completed_at = case when p_status in ('completed', 'blocked', 'dead', 'cancelled') then now() else null end
  where job.id = p_job_id
    and job.status = 'claimed'
    and job.lease_owner = p_worker_id
  returning job.*;
end;
$$;

revoke all on table public.worker_jobs from anon, authenticated;
revoke all on table public.worker_runs from anon, authenticated;
revoke all on function public.social_cues_claim_worker_jobs(text, integer, integer, text[]) from public, anon, authenticated;
revoke all on function public.social_cues_heartbeat_worker_job(uuid, text, integer) from public, anon, authenticated;
revoke all on function public.social_cues_finish_worker_job(uuid, text, text, jsonb, text, timestamptz, bigint) from public, anon, authenticated;
grant execute on function public.social_cues_claim_worker_jobs(text, integer, integer, text[]) to service_role;
grant execute on function public.social_cues_heartbeat_worker_job(uuid, text, integer) to service_role;
grant execute on function public.social_cues_finish_worker_job(uuid, text, text, jsonb, text, timestamptz, bigint) to service_role;
