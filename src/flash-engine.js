// src/lib/engines/flash.js, Definitive Flash adapter.
//
// Flash is the only engine here that does NOT return a broadcastable
// transaction. It returns an EIP-712 payload the funder must sign. That is
// exactly why Flash execution was never switched on for Corvo or PipTradeDex:
// both sign through CDP, which cannot produce this signature. The fam bot holds
// its own key, so it can sign locally with viem. This adapter is the first place
// in the stack where a Flash order can actually be placed.
//
// Envelope verified live 2026-08-11:
//   quote -> { quoteId, bridgeQuoteId, from, to, fees, estimatedPriceImpact,
//              wrap, evm: { approveTx, permitTypedData, orderTypedData }, svm }
//  , orderTypedData is a JSON STRING, not an object.
//  , Its types include EIP712Domain, which viem rejects, so it is stripped.
//  , domain.chainId is a STRING, and viem wants a number.
//  , permitTypedData is an empty STRING when unused, not null.
//  , primaryType is FlashOrder, verifying contract 0x5d000008...368f78.
//
// Direction mapping: every swap is expressed as side="sell" of the input asset,
// so target=tokenIn and contra=tokenOut. Verified both ways, `from.asset` comes
// back as "target" and `to.asset` as "contra". qty is a HUMAN DECIMAL amount.

const chains = require('../chains');
const wallet = require('../wallet');

const API = process.env.FLASH_API_BASE || 'https://flash.definitive.fi/v1';
const TIMEOUT_MS = Number(process.env.FLASH_TIMEOUT_MS || 25000);
// The bot trades its own treasury, so there is nobody to charge. A non-zero fee
// here would also make Flash lose unfairly against Kyber, whose amountOut is
// already net. Keep both at zero and the comparison is like for like.
const FEE_BPS = String(process.env.FLASH_FEE_BPS || '0');
const SUBMIT_ENABLED = () => String(process.env.FLASH_SUBMIT_ENABLED || 'false').toLowerCase() === 'true';

const name = 'flash';

function supports(chainRef) {
  const c = chains.getChain(chainRef);
  return !!(c && c.flashSlug && process.env.FLASH_API_KEY);
}

// Quoting and executing are separate capabilities here. Flash can always quote,
// which is useful for comparison, but it can only EXECUTE once submission is
// switched on. The router must know the difference, otherwise a Flash win with
// submission disabled would throw instead of falling through to Kyber.
function canExecute(chainRef) {
  const c = chains.getChain(chainRef);
  // Treasury execution on SVM is not enabled here; member execution uses
  // submitSigned() with a CDP end-user signature and an active delegation.
  if (c && c.svm) return false;
  return SUBMIT_ENABLED();
}

async function mintDecimals(mint) {
  const c = chains.getChain('solana');
  if (!c) throw new Error('Solana is not configured');
  if (mint === c.wrappedNative) return 9;
  if (c.usdc && mint === c.usdc.addr) return c.usdc.dec;
  const info = await wallet.solConnection().getParsedAccountInfo(new (require('@solana/web3.js').PublicKey)(mint));
  const dec = info && info.value && info.value.data && info.value.data.parsed && info.value.data.parsed.info && info.value.data.parsed.info.decimals;
  if (dec == null) throw new Error('could not resolve Solana mint decimals');
  return Number(dec);
}


async function search(query, chain = 'solana') {
  const qs = new URLSearchParams({ query: String(query), chain: String(chain), limit: '5' });
  const { status, j } = await api('/search?' + qs.toString());
  if (!ok2xx(status)) return [];
  return Array.isArray(j) ? j : ((j && (j.assets || j.data || j.results)) || []);
}

async function api(path, { method = 'GET', body } = {}) {
  const key = process.env.FLASH_API_KEY;
  if (!key) throw new Error('FLASH_API_KEY not set');
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), TIMEOUT_MS);
  try {
    const r = await fetch(API + path, {
      method,
      signal: ctl.signal,
      // The key goes in a header only. It is never logged and never returned.
      headers: { 'x-definitive-api-key': key, 'content-type': 'application/json' },
      body: body ? JSON.stringify(body) : undefined,
    });
    const j = await r.json().catch(() => null);
    return { status: r.status, j };
  } finally { clearTimeout(t); }
}

