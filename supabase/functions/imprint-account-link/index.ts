// ============================================================================
//  بصمة إبداع — ربط حساب برمز وصول مباشر (مسار بديل عن OAuth)
//  Supabase Edge Function (Deno) — خادم فقط
// ----------------------------------------------------------------------------
//  لماذا؟ مسار OAuth يتطلب تسجيل redirect_uri مطابقًا حرفيًا ومراجعة تطبيق،
//  وهو أكثر ما يفشل عند البدء. هذا المسار يعمل حتى لو تعطّل OAuth تمامًا:
//  المستخدم يُنشئ رمزًا من لوحة المنصة ويلصقه مرة واحدة، ونتحقق منه فعليًا
//  قبل حفظه. لا يُحفظ أي رمز فاسد، ولا يظهر الرمز في أي ردّ.
//
//  الأمان:
//   - يتحقق من هوية المستخدم عبر توكنه (JWT) قبل أي عملية.
//   - يتحقق من صلاحية الرمز لدى المنصة (طلب /me) قبل الحفظ.
//   - يخزّن الرمز في Vault عبر store_social_token ويعيد معرّفه فقط.
//   - لا يقبل قراءة أي رمز محفوظ، ولا يعيده أبدًا.
//
//  ⚠️ لا تستورد من https:// هنا: يقتل إقلاع الدالة (BOOT_ERROR).
// ============================================================================

import { createClient } from 'npm:@supabase/supabase-js@2';

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
const SERVICE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
const BUILD = 'v1-token-link';

const SITE = Deno.env.get('IMPRINT_SITE_URL') ?? 'https://s20016327.github.io/Imprint-Studio./';
const EXTRA_ORIGIN = Deno.env.get('IMPRINT_ALLOWED_ORIGIN') ?? '';

function toOrigin(u: string): string {
  try { return new URL(u).origin; } catch { return ''; }
}

const ALLOWED_ORIGINS = new Set(
  [SITE, EXTRA_ORIGIN, 'http://localhost:8080', 'http://127.0.0.1:8080']
    .map(toOrigin).filter(Boolean) as string[]
);

