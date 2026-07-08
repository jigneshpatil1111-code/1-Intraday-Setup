const storeKey = "dhan-paper-dashboard-v1";

const defaultState = {
  settings: {
    capital: 5000,
    leverage: 5,
    maxTrades: 2,
    allocationPct: 50,
    autoPaperTrade: false,
    dailyLossPct: 3,
    weeklyLossPct: 8,
    monthlyLossPct: 15,
    dailyTargetPct: 6,
  },
  api: {
    broker: "dhan",
    mode: "websocket",
    clientId: "",
    apiKey: "",
    accessToken: "",
    apiSecret: "",
    feedToken: "",
    wsUrl: "wss://api-feed.dhan.co",
    quoteUrl: "https://api.dhan.co/v2/marketfeed/ltp",
    exchangeSegment: "NSE_EQ",
    enabled: false,
    lastTestedAt: "",
  },
  scanner: {
    enabled: false,
    watchlist: "SBIN,TCS,INFY,RELIANCE",
    intervalSec: 60,
    minMovePct: 1,
    signalCooldownMin: 45,
    lastScanAt: "",
    lastScanStatus: "Scanner idle",
    lastSignalBySymbol: {},
  },
  signals: [],
  trades: [],
};

const brokerPresets = {
  dhan: {
    name: "DhanHQ",
    wsUrl: "wss://api-feed.dhan.co",
    quoteUrl: "https://api.dhan.co/v2/marketfeed/ltp",
    required: ["clientId", "accessToken"],
    help: "DhanHQ ke liye Client ID aur Access Token chahiye. Paper trading scanner ke liye WebSocket live feed best rahega.",
  },
  zerodha: {
    name: "Zerodha Kite",
    wsUrl: "wss://ws.kite.trade",
    quoteUrl: "https://api.kite.trade/quote",
    required: ["apiKey", "accessToken"],
    help: "Zerodha me API Key aur daily generated Access Token chahiye. WebSocket ticker data ke liye Kite Connect subscription required hota hai.",
  },
  upstox: {
    name: "Upstox",
    wsUrl: "wss://api.upstox.com/v2/feed/market-data-feed",
    quoteUrl: "https://api.upstox.com/v2/market-quote/quotes",
    required: ["accessToken"],
    help: "Upstox market data ke liye OAuth Access Token use hota hai. Token expiry aur refresh flow backend me handle karna hoga.",
  },
  angel: {
    name: "Angel One SmartAPI",
    wsUrl: "wss://smartapisocket.angelone.in/smart-stream",
    quoteUrl: "https://apiconnect.angelone.in/rest/secure/angelbroking/market/v1/quote/",
    required: ["clientId", "apiKey", "accessToken", "feedToken"],
    help: "Angel One SmartAPI me Client ID, API Key, JWT/Access Token aur Feed Token ki zaroorat padti hai.",
  },
  fyers: {
    name: "Fyers",
    wsUrl: "wss://api-t1.fyers.in/data-feed",
    quoteUrl: "https://api-t1.fyers.in/data/quotes",
    required: ["clientId", "accessToken"],
    help: "Fyers feed ke liye App/Client ID aur Access Token chahiye. Symbols ko broker format me map karna padega.",
  },
  custom: {
    name: "Custom Feed",
    wsUrl: "",
    quoteUrl: "",
    required: ["wsUrl"],
    help: "Custom feed me apna WebSocket ya Quote API endpoint daalo. Backend adapter symbol mapping aur auth headers handle karega.",
  },
};

let state = loadState();
let liveQuoteInFlight = false;

function loadState() {
  const raw = localStorage.getItem(storeKey);
  if (!raw) return structuredClone(defaultState);
  try {
    const parsed = JSON.parse(raw);
    return {
      ...structuredClone(defaultState),
      ...parsed,
      settings: { ...defaultState.settings, ...(parsed.settings || {}) },
      api: sanitizeApiState({ ...defaultState.api, ...(parsed.api || {}) }),
      scanner: { ...defaultState.scanner, ...(parsed.scanner || {}) },
    };
  } catch {
    return structuredClone(defaultState);
  }
}

function sanitizeApiState(api) {
  return {
    ...api,
    clientId: "",
    apiKey: "",
    accessToken: "",
    apiSecret: "",
    feedToken: "",
  };
}

function saveState() {
  localStorage.setItem(storeKey, JSON.stringify(state));
}

function money(value) {
  return new Intl.NumberFormat("en-IN", { style: "currency", currency: "INR", maximumFractionDigits: 0 }).format(value || 0);
}

function fmt(value, digits = 2) {
  return Number(value || 0).toFixed(digits);
}

function todayKey(date = new Date()) {
  return date.toISOString().slice(0, 10);
}

function localDateKey(date = new Date()) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function weekStart(date = new Date()) {
  const d = new Date(date);
  const day = d.getDay() || 7;
  d.setDate(d.getDate() - day + 1);
  d.setHours(0, 0, 0, 0);
  return d;
}

