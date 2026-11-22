import { JSDOM, VirtualConsole } from 'jsdom';
import fs from 'fs';

const html = fs.readFileSync(new URL('../index.html', import.meta.url), 'utf8');
const cloud = fs.readFileSync(new URL('../cloud.js', import.meta.url), 'utf8');
const merged = html.replace('<script src="cloud.js"></script>', '<script>' + cloud + '</script>');

const errors = []; const calls = []; let mode = 'ok';
const vc = new VirtualConsole();
vc.on('jsdomError', e => { if (!/scrollTo/.test(e.message)) errors.push(e.message); });

const dom = new JSDOM(merged, {
  runScripts: 'dangerously', virtualConsole: vc, url: 'https://x.github.io/p/',
  beforeParse(w) {
    w.URL.createObjectURL = () => 'blob:x'; w.URL.revokeObjectURL = () => {}; w.scrollTo = () => {};
    w.fetch = async (u, o = {}) => {
      const url = String(u), body = o.body;
      calls.push({ url, method: o.method || 'GET', body });
      const json = (d, st = 200) => ({ ok: st < 300, status: st,
        async text() { return JSON.stringify(d); }, async blob() { return new w.Blob(['b']); } });
      if (url.includes('grant_type=password')) return json({ access_token: 't', refresh_token: 'r',
        expires_at: Math.floor(Date.now()/1000) + 3600,
        user: { id: 'aaaaaaaa-1111-4111-8111-111111111111', email: 'o@e.com' } });
      if (url.includes('/publish_jobs') && o.method === 'POST') {
        if (mode === 'jobs-denied') return json({ message: 'new row violates row-level security policy' }, 403);
        return json([], 201);
      }
      if (url.includes('/publish_jobs') && url.includes('post_id=eq.'))
        return json(mode === 'has-job' ? [{ id: 'j1' }] : []);
      if (url.includes('/publish_jobs')) return json([]);
      if (url.includes('/rest/v1/imprint_posts') && url.includes('select=platforms'))
        return json([{ platforms: ['TikTok', 'YouTube'] }]);
      if (url.includes('/rest/v1/imprint_posts') && o.method === 'POST')
        return json([{ id: 'post-1', ...JSON.parse(body) }]);
      if (url.includes('/rest/v1/imprint_posts') && url.includes('id=eq.')) return json([{ media_path: null }]);
      if (url.includes('/rest/v1/imprint_posts'))
        return json([{ id: 'post-1', title: 'T', platforms: ['TikTok'], scheduled_at: new Date().toISOString(),
          status: 'scheduled', updated_at: new Date().toISOString(), media_path: null }]);
      return json({});
    };
  }
});

const w = dom.window, $ = id => w.document.getElementById(id);
const qa = s => [...w.document.querySelectorAll(s)];
const log = []; const check = (n, c, x = '') => log.push((c ? 'PASS ' : 'FAIL ') + n + (x ? ' :: ' + x : ''));
const tick = (ms = 120) => new Promise(r => setTimeout(r, ms));

(async () => {
  await tick(150);
  // دخول
  $('accountBtn').click(); await tick();
  $('email').value = 'o@e.com'; $('password').value = 'p';
  $('loginform').dispatchEvent(new w.Event('submit', { bubbles: true, cancelable: true }));
  await tick(150);

  // حفظ بلا موعد => لا مهام
  $('title').value = 'بلا موعد'; qa('.platform')[0].click();
  calls.length = 0;
  $('draft').click(); await tick(250);
  check('no jobs when unscheduled', !calls.some(c => c.url.includes('/publish_jobs') && c.method === 'POST'));
  check('draft status without date', /بدون موعد/.test($('status').textContent), $('status').textContent);

  // حفظ بموعد => مهام لكل منصة
  const d = new Date(Date.now() + 3600e3);
  w.document.querySelector('[name=time][value=later]').checked = true;
  $('when').style.display = 'block';
  $('when').value = new Date(d.getTime() - d.getTimezoneOffset()*60000).toISOString().slice(0,16);
  calls.length = 0;
  $('draft').click(); await tick(300);
  const postCall = calls.find(c => c.url.includes('/rest/v1/imprint_posts') &&
    (c.method === 'POST' || c.method === 'PATCH'));
  check('scheduled post saved with status scheduled',
    postCall && JSON.parse(postCall.body).status === 'scheduled',
    postCall && (postCall.method + ' ' + JSON.parse(postCall.body).status));
  const jobCall = calls.find(c => c.url.includes('/publish_jobs') && c.method === 'POST');
  check('job POST sent', !!jobCall);
  const jobs = jobCall ? JSON.parse(jobCall.body) : [];
  check('one job per platform', jobs.length === 2, String(jobs.length));
  check('jobs are queued', jobs.every(j => j.status === 'queued'));
  check('jobs carry owner_id', jobs.every(j => j.owner_id === 'aaaaaaaa-1111-4111-8111-111111111111'));
  check('queued message shown', /طابور النشر/.test($('status').textContent), $('status').textContent);

  // تكرار الحفظ لا يضيف مهامًا مكررة
  mode = 'has-job';
  calls.length = 0;
  $('draft').click(); await tick(300);
  check('existing job prevents duplicate POST', !calls.some(c => c.url.includes('/publish_jobs') && c.method === 'POST'));
  check('duplicate message', /لم تُضف مهام/.test($('status').textContent), $('status').textContent);

  // سياسة ترفض الإدخال => مسودة محفوظة مع تحذير
  mode = 'jobs-denied';
  w.eval('loadedId = null');
  calls.length = 0;
  $('draft').click(); await tick(300);
  check('RLS denial does not lose the draft',
    /تعذر إضافة مهام النشر/.test($('status').textContent), $('status').textContent);
  check('draft still saved', calls.some(c => c.url.endsWith('/rest/v1/imprint_posts') && c.method === 'POST'));

  // منظور الجدول
  mode = 'ok';
  w.openPanel('schedule'); await tick(300);
  const chips = qa('#scheduleList .job-chip');
  check('schedule renders platform chips', chips.length >= 1, String(chips.length));

  console.log(log.join('\n'));
  console.log('JS errors:', errors.length ? errors.slice(0, 3) : 'none');
  const f = log.filter(l => l.startsWith('FAIL'));
  console.log('SUMMARY:', log.length - f.length, 'passed,', f.length, 'failed');
  process.exit(f.length || errors.length ? 1 : 0);
})();
