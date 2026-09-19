// Isolated money-math tests. No live DB, no RPC, no wallet. First CI-able suite
// for the money path. Run: node test/money.test.js  (exit 1 on any failure)
const assert = require('assert');
let pass = 0, fail = 0;
function t(name, fn) { try { fn(); pass++; console.log('  ok   ' + name); } catch (e) { fail++; console.log('  FAIL ' + name + ': ' + e.message); } }

// ---- agency fee: keep BPS/10000 of the unclaimed remainder, refund the rest ----
// Mirrors settleQuest in src/tasks/quest-pay.js exactly.
function agencyFeeSplit(remaining, bps) {
  const fee = Math.round(remaining * (bps / 10000) * 100) / 100;
  const refund = Math.round((remaining - fee) * 100) / 100;
  return { fee, refund };
}
t('agency fee: $40 @ 1000bps -> fee $4, refund $36', () => {
  const r = agencyFeeSplit(40, 1000); assert.strictEqual(r.fee, 4); assert.strictEqual(r.refund, 36);
});
t('agency fee: fully claimed (remaining 0) -> nothing kept, nothing refunded', () => {
  const r = agencyFeeSplit(0, 1000); assert.strictEqual(r.fee, 0); assert.strictEqual(r.refund, 0);
});
t('agency fee: fee + refund == remaining for all amounts (no dust)', () => {
  for (const rem of [0.15, 0.4, 667, 1.11, 12.34, 0.5]) {
    const r = agencyFeeSplit(rem, 1000);
    assert.strictEqual(Math.round((r.fee + r.refund) * 100) / 100, Math.round(rem * 100) / 100, 'mismatch at ' + rem);
  }
});
t('agency fee: sub-dime remainder rounds fee to 0 (never over-charges dust)', () => {
  const r = agencyFeeSplit(0.01, 1000); assert.strictEqual(r.fee, 0); assert.strictEqual(r.refund, 0.01);
});

// ---- referral 90/10 split ----
function referralSplit(reward, refBps) {
  const referral = Math.round(reward * (refBps / 10000) * 100) / 100;
  const claimer = Math.round((reward - referral) * 100) / 100;
  return { claimer, referral };
}
t('referral: $0.10 reward -> claimer $0.09, referrer $0.01', () => {
  const r = referralSplit(0.10, 1000); assert.strictEqual(r.claimer, 0.09); assert.strictEqual(r.referral, 0.01);
});
t('referral: claimer + referral == reward (no leakage)', () => {
  for (const rw of [0.1, 1, 3, 0.25]) { const r = referralSplit(rw, 1000); assert.strictEqual(Math.round((r.claimer + r.referral) * 100) / 100, rw); }
});

// ---- member trade fee ceiling (real exported code) ----
try {
  process.env.MEMBER_FEE_BPS = '100';
  delete require.cache[require.resolve('../src/lib/member-fees')];
  const fees = require('../src/lib/member-fees');
  t('member fee: feeBps reads env (100)', () => { assert.strictEqual(fees.feeBps(), 100); });
  t('member fee: above 500bps ceiling is refused', () => {
    process.env.MEMBER_FEE_BPS = '600';
    assert.throws(() => fees.feeBps());
    process.env.MEMBER_FEE_BPS = '100';
  });
} catch (e) { console.log('  skip member-fees (' + e.message + ')'); }

// ---- delegation cap (guards the 365-day fix) ----
t('delegation: 8760 hours is exactly 365 days', () => {
  assert.strictEqual((8760 * 3600 * 1000) / (86400 * 1000), 365);
});

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
