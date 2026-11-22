// ============================================================================
//  بصمة إبداع | Imprint Creative — عامل النشر
//  Supabase Edge Function (Deno) — يعمل على الخادم فقط
// ----------------------------------------------------------------------------
//  المسؤوليات:
//    1) استدعاء enqueue_due_posts() لتحويل المسودات المستحقة إلى مهام.
//    2) حجز مهمة واحدة ذريًا عبر claim_next_publish_job() — لا تكرار للنشر.
//    3) التحقق من وجود حساب مرتبط صالح قبل أي محاولة نشر.
//    4) تسجيل النتيجة عبر finish_publish_job() مع نجاح/فشل لكل منصة.
//
//  ⚠️ لا يحتوي هذا الملف أي أسرار. المفتاح السري يُقرأ من Vault عبر
//     SERVICE_ROLE_KEY في بيئة الدالة، ولا يُرسل إلى المتصفح أبدًا.
//
//  حالة التنفيذ الحالية:
//    - التحقق من الحساب والفشل الآمن: مكتمل وقابل للاختبار الآن.
//    - استدعاءات نشر المنصات: هيكل جاهز (adapters) لكن معطّل حتى توفّر
//      تطبيقات المطورين وOAuth. كل محاولة تُسجَّل بصدق كـ blocked.
// ============================================================================

import { createClient } from 'npm:@supabase/supabase-js@2';

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
const SERVICE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;

// ضع هنا المفاتيح العامة لتطبيقات المطورين عند تفعيل الربط.
// لا تضع أي سر هنا؛ استخدم Deno.env أو Vault.
const PLATFORM_ENABLED: Record<string, boolean> = {
  TikTok: false,
  Instagram: false,
  Facebook: false,
  YouTube: false
};

type Job = {
  id: string;
  owner_id: string;
  post_id: string;
  platform: string;
  attempts: number;
  max_attempts: number;
};

function admin() {
  return createClient(SUPABASE_URL, SERVICE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false }
  });
}

Deno.serve(async (req) => {
  // حماية: اسمح فقط بالاستدعاء من المجدول (مفتاح مشترك) أو بـ service role.
  const cronSecret = Deno.env.get('IMPRINT_CRON_SECRET');
  const auth = req.headers.get('authorization') || '';
  const provided = req.headers.get('x-imprint-secret') || '';
  const isService = auth === `Bearer ${SERVICE_KEY}`;
  if (!isService && cronSecret && provided !== cronSecret) {
    return new Response(JSON.stringify({ error: 'unauthorized' }), { status: 401 });
  }

  const db = admin();
  const report: Record<string, unknown> = { started_at: new Date().toISOString() };

  try {
    // 1) أعد المهام المعلّقة إلى الطابور
    const { data: requeued } = await db.rpc('requeue_stale_jobs', { p_older_than: '30 minutes' });
    report.requeued = requeued ?? 0;

    // 2) ضع المستحقات في الطابور
    const { data: enqueued, error: enqErr } = await db.rpc('enqueue_due_posts');
    if (enqErr) throw enqErr;
    report.enqueued = (enqueued ?? []).length;

    // 3) عالج ما أمكن من المهام في هذه الدورة
    const processed: unknown[] = [];
    for (let i = 0; i < 10; i++) {
      const { data: job, error } = await db.rpc('claim_next_publish_job', { p_worker: 'edge-cron' });
      if (error) throw error;
      if (!job) break;
      const j = (Array.isArray(job) ? job[0] : job) as Job;
      if (!j || !j.id) break;
      processed.push(await handleJob(db, j));
    }
    report.processed = processed;
  } catch (e) {
    report.error = (e as Error).message;
    return new Response(JSON.stringify(report), { status: 500 });
  }

  return new Response(JSON.stringify(report), {
    headers: { 'Content-Type': 'application/json' }
  });
});

async function handleJob(db: ReturnType<typeof admin>, job: Job) {
  // هل يوجد حساب مرتبط صالح لهذه المنصة؟
  const { data: account } = await db
    .from('social_accounts')
    .select('id, status, display_name, expires_at')
    .eq('owner_id', job.owner_id)
    .eq('platform', job.platform)
    .eq('status', 'connected')
    .maybeSingle();

  if (!account) {
    await db.rpc('finish_publish_job', {
      p_job_id: job.id,
      p_status: 'blocked',
      p_error: 'لا يوجد حساب مرتبط لهذه المنصة. اربط الحساب أولًا.'
    });
    return { job: job.id, platform: job.platform, result: 'blocked', reason: 'no_account' };
  }

  if (account.expires_at && new Date(account.expires_at) < new Date()) {
    await db.from('social_accounts').update({ status: 'expired' }).eq('id', account.id);
    await db.rpc('finish_publish_job', {
      p_job_id: job.id,
      p_status: 'blocked',
      p_error: 'انتهت صلاحية رمز الوصول. أعد ربط الحساب.'
    });
    return { job: job.id, platform: job.platform, result: 'blocked', reason: 'expired' };
  }

  if (!PLATFORM_ENABLED[job.platform]) {
    await db.rpc('finish_publish_job', {
      p_job_id: job.id,
      p_status: 'blocked',
      p_error: `النشر إلى ${job.platform} غير مفعّل بعد: يلزم تطبيق مطوّر معتمد.`
    });
    return { job: job.id, platform: job.platform, result: 'blocked', reason: 'platform_disabled' };
  }

  // ---------------------------------------------------------------------
  //  هنا يُنفَّذ النشر الحقيقي عند تفعيل المنصة.
  //  كل منصة لها دالة مستقلة ترجع { externalId, url } أو ترمي خطأ.
  // ---------------------------------------------------------------------
  try {
    const result = await publishToPlatform(db, job);
    await db.rpc('finish_publish_job', {
      p_job_id: job.id,
      p_status: 'published',
      p_external_post_id: result.externalId,
      p_external_url: result.url,
      p_error: null
    });
    return { job: job.id, platform: job.platform, result: 'published', url: result.url };
  } catch (e) {
    await db.rpc('finish_publish_job', {
      p_job_id: job.id,
      p_status: 'failed',
      p_error: (e as Error).message
    });
    return { job: job.id, platform: job.platform, result: 'failed', error: (e as Error).message };
  }
}

async function publishToPlatform(
  _db: ReturnType<typeof admin>,
  job: Job
): Promise<{ externalId: string; url: string }> {
  // لا تصل إليها إلا بعد تفعيل المنصة في PLATFORM_ENABLED.
  throw new Error(`لم يُنفَّذ محوّل النشر لمنصة ${job.platform} بعد.`);
}
