// src/lib/member-orders.js
// Resting orders for members: limit, stop loss and take profit.
//
// Flash takes the signature at PLACEMENT, not at fill, which is what makes a
// resting order possible at all here. The member confirms once, the backend
// signs, and the order sits with Flash until it triggers or expires.
//
// 🚨 Kyber has no resting orders. Only Flash can carry one, and only on a chain
// and pair Flash can rest against. A refusal says which of those failed rather
// than a generic no.

const flash = require('./engines/flash');
const chains = require('./chains');
const router = require('./router');
const wallet = require('./wallet');
const members = require('./member-wallets');
const fees = require('./member-fees');
const { db } = require('../db');

// Flash's enum uses HYPHENS and has no dca. Recorded because an earlier note
// had underscores and it silently produced no quote.
const KINDS = {
  limit: 'limit',
  stop: 'stop-loss',
  tp: 'take-profit',
};

/**
 * Builds the order-specific fields Flash requires.
 *
 * limit needs a price. stop-loss and take-profit need exactly ONE trigger, and
 * the direction matters: a take profit fires on the way UP, a stop on the way
 * DOWN. Getting that backwards places an order that can never fill.
 */
function extraFor(kind, usdPrice) {
  if (kind === 'limit') return { limitNotionalPrice: String(usdPrice) };
  return {
    triggers: [{
      triggerType: kind === 'tp' ? 'upper' : 'lower',
      notionalPrice: String(usdPrice),
    }],
  };
}

/**
 * Quotes a resting order for a member.
 *
 * Returns { q, price, held, amountRaw, symbol }. Nothing is signed here.
 */
async function quote({ tgId, chainRef, token, pct, multiple, kind, settleTo }) {
  if (!KINDS[kind]) throw new Error('unknown order kind: ' + kind);

  const chain = chains.chainBySlug(chainRef);
  if (!chain || !chains.isEnabled(chain)) throw new Error('that chain is not enabled');
  if (!chain.usdc || !chain.usdc.addr) throw new Error(`${chain.name} has no USDC configured`);
  if (chain.svm) throw new Error('resting orders are EVM only for now');
  const toEth = String(settleTo || 'usdc').toLowerCase() === 'eth';
  const tokenOut = toEth ? chains.ETH_SENTINEL : chain.usdc.addr;

  const from = members.addressFor(tgId, chain);
  if (!from) throw new Error('no wallet for this member');

  // 🚨 Size from the ACTUAL balance. A percentage of an assumed number places
  // an order the member cannot fill.
  const held = await wallet.balanceOf(chain.kyberSlug, token, from);
  if (!held || held <= 0n) throw new Error('you do not hold that token on ' + chain.name);

  const amountRaw = (held * BigInt(Math.round(pct))) / 100n;
  if (amountRaw <= 0n) throw new Error('that percentage rounds to nothing of what you hold');

  const spot = await router.unitPriceUsd(chain.kyberSlug, token);
  if (spot == null) throw new Error('no price for that token, so a trigger cannot be set');

  const price = spot * Number(multiple);
  const symbol = await router.safeSymbol(chain.kyberSlug, token).catch(() => '');

  const memberBps = await fees.resolveMemberBps(from);
  const q = await flash.quote({
    chainRef: chain.kyberSlug,
    tokenIn: token,
    tokenOut,
    amountInRaw: amountRaw,
    orderType: KINDS[kind],
    extra: extraFor(kind, price),
    feeBpsOverride: fees.flashFeeBps({ isMember: true, bpsOverride: memberBps }),
    funderAddress: from,
  });
  if (!q) {
    throw new Error('the resting-order engine would not quote that. The pair, the size or the trigger price is out of range');
  }

  return { q, price, spot, held, amountRaw, symbol, chain, settleTo: toEth ? 'eth' : 'usdc' };
}

// Flash's DCA is spelled `twap`: the order fills in slices over
// durationSeconds, minimum 300. There is no `dca` in the enum.
const DCA_MIN_SECONDS = 300;
const DCA_MAX_SECONDS = 7 * 24 * 3600;

/**
 * Quotes a DCA BUY for a member: USDC in, token out, spread over a duration.
 *
 * Unlike the sell-side resting orders this SPENDS, so the caller must run the
 * same cap check and reservation a market buy gets.
 */
