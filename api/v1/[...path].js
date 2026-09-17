import { Pool } from 'pg';

const VERSION = 'LUMORA_V13_MARKET_SIGNAL_FIXED_NO_TRADE_HISTORY';
let pool;
let schemaPromise;

function getPool() {
  if (!process.env.DATABASE_URL) return null;
  if (!pool) {
    pool = new Pool({
      connectionString: process.env.DATABASE_URL,
      max: 5,
      idleTimeoutMillis: 10000,
      connectionTimeoutMillis: 8000,
      ssl: process.env.DATABASE_URL.includes('sslmode=require') ? undefined : { rejectUnauthorized: false }
    });
  }
  return pool;
}

async function createSchemaSafely(db) {
  // Vercel can run multiple serverless instances at the same time.
  // An in-process promise is not enough because each instance has its own memory.
  // PostgreSQL advisory transaction locking prevents concurrent DDL races.
  const client = await db.connect();

  try {
    await client.query('BEGIN');

    // Transaction-scoped lock: it is released automatically on COMMIT/ROLLBACK.
    await client.query('SELECT pg_advisory_xact_lock($1)', [83920101]);

    await client.query(`
      CREATE TABLE IF NOT EXISTS lumora_signals (
        id BIGSERIAL PRIMARY KEY,
        signal_id TEXT UNIQUE NOT NULL,
        source TEXT NOT NULL DEFAULT 'Nyao Scalper v43.0',
        symbol TEXT NOT NULL DEFAULT 'XAUUSD',
        timeframe TEXT NOT NULL DEFAULT 'M1',
        packet JSONB NOT NULL,
        received_at BIGINT NOT NULL,
        signal_epoch BIGINT NOT NULL,
        expiry_epoch BIGINT NOT NULL,
        result JSONB,
        result_received_at BIGINT,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );

      CREATE INDEX IF NOT EXISTS lumora_signals_expiry_idx
        ON lumora_signals(expiry_epoch);

      CREATE INDEX IF NOT EXISTS lumora_signals_created_idx
        ON lumora_signals(created_at DESC);

      CREATE TABLE IF NOT EXISTS lumora_market (
        id INTEGER PRIMARY KEY,
        packet JSONB NOT NULL,
        received_at BIGINT NOT NULL,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
    `);

    await client.query('COMMIT');
  } catch (e) {
    try {
      await client.query('ROLLBACK');
    } catch (_) {}
    throw e;
  } finally {
    client.release();
  }
}

async function ensureSchema(db) {
  if (!schemaPromise) {
    schemaPromise = createSchemaSafely(db).catch((e) => {
      // Do not permanently cache a failed initialization.
      schemaPromise = null;
      throw e;
    });
  }

  await schemaPromise;
}

function send(res, status, body) {
  res.status(status).setHeader('Cache-Control', 'no-store');
  res.status(status).json(body);
}

function cors(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
}

function bodyOf(req) {
  if (!req.body) return {};
  if (typeof req.body === 'string') {
    try { return JSON.parse(req.body); } catch { return {}; }
  }
  return req.body;
}

