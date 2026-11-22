/* ===========================================================================
   بصمة إبداع | Imprint Creative — طبقة الاتصال بـ Supabase
   ---------------------------------------------------------------------------
   يعمل في المتصفح ويستخدم المفتاح القابل للنشر (publishable) فقط.
   ممنوع منعًا باتًا إضافة service_role أو sb_secret هنا: الملف منشور علنًا
   على GitHub Pages. كل حماية البيانات تعتمد على سياسات RLS في Supabase.
   =========================================================================== */

const SB = 'https://yxmetzdoxbqndecslhlu.supabase.co';
const SB_KEY = 'sb_publishable_yYJ8xoEwOAFjGRieg9dRUQ_lArAzvwB';
const BUCKET = 'imprint-media';
const SESSION_KEY = 'imprint_session';
const MAX_BYTES = 100 * 1024 * 1024; // 100 MiB — مطابق لحد الـ bucket في Supabase

const EXT_BY_TYPE = {
  'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp',
  'video/mp4': 'mp4', 'video/webm': 'webm', 'video/quicktime': 'mov'
};
const MIME_BY_EXT = {
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp',
  mp4: 'video/mp4', webm: 'video/webm', mov: 'video/quicktime'
};

/* --------------------------- الحالة المشتركة ---------------------------- */
let session = null;        // جلسة Supabase Auth
let loadedId = null;       // معرّف المسودة المفتوحة
let loadedPath = null;     // مسار الوسائط المحفوظة
let savedFile = null;      // الملف المحفوظ فعلًا لهذه المسودة
let uploading = false;
let currentFile = null;    // الملف المختار في المتصفح
let url = '';              // Object URL للمعاينة

const $ = id => document.getElementById(id);

/* ------------------------------ رسائل الخطأ ----------------------------- */
const ERROR_MAP = [
  [/invalid login credentials/i, 'البريد الإلكتروني أو كلمة المرور غير صحيحة.'],
  [/email not confirmed/i, 'البريد الإلكتروني لم يُؤكَّد بعد. أكّده من لوحة Supabase.'],
  [/signup.*disabled|signups? not allowed/i, 'التسجيل العام مغلق. أنشئ حسابك من لوحة Supabase ← Authentication ← Users.'],
  [/jwt expired|token is expired|invalid jwt|invalid claim/i, 'انتهت صلاحية الجلسة. سجّل الدخول مرة أخرى.'],
  [/row-level security|permission denied/i, 'لا تملك صلاحية تنفيذ هذه العملية على هذا السجل.'],
  [/exceeded the maximum allowed size|payload too large|entity too large|413/i, 'حجم الملف يتجاوز الحد المسموح (١٠٠ ميغابايت) أو حدود الخطة.'],
  [/mime type .* is not supported|invalid mime/i, 'صيغة الملف غير مسموحة. استخدم PNG أو JPG أو WebP أو MP4 أو MOV أو WebM.'],
  [/duplicate key|already exists/i, 'يوجد سجل مطابق بالفعل.'],
  [/check constraint|value too long/i, 'أحد الحقول غير مقبول: تحقق من الطول أو من قائمة المنصات.'],
  [/the resource was not found|not found/i, 'العنصر غير موجود أو تم حذفه.'],
  [/failed to fetch|networkerror|load failed/i, 'تعذر الاتصال بالخادم. تحقق من اتصال الإنترنت وحاول مجددًا.']
];
function humanError(err) {
  const raw = (err && (err.message || err.error_description || err.error || err.msg)) || String(err || '');
  for (const [re, ar] of ERROR_MAP) if (re.test(raw)) return ar;
  return raw || 'حدث خطأ غير متوقع.';
}

/* -------------------------------- الشبكة -------------------------------- */
/**
 * طلب إلى Supabase.
 *  • المفتاح القابل للنشر يُرسل في ترويسة apikey فقط (ليس Bearer — فهو ليس JWT).
 *  • Authorization: Bearer يُستخدم فقط مع توكن مستخدم حقيقي.
 *  • token: null يعني «بدون Authorization».
 */
