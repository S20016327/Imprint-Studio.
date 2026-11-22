# الخلفية والجدولة — Imprint Studio

هذا المجلد يحتوي الجزء الخادمي الذي لا يمكن أن يعمل داخل GitHub Pages.

## الملفات

```
supabase/
└── functions/
    ├── imprint-publisher/index.ts    عامل النشر المجدول
    └── imprint-oauth-start/index.ts  بدء ربط حساب منصة (OAuth)
```

## ما هو موجود فعليًا في قاعدة البيانات

| العنصر | الوصف |
|---|---|
| `public.social_accounts` | الحسابات المرتبطة لكل منصة. **لا يخزّن رموز وصول**، بل معرّفات Vault فقط. |
| `public.publish_jobs` | مهمة نشر واحدة لكل (منشور، منصة) — قيد `unique` يمنع التكرار. |
| `public.publish_events` | سجل تدقيق لكل انتقال حالة، مع سبب الفشل. |
| `enqueue_due_posts()` | تحويل المسودات المستحقة إلى مهام. آمنة للتكرار. |
| `claim_next_publish_job(worker)` | حجز ذري بـ `FOR UPDATE SKIP LOCKED` فلا ينشر عاملان نفس المهمة. |
| `finish_publish_job(...)` | إغلاق المهمة وتحديث حالة المنشور الأم بناءً على كل منصاته. |
| `requeue_stale_jobs(interval)` | إعادة المهام المعلّقة إلى الطابور. |

## قواعد الأمان المطبّقة

- الرموز لا تُخزَّن في الجداول. مستقبلًا: `vault.create_secret()` ويُحفظ المعرّف الناتج فقط.
- المالك يقرأ حساباته ومهامه وسجلها فقط (`auth.uid() = owner_id`).
- **لا يستطيع المالك تزوير نجاح نشر**: سياسة التحديث تسمح فقط بالانتقال إلى `canceled`
  من حالات `queued`/`blocked`/`failed`. مُختبر: محاولة تعيين `published` تُحدّث 0 صفًا.
- لا يستطيع المالك إدراج مهمة إلا لمنشوره الذي له موعد.
- دوال الطابور مسحوبة من `anon` و `authenticated`، وممنوحة لـ `service_role` فقط.

## النشر والتشغيل

```bash
# 1) سجّل الدخول واربط المشروع
supabase login
supabase link --project-ref yxmetzdoxbqndecslhlu

# 2) انشر الدالة
supabase functions deploy imprint-publisher --no-verify-jwt

# 3) سر مشترك يحمي نقطة النهاية من الاستدعاء العشوائي
supabase secrets set IMPRINT_CRON_SECRET=<قيمة-عشوائية-طويلة>

# 4) اختبر يدويًا
curl -X POST "https://yxmetzdoxbqndecslhlu.supabase.co/functions/v1/imprint-publisher" \
  -H "x-imprint-secret: <القيمة>"
```

## ربط الحسابات

```bash
# 1) سر توقيع state — إلزامي، بدونه ترفض الدالة العمل
supabase secrets set OAUTH_STATE_SECRET=$(openssl rand -hex 32)

# 2) بيانات تطبيق TikTok المطوّر (عند الحصول عليها)
supabase secrets set \
  TIKTOK_CLIENT_ID=... TIKTOK_CLIENT_SECRET=... \
  TIKTOK_REDIRECT_URI=https://yxmetzdoxbqndecslhlu.supabase.co/functions/v1/imprint-oauth-callback

# 3) أو Meta (Instagram + Facebook)
supabase secrets set META_CLIENT_ID=... META_CLIENT_SECRET=... META_REDIRECT_URI=...

# 4) أو Google (YouTube)
supabase secrets set GOOGLE_CLIENT_ID=... GOOGLE_CLIENT_SECRET=... GOOGLE_REDIRECT_URI=...

# 5) انشر دالة البدء
supabase functions deploy imprint-oauth-start --no-verify-jwt
```

**ما يعمل الآن:** التحقق من هوية المستخدم، توقيع `state` بـHMAC، وبناء رابط
التفويض الصحيح لكل منصة. **ما لا يزال مطلوبًا:** دالة `imprint-oauth-callback`
التي تستبدل `code` برمز وصول وتخزّنه في Vault. لم أُنشئها لأنها بلا فائدة قبل
حصولك على `client_secret` من منصة واحدة على الأقل.

بدون ضبط الأسرار تعيد الدالة **501** برسالة صريحة: «ربط X غير مهيّأ». هذا مقصود:
لن يُظهر الموقع نجاحًا وهميًا.

## الجدولة كل دقيقة

الخطة المجانية في Supabase قد لا تتيح `pg_cron`. عند تفعيله:

```sql
select cron.schedule(
  'imprint-publisher',
  '* * * * *',
  $$
  select net.http_post(
    url := 'https://yxmetzdoxbqndecslhlu.supabase.co/functions/v1/imprint-publisher',
    headers := jsonb_build_object('Content-Type','application/json','x-imprint-secret','<القيمة>')
  );
  $$
);
```

البديل بدون `pg_cron`: أي مجدول خارجي (GitHub Actions scheduled workflow،
Cron-job.org، Cloudflare Cron) يستدعي نفس العنوان كل دقيقة.

## سلوك العامل الحالي — بصراحة

| الحالة | النتيجة المسجّلة |
|---|---|
| لا يوجد حساب مرتبط | `blocked` مع سبب واضح |
| رمز منتهي | الحساب يصبح `expired` والمهمة `blocked` |
| المنصة غير مفعّلة | `blocked`: «يلزم تطبيق مطوّر معتمد» |
| فشل شبكي/API | `failed`، ثم إعادة محاولة تلقائية بتأخير تصاعدي حتى `max_attempts` |

**لا يوجد نشر حقيقي إلى أي منصة بعد.** محوّل النشر (`publishToPlatform`) هيكل
فارغ يرمي خطأ، ولا يُستدعى إلا بعد تفعيل المنصة في `PLATFORM_ENABLED`. هذا مقصود:
ادعاء النشر دون تطبيق مطوّر معتمد سيكون خطأً.
