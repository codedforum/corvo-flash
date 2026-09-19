// Shared styled trade-result card (SVG → PNG via rsvg-convert). Used after every
// auto-buy and every /sell so results come back as a branded card, not plain text.
const fs = require('fs');
const { execFileSync } = require('child_process');

const esc = (s) => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const num = (n, d = 2) => Number(n || 0).toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d });
const compact = (n) => { const a = Math.abs(Number(n) || 0); if (a >= 1e9) return (n / 1e9).toFixed(2) + 'B'; if (a >= 1e6) return (n / 1e6).toFixed(2) + 'M'; if (a >= 1e3) return (n / 1e3).toFixed(2) + 'K'; return num(n, a < 1 ? 4 : 2); };
const C = { base: { c: '#0052FF', chip: '🔵 Base' }, solana: { c: '#9945FF', chip: '◎ Solana' }, robinhood: { c: '#f97316', chip: '🪶 Robinhood' } };

function T(x, y, s, o = {}) {
  return `<text x="${x}" y="${y}" font-family="${o.mono ? "'DejaVu Sans Mono',monospace" : "'DejaVu Sans','Segoe UI',sans-serif"}" font-size="${o.size || 30}" font-weight="${o.w || 400}" fill="${o.fill || '#e8edf2'}"${o.anchor ? ` text-anchor="${o.anchor}"` : ''}${o.ls ? ` letter-spacing="${o.ls}"` : ''}>${s}</text>`;
}