async function sbRequest(path, { method = 'GET', body, token, headers = {}, raw = false } = {}) {
  const h = { apikey: SB_KEY, ...headers };
  const bearer = token === undefined ? (session && session.access_token) : token;
  if (bearer) h.Authorization = 'Bearer ' + bearer;
  const isBlob = body instanceof Blob;
  if (body !== undefined && !isBlob) h['Content-Type'] = 'application/json';

  let res;
  try {
    res = await fetch(SB + path, {
      method,
      headers: h,
      body: body === undefined ? undefined : (isBlob ? body : JSON.stringify(body))
    });
  } catch {
    throw new Error('تعذر الاتصال بالخادم. تحقق من اتصال الإنترنت وحاول مجددًا.');
  }

  if (raw) {
    if (!res.ok) throw new Error((await res.text()) || 'تعذر تحميل الملف.');
    return res.blob();
  }

  const text = await res.text();
  let data = null;
  if (text) { try { data = JSON.parse(text); } catch { data = text; } }
  if (!res.ok) throw new Error(humanError(data) || ('HTTP ' + res.status));
  return data;
}

/* --------------------------------- الجلسة -------------------------------- */
function renderAccount() {
  const signed = !!(session && session.user);
  const label = $('accountLabel'), initial = $('accountInitial');
  if (label) label.textContent = signed ? session.user.email : 'غير مسجل';
  if (initial) initial.textContent = signed ? (session.user.email || 'ب').trim().charAt(0).toUpperCase() : 'ب';
  const btn = $('accountBtn');
  if (btn) btn.classList.toggle('signed', signed);
  const navAccount = document.querySelector('[data-nav="account"] .text');
  if (navAccount) navAccount.textContent = signed ? 'حسابي' : 'تسجيل الدخول';
}

function persistSession(s) {
  session = s;
  try {
    if (s) sessionStorage.setItem(SESSION_KEY, JSON.stringify(s));
    else sessionStorage.removeItem(SESSION_KEY);
  } catch { /* الوضع الخاص قد يمنع التخزين */ }
  renderAccount();
}

function restoreSession() {
  try {
    const s = JSON.parse(sessionStorage.getItem(SESSION_KEY) || 'null');
    if (s && s.access_token && s.user) session = s;
  } catch { session = null; }
  renderAccount();
}

const isSignedIn = () => !!(session && session.user && session.access_token);

/** يجدّد الجلسة تلقائيًا قبل انتهائها. */
async function ensureSession() {
  if (!isSignedIn()) return false;
  if (session.expires_at && session.expires_at * 1000 > Date.now() + 90_000) return true;
  if (!session.refresh_token) { persistSession(null); return false; }
  try {
    const d = await sbRequest('/auth/v1/token?grant_type=refresh_token', {
      method: 'POST', token: null, body: { refresh_token: session.refresh_token }
    });
    if (!d || !d.access_token || !d.user) throw new Error('استجابة تجديد الجلسة غير صالحة.');
    persistSession(d);
    return true;
  } catch {
    persistSession(null);
    return false;
  }
}

/** عمليات تحتاج مستخدمًا؛ تفتح لوحة الدخول إذا لزم. */
async function requireAuth() {
  if (await ensureSession()) return true;
  openPanel('account');
  toast('سجّل الدخول أولًا للمتابعة.', 'warn');
  return false;
}

/* ------------------------------ عناصر الواجهة ---------------------------- */
function toast(message, kind = 'info') {
  const box = $('toast');
  if (!box) return;
  box.textContent = message;
  box.className = 'toast show ' + kind;
  box.hidden = false;
  clearTimeout(toast._t);
  toast._t = setTimeout(() => { box.className = 'toast'; box.hidden = true; }, 6500);
}
function status(msg) { const el = $('status'); if (el) el.textContent = msg; }
function progress(pct, visible) {
  const wrap = $('progressWrap'), bar = $('progressBar');
  if (!wrap || !bar) return;
  wrap.hidden = !visible;
  if (visible) bar.style.width = Math.max(0, Math.min(100, pct)) + '%';
}

/* -------------------------------- الوسائط -------------------------------- */
function validateFile(f) {
  if (!f) return 'لم يتم اختيار ملف.';
  if (!EXT_BY_TYPE[f.type]) return 'الصيغة غير مدعومة. استخدم PNG أو JPG أو WebP أو MP4 أو MOV أو WebM.';
  if (f.size === 0) return 'الملف فارغ.';
  if (f.size > MAX_BYTES) return 'الملف يتجاوز ١٠٠ ميغابايت. اضغط الفيديو أو قلّل حجمه قبل الرفع.';
  return null;
}

