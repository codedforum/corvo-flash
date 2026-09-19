// src/lib/member-copy.js
// Wallet copytrade. A member follows a wallet under TRACK, then turns on copy
// for it: when that wallet BUYS a token, the member gets a one-tap copy (alert
// mode) or an automatic copy at their size (auto mode, via the delegation they
// enabled). This is the non-custodial answer to GMGN/Trojan copytrade: the bot
// never holds the member's key, it signs through their granted delegation or
// hands them a review card to sign.

const { db } = require('../db');
const chains = require('./chains');
const tracker = require('./wallet-tracker');

db.exec(`CREATE TABLE IF NOT EXISTS wallet_copy (
  tg_id INTEGER NOT NULL,
  address TEXT NOT NULL,
  mode TEXT NOT NULL DEFAULT 'alert',      -- off | alert | auto
  usd_size REAL NOT NULL DEFAULT 10,
  copy_sells INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (tg_id, address)
)`);
db.exec('CREATE INDEX IF NOT EXISTS idx_wallet_copy_addr ON wallet_copy(address, mode)');
try { db.exec("ALTER TABLE wallet_copy ADD COLUMN size_mode TEXT NOT NULL DEFAULT 'fixed'"); } catch (e) { /* already migrated */ }
try { db.exec("ALTER TABLE wallet_copy ADD COLUMN tp_mult REAL NOT NULL DEFAULT 0"); } catch (e) { /* migrated */ }
try { db.exec("ALTER TABLE wallet_copy ADD COLUMN sl_mult REAL NOT NULL DEFAULT 0"); } catch (e) { /* migrated */ }
try { db.exec("ALTER TABLE wallet_copy ADD COLUMN slippage_bps INTEGER NOT NULL DEFAULT 0"); } catch (e) { /* migrated */ }

const norm = (a) => String(a || '').toLowerCase();
const now = () => Math.floor(Date.now() / 1000);

function get(tgId, address) {
  return db.prepare('SELECT * FROM wallet_copy WHERE tg_id = ? AND address = ?').get(Number(tgId), norm(address)) || null;
}
function set(tgId, address, { mode, usdSize, copySells, sizeMode, tpMult, slMult, slippageBps } = {}) {
  const cur = get(tgId, address) || { mode: 'alert', usd_size: 10, copy_sells: 0, size_mode: 'fixed', tp_mult: 0, sl_mult: 0, slippage_bps: 0 };
  const m = mode || cur.mode;
  const u = usdSize != null ? Number(usdSize) : cur.usd_size;
  const cs = copySells != null ? (copySells ? 1 : 0) : cur.copy_sells;
  const sm = sizeMode || cur.size_mode || 'fixed';
  const tp = tpMult != null ? Number(tpMult) : (cur.tp_mult || 0);
  const sl = slMult != null ? Number(slMult) : (cur.sl_mult || 0);
  const sb = slippageBps != null ? Number(slippageBps) : (cur.slippage_bps || 0);
  db.prepare(`INSERT INTO wallet_copy (tg_id, address, mode, usd_size, copy_sells, size_mode, tp_mult, sl_mult, slippage_bps, created_at)
    VALUES (?,?,?,?,?,?,?,?,?,?)
    ON CONFLICT(tg_id, address) DO UPDATE SET mode = excluded.mode, usd_size = excluded.usd_size, copy_sells = excluded.copy_sells, size_mode = excluded.size_mode, tp_mult = excluded.tp_mult, sl_mult = excluded.sl_mult, slippage_bps = excluded.slippage_bps`)
    .run(Number(tgId), norm(address), m, u, cs, sm, tp, sl, sb, now());
  return get(tgId, address);
}
function off(tgId, address) { return set(tgId, address, { mode: 'off' }); }
function copiersOf(address) {
  return db.prepare("SELECT * FROM wallet_copy WHERE address = ? AND mode != 'off'").all(norm(address));
}
function listFor(tgId) {
  return db.prepare('SELECT * FROM wallet_copy WHERE tg_id = ? ORDER BY created_at DESC').all(Number(tgId));
}

