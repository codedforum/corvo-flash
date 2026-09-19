// src/commands/member-copy-cmd.js
// Copytrade config: per tracked wallet set copy mode (off/alert/auto), size
// (fixed $ or a % of their buy), and whether to mirror their exits (sells).

const memberCopy = require('../lib/member-copy');
const tracker = require('../lib/wallet-tracker');

const ADDR = /^0x[0-9a-fA-F]{40}$/;
const esc = (s) => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const dot = (m) => (m === 'auto' ? '🟢' : m === 'alert' ? '🟡' : '⚪');
const sizeText = (c) => (c.size_mode === 'prop' ? c.usd_size + '% of their buy' : '$' + c.usd_size);

function settingsText(tgId) {
  const tracked = tracker.listFor(tgId);
  if (!tracked.length) {
    return '🪞 <b>Copytrade</b>\n\nYou are not tracking any wallets yet. Track one with <code>/track &lt;address&gt;</code>, then turn copy on here.\n\n<i>When a wallet you copy buys, you copy at your size. Alert = one tap to confirm. Auto = places the Flash order in Telegram for you.</i>';
  }
  const lines = ['🪞 <b>Copytrade</b>', '', 'Tap a wallet to cycle off → alert → auto. Tap ↔ to mirror their sells too.', ''];
  for (const t of tracked.slice(0, 12)) {
    const c = memberCopy.get(tgId, t.address) || { mode: 'off', usd_size: 10, copy_sells: 0, size_mode: 'fixed' };
    lines.push(dot(c.mode) + ' <code>' + esc(t.address.slice(0, 10)) + '…</code>'
      + (t.label ? ' ' + esc(t.label) : '')
      + ' — ' + (c.mode === 'off' ? 'off' : c.mode + ' ' + sizeText(c) + (c.copy_sells ? ' +sells' : '')));
  }
  lines.push('', '<i>Set size:</i> <code>/copy &lt;wallet&gt; &lt;usd&gt; [auto] [sells]</code>');
  lines.push('<i>Proportional:</i> <code>/copy &lt;wallet&gt; 10% auto</code> copies 10% of their buy.');
  lines.push('<i>Protect:</i> <code>/copy &lt;wallet&gt; 10 auto tp:2 sl:0.5</code> takes profit at 2x, stops out at 0.5x.');
  return lines.join('\n');
}

function keyboard(tgId) {
  const tracked = tracker.listFor(tgId).slice(0, 6);
  const rows = tracked.map((t) => {
    const c = memberCopy.get(tgId, t.address) || { mode: 'off', copy_sells: 0 };
    return [
      { text: dot(c.mode) + ' ' + t.address.slice(0, 8) + '… (' + c.mode + ')', callback_data: 'cp:cycle:' + t.address },
      { text: (c.copy_sells ? '↔ sells on' : '→ buys only'), callback_data: 'cp:sells:' + t.address },
    ];
  });
  return { inline_keyboard: rows.length ? rows : [[{ text: 'Track a wallet first', callback_data: 'cp:noop' }]] };
}