/** يرفع الملف إلى مجلد المستخدم مع نسبة تقدم. يعيد مسار التخزين. */
function uploadMedia(file, onProgress) {
  return new Promise((resolve, reject) => {
    const ext = EXT_BY_TYPE[file.type];
    const path = session.user.id + '/' + crypto.randomUUID() + '.' + ext;
    const xhr = new XMLHttpRequest();
    xhr.open('POST', SB + '/storage/v1/object/' + BUCKET + '/' + path.split('/').map(encodeURIComponent).join('/'));
    xhr.setRequestHeader('apikey', SB_KEY);
    xhr.setRequestHeader('Authorization', 'Bearer ' + session.access_token);
    xhr.setRequestHeader('Content-Type', file.type);
    xhr.setRequestHeader('x-upsert', 'false');
    xhr.timeout = 30 * 60 * 1000;
    xhr.upload.onprogress = e => {
      if (e.lengthComputable && onProgress) onProgress(Math.round(e.loaded / e.total * 100));
    };
    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) return resolve(path);
      let msg = 'تعذر رفع الملف (HTTP ' + xhr.status + ').';
      try { msg = humanError(JSON.parse(xhr.responseText)); } catch {}
      reject(new Error(msg));
    };
    xhr.onerror = () => reject(new Error('تعذر رفع الملف. تحقق من الاتصال وحاول مجددًا.'));
    xhr.ontimeout = () => reject(new Error('انتهت مهلة الرفع. جرّب ملفًا أصغر.'));
    xhr.send(file);
  });
}

function objectUrl(path) {
  return SB + '/storage/v1/object/' + BUCKET + '/' + path.split('/').map(encodeURIComponent).join('/');
}
function downloadUrl(path) {
  return SB + '/storage/v1/object/authenticated/' + BUCKET + '/' + path.split('/').map(encodeURIComponent).join('/');
}

/** حذف ملف من التخزين — يُستخدم للتنظيف بعد فشل الحفظ أو استبدال ملف. */
async function deleteMedia(path) {
  if (!path) return;
  try {
    await sbRequest(objectUrl(path), { method: 'DELETE' });
  } catch { /* التنظيف غير حرج */ }
}

/* ------------------------------- حفظ المسودة ----------------------------- */
function currentForm() {
  const platforms = [...document.querySelectorAll('.platform.selected')].map(b => b.dataset.name);
  const later = document.querySelector('[name=time]:checked').value === 'later';
  return {
    title: $('title').value.trim(),
    description: $('desc').value,
    hashtags: $('tags').value,
    platforms,
    scheduled_at: later && $('when').value ? new Date($('when').value).toISOString() : null,
    later
  };
}

