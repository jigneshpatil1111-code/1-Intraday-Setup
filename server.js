import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { existsSync, readFileSync } from "node:fs";
import { extname, join, normalize, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createHmac, randomUUID } from "node:crypto";

const __dirname = fileURLToPath(new URL(".", import.meta.url));
const rootDir = resolve(__dirname);

loadEnvFile();

const config = {
  host: env("HOST", "0.0.0.0"),
  port: numberEnv("PORT", 8787, 1, 65535),
  allowedOrigins: env("ALLOWED_ORIGINS", "http://127.0.0.1:8787,http://localhost:8787")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean),
  rateWindowMs: numberEnv("RATE_LIMIT_WINDOW_MS", 60000, 1000, 3600000),
  rateMax: numberEnv("RATE_LIMIT_MAX", 90, 1, 10000),
  activeBroker: env("ACTIVE_BROKER", "mock").toLowerCase(),
};

const brokers = {
  mock: {
    label: "Mock Development Feed",
    required: [],
  },
  dhan: {
    label: "DhanHQ",
    required: ["DHAN_CLIENT_ID", "DHAN_ACCESS_TOKEN"],
  },
  zerodha: {
    label: "Zerodha Kite",
    required: ["ZERODHA_API_KEY", "ZERODHA_ACCESS_TOKEN"],
  },
  upstox: {
    label: "Upstox",
    required: ["UPSTOX_ACCESS_TOKEN"],
  },
  angel: {
    label: "Angel One SmartAPI",
    required: ["ANGEL_CLIENT_ID", "ANGEL_API_KEY"],
  },
  fyers: {
    label: "Fyers",
    required: ["FYERS_CLIENT_ID", "FYERS_ACCESS_TOKEN"],
  },
  custom: {
    label: "Custom Quote Feed",
    required: ["CUSTOM_QUOTE_URL"],
  },
};

const mimeTypes = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".md": "text/markdown; charset=utf-8",
  ".ico": "image/x-icon",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".svg": "image/svg+xml",
};

const rateBuckets = new Map();
const angelSymbolCache = new Map();
let angelSessionCache = null;

const server = createServer(async (req, res) => {
  const requestId = randomUUID();
  try {
    applySecurityHeaders(req, res, requestId);
    if (!isAllowedOrigin(req)) return sendJson(res, 403, { error: "Origin not allowed", requestId });
    if (req.method === "OPTIONS") return sendEmpty(res, 204);
    if (!checkRateLimit(req)) return sendJson(res, 429, { error: "Too many requests", requestId });

    const url = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);
    if (url.pathname.startsWith("/api/")) {
      return await routeApi(req, res, url, requestId);
    }
    return await serveStatic(res, url.pathname, requestId);
  } catch (error) {
    console.error(`[${requestId}]`, error);
    return sendJson(res, error.status || 500, {
      error: error.status ? error.message : "Internal server error",
      ...(error.extra || {}),
      requestId,
    });
  }
});

server.listen(config.port, config.host, () => {
  console.log(`Paper trading backend running at http://${config.host}:${config.port}`);
});

async function routeApi(req, res, url, requestId) {
  if (req.method === "GET" && url.pathname === "/api/health") {
    return sendJson(res, 200, {
      ok: true,
      mode: "paper",
      activeBroker: config.activeBroker,
      time: new Date().toISOString(),
      requestId,
    });
  }

  if (req.method === "GET" && url.pathname === "/api/brokers") {
    return sendJson(res, 200, Object.entries(brokers).map(([id, broker]) => ({
      id,
      label: broker.label,
      configured: missingBrokerEnv(id).length === 0,
    })));
  }

  if (req.method === "GET" && url.pathname === "/api/config/status") {
    return sendJson(res, 200, {
      activeBroker: config.activeBroker,
      configured: missingBrokerEnv(config.activeBroker).length === 0,
      missing: missingBrokerEnv(config.activeBroker),
      secretsAreMasked: true,
    });
  }

  if (req.method === "POST" && url.pathname === "/api/market/quote") {
    const body = await readJsonBody(req, 20_000);
    const broker = sanitizeBroker(body.broker || config.activeBroker);
    const missing = missingBrokerEnv(broker);
    if (missing.length) {
      return sendJson(res, 400, { error: "Broker is not configured", broker, missing, requestId });
    }
    const quote = await fetchQuote(broker, body);
    return sendJson(res, 200, { broker, data: quote, requestId });
  }

  if (req.method === "POST" && url.pathname === "/api/market/candles") {
    const body = await readJsonBody(req, 20_000);
    const broker = sanitizeBroker(body.broker || config.activeBroker);
    const missing = missingBrokerEnv(broker);
    if (missing.length) {
      return sendJson(res, 400, { error: "Broker is not configured", broker, missing, requestId });
    }
    const candles = await fetchCandles(broker, body);
    return sendJson(res, 200, { broker, data: candles, requestId });
  }

  return sendJson(res, 404, { error: "API route not found", requestId });
}