function corsFor(req: Request): Record<string, string> {
  const origin = toOrigin(req.headers.get('origin') ?? '');
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

type Identity = {
  accountId: string;
  displayName?: string;
  expiresIn?: number;
  refresh?: string;
  scopes?: string[];
};

// أين يحصل المستخدم على رمز صالح من كل منصة (يُستخدم في الرسائل أيضًا).
const TOKEN_HELP: Record<string, { where: string; steps: string[] }> = {
  YouTube: {
    where: 'Google Cloud Console ← APIs & Services ← Credentials',
    steps: [
      'أنشئ مشروعًا وفعّل YouTube Data API v3.',
      'أنشئ OAuth client من نوع Desktop أو Web.',
      'استخدم OAuth 2.0 Playground: اختر YouTube Data API v3 وامنح نطاق youtube.upload.',
      'Exchange authorization code for tokens، ثم انسخ access_token والصقه هنا.'
    ]
  },
  Instagram: {
    where: 'developers.facebook.com ← تطبيقك ← Instagram ← API setup with Instagram business login',
    steps: [
      'حوّل حساب إنستقرام إلى Creator أو Business أولًا (إلزامي).',
      'أضف حسابك ثم اضغط Generate token.',
      'انسخ الرمز كاملًا والصقه هنا — صالح 60 يومًا.'
    ]
  },
  Facebook: {
    where: 'developers.facebook.com ← Graph API Explorer',
    steps: [
      'اختر تطبيقك، وأضف صلاحيتي pages_show_list و pages_manage_posts.',
      'Generate Access Token ثم انسخ الرمز والصقه هنا.'
    ]
  },
  TikTok: {
    where: 'developers.tiktok.com ← تطبيقك ← Content Posting API',
    steps: [
      'احصل على رمز وصول عبر OAuth لتطبيقك.',
      'تأكد من تفعيل صلاحية video.publish.',
      'الصق الرمز هنا.'
    ]
  }
};

/** رسائل الخطأ العربية لكل حالة معروفة من كل منصة. */
const REASONS_AR: Array<[RegExp, string]> = [
  [/invalid_grant|invalid_token|malformed|Cannot parse access token/i,
    'الرمز غير صالح أو منتهي. أنشئ رمزًا جديدًا من لوحة المنصة وانسهخه كاملًا.'],
  [/expired/i, 'انتهت صلاحية الرمز. أنشئ رمزًا جديدًا.'],
  [/permission|scope|insufficient/i,
    'الرمز لا يملك الصلاحيات المطلوبة للنشر. أعد إنشاءه مع صلاحية النشر (publish).'],
  [/account type|not a business|professional/i,
    'هذا الحساب شخصي. يلزم حساب Business أو Creator للنشر عبر الواجهة البرمجية.'],
  [/OAuthException|401|403/i, 'المنصة رفضت الرمز. تأكد أنه صادر لنفس التطبيق وأنه لم يُلغَ.'],
  [/fetch failed|network|ENOTFOUND|timeout/i, 'تعذر الوصول إلى المنصة من الخادم. أعد المحاولة بعد قليل.']
];

/**
 * يحوّل خطأ المنصة إلى جملة عربية مفهومة، مع إبقاء الأصل بين قوسين حتى
 * يبقى قابلاً للتشخيص. لا نُمرّر نصًا إنجليزيًا خامًا كرسالة وحيدة أبدًا.
 */
function humanReason(raw: string, platform: string): string {
  for (const [re, ar] of REASONS_AR) if (re.test(raw)) return ar;
  const hint = TOKEN_HELP[platform]?.where ? ` أنشئ الرمز من: ${TOKEN_HELP[platform].where}.` : '';
  return `رفضت المنصة الرمز.${hint} (التفصيل: ${raw.slice(0, 120)})`;
}

/** يتحقق من رمز إنستقرام ويعيد هوية الحساب. */
async function verifyInstagram(token: string): Promise<Identity> {
  const url = new URL('https://graph.instagram.com/v26.0/me');
  url.searchParams.set('fields', 'user_id,username,account_type');
  url.searchParams.set('access_token', token);
  const r = await fetch(url);
  const d = await r.json();
  if (!r.ok || d.error) {
    throw new Error(d?.error?.message ?? 'رفض إنستقرام الرمز.');
  }
  if (d.account_type && !/BUSINESS|CREATOR|MEDIA_CREATOR/i.test(d.account_type)) {
    throw new Error('Account type not supported — هذا الحساب شخصي.');
  }
  return {
    accountId: String(d.user_id ?? ''),
    displayName: d.username ? '@' + d.username : undefined
  };
}

/** يتحقق من رمز يوتيوب عبر قناة المستخدم. */
async function verifyYouTube(token: string): Promise<Identity> {
  const r = await fetch('https://www.googleapis.com/youtube/v3/channels?part=snippet&mine=true',
    { headers: { Authorization: 'Bearer ' + token } });
  const d = await r.json();
  if (!r.ok || d.error) {
    throw new Error(d?.error?.message ?? 'رفض Google الرمز.');
  }
  if (!d.items || !d.items.length) {
    throw new Error('لا توجد قناة يوتيوب مرتبطة بهذا الحساب.');
  }
  return { accountId: String(d.items[0].id), displayName: d.items[0].snippet?.title };
}

/** يتحقق من رمز صفحة فيسبوك. */
async function verifyFacebook(token: string): Promise<Identity> {
  const me = await fetch('https://graph.facebook.com/v21.0/me?fields=id,name&access_token=' + encodeURIComponent(token));
  const md = await me.json();
  if (!me.ok || md.error) throw new Error(md?.error?.message ?? 'رفض Facebook الرمز.');

  // إن كان الرمز لصفحة، نستخدم الصفحة كحساب منشور عليه
  const pages = await fetch('https://graph.facebook.com/v21.0/me/accounts?access_token=' + encodeURIComponent(token));
  const pd = await pages.json();
  const page = pd?.data?.[0];
  if (page?.id) return { accountId: String(page.id), displayName: page.name };
  return { accountId: String(md.id), displayName: md.name };
}

/** يتحقق من رمز تيك توك عبر user info. */
async function verifyTikTok(token: string): Promise<Identity> {
  const r = await fetch('https://open.tiktokapis.com/v2/user/info/?fields=open_id,display_name',
    { headers: { Authorization: 'Bearer ' + token } });
  const d = await r.json();
  if (!r.ok || (d.error && d.error.code && d.error.code !== 'ok')) {
    throw new Error(d?.error?.message ?? 'رفض TikTok الرمز.');
  }
  const u = d.data?.user;
  if (!u?.open_id) throw new Error('لم يُعِد TikTok هوية حساب صالحة.');
  return { accountId: String(u.open_id), displayName: u.display_name };
}

const VERIFIERS: Record<string, (t: string) => Promise<Identity>> = {
  Instagram: verifyInstagram,
  YouTube: verifyYouTube,
  Facebook: verifyFacebook,
  TikTok: verifyTikTok
};

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsFor(req) });

  const url = new URL(req.url);

  // فحص إقلاع عام: لا يكشف شيئًا سوى أن الدالة تعمل
  if (url.searchParams.has('ping') || req.method === 'GET') {
    return json(req, {
      ok: true,
      service: 'imprint-account-link',
      build: BUILD,
      booted: true,
      accepts: ['POST'],
      platforms: Object.keys(VERIFIERS),
      help: TOKEN_HELP
    });
  }

  if (req.method !== 'POST') return json(req, { error: 'استخدم POST.' }, 405);

  // 1) هوية المستخدم
  const auth = req.headers.get('authorization') ?? '';
  const jwt = auth.replace(/^Bearer\s+/i, '');
  if (!jwt) return json(req, { error: 'يلزم تسجيل الدخول.' }, 401);

  const admin = createClient(SUPABASE_URL, SERVICE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false }
  });
  const { data: userData, error: userErr } = await admin.auth.getUser(jwt);
  if (userErr || !userData?.user) return json(req, { error: 'جلسة غير صالحة.' }, 401);
  const ownerId = userData.user.id;

  // 2) المدخلات
  let body: { platform?: string; token?: string; refresh?: string; expiresIn?: number };
  try { body = await req.json(); } catch { return json(req, { error: 'جسم الطلب غير صالح.' }, 400); }

  const platform = String(body.platform ?? '');
  const token = String(body.token ?? '').trim();
  const refresh = body.refresh ? String(body.refresh).trim() : '';

  if (!VERIFIERS[platform]) return json(req, { error: 'منصة غير معروفة.' }, 400);
  if (token.length < 20) return json(req, { error: 'الرمز قصير جدًا — تأكد من نسخه كاملًا.' }, 400);
  if (token.length > 4096) return json(req, { error: 'الرمز أطول من المتوقع.' }, 400);

  // 3) تحقق فعلي من الرمز قبل أي حفظ
  let identity: Identity;
  try {
    identity = await VERIFIERS[platform](token);
  } catch (e) {
    const raw = (e as Error).message || 'تعذر التحقق من الرمز.';
    return json(req, {
      error: humanReason(raw, platform),
      reason: 'verification_failed',
      platform,
      help: TOKEN_HELP[platform]
    }, 422);
  }

  try {
    // 4) حفظ الرمز في Vault — معرّفه فقط يعود
    const accessId = await admin.rpc('store_social_token', {
      p_owner_id: ownerId, p_platform: platform, p_token: token, p_label: 'access'
    });
    if (accessId.error) throw accessId.error;

    let refreshId: string | null = null;
    if (refresh.length >= 10) {
      const r2 = await admin.rpc('store_social_token', {
        p_owner_id: ownerId, p_platform: platform, p_token: refresh, p_label: 'refresh'
      });
      if (!r2.error) refreshId = r2.data as unknown as string;
    }

    const expiresAt = body.expiresIn && body.expiresIn > 0
      ? new Date(Date.now() + body.expiresIn * 1000).toISOString()
      : null;

    // 5) صف الحساب (المشغّل يحذف السر القديم عند الاستبدال)
    const { error: upsertErr } = await admin.from('social_accounts').upsert({
      owner_id: ownerId,
      platform,
      external_account_id: identity.accountId || ownerId,
      display_name: identity.displayName ?? null,
      access_secret_id: accessId.data,
      refresh_secret_id: refreshId,
      scopes: identity.scopes ?? [],
      status: 'connected',
      expires_at: expiresAt,
      last_error: null
    }, { onConflict: 'owner_id,platform,external_account_id' });
    if (upsertErr) throw upsertErr;

    // 6) الردّ: بيانات الحساب فقط، بلا أي جزء من الرمز
    return json(req, {
      ok: true,
      platform,
      account: {
        id: identity.accountId,
        name: identity.displayName ?? null
      },
      hasRefreshToken: !!refreshId,
      expiresAt
    });
  } catch (e) {
    return json(req, {
      error: 'تعذر حفظ الرمز على الخادم: ' + ((e as Error).message || '').slice(0, 120),
      reason: 'storage_failed'
    }, 500);
  }
});
