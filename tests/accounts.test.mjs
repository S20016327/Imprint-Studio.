// اختبار لوحة الحسابات: هل تخبر المستخدم بالحقيقة أم تعرض رسالة عامة؟
import { JSDOM, VirtualConsole } from 'jsdom';
import fs from 'fs';

const html = fs.readFileSync(new URL('../index.html', import.meta.url), 'utf8');
const cloud = fs.readFileSync(new URL('../cloud.js', import.meta.url), 'utf8');
const merged = html.replace('<script src="cloud.js"></script>', '<script>' + cloud + '</script>');

const errors = [];
const vc = new VirtualConsole();
vc.on('jsdomError', e => { if (!/scrollTo/.test(e.message)) errors.push(e.message); });

/** يبني نافذة مع سلوك خادم قابل للتحكم: ready | empty | 404 | down */
function build(service, accounts = []) {
  const calls = [];
  const dom = new JSDOM(merged, {
    runScripts: 'dangerously', virtualConsole: vc, url: 'https://x.github.io/p/',
    beforeParse(w) {
      w.__nav = [];
      w.URL.createObjectURL = () => 'blob:x'; w.URL.revokeObjectURL = () => {}; w.scrollTo = () => {};
      w.matchMedia = q => ({ matches: false, media: q, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {} });
      w.fetch = async (u, o = {}) => {
        const url = String(u);
        calls.push({ url, method: o.method || 'GET' });
        const json = (d, st = 200) => ({
          ok: st < 300, status: st,
          async text() { return JSON.stringify(d); },
          async json() { return d; },
          async blob() { return new w.Blob(['b']); },
          headers: { get: () => null }
        });
        if (url.includes('grant_type=password')) return json({
          access_token: 't', refresh_token: 'r', expires_at: Math.floor(Date.now() / 1000) + 3600,
          user: { id: 'aaaaaaaa-1111-4111-8111-111111111111', email: 'o@e.com' }
        });
        if (url.includes('/functions/v1/imprint-oauth-start') && url.includes('platform=')) {
          return json({ ok: true, platform: 'Instagram',
            authorizeUrl: 'https://www.instagram.com/oauth/authorize?client_id=IG&state=abc' });
        }
        if (url.includes('/functions/v1/imprint-oauth-start')) {
          if (service === '404') return json({ message: 'Function not found' }, 404);
          if (service === 'down') throw new TypeError('Failed to fetch');
          if (service === 'cors') {
            // المتصفح يرفض القراءة، لكن طلب no-cors يصل (opaque response)
            if (o.mode === 'no-cors') return { ok: true, status: 0, type: 'opaque',
              async text() { return ''; }, async json() { return {}; } };
            throw new TypeError('Failed to fetch');
          }
          if (service === 'ready') return json({
            ok: true, service: 'imprint-oauth-start', stateSecretConfigured: true,
            ready: { TikTok: false, Instagram: true, Facebook: false, YouTube: false },
            redirectUris: { Instagram: 'https://x/functions/v1/imprint-oauth-callback' },
            hints: { TikTok: 'تلميح تيك توك من الخادم', Instagram: 'تلميح إنستقرام من الخادم' }
          });
          return json({
            ok: true, service: 'imprint-oauth-start', stateSecretConfigured: true,
            ready: { TikTok: false, Instagram: false, Facebook: false, YouTube: false },
            redirectUris: {}, hints: { Instagram: 'تلميح إنستقرام من الخادم', YouTube: 'تلميح يوتيوب من الخادم' }
          });
        }
        if (url.includes('/rest/v1/social_accounts')) return json(accounts);
        if (url.includes('/rest/v1/imprint_posts')) return json([]);
        return json({});
      };
    }
  });
  return { dom, calls };
}

const log = [];
const check = (n, c, x = '') => log.push((c ? 'PASS ' : 'FAIL ') + n + (x ? ' :: ' + x : ''));

async function openPanel(service, accounts) {
  const { dom, calls } = build(service, accounts);
  const w = dom.window;
  const $ = id => w.document.getElementById(id);
  const tick = (ms = 120) => new Promise(r => setTimeout(r, ms));
  await tick(150);
  $('accountBtn').click(); await tick();
  $('email').value = 'o@e.com'; $('password').value = 'p';
  $('loginform').dispatchEvent(new w.Event('submit', { bubbles: true, cancelable: true }));
  await tick(180);
  w.openPanel('accounts');
  await tick(250);
  return { w, $, calls };
}