function number(v, fallback = 0) {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

function buildResult(signalPacket, expiryPrice, expiredAtEpoch) {
  const d = signalPacket.data || {};
  const side = String(d.side || '').toUpperCase();
  const entry = number(d.entry_price);
  const price = number(expiryPrice);
  if (!(entry > 0 && price > 0) || !['BUY', 'SELL'].includes(side)) return null;
  const stake = number(d.stake_usd, 2);
  const payout = number(d.payout_percent, 80);
  const win = side === 'BUY' ? price > entry : price < entry;
  return {
    signal_id: d.signal_id || '',
    side,
    status: 'CLOSED',
    result: win ? 'WIN' : 'LOSS',
    entry_price: entry,
    expiry_price: price,
    stake_usd: stake,
    payout_percent: payout,
    profit_usd: Number((win ? stake * payout / 100 : -stake).toFixed(2)),
    expired_at: new Date(expiredAtEpoch * 1000).toLocaleString('en-GB', {
      timeZone: 'Asia/Colombo', hour12: false
    }).replace(',', '')
  };
}

function packetForSignal(row) {
  return {
    event: 'signal',
    source: row.source,
    symbol: row.symbol,
    timeframe: row.timeframe,
    data: row.packet.data,
    received_at: row.received_at,
    result: row.result?.result || undefined,
    result_data: row.result || undefined
  };
}

function packetForResult(row) {
  if (!row.result) return null;
  return {
    event: 'signal_result',
    source: row.source,
    symbol: row.symbol,
    timeframe: row.timeframe,
    data: row.result,
    received_at: row.result_received_at || row.expiry_epoch,
    auto_settled: Boolean(row.result.auto_settled)
  };
}

async function getMarket(db) {
  const r = await db.query('SELECT packet, received_at FROM lumora_market WHERE id=1');
  if (!r.rowCount) return {};
  return { ...(r.rows[0].packet || {}), received_at: r.rows[0].received_at };
}

async function settleExpired(db, now) {
  const market = await getMarket(db);
  const bid = number(market.bid);
  const ask = number(market.ask);
  if (!(bid > 0 && ask > 0)) return [];

  const rows = await db.query(`
    SELECT * FROM lumora_signals
    WHERE result IS NULL AND expiry_epoch <= $1
    ORDER BY expiry_epoch ASC
    LIMIT 100
  `, [now]);

  const generated = [];
  for (const row of rows.rows) {
    const side = String(row.packet?.data?.side || '').toUpperCase();
    const price = side === 'BUY' ? bid : side === 'SELL' ? ask : 0;
    const result = buildResult(row.packet, price, Number(row.expiry_epoch));
    if (!result) continue;
    result.auto_settled = true;
    const upd = await db.query(`
      UPDATE lumora_signals
      SET result=$1::jsonb, result_received_at=$2
      WHERE signal_id=$3 AND result IS NULL
      RETURNING *
    `, [JSON.stringify(result), now, row.signal_id]);
    if (upd.rowCount) generated.push(packetForResult(upd.rows[0]));
  }
  return generated;
}

async function state(db) {
  const now = Math.floor(Date.now() / 1000);

  // Keep signals internally for expiry/result processing,
  // but do NOT expose trade history to the dashboard/API state response.
  await settleExpired(db, now);

  const market = await getMarket(db);

  const activeQ = await db.query(`
    SELECT * FROM lumora_signals
    WHERE result IS NULL AND expiry_epoch > $1
    ORDER BY id DESC LIMIT 1
  `, [now]);

  const active_signal = activeQ.rowCount
    ? packetForSignal(activeQ.rows[0])
    : null;

  const target = Math.floor(now / 1800 + 1) * 1800;

  return {
    history: [],
    market,
    active_signal,
    news: {
      target_epoch: target,
      label: 'USD • next scheduled window'
    },
    server_epoch: now,
    version: VERSION
  };
}

async function handle(req, res) {
  cors(res);
  if (req.method === 'OPTIONS') return res.status(204).end();

  // Use the real HTTP pathname first. This is reliable for Vercel catch-all
  // functions and avoids req.query.path differences between deployments.
  let route = '/';
  try {
    const requestUrl = new URL(req.url || '/', 'https://lumora.local');
    route = requestUrl.pathname || '/';
  } catch (_) {
    const pathParts = req.query?.path;
    const path = Array.isArray(pathParts) ? pathParts.join('/') : String(pathParts || '');
    route = '/' + path.replace(/^\/+/, '');
  }

  // Normalize trailing slashes.
  if (route.length > 1) route = route.replace(/\/+$/, '');

  const db = getPool();

  if (route === '/health') {
    if (!db) return send(res, 503, { ok: false, error: 'DATABASE_URL is not configured', version: VERSION });
    try {
      await ensureSchema(db);
      return send(res, 200, {
        ok: true,
        history: [],
        version: VERSION
      });
    } catch (e) {
      return send(res, 503, { ok: false, error: 'Database unavailable', version: VERSION });
    }
  }

  if (!db) return send(res, 503, { ok: false, error: 'DATABASE_URL is not configured' });

  try {
    await ensureSchema(db);

    if (route === '/api/v1/state' || route === '/v1/state' || route === '/state') {
      return send(res, 200, await state(db));
    }

    if (route === '/api/v1/signals' || route === '/v1/signals' || route === '/signals') {
      if (req.method !== 'POST') return send(res, 405, { error: 'method not allowed' });
      const input = bodyOf(req);

      // Accept event, eventType, or type and normalize common variants.
      const rawEvent =
        input.event ??
        input.eventType ??
        input.type ??
        (input.data && typeof input.data === 'object'
          ? (input.data.event ?? input.data.eventType)
          : undefined) ??
        'signal';

      let event = String(rawEvent).trim().toLowerCase();
      event = event.replace(/[\s-]+/g, '_');

      if (event === 'wait' || event === 'signalwait') event = 'signal_wait';
      if (event === 'trade_signal' || event === 'tradesignal') event = 'signal';
      if (event === 'result' || event === 'signalresult') event = 'signal_result';

      const data =
        input.data && typeof input.data === 'object' && !Array.isArray(input.data)
          ? { ...input.data }
          : { ...input };

      delete data.event;
      delete data.eventType;

      const now = Math.floor(Date.now() / 1000);

      if (event === 'signal_wait') {
        return send(res, 200, {
          ok: true,
          event: 'signal_wait',
          received_at: now
        });
      }


    if (event === 'signal') {
        const expirySeconds = Math.max(1, Math.floor(number(data.expiry_seconds, 30)));
        data.signal_epoch = now;
        data.expiry_epoch = now + expirySeconds;
        data.expiry_seconds = expirySeconds;
        if (!data.signal_id) data.signal_id = `${now}-${Math.random().toString(36).slice(2, 10)}`;

        const packet = { event, source: input.source || 'Nyao Scalper v43.0', symbol: input.symbol || 'XAUUSD', timeframe: input.timeframe || 'M1', data };
        await settleExpired(db, now);
        await db.query(`
          INSERT INTO lumora_signals(signal_id, source, symbol, timeframe, packet, received_at, signal_epoch, expiry_epoch)
          VALUES($1,$2,$3,$4,$5::jsonb,$6,$7,$8)
          ON CONFLICT(signal_id) DO NOTHING
        `, [data.signal_id, packet.source, packet.symbol, packet.timeframe, JSON.stringify(packet), now, data.signal_epoch, data.expiry_epoch]);
        return send(res, 200, { ok: true, event, signal_id: data.signal_id });
      }

      if (event === 'signal_result') {
        const sid = data.signal_id;
        if (!sid) return send(res, 400, { ok: false, error: 'signal_id is required' });
        const r = await db.query(`
          UPDATE lumora_signals SET result=$1::jsonb, result_received_at=$2
          WHERE signal_id=$3 AND result IS NULL RETURNING *
        `, [JSON.stringify(data), now, sid]);
        if (!r.rowCount) {
          const existing = await db.query('SELECT signal_id FROM lumora_signals WHERE signal_id=$1', [sid]);
          if (!existing.rowCount) return send(res, 404, { ok: false, error: 'signal not found' });
        }
        return send(res, 200, { ok: true, event, signal_id: sid });
      }

      return send(res, 400, {
        ok: false,
        error: 'unsupported event',
        received_event: event
      });
    }

    if (route === '/api/v1/market' || route === '/v1/market' || route === '/market') {
      if (req.method !== 'POST') return send(res, 405, { error: 'method not allowed' });
      const input = bodyOf(req);
      const data =
        input.data && typeof input.data === 'object' && !Array.isArray(input.data)
          ? { ...input.data }
          : { ...input };
      delete data.event;
      delete data.eventType;
      const now = Math.floor(Date.now() / 1000);
      const bid = number(data.bid), ask = number(data.ask);
      if (bid > 0 && ask > 0) {
        data.spread = ask - bid;
        const point = number(data.point);
        if (point > 0) data.spread_points = (ask - bid) / point;
      }
      await db.query(`
        INSERT INTO lumora_market(id, packet, received_at, updated_at)
        VALUES(1,$1::jsonb,$2,NOW())
        ON CONFLICT(id) DO UPDATE SET packet=EXCLUDED.packet, received_at=EXCLUDED.received_at, updated_at=NOW()
      `, [JSON.stringify(data), now]);
      await settleExpired(db, now);
      return send(res, 200, { ok: true, event: 'market' });
    }

    return send(res, 404, { ok: false, error: 'not found' });
  } catch (e) {
    console.error('[LUMORA API]', e);
    return send(res, 500, { ok: false, error: 'server error' });
  }
}

export default handle;