function errMsg(j) {
  if (!j) return 'no response';
  if (typeof j.error === 'string') return j.error;
  if (j.error && j.error.message) {
    // Validation failures put the useful part in `details`, keyed by field.
    // Without it the message is just "Request validation failed", which says
    // nothing about WHICH field is wrong.
    const d = j.error.details;
    if (d && typeof d === 'object') {
      const bits = Object.entries(d).map(([k, v]) => `${k}: ${Array.isArray(v) ? v.join(', ') : v}`);
      if (bits.length) return j.error.message + ' (' + bits.join('; ') + ')';
    }
    return j.error.message;
  }
  return JSON.stringify(j).slice(0, 200);
}

// Flash is not uniformly 200: /order answers 201. Treat any 2xx as success
// rather than pinning each call site to one exact code.
function ok2xx(status) { return status >= 200 && status < 300; }

// Flash settles in ERC20 terms. On Robinhood it rejects native ETH outright
// (both the zero address and the 0xEeee sentinel return InvalidArgument,
// verified 2026-08-11). Rather than branch per chain on a property we have only
// verified on one, every native leg is expressed as wrapped native and the wrap
// or unwrap is flagged for the executor. Wrapping is cheap and always correct.
function resolveAsset(c, token) {
  if (!wallet.isNative(token)) return { addr: token, wrapped: false };
  if (!c.wrappedNative) return null;
  return { addr: c.wrappedNative, wrapped: true };
}

// Flash returns human decimals and can carry MORE fractional digits than the
// token has. parseUnits rejects that, so truncate rather than round. This is the
// unit trap that would otherwise silently mis-rank Flash against Kyber.
function toRawUnits(human, dec) {
  const s = String(human);
  const [i, f = ''] = s.split('.');
  const frac = f.slice(0, dec).padEnd(dec, '0');
  return BigInt(i || '0') * (10n ** BigInt(dec)) + BigInt(frac || '0');
}

async function quote({ chainRef, tokenIn, tokenOut, amountInRaw, orderType = 'market', extra = {}, feeBpsOverride = null, funderAddress = null }) {
  const c = chains.getChain(chainRef);
  if (!supports(chainRef)) return null;

  const inA = resolveAsset(c, tokenIn);
  const outA = resolveAsset(c, tokenOut);
  if (!inA || !outA) return null;

  // Solana has no EVM client. Flash still quotes SVM assets, so resolve SPL
  // decimals from the chain registry/mint account instead of wallet.decimals().
  const assetDecimals = async (addr) => {
    if (c.svm) {
      if (addr === c.wrappedNative) return 9;
      if (c.usdc && addr === c.usdc.addr) return c.usdc.dec;
      return mintDecimals(addr);
    }
    return wallet.decimals(chainRef, addr);
  };
  const decIn = await assetDecimals(inA.addr);
  const decOut = await assetDecimals(outA.addr);
  const qty = wallet.formatUnits(BigInt(amountInRaw), decIn);

  const body = {
    orderType,
    side: 'sell',
    qty,
    targetChain: c.flashSlug,
    targetAsset: inA.addr,
    contraChain: c.flashSlug,
    contraAsset: outA.addr,
    // Treasury calls use the hot wallet. Member calls MUST supply the member
    // address, otherwise Flash binds its typed order to the wrong signer.
    funderAddress: funderAddress || (c.svm ? wallet.solAddress() : wallet.address()),
    // Flash defaults maxPriceImpact to 0.05. Left alone it silently declines
    // any thin-pool trade above 5%, so Flash would vanish from the comparison
    // exactly where a second opinion matters most, and Kyber would win by
    // default rather than on merit. Align it with our own threshold and let
    // preflight be the real gate.
    maxPriceImpact: String(Math.max(0.05, Number(process.env.HIGH_IMPACT_PCT || 8) / 100)),
    ...extra,
  };
  // 🚨 Flash validates flashIntegratorFeeBps as "a positive decimal", so sending
  // "0" is a 400 and returns NO quote at all. A zero fee means OMITTING the
  // field. Sending it as a number is also a 400, it must be a string. Getting
  // this wrong silently removes Flash from every comparison in the bot.
  // 🚨 Per call, not module level. A module level fee is charged to EVERY
  // quote including the operator's, which breaks the rule that only members
  // pay. And it must be OMITTED when zero: Flash rejects "0" as "must be a
  // positive decimal" and returns no quote at all.
  const bps = feeBpsOverride != null ? String(feeBpsOverride) : String(FEE_BPS);
  if (Number(bps) > 0) body.flashIntegratorFeeBps = bps;

  const { status, j } = await api('/quote', { method: 'POST', body });
  if (!ok2xx(status) || !j || !j.to) {
    // Flash reports its undocumented per-chain minimum only on rejection. Learn
    // from it so the preflight can refuse next time before we sign anything.
    chains.flashNoteMin(c.flashSlug, errMsg(j));
    return null;
  }

  const outRaw = toRawUnits(j.to.amount, decOut);
  const impact = j.estimatedPriceImpact != null ? Number(j.estimatedPriceImpact) * 100 : null;

  return {
    engine: name,
    chainId: c.id,
    chainRef,
    tokenIn, tokenOut,
    amountInRaw: BigInt(amountInRaw),
    outRaw,
    outUsd: Number(j.to.notional) || null,
    inUsd: Number(j.from.notional) || null,
    impactPct: impact,
    // Flash quotes its fee into the output already, so gas is the only extra.
    gasUsd: 0,
    settlesTo: outA.addr,
    needsWrap: inA.wrapped,
    needsUnwrap: outA.wrapped,
    meta: {
      quoteId: j.quoteId,
      bridgeQuoteId: j.bridgeQuoteId,
      evm: j.evm, svm: j.svm, wrap: j.wrap,
      fees: j.fees,
      decIn, decOut,
      inAddr: inA.addr, outAddr: outA.addr,
      // 🚨 POST /order is NOT an echo of quoteId plus a signature. It re-requires
      // the WHOLE order description: targetChain, contraChain, targetAsset,
      // contraAsset, side, qty, orderType, funderAddress, userSignature. Keep
      // the exact quote body so submission cannot drift from what was signed.
      body,
      // An attached bracket (take-profit + stop-loss pair) echoes salt,
      // deadline, signedMaxFromAmount and the pair's own typed data here.
      // Submit must send them back verbatim plus a second funder signature.
      attachedBracket: j.attachedBracket || null,
    },
  };
}