async function saveDraft() {
  if (uploading) return;
  if (!await requireAuth()) return;

  const form = currentForm();
  if (!form.title) { status('أضف عنوانًا قبل الحفظ.'); $('title').focus(); return; }
  if (!form.platforms.length) { status('اختر منصة واحدة على الأقل قبل الحفظ.'); return; }
  if (form.later && !$('when').value) { status('حدّد موعد الجدولة أو اختر «النشر فورًا».'); $('when').focus(); return; }

  const btn = $('draft');
  const previousPath = loadedPath;
  let uploadedPath = null;
  btn.disabled = true;
  uploading = true;

  try {
    if (currentFile && currentFile !== savedFile) {
      const bad = validateFile(currentFile);
      if (bad) throw new Error(bad);
      progress(0, true);
      status('جارٍ رفع الملف...');
      uploadedPath = await uploadMedia(currentFile, p => {
        progress(p, true);
        status('جارٍ رفع الملف... ' + p + '%');
      });
    }

    const row = {
      owner_id: session.user.id,
      title: form.title,
      description: form.description,
      hashtags: form.hashtags,
      platforms: form.platforms,
      media_path: uploadedPath || previousPath,
      media_type: currentFile ? currentFile.type : (uploadedPath ? null : undefined),
      scheduled_at: form.scheduled_at,
      status: form.scheduled_at ? 'scheduled' : 'draft'
    };
    if (row.media_type === undefined) delete row.media_type;

    let saved;
    if (loadedId) {
      saved = await sbRequest('/rest/v1/imprint_posts?id=eq.' + encodeURIComponent(loadedId), {
        method: 'PATCH', headers: { Prefer: 'return=representation' }, body: row
      });
      if (!saved || !saved.length) throw new Error('لم يتم تحديث أي سجل. قد تكون المسودة محذوفة.');
    } else {
      saved = await sbRequest('/rest/v1/imprint_posts', {
        method: 'POST', headers: { Prefer: 'return=representation' }, body: row
      });
      if (!saved || !saved.length) throw new Error('لم يُعِد الخادم السجل المحفوظ.');
    }

    loadedId = saved[0].id;
    loadedPath = saved[0].media_path;
    if (currentFile) savedFile = currentFile;

    // تنظيف الملف القديم بعد نجاح الاستبدال
    if (uploadedPath && previousPath && previousPath !== uploadedPath) await deleteMedia(previousPath);

    progress(100, true);
    setTimeout(() => progress(0, false), 900);

    if (form.scheduled_at) {
      const job = await createPublishJob(loadedId);
      if (job === 'created') {
        status('تم حفظ المسودة، ووُضعت في طابور النشر للموعد ' + fmtDate(form.scheduled_at) +
          '. سيُنشر تلقائيًا فقط بعد ربط الحساب وتشغيل العامل.');
        toast('تم الحفظ وإضافة المهمة إلى طابور النشر.', 'ok');
      } else if (job === 'exists') {
        status('تم حفظ المسودة. توجد مهام نشر سابقة لهذا المنشور، لذلك لم تُضف مهام مكررة.');
        toast('تم حفظ المسودة.', 'ok');
      } else {
        status('تم حفظ المسودة، لكن تعذر إضافة مهام النشر: ' + job);
        toast('حُفظت المسودة دون مهام نشر.', 'warn');
      }
    } else {
      status('تم حفظ المسودة كمسودة بدون موعد. أضف موعدًا ليدخل المنشور طابور النشر.');
      toast('تم حفظ المسودة.', 'ok');
    }
  } catch (e) {
    if (uploadedPath) await deleteMedia(uploadedPath);
    progress(0, false);
    const msg = humanError(e);
    status('تعذر الحفظ: ' + msg);
    toast('تعذر الحفظ: ' + msg, 'err');
  } finally {
    uploading = false;
    btn.disabled = false;
  }
}

/* ---------------------------- طابور النشر ------------------------------- */
const JOB_STATUS_AR = {
  queued: 'في الطابور', running: 'جارٍ التنفيذ', published: 'نُشر',
  failed: 'فشل', blocked: 'بانتظار الحساب', canceled: 'أُلغي'
};
const POST_STATUS_AR = {
  draft: 'مسودة', ready: 'جاهز', scheduled: 'مجدول',
  publishing: 'قيد النشر', published: 'نُشر', failed: 'فشل'
};

/**
 * ينشئ مهمة نشر لكل منصة (عبر REST مباشرة).
 * السياسة تسمح للمالك بالإدخال فقط عندما يكون المنشور مجدولًا بمستقبل القريب،
 * والتكرار يُلتقط عبر قيد unique فيفشل بهدوء.
 * يعيد: 'created' | 'exists' | نص الخطأ
 */
async function createPublishJob(postId) {
  try {
    const existing = await sbRequest('/rest/v1/publish_jobs?post_id=eq.' +
      encodeURIComponent(postId) + '&select=id&limit=1');
    if (existing && existing.length) return 'exists';

    const post = (await sbRequest('/rest/v1/imprint_posts?id=eq.' +
      encodeURIComponent(postId) + '&select=platforms,owner_id'))[0];
    if (!post) return 'لم يُعثر على المنشور.';

    await sbRequest('/rest/v1/publish_jobs', {
      method: 'POST',
      headers: { Prefer: 'return=minimal' },
      body: post.platforms.map(p => ({
        owner_id: session.user.id,
        post_id: postId,
        platform: p,
        status: 'queued'
      }))
    });
    return 'created';
  } catch (e) {
    return humanError(e);
  }
}

/** يجلب حالة مهام النشر لمجموعة منشورات. */
async function jobsForPosts(ids) {
  if (!ids.length) return {};
  const list = ids.map(id => encodeURIComponent(id)).join(',');
  const rows = await sbRequest('/rest/v1/publish_jobs?post_id=in.(' + list +
    ')&select=post_id,platform,status,attempts,last_error,external_url&order=platform');
  const map = {};
  rows.forEach(r => { (map[r.post_id] = map[r.post_id] || []).push(r); });
  return map;
}

