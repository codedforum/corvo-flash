// src/lib/member-prefs.js, per-member trading preferences kept in bot_kv.
//
// Only slippage for now. Stored in basis points and clamped to the same band
// member-exec enforces at sign time, so a stored value can never widen a fill
// beyond what the executor would accept anyway.

const { db } = require('../db');

db.exec('CREATE TABLE IF NOT EXISTS bot_kv (k TEXT PRIMARY KEY, v TEXT)');

const MIN_BPS = 25;
const MAX_BPS = 1000;
const DEFAULT_BPS = Math.min(Math.max(Number(process.env.MEMBER_SLIPPAGE_BPS || 300), MIN_BPS), MAX_BPS);

const key = (tgId) => 'member_slippage_bps:' + Number(tgId);

function clamp(bps) {
  const n = Number(bps);
  if (!Number.isFinite(n)) return null;
  return Math.min(Math.max(Math.round(n), MIN_BPS), MAX_BPS);
}

/** The member's slippage in bps, or the default when none is set. */
function slippageBps(tgId) {
  try {
    const r = db.prepare('SELECT v FROM bot_kv WHERE k = ?').get(key(tgId));
    const n = r ? clamp(r.v) : null;
    return n == null ? DEFAULT_BPS : n;
  } catch (e) { return DEFAULT_BPS; }
}

/** Stores a slippage given in PERCENT (0.5 means half a percent). Returns bps. */
function setSlippagePct(tgId, pct) {
  const n = Number(String(pct).replace('%', ''));
  if (!Number.isFinite(n) || n <= 0) throw new Error('give a percentage, for example 1 or 2.5');
  const bps = clamp(n * 100);
  if (bps !== Math.round(n * 100)) throw new Error('slippage must be between ' + (MIN_BPS / 100) + '% and ' + (MAX_BPS / 100) + '%');
  db.prepare('INSERT INTO bot_kv (k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v').run(key(tgId), String(bps));
  return bps;
}

function clearSlippage(tgId) {
  db.prepare('DELETE FROM bot_kv WHERE k = ?').run(key(tgId));
  return DEFAULT_BPS;
}

module.exports = { slippageBps, setSlippagePct, clearSlippage, DEFAULT_BPS, MIN_BPS, MAX_BPS };