async function fetchQuote(broker, body) {
  if (broker === "mock") return mockQuote(body);
  if (broker === "dhan") return dhanQuote(body);
  if (broker === "angel") return angelQuote(body);
  if (broker === "custom") return customQuote(body);
  throw httpError(501, `${brokers[broker]?.label || broker} quote adapter is prepared but not enabled yet.`);
}

async function fetchCandles(broker, body) {
  if (broker === "angel") return angelCandles(body);
  throw httpError(501, `${brokers[broker]?.label || broker} candle adapter is prepared but not enabled yet.`);
}

async function dhanQuote(body) {
  const instruments = validateInstrumentMap(body.instruments);
  const response = await fetch("https://api.dhan.co/v2/marketfeed/ltp", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Accept": "application/json",
      "access-token": env("DHAN_ACCESS_TOKEN"),
      "client-id": env("DHAN_CLIENT_ID"),
    },
    body: JSON.stringify(instruments),
  });
  return await brokerResponse(response);
}

async function customQuote(body) {
  const quoteUrl = env("CUSTOM_QUOTE_URL");
  const url = new URL(quoteUrl);
  if (!["https:", "http:"].includes(url.protocol)) throw httpError(400, "Invalid custom quote URL");
  const headers = { "Content-Type": "application/json", "Accept": "application/json" };
  const auth = env("CUSTOM_AUTH_HEADER", "");
  if (auth) headers.Authorization = auth;
  const response = await fetch(url, {
    method: "POST",
    headers,
    body: JSON.stringify({
      symbols: validateSymbolList(body.symbols || []),
      instruments: body.instruments || {},
      exchangeSegment: safeText(body.exchangeSegment || "NSE_EQ", 20),
    }),
  });
  return await brokerResponse(response);
}

async function angelQuote(body) {
  const symbols = validateSymbolList(body.symbols?.length ? body.symbols : ["SBIN"]);
  const exchange = angelExchangeCode(body.exchangeSegment || "NSE_EQ");
  return await withAngelSession(async (session) => {
    const resolved = await resolveAngelInstruments(symbols, exchange, session);
    const exchangeTokens = resolved.reduce((acc, item) => {
      if (!acc[item.exchange]) acc[item.exchange] = [];
      acc[item.exchange].push(item.symboltoken);
      return acc;
    }, {});
    const result = await angelApiFetch("/rest/secure/angelbroking/market/v1/quote", {
      session,
      body: {
        mode: safeText(body.quoteMode || "LTP", 10).toUpperCase(),
        exchangeTokens,
      },
    });
    const fetched = result?.data?.fetched || [];
    const quoteMap = new Map(fetched.map((item) => [item.symbolToken, item]));
    return {
      source: "angel",
      generatedAt: new Date().toISOString(),
      mode: safeText(body.quoteMode || "LTP", 10).toUpperCase(),
      quotes: resolved.map((item) => normalizeAngelQuote(item, quoteMap.get(item.symboltoken))),
      unfetched: result?.data?.unfetched || [],
    };
  });
}

async function angelCandles(body) {
  const symbols = validateSymbolList(body.symbols?.length ? body.symbols : ["SBIN"]);
  const exchange = angelExchangeCode(body.exchangeSegment || "NSE_EQ");
  const interval = safeText(body.interval || "ONE_MINUTE", 20).toUpperCase();
  const lookbackMinutes = Math.min(120, Math.max(16, Number(body.lookbackMinutes || 30)));
  return await withAngelSession(async (session) => {
    const resolved = await resolveAngelInstruments(symbols, exchange, session);
    const candles = [];
    for (const instrument of resolved) {
      const series = await angelCandleSeries(session, instrument, interval, lookbackMinutes);
      candles.push({
        symbol: instrument.symbol,
        tradingSymbol: instrument.tradingsymbol,
        exchange: instrument.exchange,
        symbolToken: instrument.symboltoken,
        series,
      });
    }
    return {
      source: "angel",
      generatedAt: new Date().toISOString(),
      interval,
      candles,
    };
  });
}

