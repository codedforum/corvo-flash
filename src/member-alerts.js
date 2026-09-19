// src/lib/member-alerts.js
// Price alerts a member sets on any token. One-shot: an alert fires once,
// DMs the member, and is done. The checker rides the shared price memo, so
// fifty alerts on one token cost one price read.

const { db } = require('../db');

db.exec(`CREATE TABLE IF NOT EXISTS member_price_alerts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  tg_id INTEGER NOT NULL,
  chain TEXT NOT NULL DEFAULT 'base',
  token TEXT NOT NULL,
  symbol TEXT,
  trigger_price REAL NOT NULL,
  direction TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  fired_at INTEGER,
  status TEXT NOT NULL DEFAULT 'active'
)`);
db.exec('CREATE INDEX IF NOT EXISTS idx_price_alerts_active ON member_price_alerts(status, chain, token)');
db.exec('CREATE INDEX IF NOT EXISTS idx_price_alerts_member ON member_price_alerts(tg_id, status)');

const MAX_ACTIVE = 10;

function create({ tgId, chainRef = 'base', token, symbol = '', triggerPrice, direction }) {
  const price = Number(triggerPrice);
  if (!Number.isFinite(price) || price <= 0) throw new Error('trigger price must be above zero');
  if (!['above', 'below'].includes(direction)) throw new Error('direction must be above or below');
  const active = db.prepare("SELECT COUNT(*) n FROM member_price_alerts WHERE tg_id = ? AND status = 'active'").get(Number(tgId)).n;
  if (active >= MAX_ACTIVE) throw new Error('you already have ' + MAX_ACTIVE + ' alerts waiting, cancel one first');
  const r = db.prepare(
    'INSERT INTO member_price_alerts (tg_id, chain, token, symbol, trigger_price, direction, created_at) VALUES (?,?,?,?,?,?,?)',
  ).run(Number(tgId), String(chainRef), String(token).toLowerCase(), String(symbol || ''), price, direction, Date.now());
  return { id: r.lastInsertRowid, triggerPrice: price, direction };
}

function listFor(tgId) {
  return db.prepare("SELECT * FROM member_price_alerts WHERE tg_id = ? AND status = 'active' ORDER BY created_at DESC").all(Number(tgId));
}

function cancel(tgId, id) {
  return db.prepare("UPDATE member_price_alerts SET status = 'cancelled' WHERE id = ? AND tg_id = ? AND status = 'active'")
    .run(Number(id), Number(tgId)).changes === 1;
}

/** Distinct tokens with live alerts, so the sweep prices each exactly once. */
function activeTokens() {
  return db.prepare("SELECT DISTINCT chain, token FROM member_price_alerts WHERE status = 'active'").all();
}

function activeForToken(chain, token) {
  return db.prepare("SELECT * FROM member_price_alerts WHERE status = 'active' AND chain = ? AND token = ?")
    .all(String(chain), String(token).toLowerCase());
}

function markFired(id) {
  db.prepare("UPDATE member_price_alerts SET status = 'fired', fired_at = ? WHERE id = ?").run(Date.now(), Number(id));
}

module.exports = { MAX_ACTIVE, create, listFor, cancel, activeTokens, activeForToken, markFired };
