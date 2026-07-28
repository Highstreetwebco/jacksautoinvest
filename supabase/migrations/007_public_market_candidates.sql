alter table public.engine_settings
  add column if not exists public_candidates jsonb not null default '[]'::jsonb,
  add column if not exists public_candidates_updated_at timestamptz;
