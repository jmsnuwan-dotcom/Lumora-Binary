# LUMORA V10 — Vercel Deployment

This version keeps the existing LUMORA dashboard and MT5 API contract, but replaces the local `server.py` / `data.json` runtime with a Vercel serverless API backed by PostgreSQL.

## Production architecture
MT5 EA → `/api/v1/signals` + `/api/v1/market` → PostgreSQL → `/api/v1/state` → LUMORA dashboard

The browser uses 1-second state polling. The local long-lived SSE connection is not required in production.

## Required environment variable
`DATABASE_URL` — PostgreSQL connection string.

## Deploy
1. Import the GitHub repository into Vercel.
2. Add `DATABASE_URL` under Project Settings → Environment Variables.
3. Deploy.
4. Open `/health` on the deployed domain.
5. If you want to preserve the current local `data.json` history, run `npm install` and `npm run import:data` once from a machine that has the production `DATABASE_URL`.
6. Update the MT5 EA's `LumoraApiURL` to `https://YOUR-DOMAIN/api/v1/signals`.

## Important
The current News Countdown remains the same deterministic next-half-hour dashboard window. It is not a real economic-calendar feed.