// opts: { side:'BUY'|'SELL', symbol, chain, amount(human token), counter(str e.g '0.0172 ETH'),
//         usd(number), sub(optional line e.g price), pnl(optional {value,pct}) }
function tradeSvg(o) {
  const ch = C[o.chain] || { c: '#f97316', chip: o.chain || '' };
  const buy = o.side === 'BUY';
  const accent = buy ? '#22c55e' : '#f97316';
  // Each value row is 56px. The old fixed heights put the footer through the
  // Price row (and through PnL when present), which made an otherwise useful
  // confirmation/result card hard to read on Telegram.
  const W = 900; const H = o.pnl ? 610 : 550; const pad = 52;
  const rows = [];
  rows.push(T(pad, 96, buy ? 'BOUGHT' : 'SOLD', { size: 44, w: 700, fill: accent, ls: 3 }));
  // chain chip pill
  rows.push(`<rect x="${W - pad - 250}" y="60" width="250" height="46" rx="23" fill="${ch.c}22" stroke="${ch.c}" stroke-opacity="0.55"/>`);
  rows.push(T(W - pad - 125, 90, ch.chip, { size: 24, w: 600, fill: ch.c, anchor: 'middle' }));
  // token symbol hero
  rows.push(T(pad, 190, esc(o.symbol), { size: 60, w: 700, fill: '#fff' }));
  rows.push(T(pad, 232, buy ? 'acquired' : 'realized', { size: 22, fill: '#8aa0b2', ls: 1 }));
  // amount + counter block
  let y = 300;
  const line = (label, val, vc) => { rows.push(T(pad, y, label, { size: 24, fill: '#8aa0b2' })); rows.push(T(W - pad, y, val, { size: 30, w: 700, fill: vc || '#e8edf2', anchor: 'end', mono: true })); y += 56; };
  line(buy ? 'Tokens received' : 'Tokens sold', compact(o.amount) + '  ' + esc(o.symbol));
  line(buy ? 'Paid' : 'Received', o.counter + (o.usd ? `  ($${num(o.usd)})` : ''), accent);
  if (o.sub) line('Price', o.sub);
  if (o.pnl) {
    const g = o.pnl.value >= 0; const gc = g ? '#22c55e' : '#ef4444';
    line('Realized PnL', (g ? '+' : '-') + '$' + num(Math.abs(o.pnl.value)) + `  ${g ? '+' : '-'}${o.pnl.mult.toFixed(2)}x  (${g ? '+' : ''}${o.pnl.pct.toFixed(0)}%)`, gc);
  }
  rows.push(`<line x1="${pad}" y1="${H - 66}" x2="${W - pad}" y2="${H - 66}" stroke="#1f2a35"/>`);
  rows.push(T(pad, H - 32, '@RuntimeFlashBot, on-chain execution', { size: 20, fill: '#6f8496' }));
  rows.push(T(W - pad, H - 32, new Date().toISOString().slice(0, 16).replace('T', ' ') + ' UTC', { size: 19, fill: '#6f8496', anchor: 'end', mono: true }));
  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">
 <defs>
  <linearGradient id="bg" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#121b25"/><stop offset="0.48" stop-color="#090e14"/><stop offset="1" stop-color="#05080d"/></linearGradient>
  <radialGradient id="bloom" cx="0.06" cy="0.04" r="0.95"><stop offset="0" stop-color="${accent}" stop-opacity="0.25"/><stop offset="0.45" stop-color="${accent}" stop-opacity="0.045"/><stop offset="1" stop-color="${accent}" stop-opacity="0"/></radialGradient>
  <linearGradient id="glass" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#ffffff" stop-opacity="0.075"/><stop offset="0.08" stop-color="#17212c" stop-opacity="0.88"/><stop offset="1" stop-color="#0b1118" stop-opacity="0.92"/></linearGradient>
  <linearGradient id="rail" x1="0" y1="0" x2="1" y2="0"><stop offset="0" stop-color="${accent}"/><stop offset="0.7" stop-color="${accent}" stop-opacity="0.5"/><stop offset="1" stop-color="${accent}" stop-opacity="0"/></linearGradient>
  <filter id="lift" x="-10%" y="-10%" width="120%" height="130%"><feDropShadow dx="0" dy="16" stdDeviation="18" flood-color="#000000" flood-opacity="0.48"/></filter>
 </defs>
 <rect width="${W}" height="${H}" fill="url(#bg)"/>
 <rect width="${W}" height="${H}" fill="url(#bloom)"/>
 <circle cx="${W - 24}" cy="42" r="154" fill="${ch.c}" opacity="0.055"/>
 <rect x="22" y="20" width="${W - 44}" height="${H - 40}" rx="30" fill="url(#glass)" stroke="#ffffff" stroke-opacity="0.10" filter="url(#lift)"/>
 <rect x="22" y="20" width="${W - 44}" height="6" rx="3" fill="url(#rail)"/>
 ${rows.join('\n ')}
</svg>`;
}

// Sell-all summary card. rows: [{ok, symbol, chain, got(str)}], totalUsd
function sellAllSvg(items, totalUsd) {
  const W = 900; const pad = 52; const H = 200 + items.length * 52 + 70;
  const rows = [];
  rows.push(T(pad, 96, 'SOLD ALL', { size: 44, w: 700, fill: '#f97316', ls: 3 }));
  rows.push(T(pad, 150, `${items.filter(i => i.ok).length}/${items.length} positions cleared`, { size: 26, fill: '#c9d6e2' }));
  if (totalUsd) rows.push(T(W - pad, 96, '~$' + num(totalUsd), { size: 40, w: 700, fill: '#22c55e', anchor: 'end', mono: true }));
  let y = 214;
  for (const it of items) {
    const ch = C[it.chain] || { c: '#f97316' };
    rows.push(`<rect x="${pad}" y="${y - 30}" width="8" height="38" rx="4" fill="${ch.c}"/>`);
    rows.push(T(pad + 26, y, (it.ok ? '✅ ' : '❌ ') + esc(it.symbol), { size: 27, w: 600, fill: it.ok ? '#e8edf2' : '#8aa0b2' }));
    rows.push(T(W - pad, y, it.ok ? esc(it.got) : 'failed', { size: 25, fill: it.ok ? '#22c55e' : '#ef4444', anchor: 'end', mono: true }));
    y += 52;
  }
  rows.push(T(pad, H - 28, '@RuntimeFlashBot, on-chain execution', { size: 20, fill: '#6f8496' }));
  rows.push(T(W - pad, H - 28, new Date().toISOString().slice(0, 16).replace('T', ' ') + ' UTC', { size: 19, fill: '#6f8496', anchor: 'end', mono: true }));
  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">
 <defs><linearGradient id="bg" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#1b1511"/><stop offset="0.45" stop-color="#0b1016"/><stop offset="1" stop-color="#05080d"/></linearGradient><radialGradient id="bloom" cx="0.06" cy="0" r="0.9"><stop offset="0" stop-color="#f97316" stop-opacity="0.22"/><stop offset="1" stop-color="#f97316" stop-opacity="0"/></radialGradient><linearGradient id="glass" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#ffffff" stop-opacity="0.08"/><stop offset="1" stop-color="#0b1118" stop-opacity="0.92"/></linearGradient><filter id="lift" x="-10%" y="-10%" width="120%" height="130%"><feDropShadow dx="0" dy="16" stdDeviation="18" flood-opacity="0.48"/></filter></defs>
 <rect width="${W}" height="${H}" fill="url(#bg)"/><rect width="${W}" height="${H}" fill="url(#bloom)"/><rect x="22" y="20" width="${W - 44}" height="${H - 40}" rx="30" fill="url(#glass)" stroke="#ffffff" stroke-opacity="0.10" filter="url(#lift)"/><rect x="22" y="20" width="${W - 44}" height="6" rx="3" fill="#f97316"/>
 ${rows.join('\n ')}
</svg>`;
}