function uid(prefix) {
  return `${prefix}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function toast(message) {
  const el = document.getElementById("toast");
  el.textContent = message;
  el.classList.add("show");
  setTimeout(() => el.classList.remove("show"), 2600);
}

function normalizeTicker(value) {
  return String(value || "").toUpperCase().replace(/-EQ$/, "").replace(/[^A-Z0-9]/g, "");
}

function listFromWatchlist(value) {
  return [...new Set(String(value || "")
    .split(/[\s,]+/)
    .map((item) => normalizeTicker(item))
    .filter(Boolean))];
}

function isMarketHours(date = new Date()) {
  const minutes = date.getHours() * 60 + date.getMinutes();
  const isWeekday = date.getDay() >= 1 && date.getDay() <= 5;
  return isWeekday && minutes >= 9 * 60 + 15 && minutes <= 15 * 60 + 30;
}

function openTrades() {
  return state.trades.filter((trade) => trade.status === "Open");
}

function closedTrades() {
  return state.trades.filter((trade) => trade.status === "Closed");
}

function tradePnl(trade) {
  const price = trade.status === "Closed" ? trade.exit : trade.currentPrice;
  return (Number(price) - Number(trade.entry)) * Number(trade.quantity);
}

function usedBuyingPower() {
  return openTrades().reduce((sum, trade) => sum + Number(trade.capitalUsed || 0), 0);
}

function buyingPower() {
  return Number(state.settings.capital) * Number(state.settings.leverage);
}

function availableBuyingPower() {
  return Math.max(0, buyingPower() - usedBuyingPower());
}

function pnlInRange(start, end = new Date()) {
  return closedTrades()
    .filter((trade) => new Date(trade.exitTime) >= start && new Date(trade.exitTime) <= end)
    .reduce((sum, trade) => sum + tradePnl(trade), 0);
}

function todayPnl() {
  const start = new Date();
  start.setHours(0, 0, 0, 0);
  return pnlInRange(start);
}

function riskLockReason() {
  const capital = Number(state.settings.capital);
  const dayLoss = -capital * Number(state.settings.dailyLossPct) / 100;
  const weekLoss = -capital * Number(state.settings.weeklyLossPct) / 100;
  const monthLoss = -capital * Number(state.settings.monthlyLossPct) / 100;
  const dayTarget = capital * Number(state.settings.dailyTargetPct) / 100;
  const monthStart = new Date();
  monthStart.setDate(1);
  monthStart.setHours(0, 0, 0, 0);

  if (todayPnl() <= dayLoss) return "Daily loss limit hit";
  if (pnlInRange(weekStart()) <= weekLoss) return "Weekly loss limit hit";
  if (pnlInRange(monthStart) <= monthLoss) return "Monthly loss limit hit";
  if (todayPnl() >= dayTarget) return "Daily target hit";
  return "";
}

function createTradeFromSignal(signal) {
  const reason = riskLockReason();
  if (reason) {
    toast(`Signal ignored: ${reason}`);
    return;
  }
  if (openTrades().length >= Number(state.settings.maxTrades)) {
    toast("Signal ignored: maximum open trades reached");
    return;
  }

  const allocation = buyingPower() * Number(state.settings.allocationPct) / 100;
  const capitalAllowed = Math.min(allocation, availableBuyingPower());
  const quantity = Math.floor(capitalAllowed / Number(signal.entry));
  const capitalUsed = quantity * Number(signal.entry);

  if (quantity < 1 || capitalUsed > availableBuyingPower()) {
    toast("Signal ignored: capital fully utilized");
    return;
  }

  state.trades.unshift({
    id: uid("trade"),
    stock: signal.stock.toUpperCase(),
    strategy: signal.strategy,
    entry: Number(signal.entry),
    quantity,
    capitalUsed,
    leverage: Number(state.settings.leverage),
    stopLoss: Number(signal.sl),
    target1: Number(signal.target1),
    target2: Number(signal.target2 || signal.target1),
    currentPrice: Number(signal.entry),
    entryTime: new Date().toISOString(),
    exit: null,
    exitTime: null,
    notes: "",
    status: "Open",
  });
  state.signals = state.signals.filter((item) => item.id !== signal.id);
  saveState();
  render();
  toast(`Paper BUY executed: ${signal.stock.toUpperCase()} qty ${quantity}`);
}

function addSignal(data) {
  const signal = {
    id: uid("signal"),
    stock: data.stock.toUpperCase(),
    strategy: data.strategy,
    entry: Number(data.entry),
    sl: Number(data.sl),
    target1: Number(data.target1),
    target2: Number(data.target2 || data.target1),
    createdAt: new Date().toISOString(),
  };
  state.signals.unshift(signal);
  saveState();
  render();
  if (state.settings.autoPaperTrade) createTradeFromSignal(signal);
}

function closeTrade(id, exitPrice) {
  const trade = state.trades.find((item) => item.id === id);
  if (!trade) return;
  trade.exit = Number(exitPrice || trade.currentPrice || trade.entry);
  trade.currentPrice = trade.exit;
  trade.exitTime = new Date().toISOString();
  trade.status = "Closed";
  saveState();
  render();
  toast(`${trade.stock} closed. P&L ${money(tradePnl(trade))}`);
}

function updateTrade(id, key, value) {
  const trade = state.trades.find((item) => item.id === id);
  if (!trade) return;
  trade[key] = ["currentPrice", "exit", "quantity", "entry"].includes(key) ? Number(value) : value;
  saveState();
  renderDashboardOnly();
}

function renderMetrics() {
  const closed = closedTrades();
  const wins = closed.filter((trade) => tradePnl(trade) > 0).length;
  const winRate = closed.length ? wins / closed.length * 100 : 0;
  const monthStart = new Date();
  monthStart.setDate(1);
  monthStart.setHours(0, 0, 0, 0);
  const daily = todayPnl();
  const weekly = pnlInRange(weekStart());
  const monthly = pnlInRange(monthStart);

  setText("capitalMetric", money(state.settings.capital));
  setText("buyingPowerMetric", money(buyingPower()));
  setText("usedCapitalMetric", money(usedBuyingPower()));
  setText("availablePowerMetric", money(availableBuyingPower()));
  setText("todayPnlMetric", money(daily), daily);
  setText("openTradesMetric", openTrades().length);
  setText("signalsMetric", state.signals.filter((signal) => signal.createdAt.slice(0, 10) === todayKey()).length);
  setText("winRateMetric", `${fmt(winRate, 0)}%`);
  setText("dailyPnl", money(daily), daily);
  setText("weeklyPnl", money(weekly), weekly);
  setText("monthlyPnl", money(monthly), monthly);
  setText("drawdownMetric", money(maxDrawdown()));
}

function setText(id, value, signed) {
  const el = document.getElementById(id);
  if (!el) return;
  el.textContent = value;
  el.classList.toggle("positive", signed > 0);
  el.classList.toggle("negative", signed < 0);
}

function renderSignals() {
  const html = state.signals.length ? state.signals.map(signalCard).join("") : empty("No active scanner signals yet.");
  document.getElementById("signalList").innerHTML = html;
  document.getElementById("scannerQueue").innerHTML = html;
}

function renderScannerSettings() {
  const form = document.getElementById("scannerForm");
  if (!form) return;
  Object.entries(state.scanner).forEach(([key, value]) => {
    if (!form.elements[key]) return;
    if (form.elements[key].type === "checkbox") form.elements[key].checked = Boolean(value);
    else form.elements[key].value = value ?? "";
  });
  const status = document.getElementById("scannerStatus");
  if (status) {
    status.classList.toggle("good", Boolean(state.scanner.enabled));
    status.classList.toggle("bad", !state.scanner.enabled);
    status.textContent = state.scanner.enabled ? "Auto Scanner On" : "Auto Scanner Off";
  }
  const note = document.getElementById("scannerMeta");
  if (note) {
    const watchCount = listFromWatchlist(state.scanner.watchlist).length;
    const lastScan = state.scanner.lastScanAt ? new Date(state.scanner.lastScanAt).toLocaleString("en-IN") : "Never";
    note.textContent = `${state.scanner.lastScanStatus} | Watchlist ${watchCount} | Last scan ${lastScan}`;
  }
}

function signalCard(signal) {
  const rr = (Number(signal.target1) - Number(signal.entry)) / Math.max(0.01, Number(signal.entry) - Number(signal.sl));
  return `
    <article class="signal-card">
      <div>
        <strong>${signal.stock}</strong>
        <p>${signal.strategy} | Entry ${money(signal.entry)} | SL ${money(signal.sl)} | T1 ${money(signal.target1)} | RR ${fmt(rr)}</p>
      </div>
      <div class="signal-actions">
        <button class="primary" data-buy-signal="${signal.id}">Paper BUY</button>
        <button class="ghost danger" data-remove-signal="${signal.id}">Ignore</button>
      </div>
    </article>
  `;
}

function renderTrades() {
  const openRows = openTrades().length ? openTrades().map((trade) => `
    <tr>
      <td>${trade.stock}</td><td>${trade.strategy}</td><td>${money(trade.entry)}</td>
      <td>${money(trade.currentPrice)}</td><td class="${tradePnl(trade) >= 0 ? "positive" : "negative"}">${money(tradePnl(trade))}</td><td>${trade.status}</td>
    </tr>
  `).join("") : `<tr><td colspan="6">No running paper trades.</td></tr>`;
  document.getElementById("openTradesBody").innerHTML = openRows;

  document.getElementById("tradesBody").innerHTML = state.trades.length ? state.trades.map((trade) => `
    <tr>
      <td>${trade.stock}</td>
      <td>${trade.strategy}</td>
      <td>${new Date(trade.entryTime).toLocaleString("en-IN")}</td>
      <td>${money(trade.entry)}</td>
      <td>${trade.quantity}</td>
      <td>${money(trade.capitalUsed)}</td>
      <td>${money(trade.stopLoss)}</td>
      <td>${money(trade.target1)}</td>
      <td>${money(trade.target2)}</td>
      <td>${trade.status === "Open" ? `<input data-trade-update="${trade.id}" data-key="currentPrice" type="number" step="0.05" value="${trade.currentPrice}">` : money(trade.exit)}</td>
      <td class="${tradePnl(trade) >= 0 ? "positive" : "negative"}">${money(tradePnl(trade))}</td>
      <td>${trade.status === "Open" ? `<button class="primary" data-close-trade="${trade.id}">Close</button>` : "Closed"}</td>
    </tr>
  `).join("") : `<tr><td colspan="12">No trades yet.</td></tr>`;
}

function renderJournal() {
  document.getElementById("journalBody").innerHTML = closedTrades().length ? closedTrades().map((trade) => {
    const pnl = tradePnl(trade);
    const holdMs = new Date(trade.exitTime) - new Date(trade.entryTime);
    const holdMin = Math.max(1, Math.round(holdMs / 60000));
    const rr = (Number(trade.exit) - Number(trade.entry)) / Math.max(0.01, Number(trade.entry) - Number(trade.stopLoss));
    return `
      <tr>
        <td>${trade.exitTime.slice(0, 10)}</td><td>${trade.stock}</td><td>${trade.strategy}</td>
        <td>${money(trade.entry)}</td><td>${money(trade.exit)}</td>
        <td>${new Date(trade.entryTime).toLocaleTimeString("en-IN")}</td>
        <td>${new Date(trade.exitTime).toLocaleTimeString("en-IN")}</td>
        <td>${trade.quantity}</td><td>${fmt(rr)}</td>
        <td class="${pnl >= 0 ? "positive" : "negative"}">${money(pnl)}</td>
        <td>${holdMin}m</td><td>${pnl >= 0 ? "Win" : "Loss"}</td>
        <td><textarea data-trade-update="${trade.id}" data-key="notes">${trade.notes || ""}</textarea></td>
      </tr>
    `;
  }).join("") : `<tr><td colspan="13">Completed trades will appear here.</td></tr>`;
}

function renderSettings() {
  const form = document.getElementById("settingsForm");
  Object.entries(state.settings).forEach(([key, value]) => {
    if (!form.elements[key]) return;
    if (form.elements[key].type === "checkbox") form.elements[key].checked = Boolean(value);
    else form.elements[key].value = value;
  });
  renderApiSettings();
}

function renderApiSettings() {
  const form = document.getElementById("apiForm");
  if (!form) return;
  Object.entries(state.api).forEach(([key, value]) => {
    if (!form.elements[key]) return;
    if (form.elements[key].type === "checkbox") form.elements[key].checked = Boolean(value);
    else form.elements[key].value = value ?? "";
  });
  renderBrokerHelp();
  renderApiStatus();
}

function renderBrokerHelp() {
  const broker = brokerPresets[state.api.broker] || brokerPresets.custom;
  const help = document.getElementById("brokerHelp");
  if (!help) return;
  help.innerHTML = `<strong>${broker.name} required fields:</strong> ${broker.required.join(", ")}. ${broker.help}`;
}

function renderApiStatus() {
  const status = document.getElementById("apiConnectionStatus");
  if (!status) return;
  const missing = missingApiFields();
  status.classList.toggle("good", Boolean(state.api.enabled) && !missing.length);
  status.classList.toggle("bad", Boolean(state.api.enabled) && Boolean(missing.length));
  if (!state.api.enabled) status.textContent = "Disabled";
  else if (missing.length) status.textContent = `Missing: ${missing.join(", ")}`;
  else status.textContent = `Ready: ${brokerPresets[state.api.broker]?.name || "Custom"}`;
}

function missingApiFields() {
  const broker = brokerPresets[state.api.broker] || brokerPresets.custom;
  return broker.required.filter((field) => !String(state.api[field] || "").trim());
}

function applyBrokerPreset(brokerKey) {
  const preset = brokerPresets[brokerKey] || brokerPresets.custom;
  state.api.broker = brokerKey;
  state.api.wsUrl = state.api.wsUrl && brokerKey === "custom" ? state.api.wsUrl : preset.wsUrl;
  state.api.quoteUrl = state.api.quoteUrl && brokerKey === "custom" ? state.api.quoteUrl : preset.quoteUrl;
  saveState();
  renderApiSettings();
}

function renderCharts() {
  drawLineChart("equityChart", equitySeries(), "Equity", "#22c7b8");
  drawBarChart("dailyChart", groupPnlByDate(), "#35d37f");
  drawPieChart("winLossChart", winLossData());
  drawBarChart("strategyChart", strategyPnl(), "#f2b84b");
}

function equitySeries() {
  let equity = Number(state.settings.capital);
  return closedTrades().slice().reverse().map((trade) => {
    equity += tradePnl(trade);
    return { label: trade.stock, value: equity };
  });
}

function groupPnlByDate() {
  const map = new Map();
  closedTrades().forEach((trade) => {
    const key = trade.exitTime.slice(0, 10);
    map.set(key, (map.get(key) || 0) + tradePnl(trade));
  });
  return [...map.entries()].sort().map(([label, value]) => ({ label, value }));
}

function strategyPnl() {
  const map = new Map();
  closedTrades().forEach((trade) => map.set(trade.strategy, (map.get(trade.strategy) || 0) + tradePnl(trade)));
  return [...map.entries()].map(([label, value]) => ({ label, value }));
}

function winLossData() {
  const wins = closedTrades().filter((trade) => tradePnl(trade) >= 0).length;
  const losses = closedTrades().length - wins;
  return { wins, losses };
}

function maxDrawdown() {
  let peak = Number(state.settings.capital);
  let equity = peak;
  let maxDd = 0;
  closedTrades().slice().reverse().forEach((trade) => {
    equity += tradePnl(trade);
    peak = Math.max(peak, equity);
    maxDd = Math.max(maxDd, peak - equity);
  });
  return maxDd;
}

function drawBase(canvasId) {
  const canvas = document.getElementById(canvasId);
  if (!canvas) return null;
  const ctx = canvas.getContext("2d");
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  ctx.fillStyle = "#070b10";
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.strokeStyle = "rgba(139, 154, 168, 0.16)";
  ctx.lineWidth = 1;
  for (let y = 60; y <= 220; y += 40) {
    ctx.beginPath();
    ctx.moveTo(40, y);
    ctx.lineTo(610, y);
    ctx.stroke();
  }
  for (let x = 100; x <= 580; x += 80) {
    ctx.beginPath();
    ctx.moveTo(x, 20);
    ctx.lineTo(x, 220);
    ctx.stroke();
  }
  ctx.strokeStyle = "rgba(139, 154, 168, 0.34)";
  ctx.beginPath();
  ctx.moveTo(40, 20);
  ctx.lineTo(40, 220);
  ctx.lineTo(610, 220);
  ctx.stroke();
  return { canvas, ctx };
}

function drawLineChart(canvasId, data, label, color) {
  const base = drawBase(canvasId);
  if (!base) return;
  const { ctx } = base;
  if (!data.length) return drawEmptyChart(ctx);
  const values = data.map((item) => item.value);
  const min = Math.min(...values, Number(state.settings.capital));
  const max = Math.max(...values, Number(state.settings.capital));
  const range = Math.max(1, max - min);
  ctx.shadowColor = color;
  ctx.shadowBlur = 12;
  ctx.strokeStyle = color;
  ctx.lineWidth = 3;
  ctx.beginPath();
  data.forEach((item, index) => {
    const x = 50 + index * (540 / Math.max(1, data.length - 1));
    const y = 220 - ((item.value - min) / range) * 180;
    if (index === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  });
  ctx.stroke();
  ctx.shadowBlur = 0;
  ctx.fillStyle = color;
  data.forEach((item, index) => {
    const x = 50 + index * (540 / Math.max(1, data.length - 1));
    const y = 220 - ((item.value - min) / range) * 180;
    ctx.beginPath();
    ctx.arc(x, y, 3, 0, Math.PI * 2);
    ctx.fill();
  });
  drawCaption(ctx, `${label}: ${money(values.at(-1))}`);
}

function drawBarChart(canvasId, data, color) {
  const base = drawBase(canvasId);
  if (!base) return;
  const { ctx } = base;
  if (!data.length) return drawEmptyChart(ctx);
  const maxAbs = Math.max(1, ...data.map((item) => Math.abs(item.value)));
  const width = Math.min(70, 520 / data.length);
  data.slice(-10).forEach((item, index) => {
    const x = 55 + index * (540 / Math.max(1, Math.min(10, data.length)));
    const h = Math.abs(item.value) / maxAbs * 150;
    ctx.fillStyle = item.value >= 0 ? color : "#ff5d64";
    ctx.shadowColor = item.value >= 0 ? "rgba(53, 211, 127, 0.42)" : "rgba(255, 93, 100, 0.42)";
    ctx.shadowBlur = 10;
    ctx.fillRect(x, item.value >= 0 ? 220 - h : 220, width, h);
    ctx.shadowBlur = 0;
    ctx.fillStyle = "#8b9aa8";
    ctx.font = "11px sans-serif";
    ctx.fillText(item.label.slice(5), x, 240);
  });
  drawCaption(ctx, `Total: ${money(data.reduce((sum, item) => sum + item.value, 0))}`);
}

function drawPieChart(canvasId, data) {
  const base = drawBase(canvasId);
  if (!base) return;
  const { ctx } = base;
  const total = data.wins + data.losses;
  if (!total) return drawEmptyChart(ctx);
  const cx = 320;
  const cy = 128;
  const r = 78;
  const winAngle = (data.wins / total) * Math.PI * 2;
  ctx.beginPath();
  ctx.moveTo(cx, cy);
  ctx.fillStyle = "#35d37f";
  ctx.shadowColor = "rgba(53, 211, 127, 0.35)";
  ctx.shadowBlur = 16;
  ctx.arc(cx, cy, r, 0, winAngle);
  ctx.fill();
  ctx.beginPath();
  ctx.moveTo(cx, cy);
  ctx.fillStyle = "#ff5d64";
  ctx.shadowColor = "rgba(255, 93, 100, 0.35)";
  ctx.arc(cx, cy, r, winAngle, Math.PI * 2);
  ctx.fill();
  ctx.shadowBlur = 0;
  drawCaption(ctx, `Wins ${data.wins} | Losses ${data.losses}`);
}

function drawEmptyChart(ctx) {
  ctx.fillStyle = "#8b9aa8";
  ctx.font = "14px sans-serif";
  ctx.fillText("No closed trades yet", 245, 130);
}

function drawCaption(ctx, text) {
  ctx.fillStyle = "#eef4f7";
  ctx.font = "14px sans-serif";
  ctx.fillText(text, 48, 35);
}

function empty(text) {
  return `<p class="hint">${text}</p>`;
}

function renderDashboardOnly() {
  renderMetrics();
  renderTrades();
  renderCharts();
}

function render() {
  renderMetrics();
  renderSignals();
  renderTrades();
  renderJournal();
  renderSettings();
  renderScannerSettings();
  renderReportRange();
  renderCharts();
}

function hasActiveSignalOrTrade(symbol) {
  const normalized = normalizeTicker(symbol);
  return state.signals.some((signal) => normalizeTicker(signal.stock) === normalized)
    || openTrades().some((trade) => normalizeTicker(trade.stock) === normalized);
}

function scannerSignalPayload(quote) {
  const ltp = Number(quote.ltp || 0);
  const open = Number(quote.open || ltp);
  const movePct = open > 0 ? ((ltp - open) / open) * 100 : 0;
  if (!Number.isFinite(ltp) || ltp <= 0 || !Number.isFinite(open) || open <= 0) return null;
  if (movePct < Number(state.scanner.minMovePct || 1)) return null;
  const symbol = normalizeTicker(quote.symbol || quote.tradingSymbol);
  if (!symbol || hasActiveSignalOrTrade(symbol)) return null;

  const cooldownMs = Number(state.scanner.signalCooldownMin || 45) * 60 * 1000;
  const lastSignalAt = state.scanner.lastSignalBySymbol?.[symbol];
  if (lastSignalAt && Date.now() - new Date(lastSignalAt).getTime() < cooldownMs) return null;

  const stopLoss = Math.max(open, ltp * 0.995);
  return {
    stock: symbol,
    strategy: "1% Setup Auto",
    entry: Number(ltp.toFixed(2)),
    sl: Number(stopLoss.toFixed(2)),
    target1: Number((ltp * 1.01).toFixed(2)),
    target2: Number((ltp * 1.015).toFixed(2)),
  };
}

async function runAutoScanner(silent = false, force = false) {
  if (!force && (!state.scanner.enabled || !isMarketHours())) return;
  const symbols = listFromWatchlist(state.scanner.watchlist);
  if (!symbols.length) {
    state.scanner.lastScanStatus = "Scanner watchlist empty";
    saveState();
    renderScannerSettings();
    if (!silent) toast("Scanner watchlist empty");
    return;
  }

  try {
    const response = await fetch("/api/market/quote", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        broker: state.api.enabled ? state.api.broker : "mock",
        exchangeSegment: state.api.exchangeSegment || "NSE_EQ",
        quoteMode: "OHLC",
        symbols,
      }),
    });
    const payload = await response.json();
    if (!response.ok) throw new Error(payload.error || "Scanner fetch failed");
    const quotes = payload?.data?.quotes || [];
    let created = 0;
    quotes.forEach((quote) => {
      const signal = scannerSignalPayload(quote);
      if (!signal) return;
      state.scanner.lastSignalBySymbol[signal.stock] = new Date().toISOString();
      created += 1;
      addSignal(signal);
    });
    state.scanner.lastScanAt = new Date().toISOString();
    state.scanner.lastScanStatus = created ? `Scanner found ${created} signal${created > 1 ? "s" : ""}` : "Scanner found no setup";
    saveState();
    renderScannerSettings();
    if (!silent) toast(state.scanner.lastScanStatus);
  } catch (error) {
    state.scanner.lastScanAt = new Date().toISOString();
    state.scanner.lastScanStatus = error.message || "Scanner failed";
    saveState();
    renderScannerSettings();
    if (!silent) toast(state.scanner.lastScanStatus);
  }
}

async function refreshLivePrices(silent = false) {
  if (liveQuoteInFlight || location.protocol === "file:") return;
  const symbols = [...new Set(openTrades().map((trade) => trade.stock).filter(Boolean))];
  if (!symbols.length) {
    if (!silent) toast("No open trades for live update");
    return;
  }

  liveQuoteInFlight = true;
  try {
    const response = await fetch("/api/market/quote", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        broker: state.api.enabled ? state.api.broker : "mock",
        exchangeSegment: state.api.exchangeSegment || "NSE_EQ",
        quoteMode: "LTP",
        symbols,
      }),
    });
    const payload = await response.json();
    if (!response.ok) throw new Error(payload.error || "Live price fetch failed");

    const quotes = payload?.data?.quotes || [];
    const quoteMap = new Map(quotes.map((quote) => [normalizeTicker(quote.symbol || quote.tradingSymbol), quote]));
    let updated = 0;
    openTrades().forEach((trade) => {
      const quote = quoteMap.get(normalizeTicker(trade.stock));
      if (!quote || !Number.isFinite(Number(quote.ltp)) || Number(quote.ltp) <= 0) return;
      trade.currentPrice = Number(quote.ltp);
      updated += 1;
    });
    saveState();
    renderDashboardOnly();
    if (!silent) toast(updated ? `Live prices updated: ${updated}` : "No matching live prices found");
  } catch (error) {
    if (!silent) toast(error.message || "Live price fetch failed");
  } finally {
    liveQuoteInFlight = false;
  }
}

function reportDateRange() {
  const startEl = document.getElementById("reportStartDate");
  const endEl = document.getElementById("reportEndDate");
  const today = localDateKey();
  if (startEl) startEl.max = today;
  if (endEl) endEl.max = today;

  if (startEl && (!startEl.value || startEl.value > today)) startEl.value = today;
  if (endEl && (!endEl.value || endEl.value > today)) endEl.value = today;

  const startDate = startEl?.value || today;
  const endDate = endEl?.value || today;
  if (startDate > endDate) {
    return { valid: false, startDate, endDate, message: "Starting date ending date se baad nahi ho sakti." };
  }
  return { valid: true, startDate, endDate, message: "" };
}

function reportTrades() {
  const range = reportDateRange();
  if (!range.valid) return { ...range, trades: [] };
  const trades = closedTrades().filter((trade) => {
    const exitDate = trade.exitTime.slice(0, 10);
    return exitDate >= range.startDate && exitDate <= range.endDate;
  });
  return { ...range, trades };
}

function renderReportRange() {
  const startEl = document.getElementById("reportStartDate");
  const endEl = document.getElementById("reportEndDate");
  if (!startEl || !endEl) return;
  const today = localDateKey();
  startEl.max = today;
  endEl.max = today;
  if (!startEl.value) startEl.value = today;
  if (!endEl.value) endEl.value = today;
  const report = reportTrades();
  const status = document.getElementById("reportRangeStatus");
  const summary = status?.closest(".report-summary");
  if (!status || !summary) return;
  summary.classList.toggle("bad", !report.valid);
  status.innerHTML = report.valid
    ? `<strong>${report.trades.length}</strong> closed trades selected from <strong>${report.startDate}</strong> to <strong>${report.endDate}</strong>`
    : report.message;
}

function csvRows(trades = closedTrades()) {
  const headers = ["Date", "Stock", "Strategy", "Entry", "Exit", "Entry Time", "Exit Time", "Quantity", "RiskReward", "PnL", "HoldingMinutes", "Result", "Notes"];
  const rows = trades.map((trade) => {
    const pnl = tradePnl(trade);
    const holdMin = Math.max(1, Math.round((new Date(trade.exitTime) - new Date(trade.entryTime)) / 60000));
    const rr = (Number(trade.exit) - Number(trade.entry)) / Math.max(0.01, Number(trade.entry) - Number(trade.stopLoss));
    return [trade.exitTime.slice(0, 10), trade.stock, trade.strategy, trade.entry, trade.exit, trade.entryTime, trade.exitTime, trade.quantity, fmt(rr), fmt(pnl), holdMin, pnl >= 0 ? "Win" : "Loss", trade.notes || ""];
  });
  return [headers, ...rows];
}

function reportFilename(extension) {
  const report = reportTrades();
  return `paper-trade-report-${report.startDate}-to-${report.endDate}.${extension}`;
}

function downloadFilteredReport(type) {
  const report = reportTrades();
  renderReportRange();
  if (!report.valid) {
    toast(report.message);
    return;
  }
  if (!report.trades.length) {
    toast("Selected date range me closed trades nahi hain");
    return;
  }
  const rows = csvRows(report.trades);
  if (type === "csv") {
    download(reportFilename("csv"), toCsv(rows), "text/csv");
    return;
  }
  const html = `<table>${rows.map((row) => `<tr>${row.map((cell) => `<td>${cell}</td>`).join("")}</tr>`).join("")}</table>`;
  download(reportFilename("xls"), html, "application/vnd.ms-excel");
}

function printFilteredReport() {
  const report = reportTrades();
  renderReportRange();
  if (!report.valid) {
    toast(report.message);
    return;
  }
  if (!report.trades.length) {
    toast("Selected date range me closed trades nahi hain");
    return;
  }
  const rows = csvRows(report.trades);
  const netPnl = report.trades.reduce((sum, trade) => sum + tradePnl(trade), 0);
  const wins = report.trades.filter((trade) => tradePnl(trade) >= 0).length;
  const html = `
    <!doctype html>
    <html>
      <head>
        <title>Paper Trade Report</title>
        <style>
          body { font-family: Arial, sans-serif; color: #111827; padding: 24px; }
          h1 { margin-bottom: 4px; }
          .summary { display: flex; gap: 12px; margin: 18px 0; flex-wrap: wrap; }
          .box { border: 1px solid #d1d5db; padding: 10px 12px; border-radius: 6px; }
          table { width: 100%; border-collapse: collapse; font-size: 12px; }
          th, td { border: 1px solid #d1d5db; padding: 7px; text-align: left; }
          th { background: #f3f4f6; }
        </style>
      </head>
      <body>
        <h1>Paper Trade Report</h1>
        <p>${report.startDate} to ${report.endDate}</p>
        <div class="summary">
          <div class="box"><strong>Trades:</strong> ${report.trades.length}</div>
          <div class="box"><strong>Wins:</strong> ${wins}</div>
          <div class="box"><strong>Losses:</strong> ${report.trades.length - wins}</div>
          <div class="box"><strong>Net P&L:</strong> ${money(netPnl)}</div>
        </div>
        <table>${rows.map((row, index) => `<tr>${row.map((cell) => index === 0 ? `<th>${cell}</th>` : `<td>${cell}</td>`).join("")}</tr>`).join("")}</table>
        <script>window.onload = () => window.print();<\/script>
      </body>
    </html>
  `;
  const popup = window.open("", "_blank");
  if (!popup) {
    toast("Popup blocked. Please allow popup for PDF print.");
    return;
  }
  popup.document.open();
  popup.document.write(html);
  popup.document.close();
}

function download(filename, content, type) {
  const blob = new Blob([content], { type });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

function toCsv(rows) {
  return rows.map((row) => row.map((cell) => `"${String(cell ?? "").replaceAll('"', '""')}"`).join(",")).join("\n");
}

function importCsv(text) {
  const lines = text.trim().split(/\r?\n/);
  if (lines.length < 2) return;
  const headers = splitCsvLine(lines[0]).map((header) => header.trim().toLowerCase());
  lines.slice(1).forEach((line) => {
    const cells = splitCsvLine(line);
    const row = Object.fromEntries(headers.map((header, index) => [header, cells[index]]));
    const entry = Number(row.entry || 0);
    const exit = Number(row.exit || 0);
    const qty = Number(row.quantity || row.qty || 1);
    state.trades.unshift({
      id: uid("import"),
      stock: (row.stock || "UNKNOWN").toUpperCase(),
      strategy: row.strategy || row.setup || "Imported",
      entry,
      quantity: qty,
      capitalUsed: entry * qty,
      leverage: Number(state.settings.leverage),
      stopLoss: Number(row.sl || entry),
      target1: Number(row.target || exit),
      target2: Number(row.target2 || exit),
      currentPrice: exit,
      entryTime: row["entry time"] || row.entrytime || new Date().toISOString(),
      exit,
      exitTime: row["exit time"] || row.exittime || new Date().toISOString(),
      notes: row.notes || "",
      status: "Closed",
    });
  });
  saveState();
  render();
}

function splitCsvLine(line) {
  const result = [];
  let current = "";
  let quoted = false;
  for (let i = 0; i < line.length; i += 1) {
    const char = line[i];
    if (char === '"' && line[i + 1] === '"') {
      current += '"';
      i += 1;
    } else if (char === '"') {
      quoted = !quoted;
    } else if (char === "," && !quoted) {
      result.push(current);
      current = "";
    } else {
      current += char;
    }
  }
  result.push(current);
  return result;
}

function seedSignals() {
  [
    { stock: "TCS", strategy: "1% Setup", entry: 3850, sl: 3835, target1: 3895, target2: 3920 },
    { stock: "INFY", strategy: "9/15 EMA Setup", entry: 1510, sl: 1501, target1: 1532, target2: 1548 },
    { stock: "RELIANCE", strategy: "1% Setup", entry: 2920, sl: 2898, target1: 2970, target2: 3005 },
  ].forEach(addSignal);
}

function updateClock() {
  const now = new Date();
  document.getElementById("clock").textContent = now.toLocaleString("en-IN");
  const isMarket = isMarketHours(now);
  const status = document.getElementById("marketStatus");
  status.textContent = isMarket ? "Market Open" : "Market Closed";
  status.classList.toggle("good", isMarket);
  status.classList.toggle("bad", !isMarket);
}

document.addEventListener("click", (event) => {
  const nav = event.target.closest("[data-view], [data-view-link]");
  if (nav) {
    const view = nav.dataset.view || nav.dataset.viewLink;
    document.querySelectorAll(".view").forEach((el) => el.classList.toggle("active", el.id === view));
    document.querySelectorAll(".nav-item").forEach((el) => el.classList.toggle("active", el.dataset.view === view));
    document.getElementById("viewTitle").textContent = nav.textContent.trim() || view;
  }

  const buyId = event.target.dataset.buySignal;
  if (buyId) createTradeFromSignal(state.signals.find((signal) => signal.id === buyId));

  const removeId = event.target.dataset.removeSignal;
  if (removeId) {
    state.signals = state.signals.filter((signal) => signal.id !== removeId);
    saveState();
    render();
  }

  const closeId = event.target.dataset.closeTrade;
  if (closeId) {
    const trade = state.trades.find((item) => item.id === closeId);
    closeTrade(closeId, trade.currentPrice);
  }
});

document.addEventListener("input", (event) => {
  const id = event.target.dataset.tradeUpdate;
  const key = event.target.dataset.key;
  if (id && key) updateTrade(id, key, event.target.value);
});

document.getElementById("signalForm").addEventListener("submit", (event) => {
  event.preventDefault();
  addSignal(Object.fromEntries(new FormData(event.target)));
  event.target.reset();
  toast("Signal added");
});

document.getElementById("scannerForm").addEventListener("submit", (event) => {
  event.preventDefault();
  const form = event.target;
  const data = Object.fromEntries(new FormData(form));
  state.scanner.enabled = form.elements.enabled.checked;
  state.scanner.watchlist = data.watchlist || "";
  state.scanner.intervalSec = Math.max(15, Number(data.intervalSec || 60));
  state.scanner.minMovePct = Math.max(0.2, Number(data.minMovePct || 1));
  state.scanner.signalCooldownMin = Math.max(5, Number(data.signalCooldownMin || 45));
  saveState();
  renderScannerSettings();
  toast("Auto scanner settings saved");
});

document.getElementById("scanNowBtn").addEventListener("click", async () => {
  await runAutoScanner(false, true);
});

document.getElementById("saveSettingsBtn").addEventListener("click", () => {
  const data = Object.fromEntries(new FormData(document.getElementById("settingsForm")));
  Object.keys(state.settings).forEach((key) => {
    if (key === "autoPaperTrade") state.settings[key] = document.getElementById("settingsForm").elements[key].checked;
    else state.settings[key] = Number(data[key]);
  });
  saveState();
  render();
  toast("Risk settings saved");
});

document.getElementById("brokerSelect").addEventListener("change", (event) => {
  applyBrokerPreset(event.target.value);
});

document.getElementById("saveApiBtn").addEventListener("click", () => {
  const form = document.getElementById("apiForm");
  const data = Object.fromEntries(new FormData(form));
  Object.keys(defaultState.api).forEach((key) => {
    if (key === "enabled") state.api[key] = form.elements[key].checked;
    else if (["clientId", "apiKey", "accessToken", "apiSecret", "feedToken"].includes(key)) state.api[key] = "";
    else if (key !== "lastTestedAt") state.api[key] = data[key] || "";
  });
  saveState();
  renderApiSettings();
  toast("Broker API settings saved");
});

document.getElementById("testApiBtn").addEventListener("click", async () => {
  const form = document.getElementById("apiForm");
  const data = Object.fromEntries(new FormData(form));
  Object.keys(defaultState.api).forEach((key) => {
    if (key === "enabled") state.api[key] = form.elements[key].checked;
    else if (["clientId", "apiKey", "accessToken", "apiSecret", "feedToken"].includes(key)) state.api[key] = "";
    else if (key !== "lastTestedAt") state.api[key] = data[key] || "";
  });
  state.api.lastTestedAt = new Date().toISOString();
  saveState();
  renderApiSettings();
  try {
    if (location.protocol === "file:") {
      toast("Secure backend use karne ke liye app http://127.0.0.1:8787 se open karo");
      return;
    }
    const response = await fetch("/api/config/status");
    const status = await response.json();
    toast(status.configured ? `Backend ready: ${status.activeBroker}` : `Backend missing env: ${(status.missing || []).join(", ")}`);
  } catch {
    toast("Backend not running. Start with: node server.js");
  }
});

document.getElementById("seedSignalsBtn").addEventListener("click", seedSignals);
document.getElementById("resetDashboardBtn").addEventListener("click", () => {
  if (!confirm("Reset dashboard? Demo signals, paper trades, journal and P&L will be cleared. Settings and broker API config will stay saved.")) return;
  state.signals = [];
  state.trades = [];
  saveState();
  render();
  toast("Dashboard reset done");
});
document.getElementById("clearSignalsBtn").addEventListener("click", () => {
  state.signals = [];
  saveState();
  render();
});

document.getElementById("markToMarketBtn").addEventListener("click", async () => {
  if (state.api.enabled && state.api.mode !== "delayed") {
    await refreshLivePrices(false);
    return;
  }
  openTrades().forEach((trade) => {
    const drift = (Math.random() - 0.45) * trade.entry * 0.006;
    trade.currentPrice = Math.max(0.05, Number(trade.currentPrice) + drift);
  });
  saveState();
  render();
});

document.getElementById("reportRangeForm").addEventListener("input", renderReportRange);
document.getElementById("downloadCsvBtn").addEventListener("click", () => downloadFilteredReport("csv"));
document.getElementById("exportJournalBtn").addEventListener("click", () => download("paper-trade-journal.csv", toCsv(csvRows()), "text/csv"));
document.getElementById("downloadXlsBtn").addEventListener("click", () => downloadFilteredReport("xls"));
document.getElementById("printPdfBtn").addEventListener("click", printFilteredReport);
document.getElementById("csvImport").addEventListener("change", async (event) => {
  const file = event.target.files[0];
  if (!file) return;
  importCsv(await file.text());
  event.target.value = "";
  toast("CSV imported");
});

setInterval(updateClock, 1000);
setInterval(() => {
  if (!state.scanner.enabled) return;
  const lastScanAt = state.scanner.lastScanAt ? new Date(state.scanner.lastScanAt).getTime() : 0;
  const intervalMs = Math.max(15, Number(state.scanner.intervalSec || 60)) * 1000;
  if (Date.now() - lastScanAt < intervalMs) return;
  runAutoScanner(true, false);
}, 15000);
setInterval(() => {
  if (!state.api.enabled || state.api.mode === "delayed") return;
  if (!openTrades().length) return;
  refreshLivePrices(true);
}, 30000);
updateClock();
render();
