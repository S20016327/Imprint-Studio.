// بصمة إبداع — عامل النشر (v7-reels)
// Supabase Edge Function (Deno) — خادم فقط
//   POST ?mode=due  (pg_cron كل دقيقة)  |  POST ?mode=now { post_id }  |  Header: x-worker-secret
//
// لا يُستدعى من المتصفح مباشرة: السر في الخادم، والواجهة تستخدم
// `imprint-publish-now` التي تتحقق من ملكية المنشور ثم تنادي هذا العامل.
//
// متوافق مع: claim_next_publish_job(p_worker), finish_publish_job(...),
//            get_social_credentials(owner, platform)
import { createClient } from 'npm:@supabase/supabase-js@2';

const URL_ = Deno.env.get('SUPABASE_URL')!;
const KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
const SECRET = Deno.env.get('IMPRINT_WORKER_SECRET') ?? '';
const WORKER = 'imprint-publish-v7';
const V = 'v26.0';

const admin = createClient(URL_, KEY, { auth: { persistSession: false } });
const json = (b: unknown, s = 200) => new Response(JSON.stringify(b), { status: s, headers: { 'Content-Type': 'application/json' } });

type Job = { id: string; owner_id: string; post_id: string; platform: string; attempts: number; max_attempts: number };
type Creds = { access_token: string; refresh_token: string | null; api_host: string; external_account_id: string; expires_at: string | null };

const caption = (p: any) => [p.title, p.description, p.hashtags].filter(Boolean).join('\n\n').slice(0, 2200);
const isVideo = (p: any) => String(p.media_type ?? '').toLowerCase().includes('video');
const isReel = (p: any) => String(p.publish_format ?? '') === 'reel';

/** حدود Meta للريلز — نرفض قبل الرفع بدل أن نُسمّي فيديو عاديًّا «ريلز». */
const REEL_MAX_BYTES = 150 * 1024 * 1024;

/**
 * رفع ملف إلى rupload.facebook.com كاملًا في الطلب — لأن العامل لا يملك
 * نظام ملفات دائمًا. نقرأ البايتات من التخزين ونسلّمها في جسم الرفع.
 */
async function storageBytes(path: string | null): Promise<{ blob: Blob; size: number; type: string }> {
  if (!path) throw new Blocked('لا توجد وسائط للنشر.');
  const clean = String(path).replace(/^\/+/, '');
  const dl = await admin.storage.from('imprint-media').download(clean);
  if (dl.error || !dl.data) {
    throw new Blocked('تعذّر قراءة الملف من التخزين: ' + (dl.error?.message ?? 'غير معروف'));
  }
  const blob = dl.data as Blob;
  return { blob, size: blob.size, type: blob.type || 'video/mp4' };
}

/**
 * نشر ريلز على صفحة فيسبوك — ثلاث مراحل كما في توثيق Meta:
 *   ① POST /{page}/video_reels  upload_phase=start   → video_id + upload_url
 *   ② POST {upload_url}         جسم الطلب = بايتات الفيديو
 *   ③ POST /{page}/video_reels  upload_phase=finish  → تُنشر أو تبقى مسودة
 *
 * لماذا هذا المسار لا /videos؟ لأن /videos تُنشئ فيديو صفحة عاديًّا؛
 * فيسبوك قد يعرضه كريل إن كان رأسيًّا، لكن ذلك ليس نشر ريلز.
 */
