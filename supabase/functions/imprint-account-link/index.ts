// بصمة إبداع — ربط حساب برمز وصول مباشر (v3-compact)
// POST { platform, token, refresh?, expiresIn? }  +  Authorization: Bearer <JWT>
// GET  ?ping=1  → فحص إقلاع
// ⚠️ لا تستورد من https:// هنا — يقتل إقلاع الدالة (BOOT_ERROR).
import { createClient } from 'npm:@supabase/supabase-js@2';

const URL_ = Deno.env.get('SUPABASE_URL')!;
const KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
const SITE = Deno.env.get('IMPRINT_SITE_URL') ?? 'https://s20016327.github.io/Imprint-Studio./';
const EXTRA = Deno.env.get('IMPRINT_ALLOWED_ORIGIN') ?? '';
const BUILD = 'v4-google-reason';
const V = 'v26.0';

const admin = createClient(URL_, KEY, { auth: { persistSession: false } });

const origin = (u: string) => { try { return new URL(u).origin; } catch { return ''; } };
const ORIGINS = new Set([SITE, EXTRA, 'http://localhost:8080', 'http://127.0.0.1:8080'].map(origin).filter(Boolean));

function cors(req: Request) {
  const o = origin(req.headers.get('origin') ?? '');
  return {
    'Access-Control-Allow-Origin': o && ORIGINS.has(o) ? o : origin(SITE),
    'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Vary': 'Origin',
  };
}
const json = (req: Request, b: unknown, s = 200) =>
  new Response(JSON.stringify(b), { status: s, headers: { ...cors(req), 'Content-Type': 'application/json' } });

const HELP: Record<string, { where: string; steps: string[] }> = {
  Instagram: {
    where: 'developers.facebook.com ← تطبيقك ← Instagram ← إعداد API مع تسجيل الدخول الموحّد',
    steps: [
      'حوّل الحساب إلى Business أو Creator (الحساب الشخصي لا يعمل مع أي API).',
      'Use cases ← Local messaging and content management for Instagram ← Customize.',
      'Generate access tokens ← Add account ← Generate token.',
      'انسخ الرمز كاملًا — يبدأ بـ EAA (موحّد) أو IGAA (إنستقرام).',
    ],
  },
  Facebook: {
    where: 'developers.facebook.com ← Graph API Explorer',
    steps: ['أضف pages_show_list و pages_manage_posts.', 'Generate Access Token.', 'تأكد أن الحساب يملك صفحة.'],
  },
  YouTube: {
    where: 'OAuth Playground (لا Credentials)',
    steps: [
      'الأفضل: زر «ربط» أمام YouTube — الربط عبر OAuth منشور وجاهز.',
      'وإن أردت يدويًّا: developers.google.com/oauthplayground ← الخانة ← https://www.googleapis.com/auth/youtube.upload ← Authorize.',
      'Exchange authorization code for tokens ← انسخ access_token (ينتهي خلال ساعة).',
    ],
  },
  TikTok: {
    where: 'developers.tiktok.com ← Content Posting API',
    steps: ['احصل على رمز عبر OAuth لتطبيقك.', 'فعّل صلاحية video.publish.', 'الصق الرمز هنا.'],
  },
};

