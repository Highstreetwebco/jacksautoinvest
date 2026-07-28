alter table public.engine_settings
  alter column starting_balance set default 500,
  alter column test_cash set default 500;

update public.account_snapshots snapshot
set value = snapshot.value + 400
from public.engine_settings settings
where snapshot.user_id = settings.user_id
  and settings.starting_balance = 100;

update public.engine_settings
set test_cash = test_cash + 400,
    starting_balance = 500,
    updated_at = now()
where starting_balance = 100;