// Per-token PnL detail. o: { symbol, chain, held, value, avgEntry, curPrice, invested,
// buys, proceeds, sold, sells, realized, unreal, unrealPct, unrealMult, total }
function positionSvg(o) {
  const ch = C[o.chain] || { c: '#f97316', chip: o.chain || '' };
  const hasSells = o.sells > 0;
  const W = 900, pad = 52;
  const price = (p) => p == null ? 'n/a' : (p >= 0.01 ? '$' + num(p, 4) : '$' + Number(p).toExponential(2));
  const rows = [];
  rows.push(T(pad, 74, 'POSITION', { size: 22, fill: '#8aa0b2', ls: 3 }));
  rows.push(T(pad, 138, esc(o.symbol), { size: 54, w: 700, fill: '#fff' }));
  rows.push(`<rect x="${W - pad - 250}" y="52" width="250" height="46" rx="23" fill="${ch.c}22" stroke="${ch.c}" stroke-opacity="0.55"/>`);
  rows.push(T(W - pad - 125, 82, ch.chip, { size: 24, w: 600, fill: ch.c, anchor: 'middle' }));
  let y = 200;
  const line = (label, val, vc) => { rows.push(T(pad, y, label, { size: 23, fill: '#8aa0b2' })); rows.push(T(W - pad, y, val, { size: 26, w: 600, fill: vc || '#e8edf2', anchor: 'end', mono: true })); y += 48; };
  line('Holdings', compact(o.held) + (o.value != null ? '   ($' + num(o.value) + ')' : '   (~)'));
  line('Avg entry', price(o.avgEntry) + ' /tok');
  line('Current price', price(o.curPrice) + ' /tok');
  line('Invested', '$' + num(o.invested) + '   (' + o.buys + ' buy' + (o.buys === 1 ? '' : 's') + ')');
  if (hasSells) line('Sold', '$' + num(o.proceeds) + '   (' + o.sells + ' sell' + (o.sells === 1 ? '' : 's') + ')');
  rows.push(`<line x1="${pad}" y1="${y - 12}" x2="${W - pad}" y2="${y - 12}" stroke="#1f2a35"/>`);
  y += 10;
  const pnlLine = (label, val, vc, big) => { rows.push(T(pad, y, label, { size: big ? 27 : 23, w: big ? 700 : 400, fill: big ? '#f8b37a' : '#8aa0b2' })); rows.push(T(W - pad, y, val, { size: big ? 30 : 26, w: 700, fill: vc, anchor: 'end', mono: true })); y += big ? 56 : 48; };
  if (o.unreal != null) { const ug = o.unreal >= 0; pnlLine('Unrealized', (ug ? '+' : '-') + '$' + num(Math.abs(o.unreal)) + `  ${ug ? '+' : '-'}${o.unrealMult.toFixed(2)}x (${ug ? '+' : ''}${o.unrealPct.toFixed(0)}%)`, ug ? '#22c55e' : '#ef4444'); }
  else pnlLine('Unrealized', 'quote n/a', '#6f8496');
  if (hasSells && o.realized != null) { const rg = o.realized >= 0; pnlLine('Realized', (rg ? '+' : '-') + '$' + num(Math.abs(o.realized)), rg ? '#22c55e' : '#ef4444'); }
  if (o.total != null) { const g = o.total >= 0; pnlLine('Total PnL', (g ? '+' : '-') + '$' + num(Math.abs(o.total)), g ? '#22c55e' : '#ef4444', true); }
  const H = y + 46;
  rows.push(`<line x1="${pad}" y1="${H - 52}" x2="${W - pad}" y2="${H - 52}" stroke="#1f2a35"/>`);
  rows.push(T(pad, H - 20, '@RuntimeFlashBot, position snapshot', { size: 20, fill: '#6f8496' }));
  rows.push(T(W - pad, H - 20, new Date().toISOString().slice(0, 16).replace('T', ' ') + ' UTC', { size: 19, fill: '#6f8496', anchor: 'end', mono: true }));
  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">
 <defs><linearGradient id="bg" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#111b27"/><stop offset="0.48" stop-color="#090e14"/><stop offset="1" stop-color="#05080d"/></linearGradient><radialGradient id="bloom" cx="0.06" cy="0" r="0.9"><stop offset="0" stop-color="${ch.c}" stop-opacity="0.22"/><stop offset="1" stop-color="${ch.c}" stop-opacity="0"/></radialGradient><linearGradient id="glass" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#ffffff" stop-opacity="0.08"/><stop offset="1" stop-color="#0b1118" stop-opacity="0.92"/></linearGradient><filter id="lift" x="-10%" y="-10%" width="120%" height="130%"><feDropShadow dx="0" dy="16" stdDeviation="18" flood-opacity="0.48"/></filter></defs>
 <rect width="${W}" height="${H}" fill="url(#bg)"/><rect width="${W}" height="${H}" fill="url(#bloom)"/><rect x="22" y="20" width="${W - 44}" height="${H - 40}" rx="30" fill="url(#glass)" stroke="#ffffff" stroke-opacity="0.10" filter="url(#lift)"/><rect x="22" y="20" width="${W - 44}" height="6" rx="3" fill="${ch.c}"/>
 ${rows.join('\n ')}
</svg>`;
}

function toPng(svg) {
  const tmp = `/tmp/fam-trade-${Date.now()}-${Math.floor(process.hrtime()[1] % 1e6)}`;
  fs.writeFileSync(tmp + '.svg', svg);
  execFileSync('rsvg-convert', ['-w', '900', tmp + '.svg', '-o', tmp + '.png']);
  const buf = fs.readFileSync(tmp + '.png');
  try { fs.unlinkSync(tmp + '.svg'); fs.unlinkSync(tmp + '.png'); } catch {}
  return buf;
}
const renderTradeCard = (o) => toPng(tradeSvg(o));
const renderSellAll = (items, totalUsd) => toPng(sellAllSvg(items, totalUsd));
const renderPositionCard = (o) => toPng(positionSvg(o));
module.exports = { renderTradeCard, renderSellAll, renderPositionCard };