module.exports = (bot) => {
  bot.command('copy', async (ctx) => {
    if (ctx.chat && ctx.chat.type !== 'private') {
      return ctx.reply('DM me and run /copy to set up copytrade.', { message_thread_id: ctx.message && ctx.message.message_thread_id });
    }
    const txt = String(ctx.message.text || '');
    const parts = txt.trim().split(/\s+/).slice(1);
    if (parts[0] && ADDR.test(parts[0])) {
      const addr = parts[0];
      const mode = /\bauto\b/i.test(txt) ? 'auto' : 'alert';
      const copySells = /\bsells?\b/i.test(txt);
      const sizeTok = String(parts[1] || '10');
      const prop = sizeTok.includes('%');
      const num = Number(sizeTok.replace(/[^0-9.]/g, '')) || 10;
      try { tracker.add({ tgId: ctx.from.id, address: addr }); } catch (e) { /* already tracked / at cap */ }
      const tpm = (txt.match(/\btp:([0-9.]+)/i) || [])[1];
      const slm = (txt.match(/\bsl:([0-9.]+)/i) || [])[1];
      const c = memberCopy.set(ctx.from.id, addr, { mode, usdSize: num, copySells, sizeMode: prop ? 'prop' : 'fixed' });
      if (tpm || slm) memberCopy.set(ctx.from.id, addr, {}); // ensure row
      if (tpm !== undefined || slm !== undefined) {
        const db = require('../db').db;
        try { db.prepare('UPDATE wallet_copy SET tp_mult = COALESCE(?, tp_mult), sl_mult = COALESCE(?, sl_mult) WHERE tg_id = ? AND address = ?')
          .run(tpm != null ? Number(tpm) : null, slm != null ? Number(slm) : null, ctx.from.id, addr.toLowerCase()); } catch (e) { /* skip */ }
      }
      return ctx.reply(dot(mode) + ' Copytrade <b>' + mode + '</b> on <code>' + esc(addr.slice(0, 10)) + '…</code> at <b>' + sizeText(c) + '</b>'
        + (copySells ? ', mirroring sells' : '') + '.'
        + (mode === 'auto' ? '\n\n<i>Auto needs Telegram signing permission enabled; otherwise it falls back to an alert.</i>' : ''),
        { parse_mode: 'HTML' });
    }
    return ctx.reply(settingsText(ctx.from.id), { parse_mode: 'HTML', reply_markup: keyboard(ctx.from.id) });
  });

  bot.command('copyoff', async (ctx) => {
    const a = String(ctx.message.text || '').trim().split(/\s+/)[1];
    if (!a || !ADDR.test(a)) return ctx.reply('Usage: <code>/copyoff &lt;wallet&gt;</code>', { parse_mode: 'HTML' });
    memberCopy.off(ctx.from.id, a);
    return ctx.reply('Copytrade off for <code>' + esc(a.slice(0, 10)) + '…</code>.', { parse_mode: 'HTML' });
  });

  bot.action('cp:open', async (ctx) => {
    await ctx.answerCbQuery();
    return ctx.reply(settingsText(ctx.from.id), { parse_mode: 'HTML', reply_markup: keyboard(ctx.from.id) });
  });
  bot.action('cp:noop', (ctx) => ctx.answerCbQuery());
  bot.action('fam_track', async (ctx) => {
    await ctx.answerCbQuery();
    const tracked = tracker.listFor(ctx.from.id) || [];
    const lines = ['\u25CE <b>Track wallets</b>', '', 'Follow any Base wallet, its moves land in your DM. Then copy it under Copytrade.', ''];
    if (tracked.length) tracked.slice(0, 10).forEach((t) => lines.push('\u2192 <code>' + esc(t.address.slice(0, 12)) + '\u2026</code>' + (t.label ? ' ' + esc(t.label) : '')));
    else lines.push('<i>You are not tracking any wallet yet.</i>');
    lines.push('', 'Add one: <code>/track &lt;address&gt;</code>');
    return ctx.reply(lines.join('\n'), { parse_mode: 'HTML', disable_web_page_preview: true,
      reply_markup: { inline_keyboard: [[{ text: '\uD83E\uDE9E Copytrade settings', callback_data: 'cp:open' }]] } });
  });
  bot.action(/^cp:cycle:(0x[0-9a-fA-F]{40})$/, async (ctx) => {
    const addr = ctx.match[1];
    const c = memberCopy.get(ctx.from.id, addr);
    const cur = c ? c.mode : 'off';
    const next = cur === 'off' ? 'alert' : cur === 'alert' ? 'auto' : 'off';
    memberCopy.set(ctx.from.id, addr, { mode: next });
    await ctx.answerCbQuery('Copy ' + next);
    return ctx.editMessageText(settingsText(ctx.from.id), { parse_mode: 'HTML', reply_markup: keyboard(ctx.from.id) }).catch(() => {});
  });
  bot.action(/^cp:sells:(0x[0-9a-fA-F]{40})$/, async (ctx) => {
    const addr = ctx.match[1];
    const c = memberCopy.get(ctx.from.id, addr) || { copy_sells: 0 };
    memberCopy.set(ctx.from.id, addr, { copySells: !c.copy_sells });
    await ctx.answerCbQuery(c.copy_sells ? 'Sells off' : 'Sells on');
    return ctx.editMessageText(settingsText(ctx.from.id), { parse_mode: 'HTML', reply_markup: keyboard(ctx.from.id) }).catch(() => {});
  });
};