// From a batch of sweep Transfer events, find tracked-wallet BUYS. A buy is a
// tx where a tracked wallet RECEIVED a non-stable token AND SPENT value
// (WETH/USDC out) in the SAME tx, which distinguishes a swap from an airdrop or
// a plain transfer in. Native-ETH-direct buys are missed (no ERC20 out leg),
// acceptable for v1 since most Base routing goes through WETH.
function buySignals(events) {
  const base = chains.chainBySlug('base');
  const STABLES = new Set([
    String(base.usdc.addr).toLowerCase(),
    String(base.wrappedNative).toLowerCase(),
  ]);
  const byTx = {};
  for (const ev of events) { (byTx[ev.tx] = byTx[ev.tx] || []).push(ev); }

  const out = [];
  for (const tx of Object.keys(byTx)) {
    const legs = byTx[tx];
    const receivedTokens = {}; // trackedWallet -> [token,...] non-stable received
    const spentValue = {};     // trackedWallet -> true, sent a stable/WETH leg
    for (const ev of legs) {
      const isStable = STABLES.has(ev.token);
      if (!isStable) {
        if (tracker.watchersOf(ev.to).length) (receivedTokens[ev.to] = receivedTokens[ev.to] || []).push(ev.token);
      } else if (tracker.watchersOf(ev.from).length) {
        spentValue[ev.from] = { token: ev.token, raw: ev.value };
      }
    }
    for (const tracked of Object.keys(receivedTokens)) {
      if (!spentValue[tracked]) continue; // no value spent this tx => not a buy
      const spent = spentValue[tracked];
      for (const token of [...new Set(receivedTokens[tracked])]) out.push({ tracked, token, tx, spentToken: spent.token, spentRaw: spent.raw });
    }
  }
  return out;
}


// Tracked-wallet SELLS: a tx where the wallet SENT a non-stable token AND
// RECEIVED value (WETH/USDC) => an exit. Used to mirror exits.
function sellSignals(events) {
  const base = chains.chainBySlug('base');
  const STABLES = new Set([
    String(base.usdc.addr).toLowerCase(),
    String(base.wrappedNative).toLowerCase(),
  ]);
  const byTx = {};
  for (const ev of events) { (byTx[ev.tx] = byTx[ev.tx] || []).push(ev); }
  const out = [];
  for (const tx of Object.keys(byTx)) {
    const legs = byTx[tx];
    const sentTokens = {};  // tracked -> [token,...] non-stable sent
    const gotValue = {};    // tracked -> received a stable/WETH leg
    for (const ev of legs) {
      const isStable = STABLES.has(ev.token);
      if (!isStable) {
        if (tracker.watchersOf(ev.from).length) (sentTokens[ev.from] = sentTokens[ev.from] || []).push(ev.token);
      } else if (tracker.watchersOf(ev.to).length) {
        gotValue[ev.to] = true;
      }
    }
    for (const tracked of Object.keys(sentTokens)) {
      if (!gotValue[tracked]) continue;
      for (const token of [...new Set(sentTokens[tracked])]) out.push({ tracked, token, tx });
    }
  }
  return out;
}

// Candidate NATIVE-ETH buys: a tracked wallet received a non-stable token with
// NO WETH/USDC out leg this tx (native ETH pays leave no ERC20 log). Alert only,
// after a price+liquidity gate in the dispatcher, since a plain transfer-in also
// looks like this.
function looseBuySignals(events) {
  const base = chains.chainBySlug('base');
  const STABLES = new Set([String(base.usdc.addr).toLowerCase(), String(base.wrappedNative).toLowerCase()]);
  const byTx = {};
  for (const ev of events) { (byTx[ev.tx] = byTx[ev.tx] || []).push(ev); }
  const out = [];
  for (const tx of Object.keys(byTx)) {
    const legs = byTx[tx];
    const received = {}; const spent = {};
    for (const ev of legs) {
      const isStable = STABLES.has(ev.token);
      if (!isStable) { if (tracker.watchersOf(ev.to).length) (received[ev.to] = received[ev.to] || []).push({ token: ev.token, raw: ev.value }); }
      else if (tracker.watchersOf(ev.from).length) { spent[ev.from] = true; }
    }
    for (const tracked of Object.keys(received)) {
      if (spent[tracked]) continue; // a strict buy already covers this
      for (const r of received[tracked]) out.push({ tracked, token: r.token, tx, receivedRaw: r.raw });
    }
  }
  return out;
}

module.exports = { get, set, off, copiersOf, listFor, buySignals, sellSignals, looseBuySignals };
