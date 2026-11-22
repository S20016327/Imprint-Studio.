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
        if (url.includes('/functions/v1/imprint-oauth-start')) {
          if (service === '404') return json({ message: 'Function not found' }, 404);
          if (service === 'down') throw new TypeError('Failed to fetch');
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

  check('no jsdom errors', errors.length === 0, errors.join(' | '));

  console.log(log.join('\n'));
  const failed = log.filter(l => l.startsWith('FAIL'));
  console.log('SUMMARY:', log.length - failed.length, 'passed,', failed.length, 'failed');
  process.exit(failed.length ? 1 : 0);
})();