async function quoteDca({ tgId, chainRef, token, usd, amount: ethAmount, payWith, durationSeconds }) {
  const chain = chains.chainBySlug(chainRef);
  if (!chain || !chains.isEnabled(chain)) throw new Error('that chain is not enabled');
  if (!chain.usdc || !chain.usdc.addr) throw new Error(`${chain.name} has no USDC configured`);
  if (chain.svm) throw new Error('DCA orders are EVM only for now');

  const secs = Math.round(Number(durationSeconds) || 0);
  if (secs < DCA_MIN_SECONDS) throw new Error('the shortest DCA window is 5 minutes');
  if (secs > DCA_MAX_SECONDS) throw new Error('the longest DCA window is 7 days');

  const from = members.addressFor(tgId, chain);
  if (!from) throw new Error('no wallet for this member');

  const withEth = String(payWith || 'usdc').toLowerCase() === 'eth';
  let tokenIn; let amountRaw; let usdValue; let spendSym;
  if (withEth) {
    const amt = Number(ethAmount);
    if (!Number.isFinite(amt) || amt <= 0) throw new Error('amount must be above zero');
    if (amt > 10) throw new Error('amounts here are in ' + chain.nativeSymbol + ', not dollars');
    const nUsd = await router.nativeUsd(chain.nativeSymbol);
    if (!nUsd) throw new Error('cannot price ' + chain.nativeSymbol + ' right now, use USDC');
    usdValue = Math.round(amt * nUsd * 100) / 100;
    amountRaw = wallet.parseUnits(String(amt), 18);
    tokenIn = chains.ETH_SENTINEL;
    spendSym = chain.nativeSymbol;
    // Native funds the whole twap PLUS gas headroom for its slices.
    const bal = await wallet.balanceOf(chain.kyberSlug, tokenIn, from);
    if (bal < amountRaw + wallet.parseUnits('0.0005', 18)) {
      throw new Error(`you hold ${Number(wallet.formatUnits(bal, 18)).toFixed(5)} ${chain.nativeSymbol} on ${chain.name}, this needs ${amt} plus gas`);
    }
  } else {
    const amount = Number(usd);
    if (!Number.isFinite(amount) || amount <= 0) throw new Error('amount must be above zero');
    usdValue = amount;
    amountRaw = wallet.parseUnits(String(amount), chain.usdc.dec);
    tokenIn = chain.usdc.addr;
    spendSym = 'USDC';
    // 🚨 The member must actually hold the USDC. A twap that fails its slices
    // mid-flight is worse than a refusal up front.
    const held = await wallet.balanceOf(chain.kyberSlug, chain.usdc.addr, from);
    if (held < amountRaw) {
      throw new Error(`you hold ${Number(wallet.formatUnits(held, chain.usdc.dec)).toFixed(2)} USDC on ${chain.name}, this needs ${amount}`);
    }
  }

  const memberBps = await fees.resolveMemberBps(from);
  const q = await flash.quote({
    chainRef: chain.kyberSlug,
    tokenIn,
    tokenOut: token,
    amountInRaw: amountRaw,
    orderType: 'twap',
    extra: { durationSeconds: secs },
    feeBpsOverride: fees.flashFeeBps({ isMember: true, bpsOverride: memberBps }),
    funderAddress: from,
  });
  if (!q) throw new Error('the DCA engine would not quote that pair or size');

  const symbol = await router.safeSymbol(chain.kyberSlug, token).catch(() => '');
  return { q, amountRaw, tokenIn, symbol, chain, durationSeconds: secs, usd: usdValue, spendSym, payWith: withEth ? 'eth' : 'usdc', ethAmount: withEth ? Number(ethAmount) : null };
}

/**
 * Records an order that the member signed on their own device and Flash
 * accepted. This module never receives a key or creates a signature.
 */
function recordSigned({ tgId, orderId, chain, kind, pct, price, symbol, token }) {
  // A DCA is the one BUY in this table: order_type twap, qty holds the USD
  // being spent, and there is no trigger price because time is the trigger.
  const isDca = kind === 'dca';
  db.prepare(
    `INSERT OR REPLACE INTO flash_orders
       (order_id, chain, chain_id, token, symbol, side, order_type, qty, trigger_price, status, created_at, owner_tg_id)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
  ).run(
    orderId, chain.kyberSlug, chain.id, String(token).toLowerCase(), symbol || '',
    isDca ? 'buy' : 'sell', isDca ? 'twap' : KINDS[kind], pct, isDca ? null : price,
    'PENDING', Date.now(), Number(tgId),
  );

  return { orderId, price, kind: isDca ? 'twap' : KINDS[kind] };
}

/** A member's own resting orders, newest first. */
function listFor(tgId) {
  return db.prepare(
    "SELECT * FROM flash_orders WHERE owner_tg_id = ? AND status = 'PENDING' ORDER BY created_at DESC LIMIT 20",
  ).all(Number(tgId));
}

function getFor(tgId, orderId) {
  const owner = Number(tgId);
  const key = String(orderId || '').trim();
  const exact = db.prepare('SELECT * FROM flash_orders WHERE owner_tg_id = ? AND order_id = ?')
    .get(owner, key);
  if (exact) return exact;

  // /myorders deliberately shows a short ID. Accept it only when it maps to
  // exactly one order owned by this member; an ambiguous prefix must not ever
  // select an arbitrary financial order.
  if (!/^[a-zA-Z0-9_-]{8,}$/.test(key)) return null;
  const matches = db.prepare('SELECT * FROM flash_orders WHERE owner_tg_id = ? AND order_id LIKE ? LIMIT 2')
    .all(owner, key + '%');
  return matches.length === 1 ? matches[0] : null;
}

function updateStatus(tgId, orderId, status) {
  db.prepare('UPDATE flash_orders SET status = ? WHERE owner_tg_id = ? AND order_id = ?')
    .run(String(status), Number(tgId), String(orderId));
  return getFor(tgId, orderId);
}

/**
 * Flash is authoritative about an order's terminal state.  Local rows are
 * only a member-owned index, so refresh them before presenting /myorders.
 */
async function reconcileFor(tgId) {
  const pending = listFor(tgId);
  if (!pending.length) return pending;
  const address = members.addressFor(tgId, { svm: false });
  if (!address) return pending;
  await Promise.all(pending.map(async (row) => {
    try {
      const live = await flash.orderDetail(row.order_id, address);
      const status = String(live && live.status || '').replace(/^ORDER_STATUS_/, '').toUpperCase();
      if (status && status !== String(row.status).toUpperCase()) updateStatus(tgId, row.order_id, status);
    } catch (e) { /* unavailable upstream leaves the last known state intact */ }
  }));
  return listFor(tgId);
}

function markCancelled(tgId, orderId) {
  return updateStatus(tgId, orderId, 'CANCELLED');
}

module.exports = { KINDS, quote, quoteDca, recordSigned, listFor, getFor, reconcileFor, markCancelled, DCA_MIN_SECONDS, DCA_MAX_SECONDS };
