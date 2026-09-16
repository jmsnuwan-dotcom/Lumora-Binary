import fs from 'node:fs';
import pg from 'pg';

const { Pool } = pg;
const file = new URL('../data.json', import.meta.url);
const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required');
const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: process.env.DATABASE_URL.includes('sslmode=require') ? undefined : { rejectUnauthorized: false } });
const db = await pool.connect();
try {
  await db.query(`CREATE TABLE IF NOT EXISTS lumora_signals (id BIGSERIAL PRIMARY KEY, signal_id TEXT UNIQUE NOT NULL, source TEXT NOT NULL DEFAULT 'Nyao Scalper v43.0', symbol TEXT NOT NULL DEFAULT 'XAUUSD', timeframe TEXT NOT NULL DEFAULT 'M1', packet JSONB NOT NULL, received_at BIGINT NOT NULL, signal_epoch BIGINT NOT NULL, expiry_epoch BIGINT NOT NULL, result JSONB, result_received_at BIGINT, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW());`);
  await db.query(`CREATE TABLE IF NOT EXISTS lumora_market (id INTEGER PRIMARY KEY, packet JSONB NOT NULL, received_at BIGINT NOT NULL, updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW());`);
  for (const p of raw.history || []) {
    if (p.event !== 'signal') continue;
    const d = p.data || {};
    if (!d.signal_id) continue;
    const received = Number(p.received_at || d.signal_epoch || Math.floor(Date.now()/1000));
    const signalEpoch = Number(d.signal_epoch || received);
    const expiry = Number(d.expiry_epoch || (signalEpoch + Number(d.expiry_seconds || 30)));
    await db.query(`INSERT INTO lumora_signals(signal_id,source,symbol,timeframe,packet,received_at,signal_epoch,expiry_epoch,result) VALUES($1,$2,$3,$4,$5::jsonb,$6,$7,$8,$9::jsonb) ON CONFLICT(signal_id) DO NOTHING`, [d.signal_id,p.source||'Nyao Scalper v43.0',p.symbol||'XAUUSD',p.timeframe||'M1',JSON.stringify(p),received,signalEpoch,expiry,p.result_data ? JSON.stringify(p.result_data) : null]);
  }
  if (raw.market && Object.keys(raw.market).length) {
    await db.query(`INSERT INTO lumora_market(id,packet,received_at,updated_at) VALUES(1,$1::jsonb,$2,NOW()) ON CONFLICT(id) DO UPDATE SET packet=EXCLUDED.packet,received_at=EXCLUDED.received_at,updated_at=NOW()`, [JSON.stringify(raw.market), Number(raw.market.received_at || Math.floor(Date.now()/1000))]);
  }
  console.log('LUMORA data import complete.');
} finally {
  db.release();
  await pool.end();
}
