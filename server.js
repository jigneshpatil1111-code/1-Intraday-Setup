import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { existsSync, readFileSync } from "node:fs";
import { extname, join, normalize, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";

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
    required: ["ANGEL_CLIENT_ID", "ANGEL_API_KEY", "ANGEL_ACCESS_TOKEN", "ANGEL_FEED_TOKEN"],
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

  return sendJson(res, 404, { error: "API route not found", requestId });
}

async function fetchQuote(broker, body) {
  if (broker === "mock") return mockQuote(body);
  if (broker === "dhan") return dhanQuote(body);
  if (broker === "custom") return customQuote(body);
  throw httpError(501, `${brokers[broker]?.label || broker} quote adapter is prepared but not enabled yet.`);
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
  if (!text || text.length > maxLength || !/^[\w.\-:/]+$/.test(text)) throw httpError(400, "Invalid input");
  return text;
}

function missingBrokerEnv(broker) {
  const entry = brokers[broker] || brokers.mock;
  return entry.required.filter((key) => !env(key, ""));
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
