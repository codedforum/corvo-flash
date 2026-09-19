// src/lib/member-trade-core.js
// Builds member trades for the WEB surface: cap check, route, preflight, park.
//
// The chat commands keep their own orchestration because their output is
// Telegram cards; everything that decides anything (caps, quotes, preflight,
// reservations, signing) already lives in shared libs, and this file only
// sequences them the same way the chat does. The parked request that comes out
// is IDENTICAL either way, so /api/requests/prepare and settle serve both
// surfaces with one implementation.
//
// 🚨 No path in here signs or spends. Everything ends at a parked signing
// request that only the member's own device can complete.

const chains = require('./chains');
const router = require('./router');
const wallet = require('./wallet');
const preflight = require('./preflight');
const members = require('./member-wallets');
const memberCaps = require('./member-caps');
const memberOrders = require('./member-orders');
const signreq = require('./signreq');
const flash = require('./engines/flash');
const splDecimals = async (mint) => { try { return await flash.mintDecimals(mint); } catch (_) { return 9; } };
async function solSymbol(mint) { try { const rows = await flash.search(mint, 'solana'); const x = rows[0] || {}; return x.symbol || x.name || null; } catch (_) { return null; } }
const positions = require('./positions');
const delegation = require('./member-delegation');
const cdpServer = require('./cdp-server');
const tradeRefs = require('./trade-refs');
const memberFees = require('./member-fees');
const fillLog = require('./fill-log');

const ADDR = /^0x[0-9a-fA-F]{40}$/;

function human(raw, decimals) {
  const n = Number(wallet.formatUnits(BigInt(raw), decimals));
  if (n === 0) return '0';
  if (n < 0.0001) return n.toExponential(2);
  if (n < 1000) return String(Number(n.toFixed(6)));
  return n.toLocaleString('en-US', { maximumFractionDigits: 2 });
}

function resolveChain(chainRef) {
  const chain = chains.chainBySlug(chainRef || 'base');
  if (!chain || !chains.isEnabled(chain)) throw new Error('that chain is not enabled for trading');
  // Solana is Flash-only in this runtime. Execution remains capability-gated
  // until Flash's SVM signing payload is verified end to end.
  if (!chain.usdc || !chain.usdc.addr) throw new Error(chain.name + ' has no USDC configured');
  return chain;
}

function memberAddress(tgId) {
  if (!members.isReady(tgId)) throw new Error('no wallet yet, create one first');
  return members.get(tgId).evm_address;
}

function quoteSummary(quotes, picked, outDecimals) {
  return {
    engine: picked.engine,
    impactPct: picked.impactPct != null ? Number(picked.impactPct) : null,
    all: quotes.map((q) => ({
      engine: q.engine,
      out: q.outRaw != null ? human(q.outRaw, outDecimals) : null,
      quoteOnly: q.executable === false,
      best: !!q.best,
    })),
  };
}

/**
 * A market buy. Funded in USDC by default, or in the chain's native coin when
 * payWith is 'eth': the amount is then DENOMINATED IN ETH ("0.01" means a
 * hundredth of an ETH), while the daily cap keeps counting in dollars, so the
 * ceiling means the same thing whatever funds the trade.
 */
