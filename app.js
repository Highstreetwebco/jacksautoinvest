(() => {
  "use strict";
  const $ = s => document.querySelector(s);
  const cfg = window.JAI_CONFIG || {};
  const SESSION_KEY = "jai-supabase-session";
  let session = JSON.parse(localStorage.getItem(SESSION_KEY) || "null");
  let brokerState = null;
  let refreshTimer = null;
  const money = value => new Intl.NumberFormat("en-GB", { style: "currency", currency: "GBP" }).format(Number(value || 0));
  const configured = () => Boolean(cfg.supabaseUrl && cfg.supabaseAnonKey);
  const headers = () => ({ apikey: cfg.supabaseAnonKey, Authorization: `Bearer ${session?.access_token || cfg.supabaseAnonKey}`, "Content-Type": "application/json" });

  async function refreshSession() {
    if (!session?.refresh_token || !configured()) return false;
    const response = await fetch(`${cfg.supabaseUrl}/auth/v1/token?grant_type=refresh_token`, {
      method: "POST",
      headers: { apikey: cfg.supabaseAnonKey, "Content-Type": "application/json" },
      body: JSON.stringify({ refresh_token: session.refresh_token })
    });
    if (!response.ok) return false;
    session = await response.json();
    localStorage.setItem(SESSION_KEY, JSON.stringify(session));
    return true;
  }

  async function broker(action = "status") {
    if (!configured() || !session?.access_token) throw new Error("Secure connection setup required");
    const response = await fetch(`${cfg.supabaseUrl}/functions/v1/trading-engine`, {
      method: action === "status" ? "GET" : "POST", headers: headers(),
      body: action === "status" ? undefined : JSON.stringify({ action })
    });
    const data = await response.json();
    if (!response.ok || data.error || data.setupRequired) throw new Error(data.error || "Broker credentials are not configured");
    return data;
  }
  async function refresh() {
    try { brokerState = await broker(); renderConnected(); }
    catch (error) { renderDisconnected(error.message); }
  }
  function portfolioNumbers(data) {
    const positions = Array.isArray(data?.positions) ? data.positions : [];
    const invested = Number(data?.testAccount?.invested || 0);
    const free = Number(data?.testAccount?.cash || 0);
    const total = Number(data?.testAccount?.total || free + invested);
    return { positions, invested, free, total };
  }
  function renderConnected() {
    const { positions, invested, free, total } = portfolioNumbers(brokerState);
    const gain = total - 100;
    $("#marketStatus").innerHTML = `<i></i> Trading 212 Demo connected`;
    $("#engineState").textContent = brokerState.enabled ? "RUNNING" : "STOPPED";
    $("#engineMessage").textContent = brokerState.enabled ? "Real-market paper engine active" : "Paper broker connected and ready";
    $("#engineLight").classList.toggle("running", brokerState.enabled);
    $("#startEngine").disabled = brokerState.enabled; $("#stopEngine").disabled = !brokerState.enabled;
    $("#portfolioValue").textContent = money(total);
    $("#totalReturn").textContent = `${gain >= 0 ? "+" : ""}${money(gain)} · ${gain >= 0 ? "+" : ""}${gain.toFixed(2)}%`;
    $("#totalReturn").className = `return ${gain >= 0 ? "positive" : "negative"}`;
    $("#cashValue").textContent = money(free); $("#investedValue").textContent = money(invested);
    $("#todayChange").textContent = `${gain >= 0 ? "+" : ""}${money(gain)}`;
    $("#tradeCount").textContent = String(brokerState.decisions?.filter(d => d.action !== "HOLD").length || 0);
    $("#chartCaption").textContent = brokerState.enabled ? "REAL-MARKET PAPER VALUE" : "ENGINE STOPPED";
    $("#lastUpdated").textContent = `Broker synced ${new Date(brokerState.updatedAt).toLocaleTimeString("en-GB",{hour:"2-digit",minute:"2-digit"})}`;
    $("#analysisText").textContent = brokerState.enabled ? "Waiting for the next secured market cycle…" : "Connected—press Start when ready";
    renderChart(brokerState.snapshots || []);
    $("#positionGrid").innerHTML = positions.length ? positions.map(p => `<article class="position-card"><div><span class="ticker">${p.ticker || p.instrument?.ticker || "POSITION"}</span><small>Trading 212 Demo</small></div><strong>${money(p.currentValue ?? Number(p.quantity || 0) * Number(p.currentPrice || 0))}</strong><div class="position-meta"><span>${Number(p.quantity || 0).toFixed(4)} units</span><b>${money(p.ppl || 0)}</b></div></article>`).join("") : `<article class="empty-state"><span>◎</span><h3>No open paper positions</h3><p>The connected Demo account currently holds cash.</p></article>`;
    const decisions = brokerState.decisions || [];
    $("#activityList").innerHTML = decisions.length ? decisions.map(d => `<article><span class="trade-icon ${d.action.toLowerCase()}">${d.action[0]}</span><div><strong>${d.action} · ${d.symbol || "Engine"}</strong><small>${d.reason}</small></div><div><b>${d.quantity ? `${d.quantity} units` : "No order"}</b><small>${new Date(d.created_at).toLocaleString("en-GB")}</small></div></article>`).join("") : `<article class="feed-placeholder"><span class="trade-icon hold">—</span><div><strong>No broker decisions yet</strong><small>Real paper orders will appear here after the engine starts.</small></div></article>`;
  }
  function renderChart(snapshots) {
    const values = snapshots.map(s => Number(s.value)).filter(Number.isFinite);
    if (values.length < 2) return;
    const min = Math.min(...values), max = Math.max(...values), range = Math.max(.01, max - min);
    const points = values.map((v, i) => `${(i / (values.length - 1)) * 900},${270 - ((v - min) / range) * 240}`);
    const line = `M${points.join(" L")}`;
    $("#chartLine").setAttribute("d", line);
    $("#chartArea").setAttribute("d", `${line} L900 300 L0 300 Z`);
    const [x, y] = points.at(-1).split(",");
    $("#chartPoint").setAttribute("cx", x); $("#chartPoint").setAttribute("cy", y);
  }
  function renderDisconnected(message = "Secure connection setup required") {
    $("#marketStatus").innerHTML = `<i></i> Broker disconnected`; $("#engineState").textContent = "DISCONNECTED";
    $("#engineMessage").textContent = message; $("#startEngine").disabled = false; $("#stopEngine").disabled = true;
    $("#analysisText").textContent = "Waiting for Trading 212 Demo and Supabase…"; $("#chartCaption").textContent = "NO MARKET DATA";
  }
  async function changeEngine(action) {
    const button = action === "start" ? $("#confirmStart") : $("#stopEngine"); button.disabled = true;
    try {
      brokerState = await broker(action); $("#confirmPanel").hidden = true; document.body.style.overflow = ""; renderConnected();
      clearInterval(refreshTimer);
      if (action === "start") {
        brokerState = await broker("tick"); renderConnected();
        refreshTimer = setInterval(async () => { try { brokerState = await broker("tick"); renderConnected(); } catch (error) { renderDisconnected(error.message); } }, 60000);
      }
    } catch (error) { $("#confirmCopy").textContent = error.message; renderDisconnected(error.message); }
    finally { button.disabled = false; }
  }
  async function signIn() {
    const email = $("#ownerEmail").value.trim();
    const password = $("#ownerPassword").value;
    const message = $("#loginMessage");
    const button = $("#signInButton");
    if (!configured()) { $("#loginMessage").textContent = "Supabase has not been connected yet."; return; }
    if (!email || !password) { $("#loginMessage").textContent = "Enter your email and password."; return; }
    button.disabled = true;
    button.textContent = "Signing in…";
    message.textContent = "Securely checking your account…";
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 12000);
    try {
      const response = await fetch(`${cfg.supabaseUrl}/auth/v1/token?grant_type=password`, {
        method: "POST",
        headers: { apikey: cfg.supabaseAnonKey, "Content-Type": "application/json" },
        body: JSON.stringify({ email, password }),
        signal: controller.signal
      });
      const details = await response.json().catch(() => ({}));
      if (!response.ok) {
        throw new Error(details.msg || details.message || details.error_description || "Sign in failed.");
      }
      session = details;
      localStorage.setItem(SESSION_KEY, JSON.stringify(session));
      message.textContent = "Signed in securely.";
      $("#loginFields").hidden = true;
      $("#confirmStart").hidden = false;
      await refresh();
    } catch (error) {
      message.textContent = error.name === "AbortError"
        ? "Supabase took too long to respond. Check your connection and try again."
        : error.message || "Sign in failed. Please try again.";
    } finally {
      clearTimeout(timeout);
      button.disabled = false;
      button.textContent = "Sign in securely";
    }
  }
  $("#menuButton").addEventListener("click", () => { const open = $("#mainNav").classList.toggle("open"); $("#menuButton").setAttribute("aria-expanded", String(open)); });
  $("#mainNav").querySelectorAll("a").forEach(a => a.addEventListener("click", () => $("#mainNav").classList.remove("open")));
  $("#startEngine").addEventListener("click", () => {
    $("#confirmCopy").textContent = configured() && session ? "Trading 212 Demo is ready to receive genuine paper orders using real market conditions." : "The secure paper broker must be connected before the engine can start.";
    $("#confirmPanel").hidden = false; document.body.style.overflow = "hidden";
    $("#loginFields").hidden = Boolean(session);
    $("#confirmStart").hidden = !session;
  });
  $("#signInButton").addEventListener("click", signIn);
  $("#ownerPassword").addEventListener("keydown", event => {
    if (event.key === "Enter") signIn();
  });
  $("#confirmStart").addEventListener("click", () => changeEngine("start"));
  $("#stopEngine").addEventListener("click", () => changeEngine("stop"));
  $("#closeConfirm").addEventListener("click", () => { $("#confirmPanel").hidden = true; document.body.style.overflow = ""; });
  $("#resetAccount").addEventListener("click", refresh);
  if (configured() && session) {
    refreshSession().then(ok => ok ? refresh() : renderDisconnected("Please sign in again"));
  } else {
    renderDisconnected();
  }
})();