function mockQuote(body) {
  const symbols = validateSymbolList(body.symbols?.length ? body.symbols : ["TCS", "INFY", "RELIANCE"]);
  return {
    source: "mock",
    generatedAt: new Date().toISOString(),
    quotes: symbols.map((symbol, index) => {
      const base = 1000 + index * 375;
      const wave = Math.sin(Date.now() / 60000 + index) * 8;
      return {
        symbol,
        ltp: Number((base + wave).toFixed(2)),
        changePct: Number((wave / base * 100).toFixed(2)),
      };
    }),
  };
}

function normalizeAngelQuote(instrument, quote = {}) {
  return {
    symbol: instrument.symbol,
    tradingSymbol: instrument.tradingsymbol,
    exchange: instrument.exchange,
    symbolToken: instrument.symboltoken,
    ltp: Number(quote.ltp ?? 0),
    open: quote.open ?? null,
    high: quote.high ?? null,
    low: quote.low ?? null,
    close: quote.close ?? null,
    changePct: quote.percentChange ?? null,
    raw: quote,
  };
}

async function brokerResponse(response) {
  const text = await response.text();
  let data;
  try {
    data = text ? JSON.parse(text) : {};
  } catch {
    data = { raw: text.slice(0, 2000) };
  }
  if (!response.ok) {
    throw httpError(response.status, "Broker API request failed", { brokerStatus: response.status, data });
  }
  return data;
}

async function withAngelSession(action) {
  try {
    const session = await ensureAngelSession(false);
    return await action(session);
  } catch (error) {
    if (!shouldRefreshAngelSession(error)) throw error;
    const session = await ensureAngelSession(true);
    return await action(session);
  }
}

function shouldRefreshAngelSession(error) {
  return error?.status === 401 || error?.extra?.errorCode === "AG8001" || error?.extra?.errorCode === "AB1010";
}

async function ensureAngelSession(forceRefresh) {
  if (!forceRefresh && angelSessionCache?.accessToken && angelSessionCache.expiresAt > Date.now()) {
    return angelSessionCache;
  }

  const staticAccessToken = env("ANGEL_ACCESS_TOKEN", "");
  const staticFeedToken = env("ANGEL_FEED_TOKEN", "");
  if (!forceRefresh && staticAccessToken) {
    angelSessionCache = {
      accessToken: staticAccessToken,
      refreshToken: env("ANGEL_REFRESH_TOKEN", ""),
      feedToken: staticFeedToken,
      expiresAt: nextIstMidnightEpoch(),
    };
    return angelSessionCache;
  }

  if (env("ANGEL_PASSWORD", "") && env("ANGEL_TOTP_SECRET", "")) {
    const login = await angelApiFetch("/rest/auth/angelbroking/user/v1/loginByPassword", {
      body: {
        clientcode: env("ANGEL_CLIENT_ID"),
        password: env("ANGEL_PASSWORD"),
        totp: generateTotp(env("ANGEL_TOTP_SECRET")),
      },
      useAuth: false,
    });
    const data = login?.data || {};
    angelSessionCache = {
      accessToken: safeRequiredText(data.jwtToken, "Angel login did not return jwtToken"),
      refreshToken: data.refreshToken || "",
      feedToken: data.feedToken || staticFeedToken,
      expiresAt: nextIstMidnightEpoch(),
    };
    return angelSessionCache;
  }

  const refreshToken = env("ANGEL_REFRESH_TOKEN", "");
  if (refreshToken) {
    const refresh = await angelApiFetch("/rest/auth/angelbroking/jwt/v1/generateTokens", {
      body: { refreshToken },
      useAuth: false,
    });
    const data = refresh?.data || {};
    angelSessionCache = {
      accessToken: safeRequiredText(data.jwtToken, "Angel token refresh did not return jwtToken"),
      refreshToken: data.refreshToken || refreshToken,
      feedToken: staticFeedToken,
      expiresAt: nextIstMidnightEpoch(),
    };
    return angelSessionCache;
  }

  throw httpError(400, "Angel One is not configured", {
    missing: missingAngelEnv(),
  });
}

