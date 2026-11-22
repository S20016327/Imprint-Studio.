// ============================================================================
//  بصمة إبداع — بدء ربط حساب منصة (OAuth 2.0 Authorization Code)
//  Supabase Edge Function (Deno) — خادم فقط
// ----------------------------------------------------------------------------
//  يتحقق من هوية المستخدم (JWT)، يبني رابط تفويض المنصة مع state موقّع،
//  ويعيد توجيه المتصفح إليه. الأسرار لا تُرسل إلى المتصفح أبدًا.
//
//  الأوضاع:
//    ?platform=…&mode=json  → 200 + { authorizeUrl }   (يستخدمه المتصفح)
//    ?platform=…            → 302 إلى صفحة المنصة     (متوافق مع curl)
//    ?status=1 أو ?ping=1   → 200 + نسخة التشغيل والجاهزية، بلا أي سر
//
//  ⚠️ إصلاح حرج (v5): كان الاستيراد من https://esm.sh يُفشل إقلاع الدالة
//  (BOOT_ERROR / Function failed to start) لأن زمن تشغيل Deno في Supabase
//  يعتمد مواصفة npm: ولا يجلب وحدات من الشبكة لحظة الإقلاع. أي استيراد
//  بعيد هنا يعيد نفس العطل.
//
//  المتغيرات (Supabase Secrets):
//    TIKTOK_CLIENT_ID    / _SECRET / _REDIRECT_URI   (اختياري)
//    INSTAGRAM_CLIENT_ID / _SECRET / _REDIRECT_URI   (اختياري)
//    META_CLIENT_ID      / _SECRET / _REDIRECT_URI   (اختياري)
//    GOOGLE_CLIENT_ID    / _SECRET / _REDIRECT_URI   (اختياري)
//    OAUTH_STATE_SECRET  (اختياري — يُشتق تلقائيًا إن غاب)
//    IMPRINT_SITE_URL / IMPRINT_ALLOWED_ORIGIN (CORS)
//
//  المنصة غير المضبوطة تُعيد 501 برسالة واضحة بدل محاكاة ربط وهمي.
// ============================================================================

import { createClient } from 'npm:@supabase/supabase-js@2';

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
const SERVICE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
const BUILD = 'v5-npm-import';
// مفتاح توقيع state: يُستخدم OAUTH_STATE_SECRET إن وُجد، وإلا يُشتق من
// مفتاح الخدمة الموجود أصلًا في بيئة الدالة (سرّ عالي العشوائية) حتى لا
// يتوقف الربط بسبب متغيّر ناقص. الاشتقاق لا يكشف المفتاح الأصلي.
async function stateKey(): Promise<CryptoKey> {
  const explicit = Deno.env.get('OAUTH_STATE_SECRET');
  const raw = explicit && explicit.length >= 16
    ? explicit
    : 'imprint-oauth-state-v1:' + (Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? 'missing');
  return crypto.subtle.importKey(
    'raw', new TextEncoder().encode(raw),
    { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']
  );
}

/**
 * CORS: الترويسة Origin **لا تحتوي مسارًا أبدًا** (‎https://host‎ فقط).
 * لذلك نقارن الأصل (scheme + host + port) لا العنوان الكامل. كان سماح
 * `…/Imprint-Studio./` سبب فشل الطلب في المتصفح رغم أن الخادم سليم.
 */
const SITE = Deno.env.get('IMPRINT_SITE_URL') ?? 'https://s20016327.github.io/Imprint-Studio./';
// أصل إضافي مسموح صريح (نطاق بلا مسار) — يسمح بفصل النطاق عن المسار المضيف.
const EXTRA_ORIGIN = Deno.env.get('IMPRINT_ALLOWED_ORIGIN') ?? '';

function toOrigin(u: string): string {
  try { return new URL(u).origin; } catch { return ''; }
}

const ALLOWED_ORIGINS = new Set(
  [SITE, EXTRA_ORIGIN, 'http://localhost:8080', 'http://127.0.0.1:8080', 'http://localhost:5500']
    .map(toOrigin)
    .filter(Boolean) as string[]
);

function corsFor(req: Request): Record<string, string> {
  const origin = toOrigin(req.headers.get('origin') ?? '');
  // لا نُعيد '*' إطلاقًا: نُعيد أصل الطلب إن كان مسموحًا، وإلا الأصل الرسمي.
  const allow = origin && ALLOWED_ORIGINS.has(origin) ? origin : toOrigin(SITE);
  return {
    'Access-Control-Allow-Origin': allow,
    'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Max-Age': '600',
    'Vary': 'Origin'
  };
}

function json(req: Request, body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsFor(req), 'Content-Type': 'application/json' }
  });
}

