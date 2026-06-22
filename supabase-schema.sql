-- Social Cues Supabase starter schema
-- Run this in the Supabase SQL editor for the alpha backend.
-- Keep service-role keys on the server only.

create extension if not exists pgcrypto;

create table if not exists public.app_state (
  id text primary key default 'primary',
  model jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now()
);

create table if not exists public.workspaces (
  id uuid primary key default gen_random_uuid(),
  owner_user_id uuid,
  name text not null,
  plan text not null default 'founder_alpha',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.profiles (
  id uuid primary key,
  workspace_id uuid references public.workspaces(id) on delete cascade,
  display_name text,
  email text,
  role text not null default 'owner',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.social_accounts (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid references public.workspaces(id) on delete cascade,
  platform text not null,
  handle text,
  status text not null default 'not_connected',
  scopes text[] not null default '{}',
  token_ref text,
  last_analyzed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (workspace_id, platform)
);

create table if not exists public.campaigns (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid references public.workspaces(id) on delete cascade,
  name text not null,
  goal text,
  brief text,
  status text not null default 'draft',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.content_variants (
  id uuid primary key default gen_random_uuid(),
  campaign_id uuid references public.campaigns(id) on delete cascade,
  platform text not null,
  status text not null default 'draft',
  copy text,
  tags text[] not null default '{}',
  best_time text,
  media_asset_id uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.scheduled_posts (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid references public.workspaces(id) on delete cascade,
  campaign_id uuid references public.campaigns(id) on delete set null,
  content_variant_id uuid references public.content_variants(id) on delete set null,
  platform text not null,
  status text not null default 'queued',
  caption text,
  tags text[] not null default '{}',
  media_asset_id uuid,
  scheduled_for timestamptz not null,
  published_at timestamptz,
  reminder_sent_at timestamptz,
  provider_post_id text,
  publish_error text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.media_assets (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid references public.workspaces(id) on delete cascade,
  provider text not null default 'upload',
  kind text not null default 'image',
  title text,
  prompt text,
  storage_path text,
  preview_url text,
  created_at timestamptz not null default now()
);

create table if not exists public.action_items (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid references public.workspaces(id) on delete cascade,
  type text not null default 'experiment',
  priority text not null default 'medium',
  status text not null default 'active',
  title text not null,
  signal text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.billing_customers (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid references public.workspaces(id) on delete cascade,
  stripe_customer_id text,
  selected_plan text,
  status text not null default 'not_configured',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.app_state enable row level security;
alter table public.workspaces enable row level security;
alter table public.profiles enable row level security;
alter table public.social_accounts enable row level security;
alter table public.campaigns enable row level security;
alter table public.content_variants enable row level security;
alter table public.scheduled_posts enable row level security;
alter table public.media_assets enable row level security;
alter table public.action_items enable row level security;
alter table public.billing_customers enable row level security;

create policy "profiles can read own profile"
  on public.profiles for select
  using (id = auth.uid());

create policy "profiles can update own profile"
  on public.profiles for update
  using (id = auth.uid())
  with check (id = auth.uid());

create policy "workspace members can read workspace"
  on public.workspaces for select
  using (
    exists (
      select 1 from public.profiles
      where profiles.workspace_id = workspaces.id
      and profiles.id = auth.uid()
    )
  );

create policy "workspace members can read social accounts"
  on public.social_accounts for select
  using (
    exists (
      select 1 from public.profiles
      where profiles.workspace_id = social_accounts.workspace_id
      and profiles.id = auth.uid()
    )
  );

create policy "workspace members can read campaigns"
  on public.campaigns for select
  using (
    exists (
      select 1 from public.profiles
      where profiles.workspace_id = campaigns.workspace_id
      and profiles.id = auth.uid()
    )
  );

create policy "workspace members can read variants"
  on public.content_variants for select
  using (
    exists (
      select 1
      from public.campaigns
      join public.profiles on profiles.workspace_id = campaigns.workspace_id
      where campaigns.id = content_variants.campaign_id
      and profiles.id = auth.uid()
    )
  );

create policy "workspace members can read scheduled posts"
  on public.scheduled_posts for select
  using (
    exists (
      select 1 from public.profiles
      where profiles.workspace_id = scheduled_posts.workspace_id
      and profiles.id = auth.uid()
    )
  );

create policy "workspace members can read media"
  on public.media_assets for select
  using (
    exists (
      select 1 from public.profiles
      where profiles.workspace_id = media_assets.workspace_id
      and profiles.id = auth.uid()
    )
  );

create policy "workspace members can read actions"
  on public.action_items for select
  using (
    exists (
      select 1 from public.profiles
      where profiles.workspace_id = action_items.workspace_id
      and profiles.id = auth.uid()
    )
  );

create policy "workspace members can read billing"
  on public.billing_customers for select
  using (
    exists (
      select 1 from public.profiles
      where profiles.workspace_id = billing_customers.workspace_id
      and profiles.id = auth.uid()
    )
  );

create index if not exists social_accounts_workspace_idx on public.social_accounts(workspace_id);
create index if not exists campaigns_workspace_idx on public.campaigns(workspace_id);
create index if not exists variants_campaign_idx on public.content_variants(campaign_id);
create index if not exists scheduled_posts_workspace_idx on public.scheduled_posts(workspace_id);
create index if not exists scheduled_posts_due_idx on public.scheduled_posts(status, scheduled_for);
create index if not exists media_workspace_idx on public.media_assets(workspace_id);
create index if not exists actions_workspace_idx on public.action_items(workspace_id);