async function buildBuy({ tgId, token, usd, amount, payWith, chainRef, slippageBps }) {
  if (String(chainRef) === 'solana') {
    if (!chains.isEnabled(chains.getChain('solana'))) throw new Error('Solana is not enabled for Corvo Flash right now');
    return buildSolanaBuy({ tgId, token, usd, amount, payWith, slippageBps });
  }
  if (!ADDR.test(token || '')) throw new Error('that is not a valid token contract address');
  const withEth = String(payWith || 'usdc').toLowerCase() === 'eth';
  const amt = Number(withEth ? amount : (usd != null ? usd : amount));
  if (!Number.isFinite(amt) || amt <= 0) throw new Error('amount must be above zero');
  const chain = resolveChain(chainRef);
  const address = memberAddress(tgId);

  let tokenIn; let amountInRaw; let usdValue; let spendLabel;
  if (withEth) {
    const nUsd = await router.nativeUsd(chain.nativeSymbol);
    if (!nUsd) throw new Error('cannot price ' + chain.nativeSymbol + ' right now, try USDC');
    if (amt > 10) throw new Error('that is a lot of ' + chain.nativeSymbol + '. Amounts here are in ' + chain.nativeSymbol + ', not dollars');
    usdValue = Math.round(amt * nUsd * 100) / 100;
    amountInRaw = wallet.parseUnits(String(amt), 18);
    tokenIn = chains.ETH_SENTINEL;
    // The member must hold the coin PLUS headroom for gas, or the swap that
    // spends their whole balance strands the transaction fee.
    const bal = await wallet.balanceOf(chain.kyberSlug, tokenIn, address);
    const headroom = wallet.parseUnits('0.0003', 18);
    if (bal < amountInRaw + headroom) {
      throw new Error('you hold ' + Number(wallet.formatUnits(bal, 18)).toFixed(5) + ' ' + chain.nativeSymbol
        + ' on ' + chain.name + ', this needs ' + amt + ' plus gas');
    }
    spendLabel = amt + ' ' + chain.nativeSymbol + ' (about ' + usdValue.toFixed(2) + ' USD)';
  } else {
    usdValue = amt;
    amountInRaw = wallet.parseUnits(String(amt), chain.usdc.dec);
    tokenIn = chain.usdc.addr;
    spendLabel = amt + ' USDC';
  }

  const capCheck = memberCaps.check(tgId, usdValue);
  if (!capCheck.ok) throw new Error(capCheck.reason);

  const quotes = await router.quoteAll({
    chainRef: chain.kyberSlug, tokenIn, tokenOut: token,
    amountInRaw, isMember: true, funderAddress: address,
  });
  if (!quotes || !quotes.length) {
    // "no route" hides two very different situations. Probe one whole token to
    // tell "this SIZE will not route" apart from "nothing bids for this token
    // at all", which is what a single sided pool looks like before anyone buys.
    let anySize = false;
    try {
      const dec = await wallet.decimals(chain.kyberSlug, token).catch(() => 18);
      const probeRaw = 10n ** BigInt(Number(dec) || 18);
      const probe = await router.quoteAll({
        chainRef: chain.kyberSlug, tokenIn: token, tokenOut,
        amountInRaw: probeRaw < amountInRaw ? probeRaw : amountInRaw,
        isMember: true, funderAddress: address,
      });
      anySize = !!(probe && probe.length);
    } catch (e) { anySize = false; }
    if (!anySize) {
      throw new Error('no pool is offering this token right now, so there is nothing to buy into. '
        + 'Check the contract address is the one you meant.');
    }
    throw new Error('that size will not route right now. Try a smaller amount.');
  }
  const picked = router.bestExecutable(quotes);
  if (!picked) throw new Error('Definitive Flash is not executable right now');

  const pf = await preflight.forBuy({
    chainRef: chain.kyberSlug, token, spendToken: tokenIn,
    spendRaw: amountInRaw, spendUsd: usdValue, quote: picked, who: address,
  });
  if (pf.blocked) {
    throw new Error('refused: ' + preflight.render(pf.findings.filter((f) => f.level === preflight.BLOCK)));
  }

  const symbol = await router.safeSymbol(chain.kyberSlug, token).catch(() => '');
  const outDecimals = await wallet.decimals(chain.kyberSlug, token).catch(() => 18);

  const req = signreq.park({
    tgId, kind: 'swap', chainId: chain.id,
    intent: {
      side: 'buy', tokenIn, tokenOut: token,
      amountInRaw: amountInRaw.toString(), usd: usdValue, symbol,
      payWith: withEth ? 'eth' : 'usdc',
      review_out_raw: picked.outRaw.toString(),
      slippageBps: slippageBps != null ? Number(slippageBps) : undefined,
    },
  });
  const reserved = memberCaps.reserve(tgId, req.id, usdValue, req.expires_at);
  if (!reserved.ok) {
    signreq.cancel(req.id, tgId);
    throw new Error(reserved.reason);
  }

  // 🚨 CAN YOU GET BACK OUT? A single sided pool hands tokens out but cannot
  // take them back until someone has bought in, so a buyer can be stuck with no
  // bid at any size. That has to be said BEFORE the buy, not discovered after.
  let exitWarning = null;
  try {
    const probeRaw = 10n ** BigInt(Number(outDecimals) || 18);
    const probe = await Promise.race([
      router.quoteAll({
        chainRef: chain.kyberSlug, tokenIn: token, tokenOut: chain.usdc.addr,
        amountInRaw: probeRaw, isMember: true, funderAddress: memberAddress(tgId),
      }),
      new Promise((r) => setTimeout(() => r(null), 4500)),
    ]);
    if (probe && Array.isArray(probe) && !probe.length) {
      exitWarning = 'Nothing is bidding for ' + (symbol || 'this token')
        + ' yet, so you may not be able to sell it back until someone buys into the pool.';
    }
  } catch (e) { /* a probe must never block a buy */ }

  return {
    id: req.id,
    expiresAt: req.expires_at,
    side: 'buy',
    chain: chain.name,
    symbol: symbol || token.slice(0, 8),
    spend: spendLabel,
    receive: 'about ' + human(picked.outRaw, outDecimals) + ' ' + (symbol || 'tokens'),
    warnings: [exitWarning, preflight.render(pf.findings.filter((f) => f.level !== preflight.BLOCK)) || null]
      .filter(Boolean).join(' ') || null,
    quotes: quoteSummary(quotes, picked, outDecimals),
  };
}

