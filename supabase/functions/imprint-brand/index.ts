// بصمة إبداع — منظّم النشر (v1-capabilities)
// Supabase Edge Function (Deno) — خادم فقط
//   POST { post_id }              → يخزّن النوع (post/reel)، يتحقق، ينشر، ويعيد الدليل
//   GET  ?mode=capabilities&platform=Facebook
//                                 → ما يمكن فعله فعلًا بهذا الرمز، مع السبب
//
// لماذا دالة منفصلة عن `imprint-publish`؟
//   العامل يعمل بالسرّ ولا يعرف من المستخدم. هذه الدالة تعمل بجلسة المستخدم،
//   فتستطيع أن تسأل فيسبوك «ماذا يستطيع هذا الرمز؟» قبل أن تعِد بأي شيء.
//
// قاعدة صارمة: لا نقول «مدعوم» إلا إذا أثبته Graph. أي شك = false + سبب.

import { createClient } from 'npm:@supabase/supabase-js@2';

const URL_ = Deno.env.get('SUPABASE_URL')!;
const KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
const WORKER_SECRET = Deno.env.get('IMPRINT_WORKER_SECRET') ?? '';
const BUILD = 'imprint-brand-v1';
const V = 'v26.0';

const admin = createClient(URL_, KEY, { auth: { persistSession: false } });
const json = (b: unknown, s = 200) =>
  new Response(JSON.stringify(b), {
    status: s,
    headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
  });

const isVideo = (t: string | null | undefined) => String(t ?? '').toLowerCase().includes('video');

/** شكل الرمز: EAA… = Meta موحّد على graph.facebook.com، IGAA… = إنستقرام مباشر. */
const metaHost = (token: string) => (token.startsWith('EAA') ? 'graph.facebook.com' : 'graph.instagram.com');

type Cap = {
  ok: boolean;
  reason_ar: string;
  /** الصلاحيات الناقصة التي يجب أن يضيفها المستخدم في Graph Explorer */
  needs?: string[];
};

type Caps = Record<string, Cap>;

/** جلب بيانات الحساب من Graph — أساس كل قرار. */
async function graph(token: string, path: string) {
  const r = await fetch(`https://${metaHost(token)}/${V}/${path}`, {
    headers: { Authorization: 'Bearer ' + token },
  });
  const body = await r.json().catch(() => ({}));
  return { ok: r.ok, body } as { ok: boolean; body: any };
}

/**
 * ما يستطيعه رمز فيسبوك. نسأل /debug_token عن الصلاحيات الحقيقية،
 * ثم نسأل عن مهام الصفحة — لأن الصلاحية وحدها لا تكفي بلا CREATE_CONTENT.
 */
