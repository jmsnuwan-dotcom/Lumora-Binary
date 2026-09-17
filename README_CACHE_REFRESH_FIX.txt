LUMORA V13 - CACHE / REFRESH FIX

- Service worker is network-first for the app shell.
- /api/* is never served from PWA cache.
- Service worker uses updateViaCache=none and calls registration.update().
- Old service-worker caches are removed on activation.
- Vercel sends no-cache headers for index.html, sw.js and API routes.
- Normal Ctrl+R / mobile reload should receive the latest deployed UI.
- No database data or MT5 signal logic was changed.