/* ------------------------------ فتح المسودة ------------------------------ */
async function openDraft(id) {
  if (!await ensureSession()) { openPanel('account'); return; }
  const rows = await sbRequest('/rest/v1/imprint_posts?id=eq.' + encodeURIComponent(id) + '&select=*');
  if (!rows || !rows.length) throw new Error('لم يتم العثور على المسودة.');
  const row = rows[0];

  closePanel();
  loadedId = row.id;
  loadedPath = row.media_path;
  savedFile = null;
  resetMediaView();

  $('title').value = row.title || '';
  $('desc').value = row.description || '';
  $('tags').value = row.hashtags || '';
  if (typeof syncPreview === 'function') syncPreview();
  if (typeof syncCounters === 'function') syncCounters();

  document.querySelectorAll('.platform').forEach(p => {
    const on = (row.platforms || []).includes(p.dataset.name);
    p.classList.toggle('selected', on);
    p.querySelector('.check').textContent = on ? '✓' : '';
  });

  if (row.scheduled_at) {
    document.querySelector('[name=time][value=later]').checked = true;
    $('when').style.display = 'block';
    const d = new Date(row.scheduled_at);
    $('when').value = new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 16);
  } else {
    document.querySelector('[name=time][value=now]').checked = true;
    $('when').style.display = 'none';
    $('when').value = '';
  }

  if (row.media_path) {
    status('جارٍ تحميل الملف...');
    try {
      const blob = await sbRequest(downloadUrl(row.media_path), { raw: true });
      const ext = (row.media_path.split('.').pop() || '').toLowerCase();
      const type = row.media_type || blob.type || MIME_BY_EXT[ext] || '';
      const f = new File([blob], 'media.' + ext, { type });
      if (typeof setFile === 'function') setFile(f, { keepName: true });
      savedFile = f;
      status('تم فتح المسودة وملفها. «حفظ مسودة» يحدّث المسودة نفسها.');
    } catch (e) {
      // نبقي المرجع للملف في السجل حتى لا يفقده الحفظ التالي
      status('تم فتح المسودة، لكن تعذر تحميل الملف للمعاينة: ' + humanError(e));
    }
  } else {
    status('تم فتح المسودة (بدون ملف). أضف ملفًا ثم احفظ.');
  }
  document.querySelectorAll('[data-nav]').forEach(x => x.classList.toggle('active', x.dataset.nav === 'studio'));
  $('crumb').textContent = 'استوديو النشر';
  window.scrollTo({ top: 0, behavior: 'smooth' });
}

async function deleteDraft(id, title) {
  if (!await requireAuth()) return;
  if (!confirm('حذف المسودة «' + (title || 'بدون عنوان') + '» نهائيًا؟')) return;
  try {
    const row = (await sbRequest('/rest/v1/imprint_posts?id=eq.' + encodeURIComponent(id) + '&select=media_path'))[0];
    await sbRequest('/rest/v1/imprint_posts?id=eq.' + encodeURIComponent(id), { method: 'DELETE' });
    if (row && row.media_path) await deleteMedia(row.media_path);
    if (loadedId === id && typeof newDraft === 'function') newDraft();
    toast('تم حذف المسودة.', 'ok');
    renderLibrary();
    if ($('scheduleList')) renderSchedule();
  } catch (e) {
    toast('تعذر الحذف: ' + humanError(e), 'err');
  }
}

/* --------------------------------- المكتبة ------------------------------- */
function fmtDate(iso) {
  if (!iso) return '—';
  try {
    return new Date(iso).toLocaleString('ar', {
      year: 'numeric', month: 'short', day: 'numeric',
      hour: '2-digit', minute: '2-digit', calendar: 'gregory', numberingSystem: 'latn'
    });
  } catch { return new Date(iso).toISOString().slice(0, 16).replace('T', ' '); }
}

