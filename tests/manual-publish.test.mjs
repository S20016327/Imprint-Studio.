// اختبار «نسخ للصفحة»: نشر يدوي حقيقي بلا API — ينسخ النص، ينزّل الملف،
// يفتح صفحة المنصة، ويسجّل النتيجة بأمانة.
import { JSDOM, VirtualConsole } from 'jsdom';
import fs from 'fs';

const html = fs.readFileSync(new URL('../index.html', import.meta.url), 'utf8');
const cloud = fs.readFileSync(new URL('../cloud.js', import.meta.url), 'utf8');
const merged = html.replace('<script src="cloud.js"></script>', '<script>' + cloud + '</script>');

const errors = [];
const vc = new VirtualConsole();
vc.on('jsdomError', e => { if (!/scrollTo/.test(e.message)) errors.push(e.message); });

const PATCHES = [];
const ROW = {
  id: 'post-1', title: 'عنوان المنشور', description: 'وصف تجريبي',
  hashtags: '#بصمة #ابداع', platforms: ['Instagram', 'YouTube'],
  scheduled_at: new Date().toISOString(), status: 'scheduled',
  updated_at: new Date().toISOString(), media_path: 'u/1-file.jpg', media_type: 'image/jpeg'
};

const dom = new JSDOM(merged, {
  runScripts: 'dangerously', virtualConsole: vc, url: 'https://x.github.io/p/',
  beforeParse(w) {
    w.__opened = []; w.__clicks = []; w.__copied = [];
    w.URL.createObjectURL = () => 'blob:x';
    w.URL.revokeObjectURL = () => {};
    w.scrollTo = () => {};
    w.matchMedia = q => ({ matches: false, media: q, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {} });
    w.open = (u) => { w.__opened.push(u); return null; };
    w.navigator.clipboard = { writeText: async t => { w.__copied.push(t); } };
    Object.defineProperty(w.HTMLAnchorElement.prototype, 'click', {
      value: function () { w.__clicks.push(this.download || 'click'); }, configurable: true
    });
    w.fetch = async (u, o = {}) => {
      const url = String(u);
      const json = (d, st = 200) => ({
        ok: st < 300, status: st, async text() { return JSON.stringify(d); },
        async json() { return d; }, headers: { get: () => null }
      });
      if (url.includes('grant_type=password')) return json({
        access_token: 't', refresh_token: 'r', expires_at: Math.floor(Date.now() / 1000) + 3600,
        user: { id: 'aaaaaaaa-1111-4111-8111-111111111111', email: 'o@e.com' }
      });
      if (url.includes('/rest/v1/imprint_posts') && url.includes('select=*')) return json([ROW]);
      if (o.method === 'PATCH' && url.includes('/rest/v1/publish_jobs')) {
        PATCHES.push({ kind: 'job', url, body: JSON.parse(o.body) }); return json(null, 204);
      }
      if (url.includes('/rest/v1/imprint_posts') && o.method === 'PATCH') {
        PATCHES.push({ kind: 'post', url, body: JSON.parse(o.body) }); return json(null, 204);
      }
      if (url.includes('/rest/v1/publish_jobs')) return json([
        { id: 'job-ig', post_id: 'post-1', platform: 'Instagram', status: 'queued' },
        { id: 'job-yt', post_id: 'post-1', platform: 'YouTube', status: 'queued' }
      ]);
      if (url.includes('/storage/v1/object/')) return {
        ok: true, status: 200, async blob() { return new w.Blob(['x'], { type: 'image/jpeg' }); },
        async text() { return 'x'; }
      };
      if (url.includes('/functions/v1/imprint-oauth-start')) return json({ ok: true, service: 'imprint-oauth-start', ready: {}, hints: {} });
      if (url.includes('/functions/v1/imprint-account-link')) return json({ build: 'v1-token-link', help: {} }, 404);
      return json({});
    };
  }
});

const w = dom.window, $ = id => w.document.getElementById(id);
const tick = (ms = 150) => new Promise(r => setTimeout(r, ms));
const log = []; const check = (n, c, x = '') => log.push((c ? 'PASS ' : 'FAIL ') + n + (x ? ' :: ' + x : ''));

(async () => {
  await tick(150);
  $('accountBtn').click(); await tick();
  $('email').value = 'o@e.com'; $('password').value = 'p';
  $('loginform').dispatchEvent(new w.Event('submit', { bubbles: true, cancelable: true }));
  await tick(180);

  w.openPanel('schedule');
  await tick(350);

  const btns = [...w.document.querySelectorAll('.row-actions .chip')];
  const copyBtn = btns.find(b => /نسخ إلى/.test(b.textContent));
  const doneBtn = btns.find(b => /تم النشر/.test(b.textContent));
  check('copy-to-platform button rendered', !!copyBtn, btns.map(b => b.textContent).join(' | '));
  check('honest "published" button rendered', !!doneBtn);

  // نسخ النص + تنزيل الملف + فتح الصفحة
  copyBtn.click();
  await tick(300);
  check('caption copied to clipboard', w.__copied.length === 1, JSON.stringify(w.__copied));
  check('caption has title, description, hashtags',
    /عنوان المنشور/.test(w.__copied[0]) && /وصف تجريبي/.test(w.__copied[0]) && /#بصمة/.test(w.__copied[0]),
    w.__copied[0]);
  check('media downloaded with a filename', w.__clicks.length === 1 && /\.jpg$/.test(w.__clicks[0]), w.__clicks.join(','));
  check('platform page opened', w.__opened.length === 1 && /instagram\.com/.test(w.__opened[0]), w.__opened.join(','));
  check('status explains the three steps', /الصق/.test($('status').textContent), $('status').textContent);
  check('no claim of automatic publishing', !/تم النشر آليًا|نشر تلقائي/.test($('status').textContent));

  // تسجيل النشر الفعلي
  PATCHES.length = 0;
  doneBtn.click();
  await tick(300);
  const jobPatch = PATCHES.find(p => p.kind === 'job');
  const postPatch = PATCHES.find(p => p.kind === 'post');
  check('records the job as published', jobPatch && jobPatch.body.status === 'published', JSON.stringify(jobPatch?.body));
  check('records a finish time', !!jobPatch?.body.finished_at);
  check('does not mark the post fully published when another platform is pending',
    postPatch && postPatch.body.status === 'publishing', JSON.stringify(postPatch?.body));

  check('no jsdom errors', errors.length === 0, errors.join(' | '));

  console.log(log.join('\n'));
  const f = log.filter(l => l.startsWith('FAIL'));
  console.log('SUMMARY:', log.length - f.length, 'passed,', f.length, 'failed');
  process.exit(f.length ? 1 : 0);
})();
