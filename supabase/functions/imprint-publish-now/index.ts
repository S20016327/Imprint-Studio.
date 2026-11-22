// بصمة إبداع — «انشر الآن» من الواجهة (v1-now)
//
// لماذا هذه الدالة موجودة؟
// عامل النشر `imprint-publish` محمي بـ`x-worker-secret`. لو استدعاه المتصفح
// مباشرة لكان السر في كود عام يستطيع أي زائر قراءته ويشغّل عامل النشر.
// هذه الدالة وسيط: تتحقق من جلسة المستخدم ومن أنه مالك المنشور، ثم تنادي
// العامل بالسر من داخل الخادم. السر لا يغادر Supabase أبدًا.
//
// POST { post_id }   +  Authorization: Bearer <JWT المستخدم>
import { createClient } from 'npm:@supabase/supabase-js@2';

const URL_ = Deno.env.get('SUPABASE_URL')!;
const KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
const WORKER_SECRET = Deno.env.get('IMPRINT_WORKER_SECRET') ?? '';
const SITE = Deno.env.get('IMPRINT_SITE_URL') ?? 'https://s20016327.github.io/Imprint-Studio./';
const EXTRA = Deno.env.get('IMPRINT_ALLOWED_ORIGIN') ?? '';
const BUILD = 'v1-now';

const admin = createClient(URL_, KEY, { auth: { persistSession: false } });

const origin = (u: string) => { try { return new URL(u).origin; } catch { return ''; } };
const ORIGINS = new Set([SITE, EXTRA, 'http://localhost:8080', 'http://127.0.0.1:8080'].map(origin).filter(Boolean));

function cors(req: Request) {
  const o = origin(req.headers.get('origin') ?? '');
  return {
    'Access-Control-Allow-Origin': o && ORIGINS.has(o) ? o : origin(SITE),
    'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Vary': 'Origin',
  };
}
const json = (req: Request, b: unknown, s = 200) =>
  new Response(JSON.stringify(b), { status: s, headers: { ...cors(req), 'Content-Type': 'application/json' } });

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors(req) });
  if (req.method !== 'POST') return json(req, { error: 'الطريقة غير مدعومة.' }, 405);

  const jwt = (req.headers.get('Authorization') ?? '').replace(/^Bearer\s+/i, '');
  if (!jwt) return json(req, { error: 'يلزم تسجيل الدخول.' }, 401);
  const { data: u } = await admin.auth.getUser(jwt);
  if (!u?.user) return json(req, { error: 'جلسة غير صالحة.' }, 401);

  let body: any;
  try { body = await req.json(); } catch { return json(req, { error: 'طلب غير صالح.' }, 400); }
  const postId = String(body?.post_id ?? '');
  if (!postId) return json(req, { error: 'post_id مطلوب.' }, 400);

  // الملكية أولًا — لا يمكن لأحد نشر منشور غيره
  const { data: post, error } = await admin.from('imprint_posts')
    .select('id, owner_id, title, platforms, media_path, scheduled_at')
    .eq('id', postId).maybeSingle();
  if (error) return json(req, { error: 'تعذر قراءة المنشور: ' + error.message }, 500);
  if (!post) return json(req, { error: 'المنشور غير موجود.' }, 404);
  if (post.owner_id !== u.user.id) return json(req, { error: 'هذا المنشور ليس لك.' }, 403);

  const platforms: string[] = post.platforms ?? [];
  if (!platforms.length) return json(req, { error: 'لم تُحدَّد أي منصة لهذا المنشور.' }, 400);
  if (!post.media_path) return json(req, { error: 'أضف صورة أو فيديو قبل النشر — لا تُنشر منشورات بلا وسائط.' }, 400);

  // ما هي المنصات المرتبطة فعلًا؟ نُنشر على المتاح ونُخبر بالباقي بصراحة
  const { data: accounts } = await admin.from('social_accounts')
    .select('platform').eq('owner_id', u.user.id).eq('status', 'connected');
  const linked = new Set((accounts ?? []).map((a: any) => a.platform));
  const ready = platforms.filter((p) => linked.has(p));
  const missing = platforms.filter((p) => !linked.has(p));

  if (!ready.length) {
    return json(req, {
      error: 'لا توجد منصة مرتبطة من المنصات المختارة. اربط حسابًا أولًا.',
      missing, reason: 'no_linked_account',
    }, 409);
  }

  // إنشاء المهام فورًا (بدل انتظار دورة pg_cron القادمة) — قيد unique يمنع التكرار
  const { error: insErr } = await admin.from('publish_jobs').insert(
    ready.map((platform) => ({
      owner_id: post.owner_id, post_id: post.id, platform,
      status: 'queued', run_after: new Date().toISOString(), attempts: 0, max_attempts: 3,
    }))
  );
  if (insErr && !/duplicate|unique/i.test(insErr.message)) {
    return json(req, { error: 'تعذّر إنشاء مهام النشر: ' + insErr.message }, 500);
  }
  await admin.from('imprint_posts').update({ status: 'publishing' }).eq('id', post.id);

  if (!WORKER_SECRET) {
    // المهام في الطابور وسيأخذها الـcron، لكن نُخبر أن التشغيل الفوري معطّل
    return json(req, {
      ok: true, build: BUILD, queued: ready, missing,
      note: 'المهام أُضيفت للطابور وستُنفّذ في الدقيقة القادمة عبر الجدولة.',
      warning: 'IMPRINT_WORKER_SECRET غير مهيّأ — لم يُشغَّل العامل فورًا.',
    });
  }

  // نداء العامل من الخادم (السر لا يصل للمتصفح)
  let worker: any = null;
  try {
    const r = await fetch(URL_ + '/functions/v1/imprint-publish?mode=now', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-worker-secret': WORKER_SECRET },
      body: JSON.stringify({ post_id: post.id }),
    });
    worker = await r.json();
  } catch (e) {
    worker = { error: 'تعذّر الوصول إلى عامل النشر: ' + ((e as Error).message || '').slice(0, 160) };
  }

  return json(req, {
    ok: true, build: BUILD, queued: ready, missing,
    worker,
    note: missing.length
      ? 'نُشر على المنصات المرتبطة فقط. ' + missing.join(' و') + ' غير مرتبطة ولم تُنشر عليها.'
      : null,
  });
});
