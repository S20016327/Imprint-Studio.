# الربط برمز — أسرع طريق لتشغيل النشر فعليًا

## لماذا هذا المسار موجود

مسار OAuth يحتاج `client_id` + `client_secret` + **redirect URI مطابق حرفيًا**
+ مراجعة تطبيق أحيانًا. هذا أكبر مصدر فشل عند البداية، وقد رأيناه في هذه
الجلسة أكثر من مرة. لذلك أضفنا مسارًا ثانيًا يعمل **بدون OAuth إطلاقًا**:

تنسخ رمز وصول من لوحة المنصة، تلصقه مرة واحدة، يتحقق منه الخادم فعليًا،
ثم يخزّنه **مشفّرًا في Vault** ويعرض الحساب كـ«متصل».

الرمز **لا يُحفظ في المتصفح**، ولا يُكتب في أي ملف، ولا يظهر في أي ردّ من الخادم.

## إنستقرام — الخطوات

> ⚠️ الحساب الشخصي لا يعمل مع أي API. يجب أولًا:
> إنستقرام ← الإعدادات ← نوع الحساب ← **التحويل إلى حساب احترافي** ← **Creator**.

1. [developers.facebook.com](https://developers.facebook.com) ← **Create App** ← نوع **Business**.
2. **Add Product ← Instagram ← Set up** ← اختر *API setup with Instagram business login*.
3. أضف حسابك، ثم اضغط **Generate token**.
4. انسخ الرمز (صالح 60 يومًا).
5. في الموقع: **الحسابات المرتبطة ← Instagram ← ربط برمز** ← الصق ← تحقق واحفظ.

الخادم يقرأ `/me` من `graph.instagram.com` ويتأكد أن الحساب Business/Creator
قبل الحفظ. الحساب الشخصي يُرفض برسالة صريحة.

## يوتيوب — الخطوات

1. [console.cloud.google.com](https://console.cloud.google.com) ← مشروع جديد.
2. **APIs & Services ← Library** ← فعّل **YouTube Data API v3**.
3. **Credentials ← Create credentials ← OAuth client ID** ← نوع **Web application**
   أو **Desktop app**.
4. للحصول على رمز سريع: [OAuth 2.0 Playground](https://developers.google.com/oauthplayground)
   ← اختر **YouTube Data API v3** ← نطاق `youtube.upload` ← Authorize ←
   *Exchange authorization code for tokens* ← انسخ `access_token`.
5. في الموقع: **YouTube ← ربط برمز** ← الصق ← تحقق واحفظ.

الخادم يقرأ قناتك عبر `youtube/v3/channels` ويتأكد أن هناك قناة فعلية.

> ملاحظة أحمد: رمز Google قصير (ساعة واحدة). للتشغيل المستمر أضف
> `refresh_token` في الحقل الاختياري، وسيُحفظ في Vault للاستخدام لاحقًا.

## فيسبوك وتيك توك

- **فيسبوك**: Graph API Explorer ← اختر تطبيقك ← صلاحيات `pages_show_list`
  و`pages_manage_posts` ← Generate Access Token.
- **تيك توك**: رمز من تطبيقك على TikTok for Developers مع صلاحية `video.publish`.

## ماذا يحدث تحت الغطاء

1. الواجهة ترسل `{ platform, token }` عبر `POST` إلى `imprint-account-link`.
2. الخادم يتحقق من **هوية المستخدم** (JWT) أولًا.
3. يتحقق من **الرمز** بطلب حقيقي إلى المنصة. رمز فاسد = **لا حفظ**.
4. `store_social_token()` يحفظ في **Vault** ويعيد معرّفًا فقط.
5. `social_accounts` يحفظ المعرّف والاسم والحالة.
6. أي إعادة ربط تستبدل السر، والمشغّل الجديد
   `social_accounts_vault_cleanup_on_update` **يحذف القديم** — وإلا تراكمت
   أسرار ميتة في Vault (كان تسريبًا حقيقيًا وأُغلق).

## ما تم التحقق منه فعليًا

| الفحص | النتيجة |
| --- | --- |
| الدالة تُقلع من الشبكة | **200** · `build:v1-token-link` · `booted:true` |
| رمز قصير | 400 ولا حفظ |
| رمز مرفوض من المنصة | 422 برسالة عربية + خطوات |
| إنستقرام شخصي | 422 «يلزم Business/Creator» |
| إنستقرام احترافي | 200 مع `@username` |
| الرمز في Vault | مخزّن، والرد لا يحتوي أي جزء منه |
| **إعادة الربط** | السر القديم **يُحذف** (1 → 1 لا 2) |
| فصل الحساب | السر يُحذف (1 → 0) |

## ما لم يُنفَّذ بعد

**النشر الفعلي للمحتوى** على أي منصة. الربط صار يعمل، لكن تحويل مسودة إلى
منشور يحتاج محوّل نشر لكل منصة (رفع الوسائط ← create container ← publish).

