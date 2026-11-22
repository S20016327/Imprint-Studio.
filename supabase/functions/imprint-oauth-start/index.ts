// ============================================================================
//  بصمة إبداع — بدء ربط حساب منصة (OAuth 2.0 Authorization Code)
//  Supabase Edge Function (Deno) — خادم فقط
// ----------------------------------------------------------------------------
//  يتحقق من هوية المستخدم (JWT)، يبني رابط تفويض المنصة مع state موقّع،
//  ويعيد توجيه المتصفح إليه. الأسرار لا تُرسل إلى المتصفح أبدًا.
//
//  المتغيرات المطلوبة في بيئة الدالة (Supabase Secrets):
//    OAUTH_STATE_SECRET   سر عشوائي طويل لتوقيع state (منع CSRF/إعادة الاستخدام)
//    TIKTOK_CLIENT_ID    / TIKTOK_CLIENT_SECRET    / TIKTOK_REDIRECT_URI      (اختياري)
//    INSTAGRAM_CLIENT_ID / INSTAGRAM_CLIENT_SECRET / INSTAGRAM_REDIRECT_URI   (اختياري)
//    META_CLIENT_ID      / META_CLIENT_SECRET      / META_REDIRECT_URI        (اختياري)
//    GOOGLE_CLIENT_ID    / GOOGLE_CLIENT_SECRET    / GOOGLE_REDIRECT_URI      (اختياري)
//
//  لا تعمل المنصة إلا إذا كانت متغيراتها مضبوطة فعليًا. الغياب ليس خطأً صامتًا:
//  تعيد الدالة 501 برسالة واضحة بدل محاكاة ربط وهمي.
// ============================================================================

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.45.4';

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
const SERVICE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
const STATE_SECRET = Deno.env.get('OAUTH_STATE_SECRET') ?? '';

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS'
};

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS, 'Content-Type': 'application/json' }
  });
}

/** توقيع HMAC بسيط لـ state: payload.sig */
async function signState(payload: Record<string, unknown>): Promise<string> {
  const body = btoa(JSON.stringify(payload)).replace(/=+$/, '');
  const key = await crypto.subtle.importKey(
    'raw', new TextEncoder().encode(STATE_SECRET),
    { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']
  );
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

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });

  const url = new URL(req.url);
  const platform = url.searchParams.get('platform') ?? '';
  const origin = url.searchParams.get('origin') ?? '';

  if (!['TikTok', 'Instagram', 'Facebook', 'YouTube'].includes(platform)) {
    return json({ error: 'منصة غير معروفة.' }, 400);
  }
  if (!STATE_SECRET) {
    return json({ error: 'OAUTH_STATE_SECRET غير مضبوط على الخادم.' }, 500);
  }

  // 1) تحقق من هوية المستخدم عبر توكنه
  const auth = req.headers.get('authorization') ?? '';
  const token = auth.replace(/^Bearer\s+/i, '');
  if (!token) return json({ error: 'يلزم تسجيل الدخول.' }, 401);

  const admin = createClient(SUPABASE_URL, SERVICE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false }
  });
  const { data: userData, error: userErr } = await admin.auth.getUser(token);
  if (userErr || !userData?.user) return json({ error: 'جلسة غير صالحة.' }, 401);
  const userId = userData.user.id;

  // 2) هل المنصة مهيّأة فعليًا؟
  const cfg = providerConfig(platform);
  if (!cfg) {
    return json({
      error: `ربط ${platform} غير مهيّأ: يلزم تسجيل تطبيق مطوّر وضبط ` +
             `client_id و client_secret في أسرار الدالة.`
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

  return new Response(null, {
    status: 302,
    headers: { ...CORS, Location: target.toString() }
  });
});
