create table if not exists public.engine_settings (
  user_id uuid primary key references auth.users(id) on delete cascade,
  enabled boolean not null default false,
  starting_balance numeric not null default 100,
  daily_loss_limit numeric not null default 2,
  max_position_percent numeric not null default 20,
  updated_at timestamptz not null default now()
);

create table if not exists public.engine_decisions (
  id bigint generated always as identity primary key,
  user_id uuid not null references auth.users(id) on delete cascade,
  symbol text,
  action text not null check (action in ('BUY','SELL','HOLD','STOP')),
  confidence integer,
  reason text not null,
  broker_order_id text,
  quantity numeric,
  created_at timestamptz not null default now()
);

create table if not exists public.account_snapshots (
  id bigint generated always as identity primary key,
  user_id uuid not null references auth.users(id) on delete cascade,
  value numeric not null,
  created_at timestamptz not null default now()
);

alter table public.engine_settings enable row level security;
alter table public.engine_decisions enable row level security;
alter table public.account_snapshots enable row level security;
create policy "Owner reads settings" on public.engine_settings for select using (auth.uid() = user_id);
create policy "Owner reads decisions" on public.engine_decisions for select using (auth.uid() = user_id);
create policy "Owner reads snapshots" on public.account_snapshots for select using (auth.uid() = user_id);
create index if not exists engine_decisions_user_created_idx on public.engine_decisions (user_id, created_at desc);
create index if not exists account_snapshots_user_created_idx on public.account_snapshots (user_id, created_at desc);
