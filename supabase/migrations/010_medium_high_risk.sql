alter table public.engine_settings
  alter column max_position_percent set default 25;

update public.engine_settings
set max_position_percent = 25,
    updated_at = now()
where max_position_percent = 20;