async function angelApiFetch(pathname, { session = null, body = {}, useAuth = true } = {}) {
  const response = await fetch(`https://apiconnect.angelone.in${pathname}`, {
    method: "POST",
    headers: angelHeaders(session, useAuth),
    body: JSON.stringify(body),
  });
  const data = await parseJsonSafe(response);
  if (!response.ok || data?.status === false) {
    throw httpError(response.ok ? 400 : response.status, data?.message || "Angel API request failed", {
      errorCode: data?.errorcode || data?.errorCode || "",
      data,
    });
  }
  return data;
}

function angelHeaders(session, useAuth) {
  const headers = {
    "Content-Type": "application/json",
    "Accept": "application/json",
    "X-UserType": "USER",
    "X-SourceID": "WEB",
    "X-PrivateKey": env("ANGEL_API_KEY"),
    "X-ClientLocalIP": env("ANGEL_CLIENT_LOCAL_IP", "127.0.0.1"),
    "X-ClientPublicIP": env("ANGEL_CLIENT_PUBLIC_IP", "127.0.0.1"),
    "X-MACAddress": env("ANGEL_MAC_ADDRESS", "02:00:00:00:00:00"),
  };
  if (useAuth && session?.accessToken) headers.Authorization = `Bearer ${session.accessToken}`;
  return headers;
}

async function parseJsonSafe(response) {
  const text = await response.text();
  if (!text) return {};
  try {
    return JSON.parse(text);
  } catch {
    return { raw: text.slice(0, 2000) };
  }
}

async function resolveAngelInstruments(symbols, exchange, session) {
  const resolved = [];
  for (const symbol of symbols) {
    resolved.push(await resolveAngelInstrument(symbol, exchange, session));
  }
  return resolved;
}

async function resolveAngelInstrument(symbol, exchange, session) {
  const cacheKey = `${exchange}:${symbol}`;
  const cached = angelSymbolCache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) return cached.value;
  await sleep(350);

  const result = await angelApiFetch("/rest/secure/angelbroking/order/v1/searchScrip", {
    session,
    body: {
      exchange,
      searchscrip: symbol,
    },
  });
  const instrument = selectAngelInstrument(symbol, exchange, result?.data || []);
  if (!instrument) {
    throw httpError(404, `Angel symbol not found: ${symbol}`, { symbol, exchange });
  }
  const value = {
    symbol,
    exchange: instrument.exchange,
    tradingsymbol: instrument.tradingsymbol,
    symboltoken: instrument.symboltoken,
  };
  angelSymbolCache.set(cacheKey, { value, expiresAt: Date.now() + 12 * 60 * 60 * 1000 });
  return value;
}

async function angelCandleSeries(session, instrument, interval, lookbackMinutes) {
  const end = new Date();
  const start = new Date(end.getTime() - lookbackMinutes * 60 * 1000);
  const result = await angelApiFetch("/rest/secure/angelbroking/historical/v1/getCandleData", {
    session,
    body: {
      exchange: instrument.exchange,
      symboltoken: instrument.symboltoken,
      interval,
      fromdate: formatAngelDate(start),
      todate: formatAngelDate(end),
    },
  });
  const candles = Array.isArray(result?.data) ? result.data : [];
  return candles.map((item) => ({
    time: item[0],
    open: Number(item[1]),
    high: Number(item[2]),
    low: Number(item[3]),
    close: Number(item[4]),
    volume: Number(item[5] || 0),
  }));
}

function selectAngelInstrument(symbol, exchange, items) {
  const normalized = normalizeSymbol(symbol);
  const scored = items
    .filter((item) => item?.exchange === exchange)
    .map((item) => ({ item, score: scoreAngelInstrument(normalized, item.tradingsymbol || "") }))
    .filter((entry) => entry.score > 0)
    .sort((a, b) => b.score - a.score);
  return scored[0]?.item || null;
}

function scoreAngelInstrument(symbol, tradingSymbol) {
  const normalizedTradingSymbol = normalizeSymbol(tradingSymbol);
  if (normalizedTradingSymbol === symbol) return 100;
  if (normalizedTradingSymbol === `${symbol}EQ`) return 90;
  if (tradingSymbol === `${symbol}-EQ`) return 95;
  if (tradingSymbol.startsWith(`${symbol}-`)) return 80;
  if (normalizedTradingSymbol.startsWith(symbol)) return 60;
  return 0;
}

