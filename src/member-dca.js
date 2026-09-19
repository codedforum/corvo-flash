// Time-scheduled SELL orders, the side Flash's TWAP cannot express.
//
// Flash's DCA is a buy: it spends USDC or ETH over a window. Selling a
// percentage of a holding on a clock is a different shape, so it is scheduled
// here and executed with the member's own delegated CDP signature.
//
// 🚨 Every slice is preflighted before it is signed, and every fill is
// confirmed by BALANCE DELTA. A mined transaction is not a fill.
'use strict';

const { createPublicClient, http, encodeFunctionData, getAddress, serializeTransaction } = require('viem');
const { base } = require('viem/chains');
const { CdpClient } = require('@coinbase/cdp-sdk');
const { db } = require('../db');
const chains = require('./chains');
const router = require('./router');
const tradeCore = require('./member-trade-core');
const memberExec = require('./member-exec');
const cdpServer = require('./cdp-server');
const delegation = require('./member-delegation');
const members = require('./member-wallets');

const MIN_INTERVAL = Number(process.env.DCA_SELL_MIN_INTERVAL || 900);   // 15 min
const MAX_INTERVAL = Number(process.env.DCA_SELL_MAX_INTERVAL || 604800); // 7 days
const DEFAULT_SLIP = Number(process.env.DCA_SELL_SLIP_BPS || 1000);
const MAX_ACTIVE = Number(process.env.DCA_SELL_MAX_ACTIVE || 5);

const ERC20 = [
  { name: 'balanceOf', type: 'function', stateMutability: 'view', inputs: [{ type: 'address' }], outputs: [{ type: 'uint256' }] },
  { name: 'allowance', type: 'function', stateMutability: 'view', inputs: [{ type: 'address' }, { type: 'address' }], outputs: [{ type: 'uint256' }] },
  { name: 'approve', type: 'function', stateMutability: 'nonpayable', inputs: [{ type: 'address' }, { type: 'uint256' }], outputs: [{ type: 'bool' }] },
  { name: 'symbol', type: 'function', stateMutability: 'view', inputs: [], outputs: [{ type: 'string' }] },
  { name: 'decimals', type: 'function', stateMutability: 'view', inputs: [], outputs: [{ type: 'uint8' }] },
];

function ensureSchema() {
  db.exec(`
    CREATE TABLE IF NOT EXISTS member_dca_sells (
      id TEXT PRIMARY KEY,
      tg_id INTEGER NOT NULL,
      chain TEXT NOT NULL,
      token TEXT NOT NULL,
      symbol TEXT,
      decimals INTEGER NOT NULL DEFAULT 18,
      pct INTEGER NOT NULL,
      mode TEXT NOT NULL DEFAULT 'remaining',
      interval_seconds INTEGER NOT NULL,
      slippage_bps INTEGER NOT NULL DEFAULT 1000,
      start_raw TEXT NOT NULL,
      floor_pct REAL NOT NULL DEFAULT 2,
      min_slice_usd REAL NOT NULL DEFAULT 0.20,
      max_slices INTEGER NOT NULL DEFAULT 60,
      slices_done INTEGER NOT NULL DEFAULT 0,
      sold_raw TEXT NOT NULL DEFAULT '0',
      received_usd REAL NOT NULL DEFAULT 0,
      status TEXT NOT NULL DEFAULT 'active',
      last_error TEXT,
      next_run_at INTEGER NOT NULL,
      created_at INTEGER NOT NULL,
      finished_at INTEGER
    );
    CREATE INDEX IF NOT EXISTS idx_dca_sells_due ON member_dca_sells(status, next_run_at);
  `);
}

// 🚨 Prefer the dedicated node. The public mainnet.base.org endpoint is load
// balanced and rate limited, and it has already faked a stale nonce, a bogus
// STF revert and an "over rate limit" mid-run. Only Base is served here, so the
// CDP node is only used when the slug is Base.
function pub(slug) {
  const chain = chains.chainBySlug(slug);
  const dedicated = String(slug) === 'base' ? process.env.CDP_NODE_RPC : null;
  const url = dedicated || (chain && chain.rpc && chain.rpc()) || 'https://mainnet.base.org';
  return createPublicClient({ chain: base, transport: http(url) });
}