function makeRow(title, meta, actions) {
  const item = document.createElement('div');
  item.className = 'row';
  const main = document.createElement('div');
  main.className = 'row-main';
  const t = document.createElement('strong');
  t.textContent = title;
  const m = document.createElement('small');
  m.className = 'row-meta';
  m.textContent = meta;
  main.append(t, m);
  const act = document.createElement('div');
  act.className = 'row-actions';
  actions.forEach(a => act.appendChild(a));
  item.append(main, act);
  return item;
}

function makeBtn(text, cls, onClick) {
  const b = document.createElement('button');
  b.type = 'button';
  b.className = 'chip ' + cls;
  b.textContent = text;
  b.onclick = onClick;
  return b;
}

async function renderLibrary() {
  const box = $('draftList');
  if (!box) return;
  if (!await ensureSession()) { box.innerHTML = '<p class="empty-note">سجّل الدخول لعرض مسوداتك.</p>'; return; }
  box.innerHTML = '<p class="empty-note">جارٍ التحميل...</p>';
  try {
    const rows = await sbRequest('/rest/v1/imprint_posts?select=*&order=updated_at.desc&limit=100');
    if (!rows.length) {
      box.innerHTML = '<p class="empty-note">لا توجد مسودات بعد. أضف عنوانًا واختر منصة ثم اضغط «حفظ مسودة».</p>';
      return;
    }
    box.innerHTML = '';
    const list = document.createElement('div');
    list.className = 'rows';
    rows.forEach(row => {
      list.appendChild(makeRow(
        row.title || 'مسودة بلا عنوان',
        [
          row.scheduled_at ? 'موعد محفوظ: ' + fmtDate(row.scheduled_at) : 'بدون موعد',
          (row.platforms || []).join('، ') || 'بدون منصات',
          row.media_path ? 'مع ملف' : 'بدون ملف',
          'آخر تحديث ' + fmtDate(row.updated_at)
        ].join(' · '),
        [
          makeBtn('فتح', 'primary-chip', () =>
            openDraft(row.id).catch(e => toast('تعذر فتح المسودة: ' + humanError(e), 'err'))),
          makeBtn('حذف', 'danger', () => deleteDraft(row.id, row.title))
        ]
      ));
    });
    box.appendChild(list);
  } catch (e) {
    box.innerHTML = '<p class="empty-note">تعذر تحميل المسودات: ' + humanError(e) + '</p>';
  }
}

async function renderSchedule() {
  const box = $('scheduleList');
  if (!box) return;
  if (!await ensureSession()) { box.innerHTML = '<p class="empty-note">سجّل الدخول لعرض الجدول.</p>'; return; }
  box.innerHTML = '<p class="empty-note">جارٍ التحميل...</p>';
  try {
    const rows = await sbRequest('/rest/v1/imprint_posts?select=*&order=coalesce(scheduled_at,updated_at).desc&limit=100');
    const scheduled = rows.filter(r => r.scheduled_at);
    if (!scheduled.length) {
      box.innerHTML = '<p class="empty-note">لا توجد مواعيد محفوظة. اختر «جدولة لوقت لاحق» ثم احفظ المسودة.</p>';
      return;
    }
    const jobs = await jobsForPosts(scheduled.map(r => r.id));
    box.innerHTML = '<p class="banner">كل منصة لها مهمة مستقلة. الحالة «بانتظار الحساب» تعني أن المنصة لم تُربط بعد، ولا يعني ذلك نجاح النشر.</p>';
    const list = document.createElement('div');
    list.className = 'rows';
    scheduled.forEach(row => {
      const item = document.createElement('div');
      item.className = 'row';
      item.style.flexDirection = 'column';
      item.style.alignItems = 'stretch';

      const head = document.createElement('div');
      head.style.cssText = 'display:flex;justify-content:space-between;gap:10px;align-items:center';
      const main = document.createElement('div');
      main.className = 'row-main';
      const t = document.createElement('strong'); t.textContent = row.title || 'مسودة بلا عنوان';
      const m = document.createElement('small'); m.className = 'row-meta';
      m.textContent = fmtDate(row.scheduled_at) + ' · ' + (POST_STATUS_AR[row.status] || row.status);
      main.append(t, m);

      const acts = document.createElement('div');
      acts.className = 'row-actions';
      acts.appendChild(makeBtn('فتح', '', () => openDraft(row.id).catch(e => toast(humanError(e), 'err'))));
      head.append(main, acts);
      item.appendChild(head);

      const chips = document.createElement('div');
      chips.className = 'job-chips';
      const list2 = jobs[row.id] || [];
      if (!list2.length) {
        const s = document.createElement('span');
        s.className = 'job-chip none';
        s.textContent = 'لا مهام نشر — أعد الحفظ لإضافتها';
        chips.appendChild(s);
      } else {
        list2.forEach(j => {
          const c = document.createElement('span');
          c.className = 'job-chip ' + j.status;
          c.textContent = j.platform + ' · ' + (JOB_STATUS_AR[j.status] || j.status) +
            (j.attempts ? ' (' + j.attempts + ')' : '');
          c.title = j.last_error || j.external_url || '';
          chips.appendChild(c);
        });
      }
      item.appendChild(chips);
      list.appendChild(item);
    });
    box.appendChild(list);
  } catch (e) {
    box.innerHTML = '<p class="empty-note">تعذر تحميل الجدول: ' + humanError(e) + '</p>';
  }
}