async function facebookCaps(token: string, pageId: string): Promise<Caps> {
  const caps: Caps = {
    post: { ok: false, reason_ar: 'لم يُتحقق بعد.' },
    reel: { ok: false, reason_ar: 'لم يُتحقق بعد.' },
    picture: { ok: false, reason_ar: 'لم يُتحقق بعد.' },
    cover: { ok: false, reason_ar: 'لم يُتحقق بعد.' },
  };

  // رمز المستخدم نفسه يكشف صلاحياته؛ رمز الصفحة يكشف صلاحيات الصفحة.
  const dbg = await graph(token, `debug_token?input_token=${encodeURIComponent(token)}`);
  const granted: string[] = dbg.body?.data?.scopes ?? [];

  // للصفحة: نقرأ الصورة والغلاف القابلين للقراءة، وهذا يثبت الرمز والوصول.
  const page = await graph(token, `${pageId}?fields=id,name,picture,cover`);
  const pageReachable = page.ok && !!page.body?.id;
  const pageErr = String(page.body?.error?.message ?? '');

  const canAdmin = granted.includes('pages_manage_posts');
  const canMeta = granted.includes('pages_manage_metadata');
  const canRead = granted.includes('pages_read_engagement');

  if (!pageReachable) {
    const why = /permission|\(#10\)|\(#200\)/i.test(pageErr)
      ? 'الرمز لا يملك وصولًا إلى هذه الصفحة. أعد إنشاء الرمز واختر الصفحة في نافذة الصلاحيات.'
      : pageErr || 'تعذّر الوصول إلى الصفحة بالرمز الحالي.';
    for (const k of Object.keys(caps)) caps[k] = { ok: false, reason_ar: why };
    return caps;
  }

  // المنشور العادي: يحتاج pages_manage_posts (يكفي لمنشور الصورة/الفيديو العادي)
  caps.post = canAdmin
    ? { ok: true, reason_ar: 'ممكن: الرمز يحمل pages_manage_posts ووصل إلى الصفحة فعليًا.' }
    : {
        ok: false,
        needs: ['pages_manage_posts'],
        reason_ar: 'لا يمكن النشر: الرمز لا يحمل صلاحية إنشاء منشورات على الصفحة.',
      };

  // الريلز: نفس الصلاحية لكن المسار مختلف، وننصح بـpages_read_engagement
  // (توثيق Meta يطلبها، وبعض الحسابات تُرفض بدونها).
  caps.reel = canAdmin
    ? {
        ok: true,
        reason_ar: canRead
          ? 'ممكن: الرمز يحمل pages_manage_posts وpages_read_engagement.'
          : 'ممكن غالبًا: الرمز يحمل pages_manage_posts. توثيق Meta يطلب pages_read_engagement أيضًا — إن رُفض الرفع فأضفها.',
      }
    : {
        ok: false,
        needs: ['pages_manage_posts', 'pages_read_engagement'],
        reason_ar: 'لا يمكن نشر ريلز: الرمز لا يحمل صلاحية إنشاء منشورات على الصفحة.',
      };

  // صورة الصفحة: مسار /picture يقبلها عمليًا برمز الصفحة.
  caps.picture = canAdmin
    ? { ok: true, reason_ar: 'ممكن: الرمز يحمل pages_manage_posts ويستطيع تعديل صورة الصفحة.' }
    : {
        ok: false,
        needs: ['pages_manage_posts', 'pages_manage_metadata'],
        reason_ar: 'لا يمكن تغيير صورة الصفحة بهذا الرمز.',
      };

  // الغلاف: التوثيق يشترط business_management + مهمة EDIT_PROFILE،
  // والتجارب العملية تُظهر رفضًا متكرّرًا. الصدق هنا أهم من الوعد.
  if (canMeta && granted.includes('business_management')) {
    caps.cover = {
      ok: true,
      reason_ar: 'ممكن: الرمز يحمل pages_manage_metadata وbusiness_management.',
    };
  } else {
    caps.cover = {
      ok: false,
      needs: ['pages_manage_metadata', 'business_management'],
      reason_ar:
        'غلاف الصفحة غير مضمون: Meta تشترط business_management ومهمة EDIT_PROFILE، ' +
        'وكثير من الرموز تُرفض رغم ذلك. سأحاول فعلًا وأعرض لك ردّ Meta الحقيقي، ' +
        'أو غيّره من إعدادات الصفحة مباشرة.',
    };
  }

  return caps;
}

/** يقرأ اعتماد المنصة للمستخدم الحالي. */
async function credsFor(ownerId: string, platform: string) {
  const { data, error } = await admin.rpc('get_social_credentials', {
    p_owner_id: ownerId,
    p_platform: platform,
  });
  if (error) return { error: 'تعذّر قراءة بيانات الحساب: ' + error.message };
  const row = Array.isArray(data) ? data[0] : data;
  if (!row?.access_token) {
    return { error: 'لا يوجد حساب ' + platform + ' مرتبط. اربط الحساب أولًا من «الحسابات المرتبطة».' };
  }
  return { row };
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, {
      headers: {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Headers': 'authorization, content-type, apikey',
        'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      },
    });
  }

  // المصادقة: جلسة مستخدم. لا نقبل anon.
  const auth = req.headers.get('Authorization') ?? '';
  const jwt = auth.replace(/^Bearer\s+/i, '');
  if (!jwt) return json({ error: 'يلزم تسجيل الدخول.' }, 401);
  const { data: userData, error: userErr } = await admin.auth.getUser(jwt);
  const user = userData?.user;
  if (userErr || !user) return json({ error: 'جلسة غير صالحة — أعد تسجيل الدخول.' }, 401);

  const url = new URL(req.url);

  /* ------------------- ما الذي تستطيعه الصلاحيات؟ ------------------- */
  if (req.method === 'GET' && url.searchParams.get('mode') === 'capabilities') {
    const platform = url.searchParams.get('platform') || 'Facebook';
    const c = await credsFor(user.id, platform);
    if ('error' in c) return json({ ok: false, build: BUILD, platform, caps: {}, error: c.error });

    if (platform !== 'Facebook') {
      // بقية المنصات لم تُبنَ لها طبقة فحص بعد — لا ندّعي قدرة.
      return json({
        ok: false,
        build: BUILD,
        platform,
        caps: {},
        error: 'فحص الصلاحيات مبنيّ لفيسبوك الآن. هذه المنصة تُنشر بالمسار القديم بلا فحص مسبق.',
      });
    }

    const caps = await facebookCaps(c.row.access_token, c.row.external_account_id);
    return json({
      ok: true,
      build: BUILD,
      platform,
      page: { id: c.row.external_account_id },
      caps,
    });
  }

  /* ------------------------- نشر نوع محدَّد ------------------------- */
  if (req.method === 'POST') {
    let body: any = {};
    try {
      body = await req.json();
    } catch {
      return json({ error: 'جسم الطلب غير صالح.' }, 400);
    }
    const postId = String(body?.post_id ?? '');
    if (!postId) return json({ error: 'post_id مطلوب.' }, 400);

    const { data: post, error: postErr } = await admin
      .from('imprint_posts')
      .select('id, owner_id, platforms, publish_format, media_type')
      .eq('id', postId)
      .single();
    if (postErr || !post) return json({ error: 'المنشور غير موجود.' }, 404);
    if (post.owner_id !== user.id) return json({ error: 'غير مصرّح بهذا المنشور.' }, 403);

    // ① النية تُخزَّن أولًا — العامل ينفّذها ولا يخمّن.
    if (post.publish_format !== 'reel') {
      const { error: upErr } = await admin
        .from('imprint_posts')
        .update({ publish_format: 'post' })
        .eq('id', post.id);
      if (upErr) return json({ error: 'تعذّر تثبيت نوع النشر: ' + upErr.message }, 500);
    }

    // ② نية ريلز بلا فيديو = خطأ نُعلنه بدل أن ندّعي النجاح.
    if (post.publish_format === 'reel' && !isVideo(post.media_type)) {
      return json(
        { error: 'اخترت «ريلز»، لكن المرفق ليس فيديو. الريلز فيديو رأسي 9:16 مدته 3–90 ثانية.' },
        400,
      );
    }

    // ③ إن كانت المنصة فيسبوك والنية ريلز، اطلب الدليل من Graph قبل أي وعد.
    const platforms: string[] = post.platforms ?? [];
    if (post.publish_format === 'reel' && platforms.includes('Facebook')) {
      const c = await credsFor(user.id, 'Facebook');
      if (!('error' in c)) {
        const caps = await facebookCaps(c.row.access_token, c.row.external_account_id);
        if (!caps.reel.ok) {
          return json(
            {
              error: 'لا يمكن نشر ريلز بهذا الرمز: ' + caps.reel.reason_ar,
              needs: caps.reel.needs ?? [],
              caps,
            },
            409,
          );
        }
      }
    }

    // ④ نُفوّض التنفيذ للعامل نفسه — مسار واحد، لا نسخة ثانية من الكود.
    const w = await fetch(`${URL_}/functions/v1/imprint-publish?mode=now`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-worker-secret': WORKER_SECRET },
      body: JSON.stringify({ post_id: post.id }),
    });
    const worker = await w.json().catch(() => ({}));
    if (!w.ok) {
      return json({ error: worker?.error || 'تعذّر تشغيل العامل (' + w.status + ').', worker }, w.status);
    }

    return json({
      ok: true,
      build: BUILD,
      format: post.publish_format,
      verification: verifyResults(worker?.results ?? []),
      worker,
    });
  }

  return json({ error: 'الطريقة غير مدعومة.' }, 405);
});

/**
 * «الدليل لا الادعاء»: لكل نتيجة نشر نُصنّف ما أثبتته المنصة فعلًا.
 * - published: عاد معرّف منشور خارجي (دليل وجود شيء على المنصة).
 * - blocked/failed: لا دليل — نُعيد السبب كما قالته المنصة.
 * لا نُسمّي شيئًا «ريلز» إلا إن أكّدت المنصة أنها كذلك.
 */
function verifyResults(results: any[]) {
  return results.map((r) => {
    if (!r || typeof r !== 'object') return { ok: false, note: 'نتيجة غير مفهومة من العامل.' };
    if (!r.ok) {
      return {
        ok: false,
        platform: r.platform,
        blocked: !!r.blocked,
        error: r.error || 'فشل بلا سبب واضح.',
        proof: null,
      };
    }
    const id = r.external_post_id ?? null;
    return {
      ok: !!id,
      platform: r.platform,
      proof: id ? { external_post_id: id, external_url: r.external_url ?? null } : null,
      note: id
        ? 'أعادت المنصة معرّف المنشور — هذا دليل النشر.'
        : 'المنصة لم تُعِد معرّفًا، فلا يمكن تأكيد النشر.',
    };
  });
}
