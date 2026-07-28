import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { analyse, type Bar } from "./strategy.ts";

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
    const ownerEmail = Deno.env.get("OWNER_EMAIL")?.toLowerCase();
    const cronSecret = Deno.env.get("CRON_SECRET");
    const isScheduledRequest = Boolean(cronSecret && req.headers.get("x-cron-secret") === cronSecret);
    const token = (req.headers.get("Authorization") || "").replace("Bearer ", "");
    const admin = createClient(supabaseUrl, serviceKey);
    let user = null;
    if (isScheduledRequest) {
      const users = await admin.auth.admin.listUsers({ page: 1, perPage: 100 });
      user = users.data.users.find(candidate => candidate.email?.toLowerCase() === ownerEmail) || null;
    } else {
      const auth = await admin.auth.getUser(token);
      user = auth.data.user;
      if (auth.error || !user) return json({ error: "Sign in required" }, 401);
    }
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
      if (!response.ok) throw new Error(response.status === 429 ? "RATE_LIMITED" : `Trading 212 returned ${response.status}`);
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
    const now = new Date();
    const marketParts = Object.fromEntries(new Intl.DateTimeFormat("en-US", {
      timeZone: "America/New_York",
      weekday: "short",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23"
    }).formatToParts(now).filter(part => part.type !== "literal").map(part => [part.type, part.value]));
    const marketDate = `${marketParts.year}-${marketParts.month}-${marketParts.day}`;
    const marketMinutes = Number(marketParts.hour) * 60 + Number(marketParts.minute);
    const marketOpen = !["Sat", "Sun"].includes(marketParts.weekday) && marketMinutes >= 570 && marketMinutes < 960;
    const trialHasExpired = Boolean(settings.trial_ends_at && now.getTime() >= new Date(settings.trial_ends_at).getTime());
    const trialActive = settings.autopilot_enabled && settings.daily_paused_on !== marketDate && !trialHasExpired;

    if (action === "start") {
      const trialStartedAt = !settings.trial_started_at || trialHasExpired ? now.toISOString() : settings.trial_started_at;
      const trialEndsAt = !settings.trial_ends_at || trialHasExpired ? new Date(now.getTime() + 30 * 86400000).toISOString() : settings.trial_ends_at;
      await admin.from("engine_settings").update({ enabled: marketOpen, autopilot_enabled: true, trial_started_at: trialStartedAt, trial_ends_at: trialEndsAt, updated_at: now.toISOString() }).eq("user_id", user.id);
      Object.assign(settings, { enabled: marketOpen, autopilot_enabled: true, trial_started_at: trialStartedAt, trial_ends_at: trialEndsAt });
    } else if (action === "stop") {
      await admin.from("engine_settings").update({ enabled: false, autopilot_enabled: false, updated_at: now.toISOString() }).eq("user_id", user.id);
      Object.assign(settings, { enabled: false, autopilot_enabled: false });
    } else if (action === "scheduled") {
      const enabled = Boolean(trialActive && marketOpen);
      await admin.from("engine_settings").update({ enabled, autopilot_enabled: trialHasExpired ? false : settings.autopilot_enabled, last_background_run: now.toISOString(), updated_at: now.toISOString() }).eq("user_id", user.id);
      settings.enabled = enabled;
      if (trialHasExpired) settings.autopilot_enabled = false;
      settings.last_background_run = now.toISOString();
    }

    const universe = JSON.parse(Deno.env.get("TRADING_UNIVERSE") || "[]") as Array<{ symbol: string; ticker: string }>;
    let rateLimited = false;
    const loadBrokerPositions = async (force = false) => {
      const cachedAt = settings.broker_cache_updated_at ? new Date(settings.broker_cache_updated_at).getTime() : 0;
      const cacheIsFresh = Date.now() - cachedAt < 90_000;
      if (!force && cacheIsFresh) return settings.broker_positions_cache || [];
      try {
        const latest = await broker("/equity/portfolio");
        const cachedAt = new Date().toISOString();
        settings.broker_positions_cache = latest;
        settings.broker_cache_updated_at = cachedAt;
        await admin.from("engine_settings").update({ broker_positions_cache: latest, broker_cache_updated_at: cachedAt }).eq("user_id", user.id);
        return latest;
      } catch (error) {
        if (error instanceof Error && error.message === "RATE_LIMITED") {
          rateLimited = true;
          return settings.broker_positions_cache || [];
        }
        throw error;
      }
    };
    let brokerPositions = await loadBrokerPositions();
    let ownedDecisions = (await admin.from("engine_decisions").select("symbol,action,quantity").eq("user_id", user.id).in("action", ["BUY", "SELL"]).order("created_at", { ascending: true })).data || [];
    const testPositions = () => universe.flatMap(instrument => {
      const ownedQuantity = ownedDecisions.filter(decision => decision.symbol === instrument.symbol).reduce((total, decision) => total + Number(decision.quantity || 0), 0);
      if (ownedQuantity <= 0) return [];
      const brokerPosition = brokerPositions.find((position: { ticker?: string }) => position.ticker === instrument.ticker);
      if (!brokerPosition) return [];
      const brokerQuantity = Math.abs(Number(brokerPosition.quantity || 0));
      const currentPrice = Number(brokerPosition.currentPrice || brokerPosition.averagePrice || 0);
      const scaledPpl = brokerQuantity > 0 ? Number(brokerPosition.ppl || 0) * (ownedQuantity / brokerQuantity) : 0;
      return [{ ...brokerPosition, ticker: instrument.ticker, quantity: ownedQuantity, currentPrice, currentValue: ownedQuantity * currentPrice, ppl: scaledPpl }];
    });
    let positions = testPositions();
    const positionValue = (items: Array<Record<string, unknown>>) => items.reduce((sum, position) => sum + Number(position.currentValue ?? Number(position.quantity || 0) * Number(position.currentPrice || 0)), 0);
    const runTradingCycle = settings.enabled && ["tick", "scheduled", "start"].includes(action);

    if (runTradingCycle) {
      const currentTotal = Number(settings.test_cash) + positionValue(positions);
      const today = new Date();
      today.setUTCHours(0, 0, 0, 0);
      const openingResult = await admin.from("account_snapshots").select("value").eq("user_id", user.id).gte("created_at", today.toISOString()).order("created_at", { ascending: true }).limit(1).maybeSingle();
      const openingValue = Number(openingResult.data?.value || currentTotal);
      const lossPercent = openingValue > 0 ? ((openingValue - currentTotal) / openingValue) * 100 : 0;
      if (lossPercent >= Number(settings.daily_loss_limit)) {
        await admin.from("engine_settings").update({ enabled: false, daily_paused_on: marketDate, updated_at: new Date().toISOString() }).eq("user_id", user.id);
        settings.enabled = false;
        settings.daily_paused_on = marketDate;
        await admin.from("engine_decisions").insert({ user_id: user.id, action: "STOP", confidence: 100, reason: `Automatic stop: the real paper account reached its ${settings.daily_loss_limit}% daily loss limit.` });
      }
    }

    if (runTradingCycle && settings.enabled) {
      const marketKey = Deno.env.get("TWELVE_DATA_API_KEY");
      let decision = {
        symbol: null as string | null, action: "HOLD", confidence: 0,
        reason: "No eligible multi-signal market setup.", quantity: null as number | null,
        broker_order_id: null as string | null, score: 50, signals: {} as Record<string, unknown>,
        reference_price: null as number | null, strategy_version: "ensemble-v2"
      };
      if (!marketKey || !universe.length) {
        decision.reason = "Market-data key or approved instrument universe is not configured.";
      } else {
        const fetchSeries = async (symbol: string, interval: "5min" | "1h", outputsize = 60): Promise<Bar[]> => {
          const response = await fetch(`https://api.twelvedata.com/time_series?symbol=${encodeURIComponent(symbol)}&interval=${interval}&outputsize=${outputsize}&apikey=${marketKey}`);
          const payload = await response.json();
          if (!response.ok || payload.status === "error") throw new Error(payload.message || `Market data failed for ${symbol}`);
          return (payload.values || []).map((bar: Record<string, string>) => ({ datetime: bar.datetime, open: Number(bar.open), high: Number(bar.high), low: Number(bar.low), close: Number(bar.close), volume: Number(bar.volume || 0) })).filter((bar: Bar) => Number.isFinite(bar.close));
        };
        const benchmark = await fetchSeries("SPY", "1h");
        const analyses = await Promise.all(universe.map(async instrument => {
          const [shortBars, longBars] = await Promise.all([fetchSeries(instrument.symbol, "5min"), fetchSeries(instrument.symbol, "1h")]);
          const held = positions.some((position: { ticker?: string }) => position.ticker === instrument.ticker);
          const current = analyse(shortBars, longBars, benchmark, held);
          const currentData = String(shortBars[0]?.datetime || "").startsWith(marketDate);
          return { instrument, held, result: currentData ? current : { ...current, verdict: "HOLD" as const, confidence: 0, explanation: "No trade: the latest completed market bar is not from today." } };
        }));
        const sell = analyses.filter(item => item.held && item.result.verdict === "SELL").sort((a, b) => a.result.score - b.result.score)[0];
        const buy = analyses.filter(item => !item.held && item.result.verdict === "BUY").sort((a, b) => b.result.score - a.result.score)[0];
        const selected = sell || buy || [...analyses].sort((a, b) => Math.abs(b.result.score - 50) - Math.abs(a.result.score - 50))[0];
        if (selected) {
          const { instrument, held, result } = selected;
          decision = { symbol: instrument.symbol, action: result.verdict, confidence: result.confidence, reason: result.explanation, quantity: null, broker_order_id: null, score: result.score, signals: result.signals, reference_price: result.referencePrice, strategy_version: "ensemble-v2" };
          const testCash = Number(settings.test_cash);
          if (result.verdict === "BUY" && !held && testCash >= 1) {
            const exposureCap = Number(settings.starting_balance) * (Number(settings.max_position_percent) / 100);
            const intelligentSize = Number(settings.starting_balance) * (result.suggestedExposurePercent / 100);
            const orderValue = Math.min(testCash, exposureCap, intelligentSize);
            const quantity = Math.max(0.0001, Number((orderValue / result.referencePrice).toFixed(4)));
            const order = await broker("/equity/orders/market", { method: "POST", body: JSON.stringify({ ticker: instrument.ticker, quantity }) });
            settings.test_cash = Math.max(0, testCash - (quantity * result.referencePrice));
            await admin.from("engine_settings").update({ test_cash: settings.test_cash, updated_at: new Date().toISOString() }).eq("user_id", user.id);
            decision.quantity = quantity;
            decision.broker_order_id = String(order?.id || "");
          } else if (result.verdict === "SELL" && held) {
            const heldPosition = positions.find((position: { ticker?: string }) => position.ticker === instrument.ticker);
            const quantity = -Math.abs(Number(heldPosition?.quantity || 0));
            if (quantity) {
              const order = await broker("/equity/orders/market", { method: "POST", body: JSON.stringify({ ticker: instrument.ticker, quantity }) });
              settings.test_cash = testCash + (Math.abs(quantity) * result.referencePrice);
              await admin.from("engine_settings").update({ test_cash: settings.test_cash, updated_at: new Date().toISOString() }).eq("user_id", user.id);
              decision.quantity = quantity;
              decision.broker_order_id = String(order?.id || "");
            }
          }
        }
      }
      await admin.from("engine_decisions").insert({ user_id: user.id, ...decision });
      brokerPositions = await loadBrokerPositions(true);
      ownedDecisions = (await admin.from("engine_decisions").select("symbol,action,quantity").eq("user_id", user.id).in("action", ["BUY", "SELL"]).order("created_at", { ascending: true })).data || [];
      positions = testPositions();
    }

    const investedValue = positionValue(positions);
    const currentValue = Number(settings.test_cash) + investedValue;
    await admin.from("account_snapshots").delete().eq("user_id", user.id).gt("value", Number(settings.starting_balance) * 10);
    if (currentValue > 0) await admin.from("account_snapshots").insert({ user_id: user.id, value: currentValue });

    const [decisions, snapshots] = await Promise.all([
      admin.from("engine_decisions").select("*").eq("user_id", user.id).order("created_at", { ascending: false }).limit(30),
      admin.from("account_snapshots").select("value,created_at").eq("user_id", user.id).order("created_at", { ascending: false }).limit(80)
    ]);
    return json({
      connected: true, mode: "Trading 212 Demo", rateLimited, enabled: settings.enabled,
      autopilotEnabled: settings.autopilot_enabled, marketOpen, trialStartedAt: settings.trial_started_at,
      trialEndsAt: settings.trial_ends_at, lastBackgroundRun: settings.last_background_run,
      dailyPaused: settings.daily_paused_on === marketDate, cash: { free: Number(settings.test_cash) },
      positions, testAccount: { cash: Number(settings.test_cash), invested: investedValue, total: currentValue },
      decisions: decisions.data || [], snapshots: (snapshots.data || []).reverse(),
      rules: { startingBalance: Number(settings.starting_balance), dailyLossLimit: Number(settings.daily_loss_limit), maxPositionPercent: Number(settings.max_position_percent) },
      updatedAt: new Date().toISOString()
    });
  } catch (error) {
    return json({ error: error instanceof Error ? error.message : "Unexpected error" }, 500);
  }
});