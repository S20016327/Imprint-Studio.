import { JSDOM, VirtualConsole } from 'jsdom';
import fs from 'fs';

const html = fs.readFileSync(new URL('../index.html', import.meta.url),'utf8');
const cloud = fs.readFileSync(new URL('../cloud.js', import.meta.url),'utf8');
// ندمج cloud.js في الصفحة كما لو أن المتصفح حمّله
const merged = html.replace('<script src="cloud.js"></script>', '<script>' + cloud + '</script>');

const errors = [];
const calls = [];
let mode = 'ok';

const vc = new VirtualConsole();
vc.on('jsdomError', e => { if (!/scrollTo/.test(e.message)) errors.push('jsdomError: ' + e.message); });
vc.on('error', (...a) => errors.push('console.error: ' + a.join(' ')));

const dom = new JSDOM(merged, {
  runScripts: 'dangerously',
  url: 'https://s20016327.github.io/Imprint-Studio./',
  virtualConsole: vc,
  beforeParse(w) {
    w.fetch = async (url, opts = {}) => {
      const u = String(url), body = opts.body;
      calls.push({ u, method: opts.method || 'GET', headers: opts.headers || {}, body });
      const json = (o, st = 200) => ({
        ok: st < 300, status: st,
        async text() { return JSON.stringify(o); },
        async blob() { return new w.Blob(['blob']); }
      });
      if (u.includes('grant_type=refresh_token')) {
        return json({ access_token: 'tok_refreshed', refresh_token: 'rt3',
          expires_at: Math.floor(Date.now()/1000) + 3600,
          user: { id: 'aaaaaaaa-1111-4111-8111-111111111111', email: 'e@x.com' } });
      }
      if (u.includes('grant_type=password')) {
        if (mode === 'badlogin') return json({ msg: 'Invalid login credentials' }, 400);
        return json({ access_token: 'tok_user', refresh_token: 'rt', token_type: 'bearer',
          expires_at: Math.floor(Date.now()/1000) + 3600,
          user: { id: 'aaaaaaaa-1111-4111-8111-111111111111', email: 'owner@example.com',
                  last_sign_in_at: new Date().toISOString() } });
      }
      if (u.includes('/auth/v1/logout')) return json({});
      if (u.includes('scheduled_at=not.is.null')) return json([]);
      if (u.includes('/rest/v1/imprint_posts') && opts.method === 'POST')
        return json([{ id: 'aaaaaaaa-2222-4333-8444-555555555555', ...JSON.parse(body) }]);
      if (u.includes('/rest/v1/imprint_posts') && u.includes('id=eq.')) return json([{ media_path: null, ...JSON.parse(body || '{}') }]);
      if (u.includes('/rest/v1/social_accounts')) return json([]);
      if (u.includes('/rest/v1/imprint_posts')) return json([{ id: 'p1', title: 'T', platforms: ['TikTok'],
          media_path: null, status: 'draft', updated_at: new Date().toISOString(), scheduled_at: null, owner_id: 'x' }]);
      return json({});
    };
    w.URL.createObjectURL = () => 'blob:fake';
    w.URL.revokeObjectURL = () => {};
    w.matchMedia = w.matchMedia || (q => ({ matches:false, media:q, addEventListener(){}, removeEventListener(){}, addListener(){}, removeListener(){} }));
  }
});

const w = dom.window;
const $ = id => w.document.getElementById(id);
const qa = s => [...w.document.querySelectorAll(s)];
const log = [];
const check = (n, c, x = '') => log.push((c ? 'PASS ' : 'FAIL ') + n + (x ? ' :: ' + x : ''));
const tick = (ms = 60) => new Promise(r => setTimeout(r, ms));
const submit = el => el.dispatchEvent(new w.Event('submit', { bubbles: true, cancelable: true }));