async function create({ tgId, token, pct, intervalSeconds, chainRef = 'base', slippageBps }) {
  ensureSchema();
  const owner = Number(tgId);
  const p = Math.round(Number(pct));
  if (!Number.isFinite(p) || p < 1 || p > 100) throw new Error('sell a percentage between 1 and 100');
  const every = Math.round(Number(intervalSeconds));
  if (!Number.isFinite(every) || every < MIN_INTERVAL) throw new Error('the shortest interval is ' + Math.round(MIN_INTERVAL / 60) + ' minutes');
  if (every > MAX_INTERVAL) throw new Error('the longest interval is 7 days');

  const can = delegation.canBotSign(owner);
  if (!can || !can.ok) throw new Error('a scheduled sell runs without you present, so it needs an active delegation first');

  const active = db.prepare("SELECT COUNT(*) n FROM member_dca_sells WHERE tg_id=? AND status='active'").get(owner);
  if (active && active.n >= MAX_ACTIVE) throw new Error('you already have ' + active.n + ' scheduled sells running');

  const addr = getAddress(String(token));
  const p2 = pub(chainRef);
  const [held, sym, dec] = await Promise.all([
    p2.readContract({ address: addr, abi: ERC20, functionName: 'balanceOf', args: [getAddress(can.address)] }),
    p2.readContract({ address: addr, abi: ERC20, functionName: 'symbol' }).catch(() => null),
    p2.readContract({ address: addr, abi: ERC20, functionName: 'decimals' }).catch(() => 18),
  ]);
  if (held <= 0n) throw new Error('you do not hold that token');

  const dup = db.prepare("SELECT id FROM member_dca_sells WHERE tg_id=? AND lower(token)=lower(?) AND status='active'").get(owner, addr);
  if (dup) throw new Error('there is already a scheduled sell running for that token');

  const id = 'dca_' + Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
  const now = Date.now();
  db.prepare(`INSERT INTO member_dca_sells
    (id,tg_id,chain,token,symbol,decimals,pct,mode,interval_seconds,slippage_bps,start_raw,next_run_at,created_at)
    VALUES (?,?,?,?,?,?,?,'remaining',?,?,?,?,?)`)
    .run(id, owner, chainRef, addr.toLowerCase(), sym || '', Number(dec), p, every,
         Number(slippageBps) || DEFAULT_SLIP, held.toString(), now + every * 1000, now);

  return get(owner, id);
}

function rowView(r) {
  if (!r) return null;
  const dec = Number(r.decimals) || 18;
  const div = 10 ** dec;
  return {
    id: r.id, token: r.token, symbol: r.symbol || r.token.slice(0, 8), chain: r.chain,
    pct: r.pct, everyMinutes: Math.round(r.interval_seconds / 60), status: r.status,
    slicesDone: r.slices_done, soldTokens: Number(r.sold_raw) / div, receivedUsd: r.received_usd,
    startTokens: Number(r.start_raw) / div, nextRunAt: r.next_run_at, lastError: r.last_error || null,
    slippagePct: r.slippage_bps / 100,
  };
}

function get(tgId, id) {
  ensureSchema();
  return rowView(db.prepare('SELECT * FROM member_dca_sells WHERE tg_id=? AND id=?').get(Number(tgId), String(id)));
}

function listFor(tgId) {
  ensureSchema();
  return db.prepare("SELECT * FROM member_dca_sells WHERE tg_id=? AND status IN ('active','done','error') ORDER BY created_at DESC LIMIT 20")
    .all(Number(tgId)).map(rowView);
}

function cancel(tgId, id) {
  ensureSchema();
  const r = db.prepare("UPDATE member_dca_sells SET status='cancelled', finished_at=? WHERE tg_id=? AND id=? AND status='active'")
    .run(Date.now(), Number(tgId), String(id));
  if (!r.changes) throw new Error('no running schedule with that id');
  return { cancelled: true, id };
}

// --- execution ------------------------------------------------------------

async function signAndSend(can, slug, { to, data, value = 0n }) {
  const p = pub(slug);
  const address = getAddress(can.address);
  const nonce = await p.getTransactionCount({ address, blockTag: 'pending' });
  const fees = await p.estimateFeesPerGas();
  const est = await p.estimateGas({ account: address, to, data, value });
  const unsigned = {
    type: 'eip1559', chainId: 8453, nonce, to, data, value,
    gas: (est * 130n) / 100n,
    maxFeePerGas: fees.maxFeePerGas, maxPriorityFeePerGas: fees.maxPriorityFeePerGas,
  };
  const cdp = new CdpClient();
  const signed = await cdp.endUser.signEvmTransaction({
    userId: can.cdpUserId, address, transaction: serializeTransaction(unsigned),
  });
  const raw = signed && (signed.signedTransaction || signed.signed_transaction || signed.signedTx);
  if (!raw) throw new Error('CDP returned no signed transaction');
  const hash = await p.sendRawTransaction({ serializedTransaction: raw });
  const rc = await p.waitForTransactionReceipt({ hash, timeout: 120000 });
  if (rc.status !== 'success') { const e = new Error('slice reverted on chain'); e.reverted = true; e.hash = hash; throw e; }
  return hash;
}

