// بصمة إبداع — أدوات الهوية (v1-brand-kit)
// Supabase Edge Function (Deno) — خادم فقط
//   POST ?mode=site        { kind, storage_path }   شعار/بانر الموقع (يُسجَّل فقط)
//   POST ?mode=fb-picture  { storage_path }         صورة صفحة فيسبوك — API حقيقي
//   POST ?mode=fb-cover    { storage_path }         غلاف الصفحة — نحاول ونُظهر ردّ Meta
//
// مبدأ: لا نقول «تم» إلا إذا أكّدت Meta. الغلاف على وجه الخصوص قد يُرفض
// رغم صحة الطلب — ووقتها نُعيد نصّ الخطأ الحقيقي ونشرح البديل اليدوي.

import { createClient } from 'npm:@supabase/supabase-js@2';

const URL_ = Deno.env.get('SUPABASE_URL')!;
const KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
const BUILD = 'imprint-brand-kit-v1';
const V = 'v26.0';

const admin = createClient(URL_, KEY, { auth: { persistSession: false } });
const json = (b: unknown, s = 200) =>
  new Response(JSON.stringify(b), {
    status: s,
    headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
  });

const KINDS = new Set(['site_logo', 'site_banner', 'fb_picture', 'fb_cover']);

async function credsFor(ownerId: string) {
  const { data, error } = await admin.rpc('get_social_credentials', {
    p_owner_id: ownerId,
    p_platform: 'Facebook',
  });
  if (error) return { error: 'تعذّر قراءة بيانات الحساب: ' + error.message };
  const row = Array.isArray(data) ? data[0] : data;
  if (!row?.access_token) return { error: 'اربط صفحة فيسبوك أولًا من «الحسابات المرتبطة».' };
  return { row };
}

async function bytesOf(path: string) {
  const clean = String(path).replace(/^\/+/, '');
  const dl = await admin.storage.from('imprint-media').download(clean);
  if (dl.error || !dl.data) throw new Error('تعذّر قراءة الملف: ' + (dl.error?.message ?? 'غير معروف'));
  return dl.data as Blob;
}

/** صورة الصفحة: POST /{page}/picture بجسم multipart يحمل البايتات. */
async function setPagePicture(pageId: string, token: string, blob: Blob) {
  const form = new FormData();
  form.set('access_token', token);
  form.set('source', blob, 'page.jpg');

  const r = await fetch(`https://graph.facebook.com/${V}/${pageId}/picture`, {
    method: 'POST',
    body: form,
  });
  const body = await r.json().catch(() => ({}));
  if (!r.ok || body?.error) {
    const m = String(body?.error?.message ?? r.status);
    return { ok: false, error: m, raw: body };
  }
  return { ok: body.success === true || r.ok, error: null, raw: body };
}

/**
 * غلاف الصفحة كما في التوثيق:
 *   ① ارفع الصورة كصورة صفحة غير منشورة → photo_id
 *   ② POST /{page} cover={"photo_id":…,"no_feed_story":true}
 * الخطوة ② تفشل كثيرًا. لا نخفي ذلك.
 */