/**
 * A market sell: token in, sized as a percent of the real balance. Settles to
 * USDC by default or to the chain's native coin when settleTo is 'eth'.
 */
async function buildSell({ tgId, token, pct, settleTo, chainRef, slippageBps }) {
  if (String(chainRef) === 'solana') {
    if (!chains.isEnabled(chains.getChain('solana'))) throw new Error('Solana is not enabled for Corvo Flash right now');
    return buildSolanaSell({ tgId, token, pct, settleTo });
  }
  if (!ADDR.test(token || '')) throw new Error('that is not a valid token contract address');
  const percent = pct === undefined || pct === null ? 100 : Number(pct);
  if (!Number.isFinite(percent) || percent <= 0 || percent > 100) throw new Error('percent must be 1 to 100');
  const toEth = String(settleTo || 'usdc').toLowerCase() === 'eth';
  const chain = resolveChain(chainRef);
  const address = memberAddress(tgId);

  const tokenOut = toEth ? chains.ETH_SENTINEL : chain.usdc.addr;
  const outDec = toEth ? 18 : chain.usdc.dec;
  const outSym = toEth ? chain.nativeSymbol : 'USDC';

  const held = await wallet.balanceOf(chain.kyberSlug, token, address);
  if (!held || held <= 0n) throw new Error('you do not hold that token on ' + chain.name);
  const amountInRaw = (held * BigInt(Math.round(percent))) / 100n;
  if (amountInRaw <= 0n) throw new Error('that percentage rounds to nothing of what you hold');

  const quotes = await router.quoteAll({
    chainRef: chain.kyberSlug, tokenIn: token, tokenOut,
    amountInRaw, isMember: true, funderAddress: address,
  });
  if (!quotes || !quotes.length) {
    // "no route" hides two very different situations. Probe one whole token to
    // tell "this SIZE will not route" apart from "nothing bids for this token
    // at all", which is what a single sided pool looks like before anyone buys.
    let anySize = false;
    try {
      const probeDec = await wallet.decimals(chain.kyberSlug, token).catch(() => 18);
      const probeRaw = 10n ** BigInt(Number(probeDec) || 18);
      const probe = await router.quoteAll({
        chainRef: chain.kyberSlug, tokenIn: token, tokenOut,
        amountInRaw: probeRaw < amountInRaw ? probeRaw : amountInRaw,
        isMember: true, funderAddress: address,
      });
      anySize = !!(probe && probe.length);
    } catch (e) { anySize = false; }
    if (!anySize) {
      throw new Error('nothing is bidding for this token right now, so it cannot be sold at any size. '
        + 'A single sided pool only opens to sellers once someone has bought into it.');
    }
    throw new Error('that size will not route right now. Try a smaller percentage.');
  }
  const picked = router.bestExecutable(quotes);
  if (!picked) throw new Error('Definitive Flash is not executable right now');

  const pf = await preflight.forSell({
    chainRef: chain.kyberSlug, token, amountRaw: amountInRaw, quote: picked, who: address,
  });
  if (pf.blocked) {
    throw new Error('refused: ' + preflight.render(pf.findings.filter((f) => f.level === preflight.BLOCK)));
  }

  const symbol = await router.safeSymbol(chain.kyberSlug, token).catch(() => '');
  const inDecimals = await wallet.decimals(chain.kyberSlug, token).catch(() => 18);

  const req = signreq.park({
    tgId, kind: 'swap', chainId: chain.id,
    intent: {
      side: 'sell', tokenIn: token, tokenOut,
      amountInRaw: amountInRaw.toString(), pct: percent, symbol,
      settleTo: toEth ? 'eth' : 'usdc',
      review_out_raw: picked.outRaw.toString(),
      slippageBps: slippageBps != null ? Number(slippageBps) : undefined,
    },
  });

  return {
    id: req.id,
    expiresAt: req.expires_at,
    side: 'sell',
    chain: chain.name,
    symbol: symbol || token.slice(0, 8),
    spend: human(amountInRaw, inDecimals) + ' ' + (symbol || 'tokens') + ' (' + percent + '%)',
    receive: 'about ' + human(picked.outRaw, outDec) + ' ' + outSym,
    warnings: preflight.render(pf.findings.filter((f) => f.level !== preflight.BLOCK)) || null,
    quotes: quoteSummary(quotes, picked, outDec),
  };
}

