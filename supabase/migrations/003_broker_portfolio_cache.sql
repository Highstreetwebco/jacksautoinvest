alter table public.engine_settings
  add column if not exists broker_positions_cache jsonb not null default '[]'::jsonb,
  add column if not exists broker_cache_updated_at timestamptz;