const REASONS_AR: Array<[RegExp, string]> = [
  // ⚠️ رسالة Google هذه تعني: لم يصل رمز OAuth إلى المناداة إطلاقًا.
  // الرسالة القديمة كانت تُرسل المستخدم إلى Credentials، وهي تُنشئ
  // Client ID/Secret لا رمز وصول — الطريق الخطأ تمامًا. نُصحّحها.
  [/Expected OAuth 2 access token|invalid authentication credentials/i,
    'ما وصل إلى Google ليس رمز وصول. الأفضل: استخدم زر «ربط» أمام YouTube ' +
    '(ربط OAuth جاهز على الخادم). والبديل اليدوي هو OAuth Playground بنطاق youtube.upload — ' +
    'لا Credentials، فهي تعطيك Client ID وSecret وليس رمز وصول.'],
  [/invalid_grant|invalid_token|malformed|Cannot parse access token/i,
    'الرمز غير صالح أو منتهي. أنشئ رمزًا جديدًا من لوحة المنصة وانسخه كاملًا.'],
  [/expired|Session has expired/i, 'انتهت صلاحية الرمز. أنشئ رمزًا جديدًا.'],
  [/permission|scope|insufficient|\(#10\)/i,
    'الرمز لا يملك الصلاحيات المطلوبة للنشر. أعد إنشاءه مع صلاحية النشر (publish).'],
  [/account type|not a business|professional/i,
    'هذا الحساب شخصي. يلزم حساب Business أو Creator للنشر عبر الواجهة البرمجية.'],
  [/Unsupported get request/i,
    'هذا الرمز يخص نطاقًا آخر (رمز EAA يعمل على graph.facebook.com). أعد الربط — الخادم يختار النطاق تلقائيًا.'],
  [/لا يوجد حساب إنستقرام مسند/i,
    'لا يوجد حساب إنستقرام مسند لهذا الرمز. أضف الحساب في Generate access tokens ثم أعد التوليد.'],
  [/OAuthException|401|403/i, 'المنصة رفضت الرمز. تأكد أنه صادر لنفس التطبيق وأنه لم يُلغَ.'],
  [/fetch failed|network|ENOTFOUND|timeout/i, 'تعذر الوصول إلى المنصة من الخادم. أعد المحاولة بعد قليل.'],
];

function humanReason(raw: string, platform: string): string {
  for (const [re, ar] of REASONS_AR) if (re.test(raw)) return ar;
  const hint = HELP[platform]?.where ? ` أنشئ الرمز من: ${HELP[platform].where}.` : '';
  return `رفضت المنصة الرمز.${hint} (التفصيل: ${raw.slice(0, 120)})`;
}

type Identity = {
  accountId: string;
  displayName?: string;
  scopes?: string[];
  /** النطاق الذي يعمل عليه الرمز — يُختار من بادئته لا افتراضًا. */
  apiHost?: string;
  notes?: string;
  /** رمز الصفحة — يُحفظ بدل رمز المستخدم لأنه الأصلح للنشر بصفة الصفحة. */
  pageToken?: string;
};

/** IGAA… (Instagram Login) — صالح 60 يومًا، على graph.instagram.com */
async function igLogin(t: string): Promise<Identity> {
  const r = await fetch(
    'https://graph.instagram.com/' + V + '/me?fields=user_id,username,account_type&access_token=' + encodeURIComponent(t)
  );
  const d = await r.json();
  if (!r.ok || d.error) throw new Error(d?.error?.message ?? 'رفض إنستقرام الرمز.');
  if (d.account_type && !/BUSINESS|CREATOR|MEDIA_CREATOR/i.test(d.account_type)) {
    throw new Error('Account type not supported');
  }
  return {
    accountId: String(d.user_id ?? ''),
    displayName: d.username ? '@' + d.username : undefined,
    scopes: ['instagram_business_basic'],
    apiHost: 'graph.instagram.com',
    notes: 'Instagram Login (IGAA) — صالح 60 يومًا.',
  };
}

/** EAA… (تسجيل الدخول الموحّد) — على graph.facebook.com فقط. */
async function igUnified(t: string): Promise<Identity> {
  const base = 'https://graph.facebook.com/' + V;
  const r = await fetch(base + '/me/assigned_instagram_accounts?fields=id,username,name&access_token=' + encodeURIComponent(t));
  const d = await r.json();
  if (!r.ok || d.error) throw new Error(d?.error?.message ?? 'تعذر جلب الحسابات المسندة.');
  const acc = d?.data?.[0];
  if (!acc) throw new Error('لا يوجد حساب إنستقرام مسند لهذا الرمز.');
  return {
    accountId: String(acc.id),
    displayName: acc.username ? '@' + acc.username : acc.name,
    scopes: ['instagram_basic', 'instagram_content_publish'],
    apiHost: 'graph.facebook.com',
    notes: 'Unified Login (EAA) — لا ينتهي، على graph.facebook.com.',
  };
}

/**
 * صفحات فيسبوك — نُشخّص سبب «لا توجد صفحة» بدل تخمينه.
 *
 * `/me/accounts` يُعيد قائمة فارغة لسببين مختلفين تمامًا:
 *  (أ) الرمز لا يحمل pages_show_list  → المشكلة في الصلاحيات
 *  (ب) الصلاحية موجودة لكن لا صفحة مسندة لهذا المستخدم/مستخدم النظام
 *
 * نتحقق من الصلاحيات في (أ) ونعرض الأصول في (ب)، فتصل الرسالة بسبب محدد
 * لا بجملة عامة تترك المستخدم يدور في نفس الخطوات.
 *
 * الصفحة الآن تُخزَّن بـ external_account_id = معرّف الصفحة، وباسم واضح،
 * ونرفض الصفحة التي لا تملك صلاحية CREATE_CONTENT بدل ترك النشر يفشل لاحقًا.
 */
async function fbPage(t: string, wantPage?: string): Promise<Identity> {
  const base = 'https://graph.facebook.com/' + V;
  const q = (u: string) => u + (u.includes('?') ? '&' : '?') + 'access_token=' + encodeURIComponent(t);

  const me = await fetch(q(base + '/me?fields=id,name'));
  const md = await me.json();
  if (!me.ok || md.error) throw new Error(md?.error?.message ?? 'رفض Facebook الرمز.');

  // هل توجد صلاحية pages_show_list أصلًا؟
  let scopes: string[] = [];
  try {
    const p = await fetch(q(base + '/me/permissions'));
    const pd = await p.json();
    scopes = (pd?.data ?? []).filter((x: any) => x.status === 'granted').map((x: any) => String(x.permission));
  } catch { /* التشخيص تحسين لا شرط */ }

  const hasShowList = scopes.includes('pages_show_list');
  const hasManagePosts = scopes.includes('pages_manage_posts');

  const pagesRes = await fetch(q(base + '/me/accounts?fields=id,name,access_token,tasks'));
  const pd = await pagesRes.json();
  const list: any[] = pd?.data ?? [];

  if (!list.length) {
    if (!scopes.length) {
      throw new Error(
        'الرمز لا يملك صلاحية pages_show_list، لذلك لا يمكن قراءة صفحتك. ' +
        'أعد إنشاء الرمز مع pages_show_list و pages_manage_posts، وتأكد من إضافة الصفحة ' +
        'إلى مستخدم النظام في business.facebook.com ← مستخدمو النظام ← إضافة أصول ← صفحات.'
      );
    }
    if (!hasShowList) {
      throw new Error(
        'الرمز لا يملك pages_show_list (الصلاحيات الحالية: ' + (scopes.join(', ') || 'لا شيء') + '). ' +
        'أعد إنشاء الرمز معها.'
      );
    }
    throw new Error(
      'الصلاحية pages_show_list موجودة، لكن لا صفحة مسندة لهذا الرمز. ' +
      'أضف الصفحة: business.facebook.com ← مستخدمو النظام ← إضافة أصول ← صفحات ← ' +
      'اختر صفحتك ← احفظ، ثم أنشئ رمزًا جديدًا (الرمز القديم لا يرى ما أُسند بعده).'
    );
  }

  // اختيار الصفحة: بالاسم إن طُلب، وإلا الأولى القابلة للنشر
  const usable = list.filter((p) => {
    const tasks: string[] = p?.tasks ?? [];
    // بعض الرموز لا تُعيد tasks — لا نرفضها لهذا السبب وحده
    return !tasks.length || tasks.includes('CREATE_CONTENT');
  });

  if (!usable.length) {
    throw new Error(
      'الصفحة موجودة لكنك لا تملك صلاحية «إنشاء محتوى» عليها. ' +
      'اطلب دورًا إداريًا في الصفحة: business.facebook.com ← إعدادات الصفحة ← أدوار الصفحة.'
    );
  }

  const page = wantPage
    ? (usable.find((p) => String(p.name ?? '').toLowerCase() === wantPage.toLowerCase()) ?? usable[0])
    : usable[0];

  if (wantPage && page && String(page.name ?? '').toLowerCase() !== wantPage.toLowerCase()) {
    // لم نجد الاسم المطلوب — نُخبر بأسماء الصفحات المتاحة بدل اختيار صامت
    throw new Error(
      'الصفحة «' + wantPage + '» غير موجودة لهذا الرمز. الصفحات المتاحة: ' +
      usable.map((p) => p.name).join('، ') + '.'
    );
  }

  // رمز الصفحة أقوى وأدق من رمز المستخدم للنشر بصفة الصفحة.
  // يُحفظ في refresh_secret_id ليلتقطه العامل ويستخدمه.
  return {
    accountId: String(page.id),
    displayName: page.name,
    scopes: hasManagePosts ? ['pages_manage_posts'] : ['pages_show_list'],
    apiHost: 'graph.facebook.com',
    pageToken: page.access_token ? String(page.access_token) : undefined,
    notes: hasManagePosts
      ? 'صفحة فيسبوك: ' + page.name
      : 'تحذير: الرمز لا يحمل pages_manage_posts — النشر قد يُرفض. أعد إنشاء الرمز معها.',
  };
}

async function yt(t: string): Promise<Identity> {
  const r = await fetch('https://www.googleapis.com/youtube/v3/channels?part=snippet&mine=true', {
    headers: { Authorization: 'Bearer ' + t },
  });
  const d = await r.json();
  if (!r.ok || d.error) throw new Error(d?.error?.message ?? 'رفض Google الرمز.');
  if (!d.items?.length) throw new Error('لا توجد قناة يوتيوب مرتبطة بهذا الحساب.');
  return { accountId: String(d.items[0].id), displayName: d.items[0].snippet?.title, scopes: ['youtube.upload'] };
}

async function tt(t: string): Promise<Identity> {
  const r = await fetch('https://open.tiktokapis.com/v2/user/info/?fields=open_id,display_name,username', {
    headers: { Authorization: 'Bearer ' + t },
  });
  const d = await r.json();
  if (!r.ok || (d?.error?.code && d.error.code !== 'ok') || !d?.data?.user) {
    throw new Error(d?.error?.message ?? 'رفض TikTok الرمز.');
  }
  const u = d.data.user;
  return {
    accountId: String(u.open_id ?? ''),
    displayName: u.display_name ?? (u.username ? '@' + u.username : undefined),
    scopes: ['video.publish'],
  };
}

const VERIFIERS: Record<string, (t: string) => Promise<Identity>> = {
  // البادئة تحدّد النطاق: رمز موحّد على نطاق إنستقرام يعيد
  // «Unsupported get request» — وهذا كان أصل فشل الربط.
  Instagram: (t) => (t.startsWith('EAA') ? igUnified(t) : igLogin(t)),
  Facebook: (t) => fbPage(t),
  YouTube: yt,
  TikTok: tt,
};

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors(req) });

  if (req.method === 'GET') {
    return json(req, {
      ok: true,
      service: 'imprint-account-link',
      build: BUILD,
      booted: true,
      platforms: Object.keys(VERIFIERS),
      help: HELP,
    });
  }
  if (req.method !== 'POST') return json(req, { error: 'الطريقة غير مدعومة.' }, 405);

  const jwt = (req.headers.get('Authorization') ?? '').replace(/^Bearer\s+/i, '');
  if (!jwt) return json(req, { error: 'يلزم تسجيل الدخول.' }, 401);
  const { data: u } = await admin.auth.getUser(jwt);
  if (!u?.user) return json(req, { error: 'جلسة غير صالحة.' }, 401);
  const ownerId = u.user.id;

  let body: any;
  try { body = await req.json(); } catch { return json(req, { error: 'طلب غير صالح.' }, 400); }

  const platform = String(body?.platform ?? '');
  const token = String(body?.token ?? '').trim();
  const refresh = String(body?.refresh ?? '').trim();

  if (!VERIFIERS[platform]) return json(req, { error: 'منصة غير معروفة.', platforms: Object.keys(VERIFIERS) }, 400);
  if (token.length < 20) return json(req, { error: 'الرمز قصير جدًا — انسخه كاملًا.', reason: 'too_short' }, 400);
  if (token.length > 4096) return json(req, { error: 'الرمز أطول من المتوقع.', reason: 'too_long' }, 400);

  let id: Identity;
  try {
    id = await VERIFIERS[platform](token);
  } catch (e) {
    const raw = (e as Error).message || 'تعذّر التحقق.';
    // لا حفظ عند الفشل: لا نكتب شيئًا في Vault ولا في social_accounts
    return json(req, {
      error: humanReason(raw, platform),
      reason: 'verification_failed',
      platform,
      help: HELP[platform],
    }, 422);
  }

  try {
    const acc = await admin.rpc('store_social_token', {
      p_owner_id: ownerId, p_platform: platform, p_token: token, p_label: 'access',
    });
    if (acc.error) throw acc.error;

    let refreshId: string | null = null;

    // رمز الصفحة يحلّ محل رمز المستخدم عند النشر على صفحة فيسبوك:
    // النشر برمز المستخدم يعمل أحيانًا فقط، ويفشل بلا سبب واضح.
    const secondary = id.pageToken ?? (refresh.length >= 10 ? refresh : '');
    if (secondary && secondary.length >= 10) {
      const r2 = await admin.rpc('store_social_token', {
        p_owner_id: ownerId, p_platform: platform, p_token: secondary, p_label: 'refresh',
      });
      if (!r2.error) refreshId = r2.data as string;
    }

    const expiresAt = Number(body?.expiresIn) > 0
      ? new Date(Date.now() + Number(body.expiresIn) * 1000).toISOString()
      : null;

    const { error } = await admin.from('social_accounts').upsert({
      owner_id: ownerId,
      platform,
      external_account_id: id.accountId || ownerId,
      display_name: id.displayName ?? null,
      access_secret_id: acc.data,
      refresh_secret_id: refreshId,
      scopes: id.scopes ?? [],
      status: 'connected',
      expires_at: expiresAt,
      last_error: null,
      api_host: id.apiHost ?? 'graph.instagram.com',
    }, { onConflict: 'owner_id,platform,external_account_id' });
    if (error) throw error;

    // الرد لا يحتوي أي جزء من الرمز — أبدًا
    return json(req, {
      ok: true,
      platform,
      build: BUILD,
      account: { id: id.accountId, name: id.displayName ?? null },
      apiHost: id.apiHost ?? null,
      notes: id.notes ?? null,
      hasRefreshToken: !!refreshId,
      expiresAt,
    });
  } catch (e) {
    return json(req, {
      error: 'تعذر حفظ الرمز على الخادم: ' + ((e as Error).message || '').slice(0, 120),
      reason: 'storage_failed',
    }, 500);
  }
});