/** A DCA buy over a window, funded in USDC or the native coin, via Flash twap. */
async function buildDca({ tgId, token, usd, amount, payWith, durationSeconds, chainRef }) {
  if (!ADDR.test(token || '')) throw new Error('that is not a valid token contract address');
  const chain = resolveChain(chainRef);
  memberAddress(tgId);
  const withEth = String(payWith || 'usdc').toLowerCase() === 'eth';

  const r = await memberOrders.quoteDca({
    tgId, chainRef: chain.kyberSlug, token, durationSeconds,
    usd: withEth ? undefined : Number(usd != null ? usd : amount),
    amount: withEth ? Number(amount) : undefined,
    payWith: withEth ? 'eth' : 'usdc',
  });

  // The cap is in USD whatever funds the trade; quoteDca computed r.usd.
  const capCheck = memberCaps.check(tgId, r.usd);
  if (!capCheck.ok) throw new Error(capCheck.reason);

  const req = signreq.park({
    tgId, kind: 'order', chainId: r.chain.id,
    intent: { orderKind: 'dca', token, usd: r.usd, ethAmount: r.ethAmount, payWith: r.payWith, durationSeconds: r.durationSeconds, chainRef: r.chain.kyberSlug, symbol: r.symbol },
  });
  const reserved = memberCaps.reserve(tgId, req.id, r.usd, req.expires_at);
  if (!reserved.ok) {
    signreq.cancel(req.id, tgId);
    throw new Error(reserved.reason);
  }

  const outDecimals = await wallet.decimals(r.chain.kyberSlug, token).catch(() => 18);
  const spendAmt = withEth ? (r.ethAmount + ' ' + r.spendSym) : (r.usd + ' USDC');
  return {
    id: req.id,
    expiresAt: req.expires_at,
    side: 'buy',
    kind: 'dca',
    chain: r.chain.name,
    symbol: r.symbol || token.slice(0, 8),
    spend: spendAmt + ' over ' + Math.round(r.durationSeconds / 60) + ' min',
    receive: 'about ' + human(r.q.outRaw, outDecimals) + ' ' + (r.symbol || 'tokens') + ', filled in slices',
    warnings: null,
    quotes: { engine: 'flash', impactPct: null, all: [{ engine: 'flash', out: 'fills over time', quoteOnly: false, best: true }] },
  };
}

