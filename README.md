# Jack Auto Invest

A standalone paper-investing dashboard prototype.

## Current scope

- Real-market paper-broker dashboard
- Strategy allocation and risk controls
- Explainable paper-trade activity
- Responsive mobile design
- Secure Trading 212 Demo connection through a Supabase backend

## Secure setup

- Apply `supabase/migrations/001_paper_trading.sql`.
- Deploy the `supabase/functions/trading-engine` Edge Function.
- Set `TRADING212_API_KEY`, `TRADING212_API_SECRET`, `TWELVE_DATA_API_KEY`, `TRADING_UNIVERSE` and `OWNER_EMAIL` as private Edge Function secrets.
- Copy the public Supabase project URL and anon key into `config.js`.
- The public screen stays disconnected until setup is complete and no longer manufactures returns.

This prototype is for product development and demonstrations only. It is not financial advice.