(async () => {
  {
    const { w, $ } = await openPanel('ready');
    const svc = $('svcStatus');
    check('panel shows service line', !!svc);
    check('ready state is ok', svc && svc.dataset.state === 'ok', svc && svc.dataset.state);
    check('names the ready platform', svc && /إنستقرام|Instagram/.test(svc.textContent), svc && svc.textContent);
    check('does not claim not-deployed', svc && !/غير منشورة/.test(svc.textContent));

    const needs = [...w.document.querySelectorAll('.need')].map(n => n.textContent);
    check('ready platform explains it is configured', needs.some(t => /الخادم مهيّأ/.test(t)), needs.join(' | '));
    check('unready platform shows server hint', needs.some(t => /تلميح تيك توك من الخادم/.test(t)), needs.join(' | '));
  }

  {
    const { w, $ } = await openPanel('empty');
    const svc = $('svcStatus');
    check('no-keys state is warn', svc && svc.dataset.state === 'warn', svc && svc.dataset.state);
    check('no-keys says keys are server-side', svc && /أسرار الخادم/.test(svc.textContent), svc && svc.textContent);
  }

  {
    const { w, $ } = await openPanel('404');
    const svc = $('svcStatus');
    check('404 state is err', svc && svc.dataset.state === 'err', svc && svc.dataset.state);
    check('404 mentions HTTP status', svc && /404/.test(svc.textContent), svc && svc.textContent);
  }

  {
    const { w, $ } = await openPanel('down');
    const svc = $('svcStatus');
    check('network failure handled', svc && svc.dataset.state === 'err', svc && svc.dataset.state);
    check('network failure is in Arabic', svc && /تعذر/.test(svc.textContent), svc && svc.textContent);
  }

  {
    const { w, $ } = await openPanel('ready', [{
      id: 'acc-1', platform: 'Instagram', status: 'connected',
      display_name: '@studio', expires_at: null, last_error: null
    }]);
    check('linked account shown', /@studio/.test(w.document.body.textContent));
    check('unlink button present', [...w.document.querySelectorAll('.connect-btn')].some(b => b.textContent === 'فصل'));
    check('note counts one account', /لديك 1 حساب مرتبط/.test($('accNote').textContent), $('accNote').textContent);
  }

  /* ---------- حجب CORS: الخادم موجود لكن المتصفح منع القراءة ---------- */
  {
    const { w, $ } = await openPanel('cors');
    const svc = $('svcStatus');
    check('cors-blocked is warn not err', svc && svc.dataset.state === 'warn', svc && svc.dataset.state);
    check('cors-blocked mentions the real cause', svc && /CORS/.test(svc.textContent), svc && svc.textContent);
    check('cors-blocked does not claim offline', svc && !/تعذر الوصول إلى خدمة الربط/.test(svc.textContent), svc && svc.textContent);
    check('cors-blocked still offers linking', [...w.document.querySelectorAll('.connect-btn')].length >= 4);
  }

  /* ---------- CORS: لا نُعيد * ولا نُشرط المسار (فحص نصّي للمصدر) ---------- */
  {
    check('client has no-cors fallback', /mode: 'no-cors'/.test(cloud));
    check('client distinguishes blockedByCors', /blockedByCors/.test(cloud));
  }

  /* ---------- زر «ربط»: يجب أن يقرأ authorizeUrl ويتنقّل ---------- */
  {
    const mk = build('ready');
    const w = mk.dom.window;
    w.imprintNavigate = v => w.__nav.push(v);   // jsdom يمنع تغيير location
    const $ = id => w.document.getElementById(id);
    const tick = (ms = 120) => new Promise(r => setTimeout(r, ms));
    await tick(150);
    $('accountBtn').click(); await tick();
    $('email').value = 'o@e.com'; $('password').value = 'p';
    $('loginform').dispatchEvent(new w.Event('submit', { bubbles: true, cancelable: true }));
    await tick(180);
    w.openPanel('accounts'); await tick(250);

    const btns = [...w.document.querySelectorAll('.connect-btn')];
    const instaRow = [...w.document.querySelectorAll('.account-row')]
      .find(r => /Instagram/.test(r.textContent));
    const btn = instaRow.querySelector('.connect-btn');
    btn.click();
    await tick(250);

    check('link uses JSON endpoint', mk.calls.some(c => /mode=json/.test(c.url)));
    check('link does not use redirect:manual', !/redirect: 'manual'/.test(cloud));
    check('link navigates to the provider', w.__nav.length > 0 && /instagram\.com/.test(w.__nav[0] || ''), w.__nav.join(','));
    check('no generic failure toast on success', !/تعذر الوصول/.test($('status').textContent));
    check('status explains it is opening', /فتح صفحة/.test($('status').textContent), $('status').textContent);
    check('all four link buttons exist', btns.length === 4);
  }

  check('no jsdom errors', errors.length === 0, errors.join(' | '));

  console.log(log.join('\n'));
  const failed = log.filter(l => l.startsWith('FAIL'));
  console.log('SUMMARY:', log.length - failed.length, 'passed,', failed.length, 'failed');
  process.exit(failed.length ? 1 : 0);
})();