/** A resting sell order (limit, stop, tp), settling to USDC or the native coin. */
async function buildResting({ tgId, token, kind, multiple, pct, settleTo, chainRef }) {
  if (!ADDR.test(token || '')) throw new Error('that is not a valid token contract address');
  if (!['limit', 'stop', 'tp'].includes(kind)) throw new Error('unknown order kind');
  const mult = Number(multiple);
  if (!Number.isFinite(mult) || mult <= 0) throw new Error('multiple must be above zero');
  const percent = pct === undefined || pct === null ? 100 : Number(pct);
  if (!Number.isFinite(percent) || percent <= 0 || percent > 100) throw new Error('percent must be 1 to 100');
  const toEth = String(settleTo || 'usdc').toLowerCase() === 'eth';
  const chain = resolveChain(chainRef);
  memberAddress(tgId);

  const r = await memberOrders.quote({ tgId, chainRef: chain.kyberSlug, token, pct: percent, multiple: mult, kind, settleTo: toEth ? 'eth' : 'usdc' });
  const req = signreq.park({
    tgId, kind: 'order', chainId: r.chain.id,
    intent: { orderKind: kind, token, pct: percent, multiple: mult, chainRef: chain.kyberSlug, price: r.price, symbol: r.symbol, settleTo: r.settleTo },
  });
  return {
    id: req.id,
    expiresAt: req.expires_at,
    side: 'sell',
    kind,
    chain: r.chain.name,
    symbol: r.symbol || token.slice(0, 8),
    spend: percent + '% of your ' + (r.symbol || 'position'),
    receive: 'rests until $' + r.price.toPrecision(6) + ' (now $' + r.spot.toPrecision(6) + '), into ' + (toEth ? chain.nativeSymbol : 'USDC'),
    warnings: null,
    quotes: { engine: 'flash', impactPct: null, all: [{ engine: 'flash', out: 'rests until it triggers', quoteOnly: false, best: true }] },
  };
}


// ------------------------------------------------------------------ Solana ---
// Member Solana trading over Flash, signed server-side under the member's CDP
// delegation (the SAME non custodial model as EVM, just a different signer).
// 🚨 No path here signs or spends without an active delegation; build* only
// parks a request, executeSolanaSwap runs it once, guarded against replay.
const WSOL_MINT = 'So11111111111111111111111111111111111111112';
const USDC_SOL = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const B58 = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

function solPubkey(addr) { const { PublicKey } = require('@solana/web3.js'); return new PublicKey(addr); }
async function solLamports(addr) {
  try { return BigInt(await wallet.solConnection().getBalance(solPubkey(addr))); } catch (e) { return 0n; }
}
async function splRaw(addr, mint) {
  try {
    const res = await wallet.solConnection().getParsedTokenAccountsByOwner(solPubkey(addr), { mint: solPubkey(mint) });
    let sum = 0n;
    for (const acc of res.value) sum += BigInt(acc.account.data.parsed.info.tokenAmount.amount);
    return sum;
  } catch (e) { return 0n; }
}
async function solPriceUsd() {
  try { const q = await flash.quote({ chainRef: 'solana', tokenIn: WSOL_MINT, tokenOut: USDC_SOL, amountInRaw: 1000000000n }); return q && q.outRaw ? Number(q.outRaw) / 1e6 : null; } catch (e) { return null; }
}

function isSolMint(t) { return !!t && !/^0x/i.test(t) && B58.test(t); }