// Strip EIP712Domain (viem derives it from `domain`) and coerce chainId to a
// number. Returns the args viem's signTypedData expects.
function parseTypedData(raw) {
  const td = typeof raw === 'string' ? JSON.parse(raw) : raw;
  const types = { ...td.types };
  delete types.EIP712Domain;
  const domain = { ...td.domain };
  if (domain.chainId != null) domain.chainId = Number(domain.chainId);
  return { domain, types, primaryType: td.primaryType, message: td.message };
}

async function execute(q, { onProgress } = {}) {
  if (!SUBMIT_ENABLED()) throw new Error('flash submit disabled (FLASH_SUBMIT_ENABLED)');
  const c = chains.getChain(q.chainRef);
  if (c.svm) throw new Error('flash Solana execution is not enabled until the SVM signing payload is verified');

  const evm = q.meta.evm || {};
  if (!evm.orderTypedData) throw new Error('flash quote carried no orderTypedData');
  const ab = q.meta.attachedBracket || null;

  // 1. Wrap native in, if this leg needs wrapped units to spend.
  if (q.needsWrap) {
    if (onProgress) onProgress('wrapping');
    await wallet.ensureWrapped(q.chainRef, q.amountInRaw);
  }

  // 2. Approve the Flash allowance contract using the calldata Flash supplied.
  if (evm.approveTx && evm.approveTx.to && evm.approveTx.data) {
    if (onProgress) onProgress('approving');
    await wallet.send(q.chainRef, { to: evm.approveTx.to, data: evm.approveTx.data, value: 0n });
  }

  // 2b. The bracket pair sells the RECEIVED asset, so it may carry its own
  // allowance calldata. Same on-chain gas requirement as the entry approve.
  if (ab && ab.evm && ab.evm.approveTx && ab.evm.approveTx.to && ab.evm.approveTx.data) {
    if (onProgress) onProgress('approving bracket asset');
    await wallet.send(q.chainRef, { to: ab.evm.approveTx.to, data: ab.evm.approveTx.data, value: 0n });
  }

  // 3. Sign the order. This is the step CDP could not do.
  if (onProgress) onProgress('signing');
  const td = parseTypedData(evm.orderTypedData);
  const userSignature = await wallet.account().signTypedData(td);

  let evmPermitSignature;
  if (evm.permitTypedData && String(evm.permitTypedData).length > 2) {
    const ptd = parseTypedData(evm.permitTypedData);
    evmPermitSignature = await wallet.account().signTypedData(ptd);
  }

  // 3b. A bracketed order signs TWICE with the funder wallet: the entry payload
  // above, and the attachedBracket pair payload here. Both ride one submit.
  let bracketSignature;
  let bracketPermitSignature;
  if (ab && ab.evm && ab.evm.orderTypedData) {
    if (onProgress) onProgress('signing bracket');
    bracketSignature = await wallet.account().signTypedData(parseTypedData(ab.evm.orderTypedData));
    if (ab.evm.permitTypedData && String(ab.evm.permitTypedData).length > 2) {
      bracketPermitSignature = await wallet.account().signTypedData(parseTypedData(ab.evm.permitTypedData));
    }
  }

  // 4. Submit through the shared submitter, so the treasury path and the member
  // path cannot drift apart in how an order is posted.
  if (onProgress) onProgress('submitting');
  const j = await submitSigned(q, { userSignature, evmPermitSignature });
  return afterSubmit(q, j, { onProgress });
}