(async () => {
  await tick(150);

  ['accountBtn','accountLabel','draft','review','newDraft','exportInfo','exportImage','title','desc','tags','status','toast','panelContent'].forEach(id => {
    if (!$(id)) check('missing #' + id, false);
  });
  check('all key elements exist', true);

  $('accountBtn').click(); await tick();
  check('login panel shown', !!$('loginform'));
  check('modal title correct', $('modalTitle').textContent === 'تسجيل الدخول', $('modalTitle').textContent);

  mode = 'badlogin';
  $('email').value = 'owner@example.com'; $('password').value = 'wrong';
  submit($('loginform')); await tick(120);
  check('bad login -> Arabic message', /غير صحيحة/.test($('loginStatus').textContent), $('loginStatus').textContent);

  mode = 'ok';
  $('email').value = 'owner@example.com'; $('password').value = 'right';
  submit($('loginform')); await tick(150);
  check('signed in label', $('accountLabel').textContent === 'owner@example.com', $('accountLabel').textContent);
  check('panel closed', $('overlay').dataset.open === 'false');

  $('draft').click(); await tick(80);
  check('blocked without title', /عنوان/.test($('status').textContent), $('status').textContent);

  $('title').value = 'منشور تجريبي';
  $('draft').click(); await tick(80);
  check('blocked without platform', /منصة/.test($('status').textContent), $('status').textContent);

  qa('.platform')[0].click();
  check('platform selectable', qa('.platform.selected').length === 1);
  calls.length = 0;
  $('draft').click(); await tick(200);
  const post = calls.find(c => c.method === 'POST' && c.u.includes('/rest/v1/imprint_posts'));
  check('draft POST sent', !!post);
  check('publishable in apikey, user token in Bearer',
    post && post.headers.apikey.startsWith('sb_publishable_') && post.headers.Authorization === 'Bearer tok_user',
    post && JSON.stringify({ a: post.headers.apikey?.slice(0,16), b: post.headers.Authorization }));
  check('saved message', /تم حفظ المسودة/.test($('status').textContent), $('status').textContent);
  const payload = post ? JSON.parse(post.body) : {};
  check('owner_id from session', payload.owner_id === 'aaaaaaaa-1111-4111-8111-111111111111');
  check('platforms payload', JSON.stringify(payload.platforms) === '["TikTok"]', JSON.stringify(payload.platforms));

  calls.length = 0;
  $('title').value = 'تعديل';
  $('draft').click(); await tick(200);
  check('second save uses PATCH', calls.some(c => c.method === 'PATCH' && c.u.includes('id=eq.aaaaaaaa-2222-4333-8444-555555555555')));

  w.openPanel('library'); await tick(200);
  check('library rows', qa('#draftList .row').length === 1, String(qa('#draftList .row').length));

  w.openPanel('schedule'); await tick(200);
  check('empty schedule note', /لا توجد مواعيد/.test($('scheduleList').textContent));

  w.openPanel('accounts'); await tick(220);
  check('4 platform rows', qa('#panelContent .account-row').length === 4,
    String(qa('#panelContent .account-row').length));
  check('accounts show link buttons', qa('#panelContent .connect-btn').length === 4);
  check('accounts note present', !!$('accNote'));

  w.openPanel('account'); await tick(120);
  check('account panel shows email', $('signedEmail') && $('signedEmail').textContent === 'owner@example.com');

  let dl = null;
  const proto = w.HTMLAnchorElement.prototype;
  const orig = proto.click;
  proto.click = function () { dl = this.download; };
  $('exportInfo').click(); await tick(30);
  check('exportInfo -> imprint-post.txt', dl === 'imprint-post.txt', String(dl));
  dl = null;
  $('exportImage').click(); await tick(30);
  check('exportImage refuses when no image', dl === null);
  proto.click = orig;

  w.openPanel('library'); await tick(120);
  $('newDraft').click(); await tick(40);
  check('newDraft clears title', $('title').value === '');
  check('newDraft clears platforms', qa('.platform.selected').length === 0);

  $('title').value = 'x'; qa('.platform')[1].click();

  w.openPanel('account'); await tick(100);
  $('logout').click(); await tick(200);
  check('logout resets label', $('accountLabel').textContent === 'غير مسجل', $('accountLabel').textContent);

  $('draft').click(); await tick(150);
  check('signed-out save opens login', !!$('loginform'));

  // تحقق من تجديد الجلسة: جلسة منتهية يجب أن تُجدَّد
  w.sessionStorage.setItem('imprint_session', JSON.stringify({ access_token: 'old', refresh_token: 'rt2',
    expires_at: Math.floor(Date.now()/1000) - 10, user: { id: 'aaaaaaaa-1111-4111-8111-111111111111', email: 'e@x.com' } }));
  calls.length = 0;
  w.eval('restoreSession()'); calls.length = 0; await w.eval('ensureSession()');
  check('expired session refreshed', calls.some(c => c.u.includes('grant_type=refresh_token')));
  check('refreshed token stored', JSON.parse(w.sessionStorage.getItem('imprint_session')).access_token === 'tok_refreshed');

  console.log(log.join('\n'));
  console.log('\nJS errors:', errors.length ? errors.slice(0, 5) : 'none');
  const f = log.filter(l => l.startsWith('FAIL'));
  console.log('SUMMARY:', log.length - f.length, 'passed,', f.length, 'failed');
  process.exit(f.length || errors.length ? 1 : 0);
})();