/** توقيع HMAC بسيط لـ state: payload.sig */
async function signState(payload: Record<string, unknown>): Promise<string> {
  const body = btoa(JSON.stringify(payload)).replace(/=+$/, '');
  const key = await stateKey();
  const mac = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(body));
  const sig = btoa(String.fromCharCode(...new Uint8Array(mac))).replace(/=+$/, '');
  return body + '.' + sig;
}

type Provider = {
  authorizeUrl: string;
  clientId?: string;
  redirectUri?: string;
  scope: string;
  extra?: Record<string, string>;
};

function providerConfig(platform: string): Provider | null {
  const env = (k: string) => Deno.env.get(k);
  switch (platform) {
    case 'TikTok': {
      const clientId = env('TIKTOK_CLIENT_ID');
      if (!clientId) return null;
      return {
        authorizeUrl: 'https://www.tiktok.com/v2/auth/authorize/',
        clientId,
        redirectUri: env('TIKTOK_REDIRECT_URI'),
        scope: 'user.info.basic,video.publish,video.upload',
        extra: { response_type: 'code' }
      };
    }
    // Instagram عبر "Instagram Login": لا يحتاج صفحة Facebook، لكنه يحتاج
    // حسابًا احترافيًا (Business/Creator) — الحسابات الشخصية لا تدعم النشر أصلًا.
    // مضيف التفويض هو instagram.com، وليس facebook.com، والـscopes مختلفة تمامًا.
    case 'Instagram': {
      const clientId = env('INSTAGRAM_CLIENT_ID');
      if (!clientId) return null;
      return {
        authorizeUrl: 'https://www.instagram.com/oauth/authorize',
        clientId,
        redirectUri: env('INSTAGRAM_REDIRECT_URI'),
        scope: 'instagram_business_basic,instagram_business_content_publish',
        extra: { response_type: 'code', enable_fb_login: '0', force_authentication: '1' }
      };
    }
    // Facebook Login للمنشورات على الصفحات (منفصل عن Instagram)
    case 'Facebook': {
      const clientId = env('META_CLIENT_ID');
      if (!clientId) return null;
      return {
        authorizeUrl: 'https://www.facebook.com/v21.0/dialog/oauth',
        clientId,
        redirectUri: env('META_REDIRECT_URI'),
        scope: 'pages_manage_posts,pages_read_engagement,pages_show_list'
      };
    }
    case 'YouTube': {
      const clientId = env('GOOGLE_CLIENT_ID');
      if (!clientId) return null;
      return {
        authorizeUrl: 'https://accounts.google.com/o/oauth2/v2/auth',
        clientId,
        redirectUri: env('GOOGLE_REDIRECT_URI'),
        scope: 'https://www.googleapis.com/auth/youtube.upload https://www.googleapis.com/auth/youtube.readonly',
        extra: { access_type: 'offline', prompt: 'consent', response_type: 'code' }
      };
    }
    default:
      return null;
  }
}

const PLATFORM_HINT: Record<string, string> = {
  TikTok: 'اربط تطبيقًا على TikTok for Developers واحصل على Client Key/Secret، ثم اضبط TIKTOK_CLIENT_ID وTIKTOK_CLIENT_SECRET وTIKTOK_REDIRECT_URI.',
  Instagram: 'حوّل حساب إنستقرام إلى Creator/Business، أنشئ تطبيق Meta من نوع Business وأضف منتج Instagram، ثم اضبط INSTAGRAM_CLIENT_ID وINSTAGRAM_CLIENT_SECRET وINSTAGRAM_REDIRECT_URI.',
  Facebook: 'أنشئ تطبيق Meta وأضف صلاحية pages_manage_posts، ثم اضبط META_CLIENT_ID وMETA_CLIENT_SECRET وMETA_REDIRECT_URI.',
  YouTube: 'فعّل YouTube Data API v3 في Google Cloud وأنشئ OAuth Client، ثم اضبط GOOGLE_CLIENT_ID وGOOGLE_CLIENT_SECRET وGOOGLE_REDIRECT_URI.'
};