async function facebookReel(p: any, c: Creds) {
  const base = 'https://graph.facebook.com/' + V;
  const token = c.refresh_token || c.access_token;
  const pageId = c.external_account_id;
  const media = await mediaUrl(p.media_path);

  // ① بدء جلسة الرفع
  const startParams = new URLSearchParams({
    upload_phase: 'start',
    access_token: token,
  });
  const startRes = await fetch(base + '/' + pageId + '/video_reels', {
    method: 'POST',
    body: startParams,
  });
  const start = await startRes.json();
  if (!startRes.ok || start.error) {
    const m = String(start?.error?.message ?? startRes.status);
    if (/permission|\(#10\)|\(#200\)|\(#3\)/i.test(m)) {
      throw new Blocked(
        'فيسبوك رفض بدء ريلز لعدم كفاية الصلاحية. المطلوب: pages_manage_posts (والمستحسن pages_read_engagement). ' +
          'التفصيل: ' + m,
      );
    }
    throw new Error('فيسبوك رفض بدء جلسة الريلز: ' + m);
  }
  const videoId = String(start.video_id ?? '');
  const uploadUrl = String(start.upload_url ?? '');
  if (!videoId || !uploadUrl) throw new Transient('لم يُعِد فيسبوك معرّف فيديو الريلز.');

  // ② الرفع — من التخزين إلى rupload مباشرة
  const file = await storageBytes(p.media_path);
  if (file.size > REEL_MAX_BYTES) {
    throw new Blocked(
      'ملف الريلز أكبر من ١٥٠ ميغابايت. قلّل الحجم ثم أعد المحاولة.',
    );
  }
  if (file.size === 0) throw new Blocked('ملف الفيديو فارغ.');

  const upRes = await fetch(uploadUrl, {
    method: 'POST',
    headers: {
      Authorization: 'OAuth ' + token,
      offset: '0',
      file_size: String(file.size),
      'Content-Type': 'application/octet-stream',
      // عنوان المصدر مطلوب عمليًا لبعض الصفحات
      'X-Entity-Length': String(file.size),
    },
    body: file.blob,
  });
  const upText = await upRes.text();
  if (!upRes.ok) {
    throw new Error('فشل رفع الفيديو إلى فيسبوك: ' + (upText.slice(0, 300) || upRes.status));
  }

  // ③ الإنهاء والنشر
  const text = caption(p);
  const finishParams = new URLSearchParams({
    video_id: videoId,
    upload_phase: 'finish',
    video_state: 'PUBLISHED',
    access_token: token,
  });
  if (text) finishParams.set('description', text);

  const finRes = await fetch(base + '/' + pageId + '/video_reels', {
    method: 'POST',
    body: finishParams,
  });
  const fin = await finRes.json();
  if (!finRes.ok || fin.error) {
    const m = String(fin?.error?.message ?? finRes.status);
    throw new Error('فيسبوك رفض نشر الريلز: ' + m);
  }

  // الريلز تُعيد success. نشرها النهائي غير متزامن — نتحقق من الحالة
  // حتى لا نقول «نُشر» بلا دليل. نقبل نجاحًا صريحًا أو ظهور المنشور.
  const postId = String(fin.post_id ?? '');
  if (postId) {
    return {
      external_post_id: postId,
      external_url: 'https://www.facebook.com/' + postId,
      note: 'ريلز على فيسبوك. المعالجة قد تستغرق دقيقة قبل ظهوره في الصفحة.',
    };
  }
  if (fin.success === true) {
    return {
      external_post_id: 'reel:' + videoId,
      external_url: null,
      note:
        'قبل فيسبوك جلسة الريلز (video_id: ' + videoId + ') لكنه لم يُعِد رابط منشور. ' +
        'افتح صفحتك للتأكد من ظهوره — المعالجة غير متزامنة.',
    };
  }
  throw new Transient('فيسبوك لم يؤكد نشر الريلز. النتيجة: ' + JSON.stringify(fin).slice(0, 300));
}


class Blocked extends Error {}
class Transient extends Error {}

/** رابط موقّع ساعة واحدة — يعمل مع bucket خاص أو عام. */
async function mediaUrl(path: string | null): Promise<string> {
  if (!path) throw new Blocked('لا توجد وسائط للنشر.');
  if (/^https?:\/\//i.test(path)) return path;
  const clean = path.replace(/^\/+/, '');
  const signed = await admin.storage.from('imprint-media').createSignedUrl(clean, 3600);
  if (signed.data?.signedUrl) {
    return signed.data.signedUrl.startsWith('http') ? signed.data.signedUrl : URL_ + signed.data.signedUrl;
  }
  return URL_ + '/storage/v1/object/public/imprint-media/' + clean;
}

async function creds(ownerId: string, platform: string): Promise<Creds> {
  const { data, error } = await admin.rpc('get_social_credentials', { p_owner_id: ownerId, p_platform: platform });
  if (error) throw new Transient('تعذّر قراءة بيانات الحساب: ' + error.message);
  const row = Array.isArray(data) ? data[0] : data;
  if (!row?.access_token) throw new Blocked('لا يوجد حساب مرتبط لهذه المنصة. اربط الحساب من صفحة الحسابات المرتبطة.');
  return row as Creds;
}

async function instagram(p: any, c: Creds) {
  const base = 'https://' + (c.api_host || 'graph.instagram.com') + '/' + V;
  const id = c.external_account_id;
  const media = await mediaUrl(p.media_path);
  const params = new URLSearchParams({ access_token: c.access_token, caption: caption(p) });
  if (isVideo(p)) { params.set('media_type', 'REELS'); params.set('video_url', media); }
  else params.set('image_url', media);

  const cr = await fetch(base + '/' + id + '/media', { method: 'POST', body: params });
  const created = await cr.json();
  if (!cr.ok || created.error) {
    const m = String(created?.error?.message ?? cr.status);
    throw /rate|limit|try again|temporar/i.test(m)
      ? new Transient('إنستقرام: ' + m)
      : new Error('إنستقرام رفض إنشاء الحاوية: ' + m);
  }
  const containerId = created.id;

  if (isVideo(p)) {
    const deadline = Date.now() + 5 * 60 * 1000;
    for (;;) {
      const s = await fetch(base + '/' + containerId + '?fields=status_code,status&access_token=' + encodeURIComponent(c.access_token));
      const st = await s.json();
      if (st?.status_code === 'FINISHED') break;
      if (st?.status_code === 'ERROR' || st?.status_code === 'EXPIRED') {
        throw new Error('فشل معالجة الفيديو في إنستقرام: ' + (st?.status ?? st?.status_code));
      }
      if (Date.now() > deadline) throw new Transient('انتهت مهلة معالجة الفيديو — سيُعاد لاحقًا.');
      await new Promise((r) => setTimeout(r, 5000));
    }
  }

  const pr = await fetch(base + '/' + id + '/media_publish', {
    method: 'POST', body: new URLSearchParams({ creation_id: containerId, access_token: c.access_token }),
  });
  const pub = await pr.json();
  if (!pr.ok || pub.error) throw new Error('إنستقرام رفض النشر: ' + (pub?.error?.message ?? pr.status));

  let link: string | null = null;
  try {
    const m = await fetch(base + '/' + pub.id + '?fields=permalink&access_token=' + encodeURIComponent(c.access_token));
    link = (await m.json())?.permalink ?? null;
  } catch { /* الرابط تحسين لا شرط */ }

  return { external_post_id: String(pub.id), external_url: link };
}

async function facebook(p: any, c: Creds) {
  // الريلز مسار مستقل تمامًا — لا نُسمّي فيديو عاديًّا «ريلز».
  if (isReel(p)) return facebookReel(p, c);

  const base = 'https://graph.facebook.com/' + V;
  // النشر بصفة الصفحة برمز الصفحة هو المسار الموثَّق.
  const token = c.refresh_token || c.access_token;
  const text = caption(p);
  const video = isVideo(p);

  // ⚠️ المعامل يختلف بين النقطتين، وهذا خطأ حقيقي وقع:
  //   /photos يقبل message (أو caption) — وليس description
  //   /videos يقبل description + title
  // إرسال description إلى /photos يُتجاهل بصمت: تُنشر الصورة بلا نص
  // ويأتي الرد 200 كأن كل شيء نجح. لذلك نفصل الجسم بحسب النوع.
  const params = new URLSearchParams({ access_token: token });

  if (video) {
    params.set('file_url', await mediaUrl(p.media_path));
    if (text) {
      params.set('description', text);
      params.set('title', String(p.title ?? 'منشور').slice(0, 100));
    }
  } else {
    params.set('url', await mediaUrl(p.media_path));
    if (text) params.set('message', text); // ← المعامل الصحيح للصور
  }

  const ep = base + '/' + c.external_account_id + (video ? '/videos' : '/photos');
  const r = await fetch(ep, { method: 'POST', body: params });
  const d = await r.json();
  if (!r.ok || d.error) {
    const m = String(d?.error?.message ?? r.status);
    if (/permission|\(#10\)|\(#200\)/i.test(m)) {
      throw new Blocked(
        'فيسبوك رفض النشر لعدم امتلاك صلاحية إنشاء محتوى على الصفحة. ' +
        'تأكد أن الرمز يحمل pages_manage_posts وأنك مسؤول في الصفحة. التفصيل: ' + m
      );
    }
    throw new Error('فيسبوك رفض النشر: ' + m);
  }

  // /photos يُعيد id (الصورة) و post_id (المنشور). الرابط الصحيح للمنشور
  // هو post_id — الرابط بالـ id يفتح الصورة لا المنشور.
  const postId = String(d.post_id ?? '');
  const id = postId || String(d.id ?? '');

  return { external_post_id: id, external_url: id ? 'https://www.facebook.com/' + id : null };
}

async function youtube(p: any, c: Creds) {
  // يوتيوب لا ينشر صورًا. المحاولة كانت تنتج خطأ غامضًا من Google؛
  // نرفضها هنا صراحة برسالة مفهومة بدل إحراق محاولة من محاولات المهمة.
  if (!isVideo(p)) {
    throw new Blocked('يوتيوب لا يقبل الصور — يحتاج ملف فيديو. أزل يوتيوب من هذا المنشور أو ارفع فيديو.');
  }
  const init = await fetch('https://www.googleapis.com/upload/youtube/v3/videos?uploadType=resumable&part=snippet,status', {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + c.access_token, 'Content-Type': 'application/json; charset=UTF-8', 'X-Upload-Content-Type': 'video/*' },
    body: JSON.stringify({
      snippet: { title: (p.title ?? 'منشور').slice(0, 95), description: caption(p).slice(0, 4900), categoryId: '22' },
      status: { privacyStatus: 'public', selfDeclaredMadeForKids: false },
    }),
  });
  if (!init.ok) throw new Error('يوتيوب رفض بدء الرفع: ' + (await init.text()).slice(0, 180));
  const uploadUrl = init.headers.get('location');
  if (!uploadUrl) throw new Transient('لم يعُد يوتيوب رابط رفع.');

  const mediaRes = await fetch(await mediaUrl(p.media_path));
  if (!mediaRes.ok) throw new Blocked('تعذّر تنزيل الوسائط من التخزين.');
  const bytes = await mediaRes.arrayBuffer();

  const up = await fetch(uploadUrl, {
    method: 'PUT',
    headers: { 'Content-Type': mediaRes.headers.get('content-type') ?? 'video/mp4', 'Content-Length': String(bytes.byteLength) },
    body: bytes,
  });
  const d = await up.json();
  if (!up.ok || d.error) throw new Error('يوتيوب رفض الرفع: ' + (d?.error?.message ?? up.status));
  return { external_post_id: String(d.id), external_url: d.id ? 'https://youtu.be/' + d.id : null };
}

/**
 * تيك توك — ثلاث حقائق تحكم هذا الكود:
 *
 * ١) التطبيق غير المدقَّق (unaudited) يستطيع النشر بـ SELF_ONLY فقط.
 *    إرسال PUBLIC_TO_EVERYONE يُرفض دائمًا. لذلك نسأل TikTok أولًا عن
 *    الخيارات المسموحة لهذا الحساب (`creator_info`) ونختار منها، بدل
 *    الافتراض. تمرير PUBLIC_TO_EVERYONE كان يجعل كل محاولة تفشل.
 *
 * ٢) الحساب يجب أن يكون خاصًّا وقت النشر للتطبيق غير المدقَّق، وإلا:
 *    unaudited_client_can_only_post_to_private_accounts
 *
 * ٣) `init` لا يعني النشر. النجاح الحقيقي هو PUBLISH_COMPLETE من
 *    status/fetch. الإعلان عن النشر بعد init كان ادعاءً غير صحيح.
 */
async function tiktokPrivacy(token: string): Promise<{ level: string; unaudited: boolean; note: string }> {
  const r = await fetch('https://open.tiktokapis.com/v2/post/publish/creator_info/query/', {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json; charset=UTF-8' },
    body: '{}',
  });
  const d = await r.json();
  const opts: string[] = d?.data?.privacy_level_options ?? [];
  const code = String(d?.error?.code ?? '');

  if (code && code !== 'ok') {
    // لا نستطيع قراءة الخيارات — الأسلم SELF_ONLY، وهي المقبولة دائمًا
    return { level: 'SELF_ONLY', unaudited: true, note: 'تعذّر قراءة خيارات الخصوصية — استُخدم SELF_ONLY.' };
  }
  // PUBLIC_TO_EVERYONE لا يظهر إلا لتطبيق مدقَّق
  if (opts.includes('PUBLIC_TO_EVERYONE')) {
    return { level: 'PUBLIC_TO_EVERYONE', unaudited: false, note: '' };
  }
  return {
    level: 'SELF_ONLY',
    unaudited: true,
    note: 'تيك توك نشر المنشور بخصوصية «أنا فقط» لأن التطبيق غير مدقَّق بعد. لا أحد غيرك يراه.',
  };
}

async function tiktok(p: any, c: Creds) {
  if (!isVideo(p)) throw new Blocked('تيك توك لا يقبل الصور — يحتاج ملف فيديو. أزل تيك توك أو ارفع فيديو.');

  const priv = await tiktokPrivacy(c.access_token);
  const init = await fetch('https://open.tiktokapis.com/v2/post/publish/video/init/', {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + c.access_token, 'Content-Type': 'application/json; charset=UTF-8' },
    body: JSON.stringify({
      post_info: { title: caption(p).slice(0, 2200), privacy_level: priv.level },
      source_info: { source: 'PULL_FROM_URL', video_url: await mediaUrl(p.media_path) },
    }),
  });
  const d = await init.json();
  const code = String(d?.error?.code ?? '');
  const msg = String(d?.error?.message ?? '');

  if (code === 'unaudited_client_can_only_post_to_private_accounts') {
    throw new Blocked(
      'تيك توك: حسابك عام، والتطبيق غير مدقَّق بعد. اجعل حسابك خاصًّا مؤقتًا ' +
      '(الإعدادات ← الخصوصية ← حساب خاص)، أو استخدم «نسخ إلى TikTok Studio» من جدول المنشورات.'
    );
  }
  if (/url_ownership|verified|domain/i.test(code + msg)) {
    throw new Blocked(
      'تيك توك يرفض رابط الوسائط لأن دومين التخزين غير موثَّق عندهم. ' +
      'استخدم «نسخ إلى TikTok Studio» من جدول المنشورات — يعمل فورًا بلا توثيق.'
    );
  }
  if (!init.ok || code !== 'ok') {
    throw new Error('TikTok رفض بدء النشر: ' + (msg || init.status));
  }

  // النشر لم يكتمل بعد — نتابع حتى PUBLISH_COMPLETE
  const publishId = String(d?.data?.publish_id ?? '');
  if (!publishId) throw new Transient('لم يُعِد TikTok معرّف نشر.');

  const deadline = Date.now() + 3 * 60 * 1000;
  for (;;) {
    const s = await fetch('https://open.tiktokapis.com/v2/post/publish/status/fetch/', {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + c.access_token, 'Content-Type': 'application/json; charset=UTF-8' },
      body: JSON.stringify({ publish_id: publishId }),
    });
    const sd = await s.json();
    const st = String(sd?.data?.status ?? '');
    if (st === 'PUBLISH_COMPLETE') break;
    if (st === 'FAILED') {
      throw new Error('تيك توك فشل في النشر: ' + (sd?.data?.fail_reason ?? 'سبب غير معروف'));
    }
    if (Date.now() > deadline) {
      throw new Transient('انتهت مهلة معالجة الفيديو في تيك توك — ستُعاد المحاولة.');
    }
    await new Promise((r) => setTimeout(r, 5000));
  }

  // ملاحظة الخصوصية تُرفق بالنتيجة حتى يعرف المستخدم أن المنشور خاص لا عام
  return { external_post_id: publishId, external_url: null, note: priv.note || undefined };
}


