const test = require('node:test'), assert = require('node:assert');
const { E, factory, mk } = require('./helpers.js');
const R = require('../js/erp-reports.js');
function trade() { const s = factory(); const p = s.go('createProduction', { bomId: s.bom.id, plannedQty: 2000, rawWhId: 'wh_raw', fgWhId: 'wh_fg' }); s.go('completeProduction', { id: p.id, producedQty: 2000, otherCost: 500 }); return s; }

test('المصروفات: التحقق والقيد والخزينة', () => {
  const s = factory(); s.fail('recordExpense', { category: 'x', amount: 10, method: 'نقدي' }); s.fail('recordExpense', { category: 'إيجار', amount: 0, method: 'نقدي' }); s.fail('recordExpense', { category: 'إيجار', amount: 10, method: 'y' });
  const e = s.go('recordExpense', { category: 'إيجار', amount: 3000, method: 'نقدي', note: 'إيجار نوفمبر' }); assert.equal(e.cashAfter, 97000); assert.equal(E.balances(s.db)['5200'], 3000);
  s.fail('recordExpense', { category: 'إيجار', amount: 97000.01, method: 'نقدي' }, 'insufficient_cash'); assert.deepEqual(E.verify(s.db), []);
});
test('الخزينة: إيداع وسحب بلا رصيد سالب', () => {
  const s = mk(); s.fail('cashEntry', { kind: 'withdrawal', amount: 1 }, 'insufficient_cash'); s.go('cashEntry', { kind: 'capital_in', amount: 500 }); s.fail('cashEntry', { kind: 'bad', amount: 1 }); s.go('cashEntry', { kind: 'withdrawal', amount: 500 }); assert.equal(E.cashBalance(s.db), 0);
});
test('دورة كاملة: إنتاج ← بيع آجل ← تحصيل ← مصروف؛ الميزانية متوازنة والربح صحيح', () => {
  const s = trade(); const unitCost = s.item('ORJ').stockValue / 2000;   // (306*20+80*5+2020*1+500)/2000
  const inv = s.go('createInvoice', { whId: 'wh_fg', customerId: s.cust.id, lines: [{ itemId: s.id('ORJ'), qty: 800, unitPrice: 6 }], paid: 1000, method: 'نقدي' });   // 4800، آجل 3800 (ضمن حد 5000)
  s.go('collectPayment', { customerId: s.cust.id, amount: 1800, method: 'تحويل بنكي' }); s.go('recordExpense', { category: 'كهرباء ومياه', amount: 400, method: 'نقدي' });
  const p = R.pnl(s.db, {}); assert.equal(p.revenue, 4800); assert.equal(p.cogs, inv.cogs); assert.equal(p.opex, 400); assert.equal(p.netProfit, Math.round((4800 - inv.cogs - 400) * 100) / 100);
  const f = R.finance(s.db, {}); const bs = f.sections[1].rows; assert.match(bs[bs.length - 1].note, /متوازنة/);
  const tb = f.sections.find(x => x.title === 'ميزان المراجعة'); assert.equal(tb.totals.dr, tb.totals.cr);
  assert.equal(E.arBalance(s.db, s.cust.id), 2000); assert.equal(E.cashBalance(s.db), 100000 - 500 + 1000 + 1800 - 400); assert.deepEqual(E.verify(s.db, {}), []);
  void unitCost;
});
test('فلاتر التاريخ في التقارير المالية', () => {
  const s = factory(); s.go('recordExpense', { category: 'إيجار', amount: 100, method: 'نقدي', date: '2026-10-05' }); s.go('recordExpense', { category: 'إيجار', amount: 250, method: 'نقدي', date: '2026-11-03' });
  assert.equal(R.pnl(s.db, { from: '2026-11-01', to: '2026-11-30' }).opex, 250); assert.equal(R.pnl(s.db, { from: '2026-10-01', to: '2026-10-31' }).opex, 100); assert.equal(R.pnl(s.db, {}).opex, 350);
});
test('إلغاء فاتورة لا يترك أثرًا محاسبيًا ولا يكسر الميزان', () => {
  const s = trade(); const inv = s.go('createInvoice', { whId: 'wh_fg', lines: [{ itemId: s.id('ORJ'), qty: 100, unitPrice: 6 }], customerName: 'زبون', method: 'نقدي' }); s.go('cancelInvoice', { id: inv.id, reason: 'خطأ' });
  const p = R.pnl(s.db, {}); assert.equal(p.revenue, 0); assert.equal(p.cogs, 0); assert.deepEqual(E.verify(s.db, {}), []);
});