/**
 * Posts an order that has ALREADY been signed.
 *
 * Split out so a member can sign the typed data on their own device and this
 * process can post the result, holding no key at any point.
 *
 * 🚨 POST /order is NOT an echo of { quoteId, userSignature }. It re-requires
 * the whole order description, so the exact quote body is spread back in.
 */
async function submitSigned(q, { userSignature, evmPermitSignature, bracketSignature, bracketPermitSignature, svmSponsoredDelegateTx } = {}) {
  if (!SUBMIT_ENABLED()) throw new Error('flash submit disabled (FLASH_SUBMIT_ENABLED)');
  const evm = (q.meta && q.meta.evm) || {};
  const svm = (q.meta && q.meta.svm) || {};
  const c = chains.getChain(q.chainRef);
  if (!userSignature) throw new Error('no signature supplied');

  const body = { ...q.meta.body, userSignature };
  if (c && c.svm) {
    if (!svm.nonce || !svm.deadline) throw new Error('Flash Solana quote missing nonce/deadline');
    body.svmNonce = String(svm.nonce);
    body.svmDeadline = String(svm.deadline);
    if (svm.sponsoredDelegateTx) {
      if (!svmSponsoredDelegateTx) throw new Error('Flash Solana sponsored delegation transaction must be signed first');
      body.svmSponsoredDelegateTx = svmSponsoredDelegateTx;
    } else if (svm.delegateIx) {
      throw new Error('Flash Solana quote requires a delegate instruction; no sponsored signing path is available');
    }
  } else {
    body.evmOrderTypedData = evm.orderTypedData;
  }

  // An attached bracket rides the same submit: the legs from the quote body
  // plus the echo fields (salt, deadline, signedMaxFromAmount) and the pair's
  // own funder signature. Omitting any of these is a 400.
  const ab = q.meta && q.meta.attachedBracket;
  if (ab) {
    if (!bracketSignature) throw new Error('flash bracket quote requires the pair signature');
    const legs = (q.meta.body && q.meta.body.attachedBracket) || {};
    body.attachedBracket = {
      takeProfit: legs.takeProfit,
      stopLoss: legs.stopLoss,
      userSignature: bracketSignature,
      salt: ab.salt,
      deadline: ab.deadline,
      signedMaxFromAmount: ab.signedMaxFromAmount,
    };
    if (bracketPermitSignature) {
      body.attachedBracket.evmPermitTypedData = ab.evm ? ab.evm.permitTypedData : null;
      body.attachedBracket.evmPermitSignature = bracketPermitSignature;
    }
  }
  // 🚨 A cross-chain order comes back with an EMPTY quoteId and is identified by
  // bridgeQuoteId. Sending quoteId: '' is a 400, which made every cross-chain
  // submission impossible.
  if (q.meta.quoteId) body.quoteId = q.meta.quoteId;
  if (evm.permitTypedData) body.evmPermitTypedData = evm.permitTypedData;
  if (evmPermitSignature) body.evmPermitSignature = evmPermitSignature;
  if (q.meta.bridgeQuoteId) body.bridgeQuoteId = q.meta.bridgeQuoteId;

  // 🚨 /order answers 201 Created, not 200. Demanding 200 throws away a
  // successfully placed order and reports a rejection, so the money moves and
  // the code says it failed.
  const { status, j } = await api('/order', { method: 'POST', body });
  if (status < 200 || status >= 300 || !j || !j.orderId) {
    chains.flashNoteMin(c.flashSlug, errMsg(j));
    throw new Error('flash order rejected: ' + errMsg(j));
  }
  return j;
}

