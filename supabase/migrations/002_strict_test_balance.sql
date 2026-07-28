alter table public.engine_settings
  add column if not exists test_cash numeric not null default 100;