async function renderStorageSummary() {
  const box = $('storageSummary');
  if (!box) return;
  box.textContent = 'جارٍ حساب المحتوى...';
  try {
    const rows = await sbRequest('/rest/v1/imprint_posts?select=media_path&media_path=not.is.null&limit=1000');
    box.textContent = rows.length
      ? 'لديك ' + rows.length + ' ملف محفوظ في مساحتك الخاصة. حد الملف الواحد ١٠٠ ميغابايت، والمساحة الكلية تخضع لخطة Supabase.'
      : 'لا توجد ملفات محفوظة بعد. حد الملف الواحد ١٠٠ ميغابايت.';
  } catch (e) {
    box.textContent = 'تعذر حساب الاستخدام: ' + humanError(e);
  }
}

/* --------------------------------- اللوحات ------------------------------- */
function panelShell(title, subtitle, inner) {
  const c = $('panelContent');
  c.innerHTML = '<h2 id="modalTitle"></h2>' + (subtitle ? '<p class="panel-sub"></p>' : '') + inner;
  c.querySelector('#modalTitle').textContent = title;
  if (subtitle) c.querySelector('.panel-sub').textContent = subtitle;
  $('overlay').style.display = 'flex';
}
function closePanel() { const o = $('overlay'); if (o) o.style.display = 'none'; }

function openPanel(which) {
  if (which === 'accounts') return renderAccountsPanel();
  if (which === 'library') return renderLibraryPanel();
  if (which === 'schedule') return renderSchedulePanel();
  return renderAccountPanel();
}

function renderAccountsPanel() {
  panelShell('حساباتك في مكان واحد',
    'الربط الفعلي غير مفعّل بعد: يحتاج خادمًا آمنًا يخزّن رموز الوصول، ولا يمكن تخزينها في صفحة ثابتة.',
    '<div class="hint-box">لا يوجد حاليًا أي حساب مرتبط. ما يلزم لكل منصة قبل التفعيل:</div>');
  const rows = [
    ['TikTok', 'تطبيق مطوّر ومعتمد في TikTok for Developers ثم OAuth ومراجعة المحتوى.'],
    ['Instagram', 'حساب أعمال مربوط بصفحة Facebook وتطبيق Meta ومُراجَعة صلاحيات النشر.'],
    ['Facebook', 'تطبيق Meta وصلاحيات pages_manage_posts ومراجعة App Review.'],
    ['YouTube', 'مشروع Google Cloud وتفعيل YouTube Data API وحصة نشر كافية.']
  ];
  const c = $('panelContent');
  rows.forEach(([name, need]) => {
    const div = document.createElement('div');
    div.className = 'account-row';
    const info = document.createElement('div');
    const s = document.createElement('strong'); s.textContent = name;
    const small = document.createElement('small'); small.textContent = 'غير مرتبط';
    const needEl = document.createElement('small'); needEl.className = 'need'; needEl.textContent = need;
    info.append(s, small, needEl);
    const pill = document.createElement('span'); pill.className = 'pill'; pill.textContent = 'قيد التطوير';
    div.append(info, pill);
    c.appendChild(div);
  });
}

function renderLibraryPanel() {
  panelShell('مكتبة المحتوى', 'مسوداتك المحفوظة في مساحتك الخاصة.', '<div id="draftList"></div>');
  renderLibrary();
}

