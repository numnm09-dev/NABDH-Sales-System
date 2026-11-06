// اختبارات الخادم بمزود ذكاء اصطناعي وهمي (mock): لا تثبت الاتصال الفعلي بالمزود.
const test = require('node:test'), assert = require('node:assert');
const handler = require('../api/analyze.js');
const data = require('../data/sample-data.json');
const body = (o = {}) => ({ itemId: 'i1', delay: 10, safety: 3, items: data.items, suppliers: data.suppliers, orders: data.orders, ...o });
const call = async (b, method = 'POST', headers = {}) => { let code, out, h = {}; const res = { setHeader: (k, v) => h[k] = v, status: c => (code = c, res), json: j => (out = j, res), end: () => res };
  await handler({ method, body: b, headers }, res); return { code, out, h }; };
const real = global.fetch;
// شكل رد Gemini: candidates[0].content.parts[].text
const model = (text, status = 200) => { global.fetch = async () => ({ ok: status === 200, status, json: async () => (status === 200 ? { candidates: [{ content: { parts: [{ text }] } }] } : { error: { message: 'x' } }) }); };
test.beforeEach(() => { process.env.GEMINI_API_KEY = 'test-key'; process.env.AI_MODEL = 'test-model'; process.env.ALLOWED_ORIGIN = 'https://ok.example'; });
test.after(() => { global.fetch = real; });

test('بدون مفتاح: 503 برسالة واضحة', async () => { delete process.env.GEMINI_API_KEY; const r = await call(body()); assert.equal(r.code, 503); assert.equal(r.out.code, 'not_configured'); });
test('مدخلات غير صالحة: 400', async () => {
  assert.equal((await call(null)).code, 400); assert.equal((await call(body({ itemId: 'x' }))).code, 400);
  assert.equal((await call(body({ items: [null] }))).code, 400); assert.equal((await call(body({ delay: -5 }))).code, 400);
});
test('بيانات ناقصة: 422 بدل تخمين', async () => { const items = data.items.map(i => i.id === 'i1' ? { ...i, daily: 0 } : i); assert.equal((await call(body({ items }))).code, 422); });
test('نجاح: الأرقام من الكود الرياضي والمورد المختلق يُحذف', async () => {
  model(JSON.stringify({ summary: 'ملخص', stockoutExplanation: 'س', delayImpact: 'ت', recommendedSupplierId: 'FAKE', alternatives: [{ supplierId: 's2', pros: ['أسرع'], cons: ['أغلى'] }, { supplierId: 'FAKE', pros: ['x'], cons: [] }], reorderComment: 'ك', assumptions: ['أ'], dataGaps: [] }));
  const r = await call(body()); assert.equal(r.code, 200); assert.equal(r.out.math.coverDays, 6); assert.equal(r.out.math.gapDays, 6); assert.equal(r.out.riskLevel, 'high');
  assert.equal(r.out.analysis.recommendedSupplierId, null); assert.deepEqual(r.out.analysis.alternatives.map(a => a.supplierId), ['s2']);
  assert.ok(r.out.candidates.every(c => ['s2', 's3'].includes(c.supplierId))); assert.ok(r.out.notices.some(n => n.includes('يحتاج إلى تأكيد')));
});
test('رد غير JSON من النموذج: 502', async () => { model('ليس JSON'); const r = await call(body()); assert.equal(r.code, 502); assert.equal(r.out.code, 'bad_model_output'); });
test('أخطاء المزود تُترجم', async () => { for (const [s, c] of [[401, 'provider_auth'], [404, 'provider_model'], [429, 'rate_limited']]) { model('x', s); assert.equal((await call(body())).out.code, c); } });
test('ping ينجح مع مزود وهمي', async () => { model('تمام'); const r = await call({ ping: true }); assert.equal(r.code, 200); assert.equal(r.out.ok, true); });
test('CORS: يسمح بالأصل المحدد فقط', async () => {
  assert.equal((await call(body(), 'OPTIONS', { origin: 'https://ok.example' })).h['Access-Control-Allow-Origin'], 'https://ok.example');
  assert.equal((await call(body(), 'OPTIONS', { origin: 'https://evil.example' })).h['Access-Control-Allow-Origin'], undefined);
  assert.equal((await call(body(), 'GET')).code, 405);
});
