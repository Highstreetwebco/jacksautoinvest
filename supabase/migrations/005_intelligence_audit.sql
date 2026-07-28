alter table public.engine_decisions
  add column if not exists score integer,
  add column if not exists signals jsonb,
  add column if not exists reference_price numeric,
  add column if not exists strategy_version text not null default 'momentum-v1';