async function setPageCover(pageId: string, token: string, blob: Blob) {
  const form = new FormData();
  form.set('access_token', token);
  form.set('published', 'false');
  form.set('source', blob, 'cover.jpg');

  const upRes = await fetch(`https://graph.facebook.com/${V}/${pageId}/photos`, {
    method: 'POST',
    body: form,
  });
  const up = await upRes.json().catch(() => ({}));
  if (!upRes.ok || up?.error || !up?.id) {
    return {
      ok: false,
      stage: 'upload',
      error: String(up?.error?.message ?? upRes.status),
      raw: up,
    };
  }

  const cover = JSON.stringify({ photo_id: String(up.id), no_feed_story: true });
  const params = new URLSearchParams({ cover, access_token: token });
  const r = await fetch(`https://graph.facebook.com/${V}/${pageId}`, { method: 'POST', body: params });
  const body = await r.json().catch(() => ({}));
  if (!r.ok || body?.error) {
    return {
      ok: false,
      stage: 'apply',
      photo_id: String(up.id),
      error: String(body?.error?.message ?? r.status),
      raw: body,
    };
  }
  return { ok: true, photo_id: String(up.id), raw: body };
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
  if (req.method !== 'POST') return json({ error: 'الطريقة غير مدعومة.' }, 405);

  const auth = req.headers.get('Authorization') ?? '';
  const jwt = auth.replace(/^Bearer\s+/i, '');
  if (!jwt) return json({ error: 'يلزم تسجيل الدخول.' }, 401);
  const { data: u, error: uErr } = await admin.auth.getUser(jwt);
  const user = u?.user;
  if (uErr || !user) return json({ error: 'جلسة غير صالحة — أعد تسجيل الدخول.' }, 401);

  const mode = new URL(req.url).searchParams.get('mode') ?? '';

  let body: any = {};
  try {
    body = await req.json();
  } catch {
    return json({ error: 'جسم الطلب غير صالح.' }, 400);
  }

  const kind = String(body?.kind ?? '');
  const storagePath = String(body?.storage_path ?? '');
  if (!storagePath) return json({ error: 'storage_path مطلوب.' }, 400);
  if (!storagePath.startsWith(user.id + '/')) {
    return json({ error: 'مسار الملف لا يخص حسابك.' }, 403);
  }

  const record = async (k: string) => {
    await admin.from('brand_assets')
      .upsert({ owner_id: user.id, kind: k, storage_path: storagePath, updated_at: new Date().toISOString() },
        { onConflict: 'owner_id,kind' });
  };

  /* --------------------- أصول الموقع: تُسجَّل فقط --------------------- */
  if (mode === 'site') {
    if (kind !== 'site_logo' && kind !== 'site_banner') {
      return json({ error: 'النوع يجب أن يكون site_logo أو site_banner.' }, 400);
    }
    const { error } = await admin.from('brand_assets')
      .upsert({ owner_id: user.id, kind, storage_path: storagePath, updated_at: new Date().toISOString() },
        { onConflict: 'owner_id,kind' });
    if (error) return json({ error: 'تعذّر حفظ الأصل: ' + error.message }, 500);
    return json({ ok: true, build: BUILD, kind, storage_path: storagePath, note: 'تم حفظ الأصل وسيظهر في الواجهة.' });
  }

  /* ------------------------ أصول فيسبوك الحقيقية ---------------------- */
  if (mode === 'fb-picture' || mode === 'fb-cover') {
    const c = await credsFor(user.id);
    if ('error' in c) return json({ error: c.error }, 409);

    const token = c.row.refresh_token || c.row.access_token;
    const pageId = c.row.external_account_id;
    let blob: Blob;
    try {
      blob = await bytesOf(storagePath);
    } catch (e) {
      return json({ error: (e as Error).message }, 400);
    }
    if (!String(blob.type).startsWith('image/')) {
      return json({ error: 'فيسبوك يقبل صورة فقط هنا (JPG أو PNG).' }, 400);
    }

    if (mode === 'fb-picture') {
      const r = await setPagePicture(pageId, token, blob);
      if (!r.ok) {
        return json({ ok: false, build: BUILD, error: 'فيسبوك رفض تغيير صورة الصفحة: ' + r.error, raw: r.raw }, 409);
      }
      await record('fb_picture');
      return json({ ok: true, build: BUILD, kind: 'fb_picture', verified: true,
        note: 'أكّد فيسبوك تغيير صورة الصفحة.' });
    }

    const r = await setPageCover(pageId, token, blob);
    if (!r.ok) {
      return json({
        ok: false, build: BUILD, stage: r.stage, photo_id: r.photo_id ?? null,
        error:
          (r.stage === 'upload'
            ? 'تعذّر رفع صورة الغلاف إلى فيسبوك: '
            : 'رفع فيسبوك الصورة لكنه رفض تعيينها غلافًا: ') + r.error,
        explanation:
          'غلاف الصفحة عبر API يخضع لقيد business_management ومهمة EDIT_PROFILE، ' +
          'وكثيرًا ما يُرفض رغم صحة الطلب. البديل المضمون: إعدادات الصفحة ← صورة الغلاف.',
        raw: r.raw,
      }, 409);
    }
    await record('fb_cover');
    return json({ ok: true, build: BUILD, kind: 'fb_cover', verified: true,
      photo_id: r.photo_id, note: 'أكّد فيسبوك تعيين الغلاف.' });
  }

  return json({ error: 'mode غير معروف. استخدم site أو fb-picture أو fb-cover.' }, 400);
});