function renderSchedulePanel() {
  panelShell('جدول المنشورات', 'المواعيد المحفوظة داخل المسودات.', '<div id="scheduleList"></div>');
  renderSchedule();
}

function renderAccountPanel() {
  if (isSignedIn()) {
    panelShell('حسابك', 'الجلسة محفوظة في هذه النافذة فقط وتُمسح عند إغلاقها.',
      '<div class="account-row"><div><strong id="signedEmail"></strong><small id="signedSince"></small></div>' +
      '<span class="pill ok">متصل</span></div>' +
      '<div id="storageSummary" class="hint-box"></div>' +
      '<button class="primary" id="logout" type="button">تسجيل الخروج</button>');
    $('signedEmail').textContent = session.user.email;
    $('signedSince').textContent = session.user.last_sign_in_at ? 'آخر دخول: ' + fmtDate(session.user.last_sign_in_at) : '';
    $('logout').onclick = async () => {
      try { await sbRequest('/auth/v1/logout', { method: 'POST' }); } catch {}
      persistSession(null);
      loadedId = null; loadedPath = null; savedFile = null;
      closePanel();
      toast('تم تسجيل الخروج.', 'ok');
      status('تم تسجيل الخروج. المسودات المحفوظة لم تُحذف.');
    };
    renderStorageSummary();
    return;
  }

  panelShell('تسجيل الدخول', 'الدخول مخصص لحسابك الذي تنشئه في لوحة Supabase. التسجيل العام مغلق.',
    '<form id="loginform">' +
    '<label for="email">البريد الإلكتروني</label>' +
    '<input id="email" type="email" autocomplete="username" required>' +
    '<label for="password">كلمة المرور</label>' +
    '<input id="password" type="password" autocomplete="current-password" required>' +
    '<button class="primary" type="submit" id="loginBtn">دخول</button>' +
    '<p id="loginStatus" role="status" class="hint"></p></form>');

  $('loginform').onsubmit = async e => {
    e.preventDefault();
    const btn = $('loginBtn'), out = $('loginStatus');
    btn.disabled = true;
    out.textContent = 'جارٍ الدخول...';
    try {
      const d = await sbRequest('/auth/v1/token?grant_type=password', {
        method: 'POST', token: null,
        body: { email: $('email').value.trim(), password: $('password').value }
      });
      persistSession(d);
      closePanel();
      toast('تم تسجيل الدخول بنجاح.', 'ok');
      status('تم تسجيل الدخول. يمكنك الآن حفظ المسودات وفتحها.');
    } catch (err) {
      out.textContent = 'تعذر الدخول: ' + humanError(err);
      btn.disabled = false;
    }
  };
}

/* --------------------------------- التمهيد ------------------------------- */
function boot() {
  restoreSession();

  let toastBox = $('toast');
  if (!toastBox) {
    toastBox = document.createElement('div');
    toastBox.id = 'toast';
    toastBox.className = 'toast';
    toastBox.hidden = true;
    toastBox.setAttribute('role', 'alert');
    document.body.appendChild(toastBox);
  }

  $('accountBtn').onclick = () => openPanel('account');
  $('closePanel').onclick = closePanel;
  $('overlay').addEventListener('click', e => { if (e.target === $('overlay')) closePanel(); });
  document.addEventListener('keydown', e => { if (e.key === 'Escape') closePanel(); });

  document.querySelectorAll('[data-nav]').forEach(b => {
    b.onclick = () => {
      const which = b.dataset.nav;
      document.querySelectorAll('[data-nav]').forEach(x => x.classList.toggle('active', x === b));
      $('crumb').textContent = b.querySelector('.text').textContent;
      if (which === 'studio') { closePanel(); window.scrollTo({ top: 0, behavior: 'smooth' }); return; }
      openPanel(which);
    };
  });

  $('draft').onclick = saveDraft;
  $('newDraft').onclick = () => newDraft();

  if (isSignedIn()) {
    status('مرحبًا بعودتك، ' + session.user.email + '.');
    ensureSession();
  }

  // تجديد هادئ للجلسة قبل انتهاء صلاحيتها
  setInterval(() => { if (isSignedIn()) ensureSession(); }, 5 * 60 * 1000);
}

if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
else boot();

window.saveDraft = saveDraft;
window.openDraft = openDraft;
window.deleteDraft = deleteDraft;
window.openPanel = openPanel;
window.closePanel = closePanel;
