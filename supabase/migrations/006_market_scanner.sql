alter table public.engine_settings
  add column if not exists scan_cursor integer not null default 0,
  add column if not exists instrument_cache jsonb not null default '[]'::jsonb,
  add column if not exists instrument_cache_updated_at timestamptz;
