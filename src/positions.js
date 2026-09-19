// Auto-buy/sell positions ledger, cost basis for PnL. Every admin auto-buy records
// a 'buy' row; every /sell records a 'sell' row (proceeds). Enables per-token realized
// + unrealized PnL. Aggregated (cost basis) uses BUY rows only.
const { db } = require('../db');

db.exec(`CREATE TABLE IF NOT EXISTS autobuy_positions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  chain TEXT NOT NULL,
  chain_id INTEGER,
  token TEXT NOT NULL,
  symbol TEXT,
  usd_cost REAL NOT NULL,
  tokens REAL NOT NULL,
  tx TEXT,
  ts INTEGER NOT NULL
)`);
try { db.exec(`ALTER TABLE autobuy_positions ADD COLUMN side TEXT DEFAULT 'buy'`); } catch { /* already added */ }
// Which engine actually filled this. The router chooses per trade, so without
// this the only way to answer "which aggregator?" is decoding a router address
// off the receipt.
try { db.exec(`ALTER TABLE autobuy_positions ADD COLUMN engine TEXT`); } catch { /* already added */ }
// Whose position this is. NULL is the treasury, so every pre-existing row keeps
// its meaning without a backfill.
//
// 🚨 Every treasury query below filters on this. Without it, the first member
// trade would be summed into the operator's PnL and the treasury card would
// report a number that belongs to somebody else.
try { db.exec(`ALTER TABLE autobuy_positions ADD COLUMN owner_tg_id INTEGER`); } catch { /* already added */ }
db.exec('CREATE INDEX IF NOT EXISTS idx_positions_owner ON autobuy_positions (owner_tg_id, token)');
db.exec('CREATE INDEX IF NOT EXISTS idx_positions_owner_side_ts ON autobuy_positions(owner_tg_id, side, ts)');
db.exec('CREATE INDEX IF NOT EXISTS idx_positions_token_owner_side ON autobuy_positions(token, owner_tg_id, side)');
db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS idx_positions_unique_tx_action
  ON autobuy_positions(chain_id, tx, side, COALESCE(owner_tg_id, -1))
  WHERE tx IS NOT NULL AND tx <> ''`);

// A single bound value cannot express both "IS NULL" and "= ?", so the owner
// filter is written once here and reused by every query.
const OWNED = "(($owner IS NULL AND owner_tg_id IS NULL) OR owner_tg_id = $owner)";

// Listeners for treasury buys (owner null). The mirror feature hangs off this
// rather than patching every execution site: recording IS the single funnel.
// Listeners run detached; a listener error can never fail the record.
const _treasuryBuyListeners = [];
function onTreasuryBuy(cb) { if (typeof cb === 'function') _treasuryBuyListeners.push(cb); }

function record({ chain, chainId = null, token, symbol = '', usdCost, tokens, tx = null, engine = null, owner = null }) {
  try {
    db.prepare('INSERT OR IGNORE INTO autobuy_positions (chain,chain_id,token,symbol,usd_cost,tokens,tx,ts,side,engine,owner_tg_id) VALUES (?,?,?,?,?,?,?,?,?,?,?)')
      .run(String(chain), chainId, String(token).toLowerCase(), String(symbol), Number(usdCost) || 0, Number(tokens) || 0, tx, Date.now(), 'buy', engine, owner == null ? null : Number(owner));
    if (owner == null) {
      const evt = { chain: String(chain), chainId, token: String(token).toLowerCase(), symbol: String(symbol), usdCost: Number(usdCost) || 0 };
      for (const cb of _treasuryBuyListeners) {
        setImmediate(() => { try { const p = cb(evt); if (p && p.catch) p.catch(() => {}); } catch (e) { /* listener errors stay theirs */ } });
      }
    }
  } catch (e) { console.warn('[positions] record buy failed:', e.message); }
}

// A sell: usd_cost column reused to hold USD proceeds; side='sell'.
function recordSell({ chain, chainId = null, token, symbol = '', usdProceeds, tokens, tx = null, engine = null, owner = null }) {
  try {
    db.prepare('INSERT OR IGNORE INTO autobuy_positions (chain,chain_id,token,symbol,usd_cost,tokens,tx,ts,side,engine,owner_tg_id) VALUES (?,?,?,?,?,?,?,?,?,?,?)')
      .run(String(chain), chainId, String(token).toLowerCase(), String(symbol), Number(usdProceeds) || 0, Number(tokens) || 0, tx, Date.now(), 'sell', engine, owner == null ? null : Number(owner));
  } catch (e) { console.warn('[positions] record sell failed:', e.message); }
}

// One row per (chain, token) over BUY rows only = cost basis for holdings/PnL.
function aggregated(owner = null) {
  try {
    return db.prepare(`SELECT chain, chain_id AS chainId, token,
        (SELECT symbol FROM autobuy_positions p2
           WHERE p2.token=p.token AND p2.chain=p.chain AND p2.symbol<>''
             AND (($owner IS NULL AND p2.owner_tg_id IS NULL) OR p2.owner_tg_id = $owner)
           LIMIT 1) AS symbol,
        SUM(usd_cost) AS usdCost, SUM(tokens) AS tokens, COUNT(*) AS buys
      FROM autobuy_positions p
      WHERE COALESCE(side,'buy')='buy' AND (($owner IS NULL AND p.owner_tg_id IS NULL) OR p.owner_tg_id = $owner)
      GROUP BY chain, token ORDER BY usdCost DESC`).all({ owner: owner == null ? null : Number(owner) });
  } catch { return []; }
}

// Per-token buy/sell breakdown for the position PnL card.
function tokenStats(token, owner = null) {
  const t = String(token).toLowerCase();
  const o = owner == null ? null : Number(owner);
  const empty = { bought: 0, invested: 0, buys: 0, sold: 0, proceeds: 0, sells: 0, symbol: '', chain: '' };
  try {
    const b = db.prepare(`SELECT COALESCE(SUM(usd_cost),0) c, COALESCE(SUM(tokens),0) t, COUNT(*) n,
        (SELECT symbol FROM autobuy_positions WHERE token=$t AND symbol<>'' AND ${OWNED} LIMIT 1) s,
        (SELECT chain FROM autobuy_positions WHERE token=$t AND ${OWNED} LIMIT 1) ch
      FROM autobuy_positions WHERE token=$t AND COALESCE(side,'buy')='buy' AND ${OWNED}`).get({ t, owner: o });
    const sl = db.prepare(`SELECT COALESCE(SUM(usd_cost),0) c, COALESCE(SUM(tokens),0) t, COUNT(*) n
      FROM autobuy_positions WHERE token=$t AND side='sell' AND ${OWNED}`).get({ t, owner: o });
    return { bought: b.t, invested: b.c, buys: b.n, sold: sl.t, proceeds: sl.c, sells: sl.n, symbol: b.s || '', chain: b.ch || '' };
  } catch { return empty; }
}

// Lifetime realized PnL banked across ALL sold tokens (avg-cost method).
function realizedSummary(owner = null) {
  try {
    const toks = db.prepare(`SELECT DISTINCT token FROM autobuy_positions WHERE side='sell' AND ${OWNED}`)
      .all({ owner: owner == null ? null : Number(owner) });
    let realized = 0, proceeds = 0, sells = 0;
    for (const { token } of toks) {
      const s = tokenStats(token, owner);
      const avg = s.bought > 0 ? s.invested / s.bought : 0;
      realized += s.proceeds - avg * s.sold;
      proceeds += s.proceeds; sells += s.sells;
    }
    return { realized, proceeds, sells, tokens: toks.length };
  } catch { return { realized: 0, proceeds: 0, sells: 0, tokens: 0 }; }
}

function dateParts(value, timeZone, withTime = false) {
  const options = { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' };
  if (withTime) Object.assign(options, {
    hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
  });
  const parts = new Intl.DateTimeFormat('en-CA', options).formatToParts(value);
  const out = {};
  for (const part of parts) {
    if (part.type !== 'literal') out[part.type] = Number(part.value);
  }
  return out;
}

// Converts a wall-clock midnight in the requested timezone to an epoch value.
function zonedMidnight(year, month, day, timeZone) {
  const target = Date.UTC(year, month - 1, day, 0, 0, 0);
  let guess = target;
  for (let i = 0; i < 4; i += 1) {
    const seen = dateParts(new Date(guess), timeZone, true);
    const seenUtc = Date.UTC(seen.year, seen.month - 1, seen.day, seen.hour, seen.minute, seen.second);
    const correction = target - seenUtc;
    guess += correction;
    if (correction === 0) break;
  }
  return guess;
}

function monthWindow(now, timeZone) {
  const when = now instanceof Date ? now : new Date(now == null ? Date.now() : now);
  if (!Number.isFinite(when.getTime())) throw new Error('invalid summary date');
  let zone = timeZone || 'Africa/Lagos';
  let here;
  try {
    here = dateParts(when, zone);
  } catch (error) {
    zone = 'Africa/Lagos';
    here = dateParts(when, zone);
  }
  const nextYear = here.month === 12 ? here.year + 1 : here.year;
  const nextMonth = here.month === 12 ? 1 : here.month + 1;
  return {
    start: zonedMidnight(here.year, here.month, 1, zone),
    end: zonedMidnight(nextYear, nextMonth, 1, zone),
    period: new Intl.DateTimeFormat('en-US', {
      timeZone: zone, month: 'long', year: 'numeric',
    }).format(when).toUpperCase(),
    timeZone: zone,
  };
}

/**
 * Current-month realized PnL for one owner using moving average cost.
 * Prior rows are replayed so the opening inventory keeps its real cost basis.
 */
function monthlySummary(owner, now = new Date(), timeZone = 'Africa/Lagos') {
  const ownerId = owner == null ? null : Number(owner);
  const window = monthWindow(now, timeZone);
  const rows = db.prepare(`SELECT id, token, side, usd_cost, tokens, ts
    FROM autobuy_positions
    WHERE ts < $end AND ${OWNED}
    ORDER BY ts ASC, id ASC`).all({ owner: ownerId, end: window.end });

  const inventory = new Map();
  const daily = new Map();
  let realized = 0;
  let trades = 0;

  for (const row of rows) {
    const side = String(row.side || 'buy').toLowerCase();
    if (side !== 'buy' && side !== 'sell') continue;
    const inMonth = row.ts >= window.start;
    if (inMonth) trades += 1;

    const key = String(row.token || '').toLowerCase();
    const state = inventory.get(key) || { quantity: 0, cost: 0 };
    const quantity = Math.max(0, Number(row.tokens) || 0);
    const dollars = Math.max(0, Number(row.usd_cost) || 0);

    if (side === 'buy') {
      state.quantity += quantity;
      state.cost += dollars;
      inventory.set(key, state);
      continue;
    }

    const averageCost = state.quantity > 0 ? state.cost / state.quantity : 0;
    const removedCost = averageCost * quantity;
    const salePnl = dollars - removedCost;
    state.quantity = Math.max(0, state.quantity - quantity);
    state.cost = state.quantity > 0 ? Math.max(0, state.cost - removedCost) : 0;
    inventory.set(key, state);

    if (inMonth) {
      realized += salePnl;
      const day = dateParts(new Date(row.ts), window.timeZone);
      const dayKey = `${day.year}-${String(day.month).padStart(2, '0')}-${String(day.day).padStart(2, '0')}`;
      daily.set(dayKey, (daily.get(dayKey) || 0) + salePnl);
    }
  }

  const dayResults = [...daily.values()];
  const epsilon = 0.005;
  return {
    period: window.period,
    timeZone: window.timeZone,
    realized,
    winDays: dayResults.filter((value) => value > epsilon).length,
    lossDays: dayResults.filter((value) => value < -epsilon).length,
    bestDay: dayResults.length ? Math.max(...dayResults) : null,
    worstDay: dayResults.length ? Math.min(...dayResults) : null,
    trades,
    empty: trades === 0,
  };
}

module.exports = {
  record, recordSell, aggregated, tokenStats, realizedSummary, monthlySummary, onTreasuryBuy,
};
