(() => {
  "use strict";
  const $ = selector => document.querySelector(selector);
  const money = value => new Intl.NumberFormat("en-GB", {style:"currency", currency:"GBP"}).format(value);
  const STORAGE_KEY = "jack-auto-invest-paper-v2";
  const assets = [
    {symbol:"GLOBAL", name:"Global Equity ETF", price:12.42, drift:.0008, volatility:.008},
    {symbol:"TECH", name:"Technology ETF", price:18.76, drift:.0011, volatility:.013},
    {symbol:"GREEN", name:"Clean Energy ETF", price:8.31, drift:.0005, volatility:.016},
    {symbol:"BOND", name:"Short Bond ETF", price:5.62, drift:.00025, volatility:.003}
  ];
  const defaultState = () => ({
    running:false, cash:100, startedAt:null, startValue:100, ticks:0, trades:[],
    positions:{}, history:[100], prices:Object.fromEntries(assets.map(a => [a.symbol,a.price]))
  });
  let state = loadState();
  let timer = null;

  function loadState() {
    try {
      const stored = JSON.parse(localStorage.getItem(STORAGE_KEY));
      return stored && typeof stored.cash === "number" ? {...defaultState(), ...stored, running:false} : defaultState();
    } catch { return defaultState(); }
  }
  function saveState() {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({...state, running:false}));
  }
  function portfolioValue() {
    return state.cash + Object.entries(state.positions).reduce((sum,[symbol,p]) => sum + p.units * state.prices[symbol], 0);
  }
  function investedValue() { return portfolioValue() - state.cash; }
  function priceStep(asset) {
    const cycle = Math.sin((state.ticks + assets.indexOf(asset) * 7) / 8) * .0025;
    const shock = (Math.random() - .48) * asset.volatility;
    state.prices[asset.symbol] = Math.max(.5, state.prices[asset.symbol] * (1 + asset.drift + cycle + shock));
  }
  function signals() {
    const recent = state.history.slice(-8);
    const momentum = recent.length > 2 ? (recent.at(-1) / recent[0] - 1) : 0;
    const sentiment = Math.max(-1, Math.min(1, Math.sin(state.ticks / 5) * .55 + (Math.random() - .5) * .6));
    const volatility = Math.min(1, Math.abs(Math.cos(state.ticks / 7)) * .65);
    const score = momentum * 20 + sentiment * .45 - volatility * .12 + .22;
    return {momentum, sentiment, volatility, score, confidence:Math.round(58 + Math.min(36, Math.abs(score) * 55))};
  }
  function addTrade(type, asset, amount, reason, confidence) {
    state.trades.unshift({type, symbol:asset.symbol, name:asset.name, amount, reason, confidence, time:new Date().toISOString()});
    state.trades = state.trades.slice(0,30);
  }
  function decide(sig) {
    const openSymbols = Object.keys(state.positions);
    const candidate = assets[(state.ticks * 3 + Math.floor(sig.confidence)) % assets.length];
    if (sig.score > .3 && state.cash >= 5 && state.ticks % 4 === 0) {
      const amount = Math.min(state.cash, Math.max(5, portfolioValue() * .18));
      const units = amount / state.prices[candidate.symbol];
      const existing = state.positions[candidate.symbol] || {units:0, cost:0};
      existing.units += units; existing.cost += amount;
      state.positions[candidate.symbol] = existing; state.cash -= amount;
      addTrade("BUY", candidate, amount, `Positive trend and sentiment passed all exposure checks.`, sig.confidence);
      setDecision(`Bought ${candidate.symbol}`, `Momentum and simulated sentiment agreed. ${money(amount)} moved from cash into ${candidate.name}.`);
    } else if ((sig.score < -.15 || state.ticks % 11 === 0) && openSymbols.length) {
      const symbol = openSymbols[0], asset = assets.find(a => a.symbol === symbol), pos = state.positions[symbol];
      const units = pos.units * .5, amount = units * state.prices[symbol];
      pos.units -= units; state.cash += amount;
      if (pos.units < .0001) delete state.positions[symbol];
      addTrade("SELL", asset, amount, `Risk reduced after momentum weakened or the rebalance rule fired.`, sig.confidence);
      setDecision(`Reduced ${asset.symbol}`, `The risk rule overruled growth seeking and returned ${money(amount)} to cash.`);
    } else {
      setDecision("Holding position", "No trade met the confidence threshold. The engine kept the account unchanged.");
    }
  }
  function setDecision(title, reason) {
    $("#decisionTitle").textContent = title;
    $("#decisionReason").textContent = reason;
  }
  function tick() {
    state.ticks += 1;
    assets.forEach(priceStep);
    const beforeDecision = portfolioValue();
    state.history.push(beforeDecision);
    state.history = state.history.slice(-80);
    const sig = signals();
    $("#analysisText").textContent = ["Scanning momentum and volatility…","Comparing four paper assets…","Checking exposure and loss limits…","Reading simulated sentiment…"][state.ticks % 4];
    $("#trendSignal").textContent = sig.score > .2 ? "Rising" : sig.score < -.1 ? "Falling" : "Mixed";
    $("#trendSignal").className = sig.score > .2 ? "positive" : sig.score < -.1 ? "negative" : "";
    $("#sentimentSignal").textContent = sig.sentiment > .2 ? "Positive" : sig.sentiment < -.2 ? "Cautious" : "Neutral";
    $("#confidenceSignal").textContent = `${sig.confidence}%`;
    if (state.ticks % 3 === 0) decide(sig);
    const value = portfolioValue();
    state.history[state.history.length - 1] = value;
    if (value <= state.startValue * .98) stopEngine("Daily loss guard activated");
    saveState(); render();
  }
  function startEngine() {
    if (!state.startedAt) { state.startedAt = Date.now(); state.startValue = portfolioValue(); }
    state.running = true;
    clearInterval(timer);
    timer = setInterval(tick, 1600);
    $("#confirmPanel").hidden = true;
    document.body.style.overflow = "";
    tick(); render();
  }
  function stopEngine(message="Stopped by Jack") {
    state.running = false; clearInterval(timer); timer = null; saveState(); render();
    $("#engineMessage").textContent = message;
  }
  function resetAccount() {
    if (!confirm("Reset the paper account to £100 and remove its test trades?")) return;
    stopEngine(); state = defaultState(); saveState(); render(); setDecision("Standing by","Start the paper engine to begin analysing simulated market signals.");
  }
  function renderChart() {
    const values = state.history.length > 1 ? state.history : [100,100];
    const min = Math.min(...values, 99), max = Math.max(...values, 101), range = Math.max(1,max-min);
    const points = values.map((v,i) => `${(i/(values.length-1))*900},${270-((v-min)/range)*240}`);
    const line = `M${points.join(" L")}`;
    $("#chartLine").setAttribute("d", line);
    $("#chartArea").setAttribute("d", `${line} L900 300 L0 300 Z`);
    const [x,y] = points.at(-1).split(",");
    $("#chartPoint").setAttribute("cx",x); $("#chartPoint").setAttribute("cy",y);
  }
  function renderPositions() {
    const entries = Object.entries(state.positions);
    $("#positionGrid").innerHTML = entries.length ? entries.map(([symbol,p]) => {
      const asset = assets.find(a => a.symbol === symbol), value = p.units * state.prices[symbol], change = value - p.cost;
      return `<article class="position-card"><div><span class="ticker">${symbol}</span><small>${asset.name}</small></div><strong>${money(value)}</strong><div class="position-meta"><span>${p.units.toFixed(3)} units</span><b class="${change>=0?"positive":"negative"}">${change>=0?"+":""}${money(change)}</b></div></article>`;
    }).join("") : `<article class="empty-state"><span>◎</span><h3>No open positions</h3><p>Start the engine and it will only buy when its rules identify a suitable paper trade.</p></article>`;
  }
  function renderTrades() {
    $("#activityList").innerHTML = state.trades.length ? state.trades.slice(0,8).map(t => `<article><span class="trade-icon ${t.type.toLowerCase()}">${t.type[0]}</span><div><strong>${t.type} · ${t.name}</strong><small>${t.reason}</small></div><div><b>${money(t.amount)}</b><small>${new Date(t.time).toLocaleTimeString("en-GB",{hour:"2-digit",minute:"2-digit"})} · ${t.confidence}%</small></div></article>`).join("") : `<article class="feed-placeholder"><span class="trade-icon hold">—</span><div><strong>The engine has not traded yet</strong><small>Its first decision will appear here with a clear reason.</small></div></article>`;
  }
  function render() {
    const value = portfolioValue(), gain = value - 100, percent = gain;
    $("#portfolioValue").textContent = money(value);
    $("#totalReturn").textContent = `${gain>=0?"+":""}${money(gain)} · ${percent>=0?"+":""}${percent.toFixed(2)}%`;
    $("#totalReturn").className = `return ${gain>0?"positive":gain<0?"negative":"flat"}`;
    $("#cashValue").textContent = money(state.cash); $("#investedValue").textContent = money(investedValue());
    $("#todayChange").textContent = `${gain>=0?"+":""}${money(gain)}`; $("#todayChange").className = gain>=0?"positive":"negative";
    $("#tradeCount").textContent = state.trades.length;
    $("#engineState").textContent = state.running ? "RUNNING" : "STOPPED";
    $("#engineMessage").textContent = state.running ? "Analysing paper market every few seconds" : "Press Start to continue the paper test";
    $("#engineLight").classList.toggle("running",state.running); $("#brainPulse").classList.toggle("running",state.running);
    $("#marketStatus").innerHTML = `<i></i> ${state.running?"Paper engine live":"Engine ready"}`;
    $("#startEngine").disabled = state.running; $("#stopEngine").disabled = !state.running;
    $("#chartCaption").textContent = state.running ? "LIVE PAPER VALUE" : "ENGINE STOPPED";
    $("#lastUpdated").textContent = state.startedAt ? `Saved ${new Date().toLocaleTimeString("en-GB",{hour:"2-digit",minute:"2-digit"})}` : "Not started";
    renderChart(); renderPositions(); renderTrades();
  }

  $("#menuButton").addEventListener("click", () => {
    const open = $("#mainNav").classList.toggle("open"); $("#menuButton").setAttribute("aria-expanded",String(open));
  });
  $("#mainNav").querySelectorAll("a").forEach(a => a.addEventListener("click",()=>$("#mainNav").classList.remove("open")));
  $("#startEngine").addEventListener("click",()=>{$("#confirmPanel").hidden=false;document.body.style.overflow="hidden";});
  $("#confirmStart").addEventListener("click",startEngine);
  $("#stopEngine").addEventListener("click",()=>stopEngine());
  $("#resetAccount").addEventListener("click",resetAccount);
  $("#closeConfirm").addEventListener("click",()=>{$("#confirmPanel").hidden=true;document.body.style.overflow="";});
  $("#confirmPanel").addEventListener("click",e=>{if(e.target===$("#confirmPanel")){$("#confirmPanel").hidden=true;document.body.style.overflow="";}});
  window.addEventListener("beforeunload",saveState);
  render();
})();