function reasonFor(platform: string): string {
  return `ربط ${platform} غير مهيّأ على الخادم: ${PLATFORM_HINT[platform] ?? ''}`;
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsFor(req) });

  const url = new URL(req.url);
  const platform = url.searchParams.get('platform') ?? '';
  const origin = url.searchParams.get('origin') ?? '';

  // 0) نقطة تشخيص عامة (بلا أسرار). الوصول إليها يعني أن الإقلاع نجح.
  if (url.searchParams.has('status') || url.searchParams.has('ping') || !platform) {
    const has = (k: string) => !!Deno.env.get(k);
    const readiness = {
      TikTok:    has('TIKTOK_CLIENT_ID') && has('TIKTOK_CLIENT_SECRET'),
      Instagram: has('INSTAGRAM_CLIENT_ID') && has('INSTAGRAM_CLIENT_SECRET'),
      Facebook:  has('META_CLIENT_ID') && has('META_CLIENT_SECRET'),
      YouTube:   has('GOOGLE_CLIENT_ID') && has('GOOGLE_CLIENT_SECRET')
    };
    return json(req, {
      ok: true,
      service: 'imprint-oauth-start',
      build: BUILD,
      booted: true,
      stateSecretConfigured: true,
      redirectUris: {
        Instagram: Deno.env.get('INSTAGRAM_REDIRECT_URI') ?? null,
        TikTok: Deno.env.get('TIKTOK_REDIRECT_URI') ?? null,
        Facebook: Deno.env.get('META_REDIRECT_URI') ?? null,
        YouTube: Deno.env.get('GOOGLE_REDIRECT_URI') ?? null
      },
      ready: readiness,
      hints: PLATFORM_HINT
    });
  }

  if (!['TikTok', 'Instagram', 'Facebook', 'YouTube'].includes(platform)) {
    return json(req, { error: 'منصة غير معروفة.' }, 400);
  }

  // 1) تحقق من هوية المستخدم عبر توكنه
  const auth = req.headers.get('authorization') ?? '';
  const token = auth.replace(/^Bearer\s+/i, '');
  if (!token) return json(req, { error: 'يلزم تسجيل الدخول.' }, 401);

  const admin = createClient(SUPABASE_URL, SERVICE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false }
  });
  const { data: userData, error: userErr } = await admin.auth.getUser(token);
  if (userErr || !userData?.user) return json(req, { error: 'جلسة غير صالحة.' }, 401);
  const userId = userData.user.id;

  // 2) هل المنصة مهيّأة فعليًا؟
  const cfg = providerConfig(platform);
  if (!cfg) {
    return json(req, {
      error: reasonFor(platform),
      reason: 'not_configured',
      platform
    }, 501);
  }

  // 3) state موقّع يحتوي المستخدم والمنصة والوقت
  const state = await signState({
    uid: userId, platform, origin,
    iat: Date.now(), nonce: crypto.randomUUID()
  });

  const target = new URL(cfg.authorizeUrl);
  target.searchParams.set('client_id', cfg.clientId!);
  if (cfg.redirectUri) target.searchParams.set('redirect_uri', cfg.redirectUri);
  target.searchParams.set('scope', cfg.scope);
  target.searchParams.set('state', state);
  for (const [k, v] of Object.entries(cfg.extra ?? {})) target.searchParams.set(k, v);

  // الوضع الافتراضي للمتصفح: ردّ JSON يحوي الرابط، ثم يتنقّل العميل بنفسه.
  // السبب: fetch مع redirect:'manual' يعيد استجابة opaque في المتصفح
  // (status = 0 وترويسات غير قابلة للقراءة)، فلا يمكن قراءة Location إطلاقًا.
  const wantsJson = url.searchParams.get('mode') === 'json' || req.method === 'POST';
  if (wantsJson) {
    return json(req, { ok: true, platform, authorizeUrl: target.toString() });
  }

  return new Response(null, {
    status: 302,
    headers: { ...corsFor(req), Location: target.toString() }
  });
});
