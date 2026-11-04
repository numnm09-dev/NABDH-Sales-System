/* حسابات نبض الرياضية الفعلية — منفصلة تمامًا عن توقعات الذكاء الاصطناعي */
(function (root, f) { if (typeof module === 'object') module.exports = f(); else root.Calc = f(); })(this, function () {
  const num = v => (v === '' || v == null ? NaN : Number(v));
  const ok = v => Number.isFinite(v);
  // أيام التغطية = الكمية ÷ الاستهلاك اليومي؛ null عند بيانات غير صالحة
  function coverDays(qty, daily) { qty = num(qty); daily = num(daily); return (ok(qty) && qty >= 0 && ok(daily) && daily > 0) ? qty / daily : null; }
  function arrival(it) { return (num(it.inbound) || 0) + (num(it.delay) || 0); }
  // فجوة التوريد = أيام ما بعد نفاد المخزون وقبل وصول الشحنة
  function gapDays(it) { const c = coverDays(it.qty, it.daily); return c === null ? null : Math.max(0, arrival(it) - c); }
  function status(it) {
    const c = coverDays(it.qty, it.daily);
    if (c === null) return { k: 'nodata', t: 'بيانات ناقصة', c: null };
    if (c < arrival(it)) return { k: 'crit', t: 'سينفد قبل الشحنة', c };
    if (num(it.qty) <= num(it.min)) return { k: 'low', t: 'تحت الحد الأدنى', c };
    return { k: 'ok', t: 'آمن', c };
  }
  // كمية إعادة الطلب = الاستهلاك خلال (مدة التوريد + مخزون أمان) − المتاح، مع احترام الحد الأدنى للطلب
  function reorderQty(it, leadDays, safetyDays = 3, moq = 0) {
    const need = num(it.daily) * (num(leadDays) + safetyDays) - num(it.qty);
    if (!ok(need) || need <= 0) return 0;
    return Math.ceil(Math.max(need, num(moq) || 0));
  }
  // ترتيب البدلاء: 35% سعر، 35% وقت، 30% جودة (أوزان افتراضية)
  function rank(it, suppliers, w = { p: .35, t: .35, q: .3 }) {
    const c = suppliers.filter(s => s.id !== it.supplierId && String(s.itemCodes || '').split(/[,،]/).map(x => x.trim()).includes(it.code) && num(s.price) > 0 && num(s.lead) > 0);
    if (!c.length) return [];
    const mp = Math.min(...c.map(s => num(s.price))), ml = Math.min(...c.map(s => num(s.lead)));
    return c.map(s => ({ s, score: Math.round(100 * (w.p * mp / num(s.price) + w.t * ml / num(s.lead) + w.q * (num(s.quality) || 0) / 5)) }))
      .sort((a, b) => b.score - a.score);
  }
  // مقارنة الانتظار بالشراء من بديل. p: {demand, extraDelay, priceMult}
  function compare(it, alt, p = {}) {
    const dm = p.demand ?? 1, xd = p.extraDelay ?? 0, pm = p.priceMult ?? 1, daily = num(it.daily) * dm;
    const cover = coverDays(it.qty, daily); if (cover === null) return null;
    const waitArr = arrival(it) + xd, altArr = num(alt.lead) + xd;
    // الكمية تغطي حتى وصول الشحنة المتأخرة (أو البديل أيهما أبعد) + مخزون أمان
    const qty = reorderQty({ ...it, daily }, Math.max(waitArr, altArr), p.safety ?? 3, alt.moq);
    const unit = num(it.price);
    const waitShort = Math.max(0, waitArr - cover), altShort = Math.max(0, altArr - cover);
    return { cover, waitArr, altArr, qty, waitShort, altShort, waitLostUnits: waitShort * daily, altLostUnits: altShort * daily,
      waitLostValue: waitShort * daily * unit, extraCost: qty * (num(alt.price) * pm - unit) };
  }
  return { coverDays, arrival, gapDays, status, reorderQty, rank, compare };
});
