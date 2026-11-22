# ربط إنستقرام: من الحساب الشخصي إلى أول منشور

## أولًا: تصحيح مهم قبل أي خطوة

**لا توجد واجهة برمجية (API) تنشر من حساب إنستقرام «شخصي».** منذ ديسمبر 2024
أُلغيت `Basic Display API` نهائيًا، وما بقي هو واجهات تعمل مع **حساب احترافي**
(Professional) فقط، أي:

| نوع الحساب | هل يمكنه النشر آليًا؟ |
| --- | --- |
| Personal (شخصي) | ❌ لا — أصلًا لا يظهر في أي API |
| Creator (صانع محتوى) | ✅ نعم |
| Business (تجاري) | ✅ نعم |

التحويل مجاني، ولا يغيّر اسمك ولا منشوراتك ولا متابعيك، ويأخذ دقيقة:
تطبيق إنستقرام ← **الإعدادات** ← **نوع الحساب وأدوات التحكم** ←
**التحويل إلى حساب احترافي** ← اختر **صانع محتوى (Creator)**.

> حسابك يبقى «حسابك الشخصي» بمعنى أنك تتحكم به وحدك؛ لكنه يصبح احترافيًا من
> ناحية النوع التقني فقط. هذا شرط من Meta وليس خيارًا في تصميمنا.

## ثانيًا: إنشاء التطبيق واستخراج المفاتيح

الخطوات على [developers.facebook.com](https://developers.facebook.com):

1. **My Apps ← Create App**.
2. اختر **Business** كنوع التطبيق (وليس Consumer ولا None — نوع Business هو
   الوحيد الذي يعرض منتج Instagram بشكل كامل).
3. سمِّه مثلًا `Imprint Creative` وأدخل بريدك.
4. من لوحة التطبيق: **Add Product ← Instagram ← Set up**.
5. داخل منتج Instagram اختر **API setup with Instagram business login**
   (وليس «Instagram API with Facebook Login» — الأول لا يحتاج صفحة فيسبوك).
6. اضغط **Add account** وسجّل الدخول بحسابك الاحترافي، ثم **Generate token**
   للتأكد أن الحساب مقبول. هذا الرمز للاختبار السريع فقط.
7. اذهب إلى **App settings ← Basic**، وابحث عن قسم **Instagram** (منفصل عن
   قسم Facebook في أعلى الصفحة):
   - **Instagram App ID** ← هذا هو `INSTAGRAM_CLIENT_ID`
   - **Instagram App Secret** ← اضغط *Show* ← هذا هو `INSTAGRAM_CLIENT_SECRET`

> ⚠️ الخطأ الأشهر: نسخ **App ID** من أعلى الصفحة (وهو معرّف تطبيق فيسبوك).
> القيمتان مختلفتان، والخطأ يظهر كرسالة `Invalid client_id`.

8. في نفس القسم: **Instagram business login ← OAuth redirect URIs** أضف:

   ```
   https://yxmetzdoxbqndecslhlu.supabase.co/functions/v1/imprint-oauth-callback
   ```

   حرفيًا بدون مسافة زائدة؛ لوحة Meta تضيف `/` في النهاية أحيانًا — انسخ
   القيمة من اللوحة **بعد** الحفظ إلى `INSTAGRAM_REDIRECT_URI` ليكون التطابق تامًا.

9. تحتاج صلاحيتين فقط، وهما متاحتان لك **بدون مراجعة تطبيق (App Review)**
   ما دمت تستخدم حسابك أنت:
   - `instagram_business_basic`
   - `instagram_business_content_publish`

   مراجعة التطبيق + توثيق النشاط التجاري مطلوبان فقط عندما تريد نشر محتوى
   **حسابات أشخاص آخرين** (أي حين تصبح المنصة عامة).

## ثالثًا: وضع المفاتيح في الخادم (لا في المتصفح ولا في GitHub)

```bash
supabase secrets set \
  INSTAGRAM_CLIENT_ID=... \
  INSTAGRAM_CLIENT_SECRET=... \
  INSTAGRAM_REDIRECT_URI=https://yxmetzdoxbqndecslhlu.supabase.co/functions/v1/imprint-oauth-callback \
  OAUTH_STATE_SECRET=$(openssl rand -hex 32) \
  IMPRINT_SITE_URL=https://s20016327.github.io/Imprint-Studio./

supabase functions deploy imprint-oauth-start    --no-verify-jwt
supabase functions deploy imprint-oauth-callback --no-verify-jwt
```

## رابعًا: ما يحدث عند الضغط على «ربط»

1. الموقع يطلب من `imprint-oauth-start` رابط تفويض موقّعًا بـ`state` (صالح 15 دقيقة).
2. تُفتح صفحة إنستقرام الرسمية — أنت توافق على الصلاحيتين.
3. تعود إلى `imprint-oauth-callback`:
   - يتحقق من `state` (ضد التلاعب).
   - `code` ← رمز قصير الأجل ← رمز طويل الأجل **60 يومًا**.
   - يقرأ `/me` ليتأكد أن الحساب احترافي، ويرفض الشخصي برسالة صريحة.
   - `store_social_token()` يحفظ الرمز **مشفّرًا في Vault** ويعيد معرّفًا فقط.
   - `social_accounts` يحفظ المعرّف واسم الحساب وتاريخ الانتهاء.
4. تعود إلى الموقع برسالة نجاح، وتُفتح لوحة الحسابات.

الرمز **لا يظهر في المتصفح ولا في الجداول ولا في السجلات**، وفصل الحساب
يحذفه من Vault تلقائيًا.

## خامسًا: الحدود الحالية بصراحة

- ✅ الربط والحفظ الآمن: مبني ومُختبر على مستوى قاعدة البيانات (دورة حفظ/حذف
  كاملة نجحت). يحتاج فقط مفاتيحك أعلاه.
- ⚠️ **النشر الفعلي لإنتسقرام غير مُنفَّذ بعد**: يجب أن يكون الملف صورة JPEG
  على رابط HTTPS عام ≤ 8 ميغابايت، والتسلسل هو *إنشاء حاوية ← الانتظار حتى
  `FINISHED` ← `media_publish`*. هذه الخطوة التالية بعد نجاح الربط.
- ⚠️ **التخزين الحالي خاص (private)**، فيجب رفع نسخة عامة مؤقتة أو استخدام
  رابط موقّع كي يقرأه إنستقرام. لم يُبنَ هذا الجزء بعد.
- ⚠️ رمز الستين يومًا يحتاج تجديدًا دوريًا (`ig_refresh_token`) — لم تُجدول بعد.
- ✅ حد النشر: 100 منشور لكل 24 ساعة.
