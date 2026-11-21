// سلامة حزمة التسليم: الملفات الحرجة موجودة، .env.example كامل ويتزامن تلقائيًا مع الكود، .gitignore لا يُسقطه،
// كل اعتماد مُستورد في api/ معلَن في package.json، وإعدادات Vercel صحيحة.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const root = path.join(__dirname, '..');
const read = f => fs.readFileSync(path.join(root, f), 'utf8');
const listJs = dir => fs.readdirSync(path.join(root, dir), { withFileTypes: true })
  .flatMap(d => d.isDirectory() ? listJs(path.join(dir, d.name)) : d.name.endsWith('.js') ? [path.join(dir, d.name)] : []);

test('الملفات الحرجة موجودة في الحزمة', () => {
  for (const f of ['accept-invitation/index.html', 'accept-invitation/accept.js', '.env.example', 'database.rules.json',
    'database.rules.phase2.json', 'api/accept-invitation.js', 'api/admin-invitations-send.js', 'api/erp-op.js', 'api/admin-maintenance.js',
    'api/company-staff.js', 'js/erp-hr.js', 'js/roles.js', 'js/ui-hr.js'])
    assert.ok(fs.existsSync(path.join(root, f)), f);
});

test('.env.example يضم كل متغير بيئة يقرأه كود api/ (يتزامن تلقائيًا) ولا يحتوي أسرارًا حقيقية', () => {
  const used = new Set();
  for (const f of listJs('api')) for (const m of read(f).matchAll(/process\.env\.([A-Z][A-Z0-9_]+)/g)) used.add(m[1]);

  const example = read('.env.example');
  for (const name of used) assert.match(example, new RegExp(`^${name}=`, 'm'), `متغير ناقص في .env.example: ${name}`);

  for (const required of ['GCP_PROJECT_ID', 'GCP_PROJECT_NUMBER', 'GCP_SERVICE_ACCOUNT_EMAIL', 'GCP_WORKLOAD_IDENTITY_POOL_ID',
    'GCP_WORKLOAD_IDENTITY_POOL_PROVIDER_ID', 'SUPER_ADMIN_UID', 'APP_BASE_URL', 'RESEND_API_KEY', 'INVITATION_FROM_EMAIL'])
    assert.match(example, new RegExp(`^${required}=`, 'm'), required);

  assert.ok(!/re_[A-Za-z0-9]{20,}|AIza[0-9A-Za-z_-]{30,}|PRIVATE KEY|eyJ[A-Za-z0-9_-]{20,}\./.test(example), 'لا أسرار حقيقية');
});

test('.gitignore: يتجاهل ملفات .env الحقيقية ويستثني .env.example صراحةً بعد أنماط التجاهل', () => {
  const lines = read('.gitignore').split(/\r?\n/).map(l => l.trim());
  const negation = lines.indexOf('!.env.example');
  assert.ok(negation >= 0, 'استثناء !.env.example مفقود');
  for (const pattern of ['.env', '.env.*', '.env*']) {
    assert.ok(lines.includes(pattern), pattern);
    assert.ok(lines.indexOf(pattern) < negation, `الاستثناء يجب أن يأتي بعد ${pattern}`);
  }
});

test('git check-ignore الفعلي: .env.example غير متجاهَل و.env و.env.local متجاهَلان', t => {
  if (spawnSync('git', ['--version']).status !== 0) return t.skip('git غير متاح');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nabdh-gi-'));
  spawnSync('git', ['init', '-q'], { cwd: dir });
  fs.copyFileSync(path.join(root, '.gitignore'), path.join(dir, '.gitignore'));
  const ignored = f => spawnSync('git', ['check-ignore', '-q', f], { cwd: dir }).status === 0;
  assert.equal(ignored('.env.example'), false);
  assert.equal(ignored('.env'), true);
  assert.equal(ignored('.env.local'), true);
  assert.equal(ignored('accept-invitation/index.html'), false);
  assert.equal(ignored('node_modules/x.js'), true);
});

test('كل اعتماد خارجي يستورده كود api/ معلَن في package.json', () => {
  const pkg = JSON.parse(read('package.json'));
  const declared = new Set([...Object.keys(pkg.dependencies || {}), ...Object.keys(pkg.devDependencies || {})]);
  const lock = JSON.parse(read('package-lock.json'));

  for (const f of listJs('api')) {
    for (const m of read(f).matchAll(/require\('([^'.][^']*)'\)/g)) {
      if (m[1].startsWith('node:')) continue;
      const name = m[1].startsWith('@') ? m[1].split('/').slice(0, 2).join('/') : m[1].split('/')[0];
      assert.ok(declared.has(name), `${f} يستورد ${name} وهو غير معلَن في package.json`);
      assert.ok(lock.packages[`node_modules/${name}`], `${name} غير موجود في package-lock.json`);
    }
  }
});

test('vercel.json صالح، كل دالة مذكورة فيه موجودة، وعدد الدوال ضمن حد الخطة المجانية (12)', () => {
  const cfg = JSON.parse(read('vercel.json'));
  for (const f of Object.keys(cfg.functions)) assert.ok(fs.existsSync(path.join(root, f)), f);

  const fns = fs.readdirSync(path.join(root, 'api')).filter(f => f.endsWith('.js'));
  assert.ok(fns.length <= 12, `عدد دوال api = ${fns.length}`);

  // الدوال التي تحمّل محرك ERP أو ملف الأدوار يجب أن تُضمَّن ملفات js/ في حزمتها
  for (const f of ['api/erp-op.js', 'api/accept-invitation.js', 'api/admin-maintenance.js', 'api/admin-companies-list.js', 'api/company-staff.js'])
    assert.equal(cfg.functions[f].includeFiles, 'js/*.js', f);
});

test('index.html يحمّل ملفات الموارد البشرية والأدوار بالترتيب الصحيح (المحرك ثم الأدوار ثم الواجهة ثم app.js)', () => {
  const html = read('index.html');
  const order = ['js/erp-ops2.js', 'js/erp-hr.js', 'js/roles.js', 'js/erp-reports.js', 'js/ui-pages3.js', 'js/ui-hr.js', 'js/app.js'].map(f => html.indexOf(`src="${f}"`));
  assert.ok(order.every(i => i > 0), 'كل الملفات مذكورة');
  assert.deepEqual([...order].sort((a, b) => a - b), order, 'الترتيب صحيح');
});