const PUB: Record<string, (p: any, c: Creds) => Promise<{ external_post_id: string; external_url: string | null }>> = {
  Instagram: instagram, Facebook: facebook, YouTube: youtube, TikTok: tiktok,
};

async function processJob(job: Job) {
  try {
    const { data: post, error } = await admin.from('imprint_posts')
      .select('id, owner_id, title, description, hashtags, media_path, media_type, platforms, publish_format').eq('id', job.post_id).single();
    if (error || !post) throw new Blocked('المنشور غير موجود.');
    const c = await creds(job.owner_id, job.platform);
    const fn = PUB[job.platform];
    if (!fn) throw new Blocked('منصة غير مدعومة: ' + job.platform);
    const out = await fn(post, c);
    await admin.rpc('finish_publish_job', {
      p_job_id: job.id, p_status: 'published',
      p_external_post_id: out.external_post_id, p_external_url: out.external_url, p_error: null,
    });
    return { job: job.id, platform: job.platform, ok: true, ...out };
  } catch (e) {
    const msg = ((e as Error).message ?? 'خطأ غير معروف').slice(0, 900);
    const status = e instanceof Blocked ? 'blocked' : 'failed';
    await admin.rpc('finish_publish_job', { p_job_id: job.id, p_status: status, p_error: msg });
    return { job: job.id, platform: job.platform, ok: false, blocked: status === 'blocked', error: msg };
  }
}