function normalizeSymbol(value) {
  return String(value || "").toUpperCase().replace(/[^A-Z0-9]/g, "");
}

function angelExchangeCode(segment) {
  const map = {
    NSE_EQ: "NSE",
    BSE_EQ: "BSE",
    NSE_FNO: "NFO",
  };
  const key = safeText(segment, 20).toUpperCase();
  if (!map[key]) throw httpError(400, "Unsupported Angel exchange segment");
  return map[key];
}

function nextIstMidnightEpoch() {
  const now = new Date();
  const ist = new Date(now.toLocaleString("en-US", { timeZone: "Asia/Kolkata" }));
  ist.setHours(24, 0, 0, 0);
  const diff = ist.getTime() - new Date(now.toLocaleString("en-US", { timeZone: "Asia/Kolkata" })).getTime();
  return Date.now() + Math.max(60_000, diff - 60_000);
}

function formatAngelDate(date) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  const hours = String(date.getHours()).padStart(2, "0");
  const minutes = String(date.getMinutes()).padStart(2, "0");
  return `${year}-${month}-${day} ${hours}:${minutes}`;
}

function generateTotp(secret) {
  const normalized = String(secret).replace(/\s+/g, "").toUpperCase();
  const key = decodeBase32(normalized);
  const counter = Math.floor(Date.now() / 30_000);
  const buffer = Buffer.alloc(8);
  buffer.writeUInt32BE(Math.floor(counter / 0x100000000), 0);
  buffer.writeUInt32BE(counter >>> 0, 4);
  const digest = createHmac("sha1", key).update(buffer).digest();
  const offset = digest[digest.length - 1] & 0x0f;
  const code = ((digest.readUInt32BE(offset) & 0x7fffffff) % 1_000_000).toString();
  return code.padStart(6, "0");
}

function decodeBase32(value) {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
  let bits = "";
  for (const char of value.replace(/=+$/g, "")) {
    const index = alphabet.indexOf(char);
    if (index === -1) throw httpError(400, "ANGEL_TOTP_SECRET is not valid base32");
    bits += index.toString(2).padStart(5, "0");
  }
  const bytes = [];
  for (let i = 0; i + 8 <= bits.length; i += 8) {
    bytes.push(Number.parseInt(bits.slice(i, i + 8), 2));
  }
  return Buffer.from(bytes);
}

