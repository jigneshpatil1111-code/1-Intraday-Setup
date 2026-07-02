# Dhan Paper Trading Dashboard

Phase 1 dashboard for scanner-first paper trading. It does not place real orders.

## Open

Open `index.html` in a browser.

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

Settings me `Broker API - Market Data` section hai. Isme DhanHQ, Zerodha Kite, Upstox, Angel One SmartAPI, Fyers, ya custom feed select karke client ID, API key, access token, feed token, WebSocket URL, quote API URL aur exchange segment save kar sakte ho.

This dashboard stores credentials only in browser local storage for the first local paper-trading version. Real live-data integration should move secrets to a backend service before using real broker credentials.