/** Everything after a successful post: resting orders return immediately. */
async function afterSubmit(q, j, { onProgress } = {}) {
  // 🚨 A RESTING order is complete when ACCEPTED. Waiting for a terminal state
  // is right for a market order, which fills in seconds, and wrong for a limit,
  // stop or take-profit, which may rest for weeks by design. Blocking here made
  // /limit, /stop and /tp hang for the full poll timeout and then report an
  // error for an order that had been placed perfectly well.
  const orderType = String((q.meta.body && q.meta.body.orderType) || 'market');
  if (orderType !== 'market') {
    if (onProgress) onProgress('resting');
    return { txid: j.orderId, orderId: j.orderId, engine: name, resting: true, orderType };
  }

  // 5. Poll to a terminal state. A submitted market order is not a filled one.
  if (onProgress) onProgress('filling');
  const final = await waitForOrder(j.orderId, { onProgress });

  // 6. Unwrap the proceeds back to native when the caller wanted native out.
  if (q.needsUnwrap && final.filled) {
    try {
      if (onProgress) onProgress('unwrapping');
      const held = await wallet.balanceOf(q.chainRef, c.wrappedNative);
      if (held > 0n) await wallet.unwrapNative(q.chainRef, held);
    } catch (e) { /* proceeds are safe as wrapped, /gas can unwrap later */ }
  }

  return { txid: final.transactionId || j.orderId, orderId: j.orderId, engine: name, detail: final.raw };
}

const TERMINAL = ['FILLED', 'CANCELLED', 'REJECTED', 'TERMINATED'];

// 🚨 GET /orders/{id} REQUIRES funderAddress as a query param. Without it the
// call is a 400 and the poll silently reads as "no detail", so a filled order
// looks like a timeout.
async function orderDetail(orderId, funderAddress) {
  const funder = funderAddress || wallet.address();
  const { status, j } = await api(`/orders/${orderId}?funderAddress=${funder}`);
  if (!ok2xx(status) || !j) return null;
  // 🚨 The single-order response is WRAPPED as { order, fills }, unlike the list
  // endpoint which returns order objects directly. Reading j.status off the
  // envelope yields undefined, so the poll never sees FILLED and every order
  // looks like a timeout. Flatten, and keep the fills alongside.
  const o = j.order || j;
  return { ...o, fills: j.fills || o.fills || [] };
}

async function waitForOrder(orderId, { timeoutMs = 180000, onProgress } = {}) {
  const started = Date.now();
  let last = null;
  while (Date.now() - started < timeoutMs) {
    const d = await orderDetail(orderId);
    if (d) {
      last = d;
      const st = String(d.status || '').replace(/^ORDER_STATUS_/, '');
      if (onProgress) onProgress('status ' + st.toLowerCase());
      if (TERMINAL.includes(st)) {
        if (st !== 'FILLED') throw new Error('flash order ' + st.toLowerCase() + (d.closeReason ? ' (' + d.closeReason + ')' : ''));
        // 🚨 The on-chain hash lives on the FILL, not on the order. Reading
        // d.transactionId returns undefined, and the caller then logs the
        // orderId as if it were a tx hash, so no explorer link ever works.
        const fill = (d.fills || []).find((f) => f && f.transactionId);
        return { filled: true, transactionId: (fill && fill.transactionId) || d.transactionId, raw: d };
      }
    }
    await new Promise((r) => setTimeout(r, 3000));
  }
  return { filled: false, transactionId: last && last.transactionId, raw: last };
}