async function buildSolanaBuy({ tgId, token, usd, amount, payWith, slippageBps }) {
  if (!isSolMint(token)) throw new Error('that is not a valid Solana mint');
  if (!members.isReady(tgId)) throw new Error('no wallet yet, create one first');
  const address = members.get(tgId).sol_address;
  if (!address) throw new Error('no Solana wallet on your account yet');
  const withSol = String(payWith || 'usdc').toLowerCase() === 'sol';
  const amt = Number(withSol ? amount : (usd != null ? usd : amount));
  if (!Number.isFinite(amt) || amt <= 0) throw new Error('amount must be above zero');

  let tokenIn; let amountInRaw; let usdValue; let spendLabel;
  if (withSol) {
    const px = await solPriceUsd();
    if (!px) throw new Error('cannot price SOL right now, try USDC');
    if (amt > 100) throw new Error('that is a lot of SOL. Amounts here are in SOL, not dollars');
    usdValue = Math.round(amt * px * 100) / 100;
    amountInRaw = BigInt(Math.round(amt * 1e9));
    tokenIn = 'native';
    const bal = await solLamports(address);
    const headroom = 3000000n;
    if (bal < amountInRaw + headroom) throw new Error('you hold ' + (Number(bal) / 1e9).toFixed(4) + ' SOL, this needs ' + amt + ' plus fees');
    spendLabel = amt + ' SOL (about $' + usdValue.toFixed(2) + ')';
  } else {
    usdValue = amt;
    amountInRaw = BigInt(Math.round(amt * 1e6));
    tokenIn = USDC_SOL;
    const bal = await splRaw(address, USDC_SOL);
    if (bal < amountInRaw) throw new Error('you hold ' + (Number(bal) / 1e6).toFixed(2) + ' USDC on Solana, this needs ' + amt);
    spendLabel = amt + ' USDC';
  }

  const capCheck = memberCaps.check(tgId, usdValue);
  if (!capCheck.ok) throw new Error(capCheck.reason);

  const q = await flash.quote({ chainRef: 'solana', tokenIn: tokenIn === 'native' ? WSOL_MINT : tokenIn, tokenOut: token, amountInRaw, funderAddress: address });
  if (!q || !q.outRaw) throw new Error('no Flash route for that token right now');
  const outDec = Number(q.meta.decOut || 9);
  const symbol = (await solSymbol(token)) || token.slice(0, 6);

  const req = signreq.park({
    tgId, kind: 'solana-swap', chainId: null,
    intent: {
      side: 'buy', chainRef: 'solana', tokenIn, tokenOut: token,
      amountInRaw: amountInRaw.toString(), usd: usdValue, symbol,
      payWith: withSol ? 'sol' : 'usdc',
      slippageBps: slippageBps != null ? Number(slippageBps) : undefined,
      review_out_raw: q.outRaw.toString(), outDec,
    },
  });
  const reserved = memberCaps.reserve(tgId, req.id, usdValue, req.expires_at);
  if (!reserved.ok) { signreq.cancel(req.id, tgId); throw new Error(reserved.reason); }

  return {
    id: req.id, expiresAt: req.expires_at, side: 'buy', chain: 'Solana', svm: true,
    symbol, spend: spendLabel, receive: 'about ' + human(q.outRaw, outDec) + ' ' + symbol,
    warnings: null,
    quotes: { engine: 'flash', impactPct: q.impactPct != null ? Number(q.impactPct) : null, all: [{ engine: 'flash', out: human(q.outRaw, outDec), best: true }] },
  };
}