async function drain(limit: number) {
  const out: unknown[] = [];
  for (let i = 0; i < limit; i++) {
    const { data, error } = await admin.rpc('claim_next_publish_job', { p_worker: WORKER });
    if (error) { out.push({ error: error.message }); break; }
    const job = (Array.isArray(data) ? data[0] : data) as Job | null;
    if (!job?.id) break;
    out.push(await processJob(job));
  }
  return out;
}

Deno.serve(async (req) => {
  if (req.method !== 'POST') return json({ error: 'الطريقة غير مدعومة.' }, 405);
  if (!SECRET || req.headers.get('x-worker-secret') !== SECRET) return json({ error: 'غير مصرّح.' }, 401);

  const mode = new URL(req.url).searchParams.get('mode') ?? 'due';

  if (mode === 'now') {
    let b: any = {};
    try { b = await req.json(); } catch { /* نص فارغ مقبول */ }
    const postId = String(b?.post_id ?? '');
    if (!postId) return json({ error: 'post_id مطلوب.' }, 400);

    const { data: post, error } = await admin.from('imprint_posts').select('id, owner_id, platforms').eq('id', postId).single();
    if (error || !post) return json({ error: 'المنشور غير موجود.' }, 404);
    const platforms: string[] = post.platforms ?? [];
    if (!platforms.length) return json({ error: 'لم تُختَر أي منصة للنشر.' }, 400);

    const { error: insErr } = await admin.from('publish_jobs').insert(platforms.map((platform) => ({
      owner_id: post.owner_id, post_id: post.id, platform,
      status: 'queued', run_after: new Date().toISOString(), attempts: 0, max_attempts: 3,
    })));
    if (insErr && !/duplicate|unique/i.test(insErr.message)) {
      return json({ error: 'تعذّر إنشاء وظائف النشر: ' + insErr.message }, 500);
    }

    await admin.from('imprint_posts').update({ status: 'publishing' }).eq('id', post.id);
    return json({ ok: true, mode, build: WORKER, results: await drain(24) });
  }

  const results = await drain(40);
  return json({ ok: true, mode: 'due', build: WORKER, processed: results.length, results });
});
