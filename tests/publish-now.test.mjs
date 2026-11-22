// «انشر الآن»: يتحقق أن الواجهة تنادي الوسيط، وتُبلّغ بالحقيقة في كل حالة،
// ولا تدّعي نجاحًا لم يحدث ولا تسرّب سر العامل.
import { JSDOM, VirtualConsole } from 'jsdom';
import fs from 'fs';

const html = fs.readFileSync(new URL('../index.html', import.meta.url), 'utf8');
const cloud = fs.readFileSync(new URL('../cloud.js', import.meta.url), 'utf8');
const merged = html.replace('<script src="cloud.js"></script>', '<script>' + cloud + '</script>');

const errors = [];
const vc = new VirtualConsole();
vc.on('jsdomError', e => { if (!/scrollTo/.test(e.message)) errors.push(e.message); });

const log = []; const check = (n, c, x = '') => log.push((c ? 'PASS ' : 'FAIL ') + n + (x ? ' :: ' + x : ''));
let WORKER_RESPONSE = { ok: true };

const dom = new JSDOM(merged, {
  runScripts: 'dangerously', virtualConsole: vc, url: 'https://x.github.io/p/',
  beforeParse(w) {
    w.__calls = [];
    w.URL.createObjectURL = () => 'blob:x';
    w.URL.revokeObjectURL = () => {};
    w.scrollTo = () => {};
    w.matchMedia = q => ({ matches: false, media: q, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {} });
    w.fetch = async (u, o = {}) => {
      const url = String(u);
      const json = (d, st = 200) => ({
        ok: st < 300, status: st,
        async text() { return JSON.stringify(d); }, async json() { return d; },
        headers: { get: () => null }
      });
      if (url.includes('grant_type=password')) return json({
        access_token: 't', refresh_token: 'r', expires_at: Math.floor(Date.now() / 1000) + 3600,
        user: { id: 'aaaaaaaa-1111-4111-8111-111111111111', email: 'o@e.com' }
      });
      if (url.includes('imprint-publish-now')) {
        w.__calls.push({ url, headers: o.headers, body: JSON.parse(o.body) });
        return json(WORKER_RESPONSE, WORKER_RESPONSE.__status || 200);
      }
      if (url.includes('/rest/v1/imprint_posts') && o.method === 'POST') {
        return json([{ id: 'post-9', media_path: 'u/x.jpg' }]);
      }
      if (url.includes('/rest/v1/imprint_posts') && o.method === 'PATCH') return json([{ id: 'post-9' }]);
      if (url.includes('/rest/v1/publish_jobs') && !o.method) return json([]);
      if (url.includes('/rest/v1/imprint_posts') && url.includes('select=*')) return json([]);
      if (url.includes('/storage/v1/object/')) return { ok: true, status: 200, async text() { return 'x'; }, async json() { return {}; }, async blob() { return new w.Blob(['x']); } };
      if (url.includes('/functions/v1/imprint-oauth-start')) return json({ ok: true, service: 'imprint-oauth-start', ready: {}, hints: {} });
      if (url.includes('/functions/v1/imprint-account-link')) return json({}, 404);
      return json({});
    };
  }
});

const w = dom.window, $ = id => w.document.getElementById(id);
const tick = (ms = 150) => new Promise(r => setTimeout(r, ms));

async function fillAndPublish() {
  $('title').value = 'منشور اختبار';
  $('desc').value = 'وصف';
  w.document.querySelectorAll('.platform').forEach(b => b.classList.add('selected'));
}

(async () => {
  await tick(150);
  $('accountBtn').click(); await tick();
  $('email').value = 'o@e.com'; $('password').value = 'p';
  $('loginform').dispatchEvent(new w.Event('submit', { bubbles: true, cancelable: true }));
  await tick(180);

  // 1) نجاح كامل
  WORKER_RESPONSE = { ok: true, queued: ['Instagram', 'YouTube'], missing: [], worker: { results: [
    { platform: 'Instagram', ok: true, external_url: 'https://instagram.com/p/x' },
    { platform: 'YouTube', ok: true, external_url: 'https://youtu.be/y' }
  ] } };
  await fillAndPublish();
  $('publishNow').click();
  await tick(500);

  const call = w.__calls[w.__calls.length - 1];
  check('calls the server-side broker (not the worker)', !!call && /imprint-publish-now/.test(call.url), call?.url);
  check('sends the user JWT (not undefined)', /^Bearer t$/.test(call.headers.Authorization || ''), call.headers.Authorization);
  check('never sends a worker secret from the browser', !('x-worker-secret' in (call.headers || {})), JSON.stringify(call.headers));
  check('sends the saved post id', call.body.post_id === 'post-9', JSON.stringify(call.body));
  check('reports both platforms succeeded', /نُشر على: Instagram وYouTube/.test($('status').textContent), $('status').textContent);
  check('success is marked ok', $('status').dataset.kind === 'ok', $('status').dataset.kind);

  // 2) نجاح جزئي — يجب ألا يقول «تم النشر» بإطلاق
  WORKER_RESPONSE = { ok: true, queued: ['Instagram', 'YouTube'], missing: ['YouTube'], worker: { results: [
    { platform: 'Instagram', ok: true },
    { platform: 'YouTube', ok: false, error: 'يوتيوب لا يقبل الصور — يحتاج ملف فيديو.' }
  ] } };
  w.__calls.length = 0;
  $('publishNow').click();
  await tick(500);
  const t2 = $('status').textContent;
  check('partial success is reported as partial', /نُشر على Instagram/.test(t2) && /فشل على YouTube/.test(t2), t2);
  check('partial success surfaces the real reason', /يوتيوب لا يقبل الصور/.test(t2), t2);
  check('partial success is a warning, not ok', $('status').dataset.kind === 'warn', $('status').dataset.kind);

  // 3) لا حساب مرتبط
  WORKER_RESPONSE = { __status: 409, error: 'لا توجد منصة مرتبطة من المنصات المختارة. اربط حسابًا أولًا.', missing: ['Instagram'], reason: 'no_linked_account' };
  $('publishNow').click();
  await tick(500);
  check('no-account case shows the real server message', /لا توجد منصة مرتبطة/.test($('status').textContent), $('status').textContent);
  check('no-account case is an error', $('status').dataset.kind === 'err', $('status').dataset.kind);

  check('no jsdom errors', errors.length === 0, errors.join(' | '));

  console.log(log.join('\n'));
  const f = log.filter(l => l.startsWith('FAIL'));
  console.log('SUMMARY:', log.length - f.length, 'passed,', f.length, 'failed');
  process.exit(f.length ? 1 : 0);
})();
