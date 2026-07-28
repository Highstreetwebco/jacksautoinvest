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
    const trialActive = settings.autopilot_enabled &&
      settings.daily_paused_on !== marketDate &&
      !trialHasExpired;

    if (action === "start") {
      const trialStartedAt = !settings.trial_started_at || trialHasExpired ? now.toISOString() : settings.trial_started_at;
      const trialEndsAt = !settings.trial_ends_at || trialHasExpired ? new Date(now.getTime() + 30 * 86400000).toISOString() : settings.trial_ends_at;
      await admin.from("engine_settings").update({
        enabled: marketOpen,
        autopilot_enabled: true,
        trial_started_at: trialStartedAt,
        trial_ends_at: trialEndsAt,
        updated_at: now.toISOString()
      }).eq("user_id", user.id);
      Object.assign(settings, { enabled: marketOpen, autopilot_enabled: true, trial_started_at: trialStartedAt, trial_ends_at: trialEndsAt });
    } else if (action === "stop") {
      await admin.from("engine_settings").update({
        enabled: false,
        autopilot_enabled: false,
        updated_at: now.toISOString()
      }).eq("user_id", user.id);
      Object.assign(settings, { enabled: false, autopilot_enabled: false });
    } else if (action === "scheduled") {
      const enabled = Boolean(trialActive && marketOpen);
      await admin.from("engine_settings").update({
        enabled,
        autopilot_enabled: trialHasExpired ? false : settings.autopilot_enabled,
        last_background_run: now.toISOString(),
        updated_at: now.toISOString()
      }).eq("user_id", user.id);
      settings.enabled = enabled;
      if (trialHasExpired) settings.autopilot_enabled = false;
      settings.last_background_run = now.toISOString();
    }

    type Instrument = { symbol: string; ticker: string };
    const configuredUniverse = JSON.parse(Deno.env.get("TRADING_UNIVERSE") || "[]") as Instrument[];
    let universe = configuredUniverse;
    const instrumentCacheAge = settings.instrument_cache_updated_at
      ? Date.now() - new Date(settings.instrument_cache_updated_at).getTime()
      : Number.POSITIVE_INFINITY;
    if (instrumentCacheAge < 86_400_000 && Array.isArray(settings.instrument_cache) && settings.instrument_cache.length) {
      universe = settings.instrument_cache;
    } else {
      try {
        const brokerInstruments = await broker("/equity/metadata/instruments");
        const discovered = (Array.isArray(brokerInstruments) ? brokerInstruments : [])
          .filter((instrument: { ticker?: string; type?: string }) =>
            instrument.type === "STOCK" && String(instrument.ticker || "").endsWith("_US_EQ"))
          .map((instrument: { ticker: string }) => ({
            ticker: instrument.ticker,
            symbol: instrument.ticker.replace(/_US_EQ$/, "")
          }))
          .filter((instrument: Instrument) => /^[A-Z][A-Z0-9.-]{0,9}$/i.test(instrument.symbol));
        if (discovered.length) {
          universe = discovered;
          settings.instrument_cache = discovered;
          settings.instrument_cache_updated_at = now.toISOString();
          await admin.from("engine_settings").update({
            instrument_cache: discovered,
            instrument_cache_updated_at: now.toISOString()
          }).eq("user_id", user.id);
        }
      } catch {
        universe = configuredUniverse;
      }
    }
    type PublicCandidate = { symbol: string; source: string };
    let publicCandidates = Array.isArray(settings.public_candidates)
      ? settings.public_candidates as PublicCandidate[]
      : [];
    const publicCacheAge = settings.public_candidates_updated_at
      ? Date.now() - new Date(settings.public_candidates_updated_at).getTime()
      : Number.POSITIVE_INFINITY;
    if (marketOpen && settings.autopilot_enabled && publicCacheAge >= 30 * 60_000) {
      const publicPages = [
        {
          source: "TradingView most active",
          url: "https://www.tradingview.com/markets/stocks-usa/market-movers-active/",
          pattern: /\/symbols\/(?:NASDAQ|NYSE|AMEX|NYSEARCA)-([A-Z0-9.-]{1,10})\//g
        },
        {
          source: "TradingView unusual volume",
          url: "https://www.tradingview.com/markets/stocks-usa/market-movers-unusual-volume/",
          pattern: /\/symbols\/(?:NASDAQ|NYSE|AMEX|NYSEARCA)-([A-Z0-9.-]{1,10})\//g
        },
        {
          source: "TradingView gainers",
          url: "https://www.tradingview.com/markets/stocks-usa/market-movers-gainers/",
          pattern: /\/symbols\/(?:NASDAQ|NYSE|AMEX|NYSEARCA)-([A-Z0-9.-]{1,10})\//g
        },
        {
          source: "Yahoo Finance most active",
          url: "https://finance.yahoo.com/markets/stocks/most-active/",
          pattern: /\/quote\/([A-Z][A-Z0-9.-]{0,9})(?:\/|\?)/g
        }
      ];
      const fetched = (await Promise.all(publicPages.map(async page => {
        try {
          const response = await fetch(page.url, {
            headers: { "User-Agent": "JackAutoInvest/1.0 private-paper-research" },
            signal: AbortSignal.timeout(6_000)
          });
          if (!response.ok) return [];
          const html = await response.text();
          return [...html.matchAll(page.pattern)].map(match => ({
            symbol: match[1].toUpperCase(),
            source: page.source
          }));
        } catch {
          return [];
        }
      }))).flat();
      const tradableSymbols = new Set(universe.map(instrument => instrument.symbol.toUpperCase()));
      const unique = [...new Map(fetched
        .filter(candidate => tradableSymbols.has(candidate.symbol))
        .map(candidate => [candidate.symbol, candidate])).values()].slice(0, 100);
      if (unique.length) {
        publicCandidates = unique;
        settings.public_candidates = unique;
        settings.public_candidates_updated_at = now.toISOString();
        await admin.from("engine_settings").update({
          public_candidates: unique,
          public_candidates_updated_at: now.toISOString()
        }).eq("user_id", user.id);
      }
    }
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
        await admin.from("engine_settings").update({
          broker_positions_cache: latest,
          broker_cache_updated_at: cachedAt
        }).eq("user_id", user.id);
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
    let ownedDecisions = (await admin.from("engine_decisions")
      .select("symbol,action,quantity,signals,created_at")
      .eq("user_id", user.id)
      .in("action", ["BUY", "SELL"])
      .order("created_at", { ascending: true })).data || [];
    const testPositions = () => universe.flatMap(instrument => {
      const ownedQuantity = ownedDecisions
        .filter(decision => decision.symbol === instrument.symbol)
        .reduce((total, decision) => total + Number(decision.quantity || 0), 0);
      if (ownedQuantity <= 0) return [];
      const brokerPosition = brokerPositions.find((position: { ticker?: string }) => position.ticker === instrument.ticker);
      if (!brokerPosition) return [];
      const brokerQuantity = Math.abs(Number(brokerPosition.quantity || 0));
      const currentPrice = Number(brokerPosition.currentPrice || brokerPosition.averagePrice || 0);
      const scaledPpl = brokerQuantity > 0 ? Number(brokerPosition.ppl || 0) * (ownedQuantity / brokerQuantity) : 0;
      return [{
        ...brokerPosition,
        ticker: instrument.ticker,
        quantity: ownedQuantity,
        currentPrice,
        currentValue: ownedQuantity * currentPrice,
        ppl: scaledPpl
      }];
    });
    let positions = testPositions();
    const positionValue = (items: Array<Record<string, unknown>>) =>
      items.reduce((sum, position) => sum + Number(position.currentValue ?? Number(position.quantity || 0) * Number(position.currentPrice || 0)), 0);

    const runTradingCycle = settings.enabled && ["tick", "scheduled", "start"].includes(action);
    const lastDeepScan = settings.last_deep_scan_at ? new Date(settings.last_deep_scan_at).getTime() : 0;
    const deepScanDue = action === "start" || Date.now() - lastDeepScan >= 4.5 * 60_000;

    if (runTradingCycle) {
      const currentTotal = Number(settings.test_cash) + positionValue(positions);
      const today = new Date();
      today.setUTCHours(0, 0, 0, 0);
      const openingResult = await admin.from("account_snapshots").select("value").eq("user_id", user.id).gte("created_at", today.toISOString()).order("created_at", { ascending: true }).limit(1).maybeSingle();
      const openingValue = Number(openingResult.data?.value || currentTotal);
      const lossPercent = openingValue > 0 ? ((openingValue - currentTotal) / openingValue) * 100 : 0;
      if (lossPercent >= Number(settings.daily_loss_limit)) {
        await admin.from("engine_settings").update({
          enabled: false,
          daily_paused_on: marketDate,
          updated_at: new Date().toISOString()
        }).eq("user_id", user.id);
        settings.enabled = false;
        settings.daily_paused_on = marketDate;
        await admin.from("engine_decisions").insert({
          user_id: user.id,
          action: "STOP",
          confidence: 100,
          reason: `Automatic stop: the real paper account reached its ${settings.daily_loss_limit}% daily loss limit.`
        });
      }
    }

    const stoppedThisCycle = new Set<string>();
    if (runTradingCycle && settings.enabled && positions.length) {
      for (const position of positions) {
        const instrument = universe.find(item => item.ticker === position.ticker);
        const latestEntry = [...ownedDecisions].reverse().find(decision =>
          decision.symbol === instrument?.symbol && decision.action === "BUY" && Number(decision.quantity || 0) > 0);
        const assignedStop = Number(latestEntry?.signals?.assignedStopPrice || latestEntry?.signals?.stopPrice || 0);
        const currentPrice = Number(position.currentPrice || 0);
        if (!instrument || !assignedStop || !currentPrice || currentPrice > assignedStop) continue;
        const quantity = -Math.abs(Number(position.quantity || 0));
        const order = await broker("/equity/orders/market", {
          method: "POST",
          body: JSON.stringify({ ticker: instrument.ticker, quantity })
        });
        settings.test_cash = Number(settings.test_cash) + (Math.abs(quantity) * currentPrice);
        await admin.from("engine_settings").update({
          test_cash: settings.test_cash,
          updated_at: now.toISOString()
        }).eq("user_id", user.id);
        await admin.from("engine_decisions").insert({
          user_id: user.id,
          symbol: instrument.symbol,
          action: "SELL",
          confidence: 100,
          quantity,
          broker_order_id: String(order?.id || ""),
          reference_price: currentPrice,
          score: 0,
          signals: { assignedStopPrice: assignedStop, hardStopTriggered: true },
          strategy_version: "mechanical-stop-v1",
          reason: `HARD STOP EXECUTED: ${instrument.symbol} reached $${currentPrice.toFixed(2)}, at or below its assigned $${assignedStop.toFixed(2)} stop. The full paper position was closed without lowering the stop.`
        });
        stoppedThisCycle.add(instrument.symbol);
        ownedDecisions.push({ symbol: instrument.symbol, action: "SELL", quantity, signals: {}, created_at: now.toISOString() });
      }
      positions = testPositions();
    }

    if (runTradingCycle && settings.enabled && deepScanDue) {
      const marketKey = Deno.env.get("TWELVE_DATA_API_KEY");
      let decision = {
        symbol: null as string | null, action: "HOLD", confidence: 0,
        reason: "No eligible multi-signal market setup.", quantity: null as number | null,
        broker_order_id: null as string | null, score: 50, signals: {} as Record<string, unknown>,
        reference_price: null as number | null, strategy_version: "public-intelligence-v4"
      };
      if (!marketKey || !universe.length) {
        decision.reason = "Market-data key or approved instrument universe is not configured.";
      } else {
        const fetchSeries = async (symbol: string, interval: "5min" | "1h" | "1day", outputsize = 60): Promise<Bar[]> => {
          const response = await fetch(`https://api.twelvedata.com/time_series?symbol=${encodeURIComponent(symbol)}&interval=${interval}&outputsize=${outputsize}&apikey=${marketKey}`);
          const payload = await response.json();
          if (!response.ok || payload.status === "error") throw new Error(payload.message || `Market data failed for ${symbol}`);
          return (payload.values || []).map((bar: Record<string, string>) => ({
            datetime: bar.datetime,
            open: Number(bar.open),
            high: Number(bar.high),
            low: Number(bar.low),
            close: Number(bar.close),
            volume: Number(bar.volume || 0)
          })).filter((bar: Bar) => Number.isFinite(bar.close));
        };
        const scanSize = 3;
        const cursor = Number(settings.scan_cursor || 0) % universe.length;
        const rotating = Array.from({ length: Math.min(scanSize, universe.length) }, (_, offset) =>
          universe[(cursor + offset) % universe.length]);
        const heldInstruments = universe.filter(instrument =>
          positions.some((position: { ticker?: string }) => position.ticker === instrument.ticker));
        const candidateOffset = publicCandidates.length ? cursor % publicCandidates.length : 0;
        const nominatedSymbols = Array.from({ length: Math.min(3, publicCandidates.length) }, (_, offset) =>
          publicCandidates[(candidateOffset + offset) % publicCandidates.length]);
        const nominatedInstruments = nominatedSymbols.flatMap(candidate => {
          const instrument = universe.find(item => item.symbol.toUpperCase() === candidate.symbol);
          return instrument ? [instrument] : [];
        });
        const candidateSources = new Map(publicCandidates.map(candidate => [candidate.symbol, candidate.source]));
        const scanUniverse = [...new Map([...heldInstruments, ...nominatedInstruments, ...rotating].map(instrument =>
          [instrument.ticker, instrument])).values()].slice(0, scanSize);
        const shortCandidates = (await Promise.all(scanUniverse.map(async instrument => {
          try {
            const bars = await fetchSeries(instrument.symbol, "5min");
            const newest = bars[0];
            const oldest = bars[Math.min(11, bars.length - 1)];
            const held = heldInstruments.some(item => item.ticker === instrument.ticker);
            if (!newest || !oldest || !String(newest.datetime || "").startsWith(marketDate)) return null;
            const normalVolume = bars.slice(1, 21).reduce((sum, bar) => sum + Number(bar.volume || 0), 0) /
              Math.max(1, bars.slice(1, 21).filter(bar => bar.volume).length);
            const momentum = oldest.close ? ((newest.close / oldest.close) - 1) * 100 : 0;
            const volumeRatio = normalVolume ? newest.volume / normalVolume : 0;
            if (!held && (newest.close < 1 || normalVolume < 10_000 || momentum <= 0)) return null;
            const source = candidateSources.get(instrument.symbol.toUpperCase()) || "";
            const sourceBonus = source.includes("gainers") ? 3 : source.includes("unusual") ? 2 : source ? 1 : 0;
            const activity = held ? 100 + Math.abs(momentum) : (momentum * 3) + Math.min(volumeRatio, 4) + sourceBonus;
            return { instrument, bars, activity };
          } catch {
            return null;
          }
        }))).filter(Boolean) as Array<{ instrument: Instrument; bars: Bar[]; activity: number }>;
        const deepCandidates = shortCandidates
          .sort((a, b) => {
            const aHeld = heldInstruments.some(item => item.ticker === a.instrument.ticker) ? 1 : 0;
            const bHeld = heldInstruments.some(item => item.ticker === b.instrument.ticker) ? 1 : 0;
            return (bHeld - aHeld) || (b.activity - a.activity);
          })
          .slice(0, 2);
        const benchmark = await fetchSeries("SPY", "1h");
        const analyses = await Promise.all(deepCandidates.map(async candidate => {
          const { instrument, bars: shortBars } = candidate;
          const [longBars, dailyBars] = await Promise.all([
            fetchSeries(instrument.symbol, "1h"),
            fetchSeries(instrument.symbol, "1day", 220)
          ]);
          const held = positions.some((position: { ticker?: string }) => position.ticker === instrument.ticker);
          let current = analyse(shortBars, longBars, benchmark, held, dailyBars);
          const heldPosition = positions.find((position: { ticker?: string }) => position.ticker === instrument.ticker);
          const averagePrice = Number(heldPosition?.averagePrice || 0);
          const currentPrice = Number(heldPosition?.currentPrice || current.referencePrice || 0);
          const positionReturn = averagePrice > 0 ? ((currentPrice / averagePrice) - 1) * 100 : 0;
          if (held && positionReturn <= -3) {
            current = {
              ...current,
              verdict: "SELL",
              confidence: 100,
              score: Math.min(current.score, 20),
              explanation: `Strict position stop: the paper position fell ${Math.abs(positionReturn).toFixed(2)}%, reaching the 3% adverse-move limit.`,
              signals: { ...current.signals, strictPositionStop: true, positionReturnPercent: Number(positionReturn.toFixed(3)) }
            };
          }
          const currentData = String(shortBars[0]?.datetime || "").startsWith(marketDate);
          return {
            instrument,
            held,
            result: currentData ? current : {
              ...current,
              verdict: "HOLD" as const,
              confidence: 0,
              explanation: "No trade: the latest completed market bar is not from today."
            }
          };
        }));
        const nextCursor = (cursor + scanUniverse.length) % universe.length;
        settings.scan_cursor = nextCursor;
        await admin.from("engine_settings").update({ scan_cursor: nextCursor }).eq("user_id", user.id);
        const sell = analyses.filter(item => item.held && item.result.verdict === "SELL").sort((a, b) => a.result.score - b.result.score)[0];
        const buy = analyses
          .filter(item => !item.held && item.result.verdict === "BUY" && !stoppedThisCycle.has(item.instrument.symbol))
          .sort((a, b) => b.result.score - a.result.score)[0];
        const selected = sell || buy || [...analyses].sort((a, b) => Math.abs(b.result.score - 50) - Math.abs(a.result.score - 50))[0];
        if (selected) {
          const { instrument, held, result } = selected;
          decision = {
            symbol: instrument.symbol,
            action: result.verdict,
            confidence: result.confidence,
            reason: candidateSources.has(instrument.symbol.toUpperCase())
              ? `Candidate nominated by ${candidateSources.get(instrument.symbol.toUpperCase())}; ${result.explanation}`
              : result.explanation,
            quantity: null,
            broker_order_id: null,
            score: result.score,
            signals: {
              ...result.signals,
              marketUniverseSize: universe.length,
              publicCandidatesAvailable: publicCandidates.length,
              candidateSource: candidateSources.get(instrument.symbol.toUpperCase()) || "Rotating Trading 212 universe",
              candidatesScanned: scanUniverse.length,
              candidatesDeepAnalysed: deepCandidates.length
            },
            reference_price: result.referencePrice,
            strategy_version: "mechanical-day-trader-v8"
          };
          const testCash = Number(settings.test_cash);
          if (result.verdict === "BUY" && !held && testCash >= 1) {
            const exposureCap = Number(settings.starting_balance) * (Number(settings.max_position_percent) / 100);
            const intelligentSize = Number(settings.starting_balance) * (result.suggestedExposurePercent / 100);
            const stopDistancePercent = Number(result.signals.stopDistancePercent || 3);
            const onePercentRiskSize = stopDistancePercent > 0
              ? (Number(settings.starting_balance) * 0.01) / (stopDistancePercent / 100)
              : exposureCap;
            const orderValue = Math.min(testCash, exposureCap, intelligentSize, onePercentRiskSize);
            const quantity = Math.max(0.0001, Number((orderValue / result.referencePrice).toFixed(4)));
            const order = await broker("/equity/orders/market", { method: "POST", body: JSON.stringify({ ticker: instrument.ticker, quantity }) });
            settings.test_cash = Math.max(0, testCash - (quantity * result.referencePrice));
            await admin.from("engine_settings").update({ test_cash: settings.test_cash, updated_at: new Date().toISOString() }).eq("user_id", user.id);
            decision.quantity = quantity;
            decision.broker_order_id = String(order?.id || "");
            const stopPrice = Number(result.signals.stopPrice || result.referencePrice * 0.97);
            const riskPerShare = Math.max(0, result.referencePrice - stopPrice);
            const targetOne = result.referencePrice + (riskPerShare * 2);
            const targetTwo = result.referencePrice + (riskPerShare * 3);
            const riskAmount = quantity * riskPerShare;
            const strategy = Number(result.signals.breakoutPercent || 0) > 0
              ? "Opening Range Breakout"
              : result.signals.priceAboveVwap
                ? "VWAP Pullback"
                : "Support Bounce";
            decision.signals = {
              ...decision.signals,
              strategy,
              entryTriggerPrice: result.referencePrice,
              assignedStopPrice: stopPrice,
              profitTargetOne: targetOne,
              profitTargetTwo: targetTwo,
              calculatedRiskAmount: riskAmount,
              onePercentRiskRulePassed: riskAmount <= Number(settings.starting_balance) * 0.01
            };
            decision.reason = `[TRADE SIGNAL GENERATED]
TICKER: ${instrument.symbol}
STRATEGY: ${strategy}
DIRECTION: LONG
ENTRY TRIGGER: $${result.referencePrice.toFixed(2)}
ASSIGNED STOP: $${stopPrice.toFixed(2)} (calculated paper risk: £${riskAmount.toFixed(2)})
TARGET 1: $${targetOne.toFixed(2)} (2:1)
TARGET 2: $${targetTwo.toFixed(2)} (3:1)
POSITION: ${quantity.toFixed(4)} shares
RISK: Sized below 1% of the £${Number(settings.starting_balance).toFixed(0)} paper account; setup reward/risk ${Number(result.signals.riskRewardRatio || 0).toFixed(2)}:1.`;
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
      settings.last_deep_scan_at = now.toISOString();
      await admin.from("engine_settings").update({
        last_deep_scan_at: now.toISOString()
      }).eq("user_id", user.id);
      brokerPositions = await loadBrokerPositions(true);
      ownedDecisions = (await admin.from("engine_decisions")
        .select("symbol,action,quantity,signals,created_at")
        .eq("user_id", user.id)
        .in("action", ["BUY", "SELL"])
        .order("created_at", { ascending: true })).data || [];
      positions = testPositions();
    } else if (runTradingCycle && settings.enabled) {
      await admin.from("engine_decisions").insert({
        user_id: user.id,
        action: "HOLD",
        confidence: 0,
        reason: "One-minute assessment complete: engine, cash, positions and loss controls checked. Waiting for the next completed five-minute market bar before issuing a new trade signal.",
        score: 50,
        signals: {
          minuteRiskCheck: true,
          nextDeepScanInSeconds: Math.max(0, Math.ceil(((lastDeepScan + 5 * 60_000) - Date.now()) / 1000))
        },
        strategy_version: "minute-risk-check-v1"
      });
    }

    const investedValue = positionValue(positions);
    const currentValue = Number(settings.test_cash) + investedValue;
    await admin.from("account_snapshots")
      .delete()
      .eq("user_id", user.id)
      .gt("value", Number(settings.starting_balance) * 10);
    if (currentValue > 0) await admin.from("account_snapshots").insert({ user_id: user.id, value: currentValue });

    const [decisions, snapshots] = await Promise.all([
      admin.from("engine_decisions").select("*").eq("user_id", user.id).order("created_at", { ascending: false }).limit(30),
      admin.from("account_snapshots").select("value,created_at").eq("user_id", user.id).order("created_at", { ascending: false }).limit(80)
    ]);
    return json({
      connected: true,
      mode: "Trading 212 Demo",
      rateLimited,
      enabled: settings.enabled,
      autopilotEnabled: settings.autopilot_enabled,
      marketOpen,
      trialStartedAt: settings.trial_started_at,
      trialEndsAt: settings.trial_ends_at,
      lastBackgroundRun: settings.last_background_run,
      lastDeepScanAt: settings.last_deep_scan_at || null,
      dailyPaused: settings.daily_paused_on === marketDate,
      scanner: {
        universeSize: universe.length,
        publicCandidates: publicCandidates.length,
        publicCandidatesUpdatedAt: settings.public_candidates_updated_at || null,
        cursor: Number(settings.scan_cursor || 0),
        candidatesPerCycle: 5,
        mode: "rotating-market-scan"
      },
      cash: { free: Number(settings.test_cash) },
      positions,
      testAccount: { cash: Number(settings.test_cash), invested: investedValue, total: currentValue },
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