function safeRequiredText(value, message) {
  const text = String(value || "").trim();
  if (!text) throw httpError(500, message);
  return text;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function serveStatic(res, pathname, requestId) {
  const cleanPath = pathname === "/" ? "/index.html" : decodeURIComponent(pathname);
  const filePath = normalize(join(rootDir, cleanPath));
  if (!filePath.startsWith(rootDir)) return sendJson(res, 403, { error: "Forbidden", requestId });
  try {
    const bytes = await readFile(filePath);
    const type = mimeTypes[extname(filePath).toLowerCase()] || "application/octet-stream";
    res.writeHead(200, { "Content-Type": type, "Cache-Control": "no-store" });
    return res.end(bytes);
  } catch {
    return sendJson(res, 404, { error: "File not found", requestId });
  }
}

function loadEnvFile() {
  const envPath = join(rootDir, ".env");
  if (!existsSync(envPath)) return;
  const lines = readFileSync(envPath, "utf8").split(/\r?\n/);
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const index = trimmed.indexOf("=");
    if (index === -1) continue;
    const key = trimmed.slice(0, index).trim();
    const value = trimmed.slice(index + 1).trim().replace(/^["']|["']$/g, "");
    if (key && process.env[key] == null) process.env[key] = value;
  }
}

function applySecurityHeaders(req, res, requestId) {
  const origin = req.headers.origin;
  if (origin && config.allowedOrigins.includes(origin)) {
    res.setHeader("Access-Control-Allow-Origin", origin);
    res.setHeader("Vary", "Origin");
  }
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  res.setHeader("Access-Control-Max-Age", "600");
  res.setHeader("X-Request-Id", requestId);
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Referrer-Policy", "no-referrer");
  res.setHeader("X-Frame-Options", "DENY");
  res.setHeader("Permissions-Policy", "camera=(), microphone=(), geolocation=(), payment=()");
  res.setHeader("Content-Security-Policy", "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'self'; frame-ancestors 'none'");
}

function isAllowedOrigin(req) {
  const origin = req.headers.origin;
  if (!origin) return true;
  return config.allowedOrigins.includes(origin);
}

function checkRateLimit(req) {
  const ip = req.socket.remoteAddress || "unknown";
  const now = Date.now();
  const bucket = rateBuckets.get(ip) || { resetAt: now + config.rateWindowMs, count: 0 };
  if (now > bucket.resetAt) {
    bucket.resetAt = now + config.rateWindowMs;
    bucket.count = 0;
  }
  bucket.count += 1;
  rateBuckets.set(ip, bucket);
  return bucket.count <= config.rateMax;
}

async function readJsonBody(req, maxBytes) {
  const contentType = req.headers["content-type"] || "";
  if (!contentType.includes("application/json")) throw httpError(415, "Content-Type must be application/json");
  let size = 0;
  let raw = "";
  for await (const chunk of req) {
    size += chunk.length;
    if (size > maxBytes) throw httpError(413, "Request body too large");
    raw += chunk;
  }
  try {
    return raw ? JSON.parse(raw) : {};
  } catch {
    throw httpError(400, "Invalid JSON body");
  }
}

function validateSymbolList(symbols) {
  if (!Array.isArray(symbols) || symbols.length > 100) throw httpError(400, "symbols must be an array with max 100 items");
  return symbols.map((symbol) => safeText(symbol, 30).toUpperCase());
}

function validateInstrumentMap(instruments) {
  if (!instruments || typeof instruments !== "object" || Array.isArray(instruments)) {
    throw httpError(400, "Dhan request needs instruments object, for example { \"NSE_EQ\": [\"11536\"] }");
  }
  const clean = {};
  for (const [segment, ids] of Object.entries(instruments)) {
    const safeSegment = safeText(segment, 20);
    if (!Array.isArray(ids) || ids.length > 100) throw httpError(400, `${safeSegment} must be an array with max 100 ids`);
    clean[safeSegment] = ids.map((id) => safeText(id, 30));
  }
  return clean;
}

function sanitizeBroker(value) {
  const broker = safeText(value, 20).toLowerCase();
  if (!brokers[broker]) throw httpError(400, "Unsupported broker");
  return broker;
}

function safeText(value, maxLength) {
  const text = String(value ?? "").trim();
  if (!text || text.length > maxLength || !/^[\w.\-:/&]+$/.test(text)) throw httpError(400, "Invalid input");
  return text;
}

function missingBrokerEnv(broker) {
  if (broker === "angel") return missingAngelEnv();
  const entry = brokers[broker] || brokers.mock;
  return entry.required.filter((key) => !env(key, ""));
}

function missingAngelEnv() {
  const missing = [];
  if (!env("ANGEL_CLIENT_ID", "")) missing.push("ANGEL_CLIENT_ID");
  if (!env("ANGEL_API_KEY", "")) missing.push("ANGEL_API_KEY");
  const hasStaticAccess = Boolean(env("ANGEL_ACCESS_TOKEN", ""));
  const hasPasswordLogin = Boolean(env("ANGEL_PASSWORD", "") && env("ANGEL_TOTP_SECRET", ""));
  const hasRefreshToken = Boolean(env("ANGEL_REFRESH_TOKEN", ""));
  if (!hasStaticAccess && !hasPasswordLogin && !hasRefreshToken) {
    missing.push("ANGEL_ACCESS_TOKEN or ANGEL_PASSWORD+ANGEL_TOTP_SECRET or ANGEL_REFRESH_TOKEN");
  }
  return missing;
}

function env(key, fallback = "") {
  return process.env[key] ?? fallback;
}

function numberEnv(key, fallback, min, max) {
  const value = Number(env(key, fallback));
  if (!Number.isFinite(value) || value < min || value > max) return fallback;
  return value;
}

function httpError(status, message, extra = {}) {
  const error = new Error(message);
  error.status = status;
  error.extra = extra;
  return error;
}

function sendEmpty(res, status) {
  res.writeHead(status);
  res.end();
}

function sendJson(res, status, payload) {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
  res.end(JSON.stringify(payload));
}

process.on("uncaughtException", (error) => {
  console.error("Uncaught exception", error);
});

process.on("unhandledRejection", (error) => {
  console.error("Unhandled rejection", error);
});
