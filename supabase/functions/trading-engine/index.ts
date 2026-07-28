import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, apikey, content-type",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS"
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...cors, "Content-Type": "application/json" } });

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  try {
    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const token = (req.headers.get("Authorization") || "").replace("Bearer ", "");
    const admin = createClient(supabaseUrl, serviceKey);
    const { data: { user }, error: authError } = await admin.auth.getUser(token);
    if (authError || !user) return json({ error: "Sign in required" }, 401);
    const ownerEmail = Deno.env.get("OWNER_EMAIL")?.toLowerCase();
    if (!ownerEmail || user.email?.toLowerCase() !== ownerEmail) return json({ error: "Owner access only" }, 403);

    const apiKey = Deno.env.get("TRADING212_API_KEY");
    const apiSecret = Deno.env.get("TRADING212_API_SECRET");
    if (!apiKey || !apiSecret) return json({ connected: false, setupRequired: true });

    const basic = btoa(`${apiKey}:${apiSecret}`);
    const broker = async (path: string, init: RequestInit = {}) => {
      const response = await fetch(`https://demo.trading212.com/api/v0${path}`, {
        ...init,
        headers: { Authorization: `Basic ${basic}`, "Content-Type": "application/json", ...(init.headers || {}) }
      });
      if (!response.ok) throw new Error(`Trading 212 returned ${response.status}`);
      return response.status === 204 ? null : response.json();
    };

    const url = new URL(req.url);
    const action = req.method === "POST" ? (await req.json()).action : (url.searchParams.get("action") || "status");
    const existing = await admin.from("engine_settings").select("*").eq("user_id", user.id).maybeSingle();
    let settings = existing.data;
    if (!settings) {
      const created = await admin.from("engine_settings").insert({ user_id: user.id }).select().single();
      settings = created.data;
    }
    if (action === "start" || action === "stop") {
      const enabled = action === "start";
      await admin.from("engine_settings").update({ enabled, updated_at: new Date().toISOString() }).eq("user_id", user.id);
      settings.enabled = enabled;
    }

    let cash = await broker("/equity/account/cash");
    let positions = await broker("/equity/portfolio");

    if (action === "tick" && settings.enabled) {
      const marketKey = Deno.env.get("TWELVE_DATA_API_KEY");
      const universe = JSON.parse(Deno.env.get("TRADING_UNIVERSE") || "[]") as Array<{ symbol: string; ticker: string }>;
      let decision = { symbol: null as string | null, action: "HOLD", confidence: 0, reason: "No eligible real-market signal.", quantity: null as number | null, broker_order_id: null as string | null };
      if (!marketKey || !universe.length) {
        decision.reason = "Market-data key or approved instrument universe is not configured.";
      } else {
        const candidate = universe[new Date().getUTCMinutes() % universe.length];
        const marketResponse = await fetch(`https://api.twelvedata.com/time_series?symbol=${encodeURIComponent(candidate.symbol)}&interval=5min&outputsize=30&apikey=${marketKey}`);
        const market = await marketResponse.json();
        const closes = (market.values || []).map((bar: { close: string }) => Number(bar.close)).filter(Number.isFinite);
        if (closes.length >= 20) {
          const average = (values: number[]) => values.reduce((a, b) => a + b, 0) / values.length;
          const fast = average(closes.slice(0, 5));
          const slow = average(closes.slice(0, 20));
          const momentum = (fast / slow) - 1;
          const confidence = Math.min(95, Math.round(60 + Math.abs(momentum) * 4000));
          const total = Number(cash.total ?? cash.result ?? cash.free ?? 0);
          const maxValue = total * (Number(settings.max_position_percent) / 100);
          const held = positions.find((p: { ticker?: string }) => p.ticker === candidate.ticker);
          decision = { symbol: candidate.symbol, action: "HOLD", confidence, reason: "Real five-minute momentum remained inside the trade threshold.", quantity: null, broker_order_id: null };
          if (momentum > 0.002 && !held && maxValue >= fast) {
            const quantity = Math.max(0.0001, Number((maxValue / fast).toFixed(4)));
            const order = await broker("/equity/orders/market", { method: "POST", body: JSON.stringify({ ticker: candidate.ticker, quantity }) });
            decision = { symbol: candidate.symbol, action: "BUY", confidence, reason: "Real five-minute average moved above the twenty-period average while exposure remained below 20%.", quantity, broker_order_id: String(order?.id || "") };
          } else if (momentum < -0.002 && held) {
            const quantity = -Math.abs(Number(held.quantity));
            const order = await broker("/equity/orders/market", { method: "POST", body: JSON.stringify({ ticker: candidate.ticker, quantity }) });
            decision = { symbol: candidate.symbol, action: "SELL", confidence, reason: "Real short-term momentum moved below the exit threshold.", quantity, broker_order_id: String(order?.id || "") };
          }
        } else {
          decision.reason = "The real market-data provider did not return enough completed price bars.";
        }
      }
      await admin.from("engine_decisions").insert({ user_id: user.id, ...decision });
      cash = await broker("/equity/account/cash");
      positions = await broker("/equity/portfolio");
    }

    const currentValue = Number(cash.total ?? cash.result ?? cash.free ?? 0);
    if (currentValue > 0) await admin.from("account_snapshots").insert({ user_id: user.id, value: currentValue });

    const [decisions, snapshots] = await Promise.all([
      admin.from("engine_decisions").select("*").eq("user_id", user.id).order("created_at", { ascending: false }).limit(30),
      admin.from("account_snapshots").select("value,created_at").eq("user_id", user.id).order("created_at", { ascending: false }).limit(80)
    ]);
    return json({
      connected: true,
      mode: "Trading 212 Demo",
      enabled: settings.enabled,
      cash,
      positions,
      decisions: decisions.data || [],
      snapshots: (snapshots.data || []).reverse(),
      rules: {
        startingBalance: Number(settings.starting_balance),
        dailyLossLimit: Number(settings.daily_loss_limit),
        maxPositionPercent: Number(settings.max_position_percent)
      },
      updatedAt: new Date().toISOString()
    });
  } catch (error) {
    return json({ error: error instanceof Error ? error.message : "Unexpected error" }, 500);
  }
});
