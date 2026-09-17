LUMORA V15 — FINAL MOBILE + LIVE REFRESH FIX

LUMORA V14 — FINAL MOBILE RESPONSIVE FIX

LUMORA 30 SECOND SIGNAL ENGINE - V10

This package contains the LUMORA local dashboard, Python server, PWA assets and MT5 bridge EA.

LATEST FIXES
- Completed WIN/LOSS history is persisted in data.json.
- Expired signals are reconciled even if an EA result arrives late or is missing.
- Live signal card clears stale BUY/SELL values after expiry.
- Server-authoritative 30-second signal countdown survives page refresh.
- News Countdown now updates every second and is based on server time.
- Service worker cache version updated.

NEWS COUNTDOWN NOTE
Until a real economic-calendar feed is connected, the News Countdown is a deterministic next-30-minute dashboard window. It is not a verified live high-impact news release time.

START
1. Stop any old LUMORA server.
2. Run run_server.bat.
3. Open http://localhost:8787.
4. Use Ctrl+F5 after replacing an older package.