async function buildSolanaSell({ tgId, token, pct, settleTo }) {
  if (!isSolMint(token)) throw new Error('that is not a valid Solana mint');
  if (!members.isReady(tgId)) throw new Error('no wallet yet, create one first');
  const address = members.get(tgId).sol_address;
  if (!address) throw new Error('no Solana wallet on your account yet');
  const percent = pct === undefined || pct === null ? 100 : Number(pct);
  if (!Number.isFinite(percent) || percent <= 0 || percent > 100) throw new Error('percent must be 1 to 100');
  const toSol = String(settleTo || 'usdc').toLowerCase() === 'sol';
  const tokenOut = toSol ? 'native' : USDC_SOL;
  const outDec = toSol ? 9 : 6;
  const outSym = toSol ? 'SOL' : 'USDC';

  const held = await splRaw(address, token);
  if (!held || held <= 0n) throw new Error('you do not hold that token on Solana');
  const inDec = await splDecimals(token);
  const amountInRaw = (held * BigInt(Math.round(percent))) / 100n;
  if (amountInRaw <= 0n) throw new Error('that percentage rounds to nothing of what you hold');

  const q = await flash.quote({ chainRef: 'solana', tokenIn: token, tokenOut: tokenOut === 'native' ? WSOL_MINT : tokenOut, amountInRaw, funderAddress: address });
  if (!q || !q.outRaw) throw new Error('no Flash route right now');
  const symbol = (await solSymbol(token)) || token.slice(0, 6);

  const req = signreq.park({
    tgId, kind: 'solana-swap', chainId: null,
    intent: {
      side: 'sell', chainRef: 'solana', tokenIn: token, tokenOut,
      amountInRaw: amountInRaw.toString(), pct: percent, symbol,
      settleTo: toSol ? 'sol' : 'usdc',
      review_out_raw: q.outRaw.toString(), outDec, inDec,
    },
  });

  return {
    id: req.id, expiresAt: req.expires_at, side: 'sell', chain: 'Solana', svm: true,
    symbol, spend: human(amountInRaw, inDec) + ' ' + symbol + ' (' + percent + '%)',
    receive: 'about ' + human(q.outRaw, outDec) + ' ' + outSym, warnings: null,
    quotes: { engine: 'flash', impactPct: q.impactPct != null ? Number(q.impactPct) : null, all: [{ engine: 'flash', out: human(q.outRaw, outDec), best: true }] },
  };
}

