# إصلاح دخول Super Admin — التقرير

## الخلاصة الصريحة
**لا أستطيع إثبات السبب الجذري الفعلي في إنتاجك من الكود وحده**، لأن الرسالة «غير مصرح لك بدخول لوحة مدير النظام» لا تدل على سبب واحد. الذي **أثبتّه** من الكود:

**الخلل المؤكد (تشخيصي):** `admin/admin.js` كان يعرض هذه الرسالة لأي ردّ غير ناجح — 401 و403 **و500 (عطل Firebase Admin/الإعداد)** — بينما `api/admin-check.js` كان يبتلع السبب الحقيقي دون أي تسجيل. فالرسالة التي رأيتَها قد تكون عطلًا في الخادم لا رفضًا للصلاحية، ولا يوجد أثر يكشف أيهما. (تصنيفه: Frontend/API error handling، لا Authorization.)

الأسباب الممكنة التي تنتج **نفس الرسالة** بحسب الكود (ما بين قوسين = ما أثبتُّه تجريبيًا):
| الرد | الحالة | السبب المحتمل |
|---|---|---|
| 403 | Authorization | قيمة `SUPER_ADMIN_UID` لا تطابق حرفيًا (مسافة/سطر زائد عند اللصق، أو حرف مشابه). (المطابقة كانت صارمة دون `trim`) |
| 401 | Token Verification | `GCP_PROJECT_ID` ≠ معرّف مشروع Firebase للتوكن ⇒ `auth/argument-error` ⇒ يُترجَم 401 (**أثبتُّه بمكتبة firebase-admin الحقيقية دون شبكة**). أو توكن منتهٍ/مُبطَل |
| 500 | Firebase Admin Runtime | متغير GCP_* ناقص، فشل OIDC/Workload Identity، أو حساب الخدمة بلا صلاحية قراءة المستخدم (لأن `verifyIdToken(token, true)` يفحص الإبطال بقراءة سجل المستخدم) |

## ما غُيّر (3 ملفات + اختبارات)، دون تغيير نظام الصلاحيات
1. `api/_lib/require-super-admin.js`: مقارنة UID بعد `trim()` للقيمة المُعدّة فقط (القيمة الفارغة/مسافات فقط ⇒ رفض)؛ وإرفاق السبب الأصلي بالخطأ للتسجيل الخادمي فقط. تبقى المطابقة على UID وليس البريد.
2. `api/admin-check.js`: تسجيل كل رفض/فشل في سجلات Vercel بصيغة `admin-check failed: {...}` (رمز الخطأ، الرسالة مع حجب أي JWT، وأطوال UID دون قيمه). الردود للعميل لم تتغير (`unauthorized`/`forbidden`/`authentication_failed`).
3. `admin/admin.js`: رسالة مختلفة لـ 500 (خطأ إعداد خادم) و401 (جلسة)، وتبقى رسالة «غير مصرح» لـ 403 ولغير SUPER_ADMIN.
4. `tests/admin-check-diagnostics.test.js` (13 اختبارًا جديدًا). الـ diff الكامل في `ADMIN_FIX.diff`، والنسخ الأصلية قبل التعديل في `/home/claude/pre-admin-fix/` وفي ZIP الأصلي الذي رفعتَه.
ملاحظة: حفظ `require-super-admin.js` أزال BOM في أول الملف وحوّل نهاية السطر الأخيرة من CRLF إلى LF (لا أثر وظيفي).
**الملفات المفحوصة:** admin-check.js، _lib/firebase-admin.js، _lib/require-super-admin.js، _lib/verify-user.js، admin/admin.js، admin/index.html، js/firebase-init.js، tests/admin-auth.test.js، tests/admin-missing-uid.test.js، package.json، vercel.json، .env.example. لم أعدّل firebase-admin.js ولا vercel.json ولا قواعد Firebase.

## نتائج الاختبارات الفعلية (محاكاة؛ ليست Firebase/Vercel حقيقيين)
- ملفات الإدارة الثلاثة: 20/20 Pass (7 قديمة + 13 جديدة)، Fail 0، Skipped 0.
- المجموعة الكاملة `npm test`: **329 Pass / 0 Fail / 0 Skipped** (السجل في `AUDIT_TEST_RUN.log`).
- مغطّى: مدير صحيح 200 + role؛ UID مختلف/مشابه/بريد وحده ⇒ 403؛ غياب أو فراغ `SUPER_ADMIN_UID` ⇒ رفض؛ بلا توكن/Basic ⇒ 401؛ 5 أنواع توكن غير صالح ⇒ 401؛ أعطال Admin/إعداد ⇒ 500 برد عام ومحجوب؛ طرق غير GET ⇒ 405؛ رسائل الواجهة لكل حالة.
- **لم يُختبر:** Firebase الحقيقي، OIDC/Workload Identity، حساب الخدمة وصلاحياته، Vercel Production، حسابك الفعلي.

## الجاهزية
جاهز للرفع **كتغيير تشخيصي وآمن** (لا يوسّع الصلاحيات ولا يغيّر الردود). لكنه **لا يضمن وحده** أن الدخول سينجح؛ قد يكشف أن السبب إعداد في Vercel/Google. لم أنشر شيئًا.

## خطوات اختبار الحساب الحقيقي بعد النشر
1. تأكد أن `SUPER_ADMIN_UID` موجود في بيئة النشر التي تخدم الموقع، وأن **نشرًا جديدًا** حدث بعد آخر تعديل لمتغيرات البيئة (التعديل لا يسري على نشر قديم).
2. سجّل الدخول بـ nabdh.erp@gmail.com (بريد مؤكَّد) وافتح `/admin/`.
3. الرسالة الآن تحدد الفئة: «غير مصرح» = 403، «خطأ في إعداد الخادم» = 500، «جلسة الدخول» = 401.
4. في Vercel → Logs ابحث عن `admin-check failed` وافعل حسب القيمة:
   - `auth/argument-error` مع `incorrect "aud"`: اجعل `GCP_PROJECT_ID` = معرّف مشروع Firebase الظاهر في الرسالة.
   - `forbidden` مع `configuredRawLength` ≠ `configuredLength`: كان في القيمة مسافة (أصلحها الكود الآن). إن اختلف `configuredLength` عن `tokenUidLength` فالقيمة خاطئة؛ انسخ UID من Firebase Console → Authentication → Users.
   - `server_error` مع `missing_config:`: أضف المتغيرات المذكورة. مع `app/invalid-credential` أو أخطاء STS/OIDC: راجع إعداد Workload Identity. مع `auth/insufficient-permission`/PERMISSION_DENIED: يحتاج حساب الخدمة صلاحية قراءة مستخدمي Firebase Auth.
5. من DevTools → Network يمكنك أيضًا رؤية status وbody لـ `/api/admin-check`.

## معلومة ناقصة مطلوبة
بعد النشر أرسل لي **سطر السجل `admin-check failed: {...}`** (لا يحوي أسرارًا) أو status/body الاستجابة، وأحدد السبب الجذري الفعلي وأعالجه بأقل تعديل.
