# Dhan Paper Trading Dashboard

Phase 1 dashboard for scanner-first paper trading. It does not place real orders.

## Open Frontend Only

Open `index.html` in a browser.

## Secure Backend Mode

For broker API keys, use the backend. Do not put real API secrets in the browser.

1. Copy `.env.example` to `.env`.
2. Set `ACTIVE_BROKER` and fill that broker's credentials.
3. Start the backend:

```powershell
node server.js
```

4. Open:

```text
http://127.0.0.1:8787
```

Backend API:

- `GET /api/health`
- `GET /api/brokers`
- `GET /api/config/status`
- `POST /api/market/quote`

Security controls included:

- API secrets stay in `.env`, which is ignored by Git.
- Browser stores only non-secret UI preferences.
- Security headers, CORS allow-list, request size limit, rate limit, input validation and masked config status.
- Static files and API run from the same local origin in backend mode.

## Included

- Dashboard home with market status, signals, open trades, capital use and P&L.
- Manual scanner signal entry for `1% Setup` and `9/15 EMA Setup`.
- Paper BUY execution with quantity, leverage, capital allocation and position-limit checks.
- Risk locks for daily, weekly and monthly loss plus daily target.
- Trade journal with editable notes.
- Daily, weekly and monthly P&L analytics.
- Equity curve, daily P&L, win/loss and strategy performance charts.
- CSV, Excel-compatible `.xls`, and print-to-PDF report export.
- Basic CSV import for broker or manual trade data.
- Broker API configuration section for paper-trade market data source selection.

## Recommended live data path

Use DhanHQ Data API for serious paper trading. Free feeds are useful for UI development, but intraday strategy validation can become misleading if prices are delayed, rate-limited, unofficial, or inconsistent with your broker feed.

Next integration step:

1. Add a small backend service for Dhan WebSocket credentials.
2. Subscribe to Nifty 500 instruments.
3. Maintain live candles and EMA values.
4. Push scanner signals into this dashboard.
5. Keep order placement disabled until Phase 2.

## Broker API section

Settings me `Broker API - Market Data` section hai. Isme DhanHQ, Zerodha Kite, Upstox, Angel One SmartAPI, Fyers, ya custom feed select kar sakte ho. Real client ID, API key, access token aur feed token backend `.env` me rakhne hain.

This dashboard does not store broker secrets in browser local storage.

## Railway deployment note

For Railway or any cloud host:

- Keep `PORT` managed by the platform.
- Set `HOST=0.0.0.0`.
- Open the app from the deployed domain, because frontend API calls use the same origin.

## Angel One live data

For Angel One quote snapshots:

- Set `ACTIVE_BROKER=angel`
- Set `ANGEL_CLIENT_ID` and `ANGEL_API_KEY`
- Then use one auth path:
  - preferred auto-login: `ANGEL_PASSWORD` and `ANGEL_TOTP_SECRET`
  - or temporary token mode: `ANGEL_ACCESS_TOKEN`
  - or refresh flow: `ANGEL_REFRESH_TOKEN`

`ANGEL_FEED_TOKEN` is optional for this phase because the app currently uses quote snapshots, not live WebSocket streaming.

Important: this project is still paper trading only. It does not place real orders.