// Runs a parked Solana swap ONCE under the member's delegation. acquireSettlement
// is the replay lock: only the caller that flips pending -> settling proceeds.
async function executeSolanaSwap({ tgId, id }) {
  if (!(delegation.enabled() && delegation.isActive(tgId))) throw new Error('turn on in-Telegram signing to trade on Solana');
  const acq = signreq.acquireSettlement(id, tgId);
  if (!acq || acq.ok === false) throw new Error((acq && acq.reason) || 'this request is no longer pending');
  try {
    const req = signreq.get(id);
    if (!req || (req.kind !== 'solana-swap' && req.kind !== 'solana-transfer')) throw new Error('not a Solana request');
    const intent = req.intent;
    const address = members.get(tgId).sol_address;
    if (!address) throw new Error('no Solana wallet on your account');
    let userId = (members.get(tgId) || {}).cdp_user_id || null;
    if (!userId) { try { const found = await cdpServer.findBySubject(tgId); userId = found && (found.userId || found.user_id); } catch (e) { /* fall through */ } }
    if (!userId) throw new Error('no CDP user for this member');

    if (req.kind === 'solana-transfer') {
      const { CdpClient } = require('@coinbase/cdp-sdk');
      const cdp = new CdpClient();
      const res = await cdp.endUser.sendSolanaAsset({ userId, address, asset: intent.asset, to: intent.to, amount: String(intent.amountRaw), network: 'solana', createRecipientAta: true });
      const txid = res && (res.transactionSignature || res.signature || res.txid || res.transactionHash) || null;
      try { require('./member-notify').push(tgId, { type: 'sent', icon: '\u2191', title: 'Sent ' + (intent.symbol || 'SOL'), body: 'to ' + String(intent.to).slice(0, 6) + '\u2026' + String(intent.to).slice(-4) }); } catch (e) { /* notif best-effort */ }
      signreq.markSigned(id, { txid });
      return { txid, symbol: intent.symbol, side: 'withdraw', chain: 'Solana' };
    }

    const q = await flash.quote({ chainRef: 'solana', tokenIn: intent.tokenIn === 'native' ? WSOL_MINT : intent.tokenIn, tokenOut: intent.tokenOut === 'native' ? WSOL_MINT : intent.tokenOut, amountInRaw: BigInt(intent.amountInRaw), funderAddress: address });
    if (!q) throw new Error('Flash Solana quote expired or unavailable');
    const cdp = new (require('@coinbase/cdp-sdk').CdpClient)();
    const signed = await cdp.endUser.signSolanaMessage({ userId, address, message: Buffer.from(q.meta.svm.orderMessage, 'utf8').toString('base64') });
    const rawSig = signed && (signed.signature || signed.signedMessage || signed);
    if (!rawSig) throw new Error('CDP returned no Solana message signature');
    const sigBytes = /^[0-9a-fA-F]{128}$/.test(String(rawSig)) ? Buffer.from(String(rawSig), 'hex') : Buffer.from(String(rawSig), 'base64');
    if (sigBytes.length !== 64) throw new Error('CDP returned an invalid Ed25519 signature');
    const ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
    let n = BigInt('0x' + sigBytes.toString('hex')), userSignature = '';
    while (n > 0n) { userSignature = ALPHABET[Number(n % 58n)] + userSignature; n /= 58n; }
    for (const b of sigBytes) { if (b !== 0) break; userSignature = '1' + userSignature; }
    let svmSponsoredDelegateTx;
    if (q.meta.svm.sponsoredDelegateTx) {
      const signedDelegate = await cdp.endUser.signSolanaTransaction({
        userId, address, transaction: q.meta.svm.sponsoredDelegateTx,
      });
      svmSponsoredDelegateTx = signedDelegate && (signedDelegate.signedTransaction || signedDelegate.signature);
      if (!svmSponsoredDelegateTx) throw new Error('CDP returned no signed Flash delegation transaction');
    }
    const result = await flash.submitSigned(q, { userSignature, svmSponsoredDelegateTx });
    const txid = result.transactionId || result.txid || result.orderId || result.order_id;

    try {
      if (intent.side === 'buy') {
        const outDec = intent.outDec || 9;
        positions.record({ chain: 'solana', chainId: null, token: intent.tokenOut, symbol: intent.symbol || '', usdCost: intent.usd || 0, tokens: Number(wallet.formatUnits(BigInt(q.outRaw), outDec)), tx: result.txid, engine: 'flash', owner: tgId });
        tradeRefs.recordFill({ tgId, side: 'buy', token: intent.tokenOut, usd: intent.usd, feeBps: memberFees.feeBps(), tx: result.txid, engine: 'flash' });
      } else {
        const inDec = intent.inDec || 9;
        const usdProceeds = intent.settleTo === 'usdc' ? Number(q.outRaw) / 1e6 : 0;
        positions.recordSell({ chain: 'solana', chainId: null, token: intent.tokenIn, symbol: intent.symbol || '', usdProceeds, tokens: Number(wallet.formatUnits(BigInt(intent.amountInRaw), inDec)), tx: result.txid, engine: 'flash', owner: tgId });
        tradeRefs.recordFill({ tgId, side: 'sell', token: intent.tokenIn, usd: usdProceeds, feeBps: memberFees.feeBps(), tx: result.txid, engine: 'flash' });
      }
    } catch (e) { /* the ledger row is best-effort, never fail a filled trade */ }

    try { memberCaps.release(tgId, id); } catch (e) { /* reservation may not exist for sells */ }
    signreq.markSigned(id, { txid: result.txid });
    fillLog.write({ type: 'solana_fill', tgId, reqId: id, side: intent.side, chain: 'solana', engine: 'flash', tokenIn: intent.tokenIn, tokenOut: intent.tokenOut, amountInRaw: intent.amountInRaw, outRaw: q.outRaw, usd: intent.usd, tx: result.txid });
    return { txid, symbol: intent.symbol, side: intent.side, chain: 'Solana' };
  } catch (e) {
    try { signreq.markFailed(id, e.message); } catch (_) { /* ignore */ }
    fillLog.write({ type: 'solana_fail', tgId, reqId: id, chain: 'solana', error: String(e.message).slice(0, 300) });
    throw e;
  }
}

module.exports = { buildBuy, buildSell, buildDca, buildResting, executeSolanaSwap };