async function runSlice(row) {
  const owner = Number(row.tg_id);
  const can = delegation.canBotSign(owner);
  if (!can || !can.ok) throw new Error('delegation is no longer active');
  const p = pub(row.chain);
  const me = getAddress(can.address);
  const token = getAddress(row.token);
  const chain = chains.chainBySlug(row.chain);
  const usdc = getAddress(chain.usdc.addr);
  const dec = Number(row.decimals) || 18;

  const held = await p.readContract({ address: token, abi: ERC20, functionName: 'balanceOf', args: [me] });
  const startRaw = BigInt(row.start_raw);
  const floorRaw = (startRaw * BigInt(Math.round(Number(row.floor_pct) * 100))) / 10000n;
  if (held <= floorRaw) return { finish: 'floor reached, position is down to the floor' };

  const sliceRaw = (held * BigInt(row.pct)) / 100n;
  if (sliceRaw <= 0n) return { finish: 'nothing left to sell' };

  // Scheduled sells must use the same Definitive Flash path as manual sells.
  // Do not build a Kyber/0x transaction here: runtime mode is Flash-only and
  // the member's delegated CDP account signs the Flash order.
  const beforeUsdc = await p.readContract({ address: usdc, abi: ERC20, functionName: 'balanceOf', args: [me] });
  const d = await tradeCore.buildSell({
    tgId: owner,
    token: token.toLowerCase(),
    pct: Number(row.pct),
    settleTo: 'usdc',
    chainRef: row.chain,
    slippageBps: Number(row.slippage_bps),
  });
  const found = await cdpServer.findBySubject(owner);
  const userId = found && (found.userId || found.user_id);
  if (!d || !d.id || !userId) throw new Error('delegated Flash account is unavailable');
  const result = await memberExec.executeDelegated({
    id: d.id, tgId: owner, userId, address: me,
  });
  const afterUsdc = await p.readContract({ address: usdc, abi: ERC20, functionName: 'balanceOf', args: [me] });
  const afterTok = await p.readContract({ address: token, abi: ERC20, functionName: 'balanceOf', args: [me] });
  const gotUsd = Number(afterUsdc - beforeUsdc) / (10 ** Number(chain.usdc.dec));
  const soldRaw = held - afterTok;
  if (gotUsd <= 0 || soldRaw <= 0n) throw new Error('Flash order completed without a confirmed balance delta');
  return { hash: result && result.orderId ? result.orderId : null, soldRaw, gotUsd, remaining: afterTok, dec };

}

async function tick(notify) {
  ensureSchema();
  const now = Date.now();
  const due = db.prepare("SELECT * FROM member_dca_sells WHERE status='active' AND next_run_at<=? ORDER BY next_run_at LIMIT 5").all(now);
  for (const row of due) {
    // Move the clock first, so a slow or failing slice can never re-enter.
    db.prepare('UPDATE member_dca_sells SET next_run_at=? WHERE id=?').run(now + row.interval_seconds * 1000, row.id);
    try {
      const r = await runSlice(row);
      if (r.finish) {
        db.prepare("UPDATE member_dca_sells SET status='done', last_error=?, finished_at=? WHERE id=?").run(r.finish, Date.now(), row.id);
        if (notify) notify(row.tg_id, 'Scheduled sell finished', (row.symbol || 'token') + ': ' + r.finish);
        continue;
      }
      if (r.skip) { db.prepare('UPDATE member_dca_sells SET last_error=? WHERE id=?').run(r.skip, row.id); continue; }
      const soldTotal = (BigInt(row.sold_raw) + r.soldRaw).toString();
      const slices = row.slices_done + 1;
      const status = slices >= row.max_slices ? 'done' : 'active';
      db.prepare(`UPDATE member_dca_sells SET slices_done=?, sold_raw=?, received_usd=?, last_error=NULL, status=?, finished_at=? WHERE id=?`)
        .run(slices, soldTotal, Number(row.received_usd) + r.gotUsd, status, status === 'done' ? Date.now() : null, row.id);
      if (notify) {
        notify(row.tg_id, 'Sold a slice',
          (Number(r.soldRaw) / (10 ** r.dec)).toFixed(0) + ' ' + (row.symbol || 'tokens') + ' for $' + r.gotUsd.toFixed(4)
          + ', ' + (Number(r.remaining) / (10 ** r.dec)).toFixed(0) + ' left');
      }
    } catch (e) {
      const msg = String((e && (e.shortMessage || e.message)) || 'slice failed').slice(0, 300);
      db.prepare('UPDATE member_dca_sells SET last_error=? WHERE id=?').run(msg, row.id);
      console.warn('[dca-sell] ' + row.id + ': ' + msg);
    }
  }
  return { due: due.length };
}

module.exports = { ensureSchema, create, listFor, get, cancel, tick, runSlice, MIN_INTERVAL };
