alter table public.engine_settings
  add column if not exists autopilot_enabled boolean not null default false,
  add column if not exists trial_started_at timestamptz,
  add column if not exists trial_ends_at timestamptz,
  add column if not exists last_background_run timestamptz,
  add column if not exists daily_paused_on text;