async function orders(funderAddress, { statuses, pageSize = 50 } = {}) {
  const qs = new URLSearchParams({ funderAddress: funderAddress || wallet.address(), pageSize: String(pageSize) });
  if (statuses) qs.set('statuses', statuses);
  const { status, j } = await api('/orders?' + qs.toString());
  if (!ok2xx(status)) return [];
  return (j && (j.orders || j.data || j)) || [];
}

// 🚨 Cancelling is NOT a bare POST. Flash is non-custodial, so a cancel must be
// SIGNED by the funder: it requires `cancelMessage` plus `userSignature`, an
// EIP-191 personal_sign over an exact plaintext.
//
// The message bytes are fixed by the protocol and were read from its OpenAPI
// spec, not retyped: codepoint 8212 is an EM DASH (U+2014) and the \n is a real
// newline. Do NOT "clean up" that dash to satisfy our own house style, it is
// part of a signed payload and changing one byte invalidates the signature.
function cancelMessageFor(orderId) {
  return `Definitive Flash v1 \u2014 Cancel Order\nOrder: ${orderId}`;
}

async function cancel(orderId) {
  const cancelMessage = cancelMessageFor(orderId);
  const userSignature = await wallet.account().signMessage({ message: cancelMessage });
  return cancelSigned(orderId, { cancelMessage, userSignature });
}

/** Submit a cancellation already signed by a member's device. */
async function cancelSigned(orderId, { cancelMessage, userSignature } = {}) {
  if (!orderId || !cancelMessage || !userSignature) throw new Error('signed cancellation is incomplete');
  const { status, j } = await api('/orders/' + orderId + '/cancel', {
    method: 'POST', body: { cancelMessage, userSignature },
  });
  if (!ok2xx(status)) throw new Error('flash cancel failed: ' + errMsg(j));
  return j || { ok: true };
}

/**
 * Reprice a resting order in place (cancel-and-replace under the same
 * orderId). Like cancel, the update must be SIGNED by the funder: a short
 * plaintext message the wallet's signing prompt can show verbatim.
 *
 * 🚨 Protocol bytes, read from the Flash docs, not retyped: the header uses an
 * EM DASH (U+2014) and NO "v1" (unlike the cancel header). Lines are single
 * \n joined with NO trailing newline, decimals byte-identical to the request
 * body, Limit line above Trigger line. The Issued At stamp must be within
 * 1 minute of server time, so build and sign this immediately before sending.
 */
function updateMessageFor(orderId, patch) {
  const lines = [
    'Definitive Flash \u2014 Update Order',
    `Order: ${orderId}`,
    `Issued At: ${new Date().toISOString()}`,
  ];
  if (patch.limitNotionalPrice != null) lines.push(`Limit Notional Price: ${patch.limitNotionalPrice}`);
  if (patch.limitCrossPrice != null) lines.push(`Limit Cross Price: ${patch.limitCrossPrice}`);
  if (patch.trigger && patch.trigger.notionalPrice != null) {
    lines.push(`Trigger ${patch.trigger.triggerType === 'upper' ? 'Upper' : 'Lower'} Notional Price: ${patch.trigger.notionalPrice}`);
  }
  if (patch.trigger && patch.trigger.crossPrice != null) {
    lines.push(`Trigger ${patch.trigger.triggerType === 'upper' ? 'Upper' : 'Lower'} Cross Price: ${patch.trigger.crossPrice}`);
  }
  return lines.join('\n');
}

async function updateOrder(orderId, patch) {
  const updateMessage = updateMessageFor(orderId, patch);
  const userSignature = await wallet.account().signMessage({ message: updateMessage });
  return updateSigned(orderId, { patch, updateMessage, userSignature });
}

/** Submit a price update already signed by a member's device. */
async function updateSigned(orderId, { patch, updateMessage, userSignature } = {}) {
  if (!orderId || !patch || !updateMessage || !userSignature) throw new Error('signed update is incomplete');
  const { status, j } = await api('/orders/' + orderId, {
    method: 'PATCH', body: { ...patch, updateMessage, userSignature },
  });
  if (!ok2xx(status)) throw new Error('flash update failed: ' + errMsg(j));
  return j || { ok: true };
}

module.exports = {
  name, supports, canExecute, quote, execute, submitSigned, mintDecimals, search,
  orders, orderDetail, cancel, cancelSigned, cancelMessageFor, updateOrder, updateSigned, updateMessageFor, waitForOrder,
  parseTypedData, toRawUnits,
};
