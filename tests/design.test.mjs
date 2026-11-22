import { JSDOM, VirtualConsole } from 'jsdom';
import fs from 'fs';

const html = fs.readFileSync(new URL('../index.html', import.meta.url), 'utf8');
const css = html.match(/<style>([\s\S]*?)<\/style>/)[1];
const errs = []; const vc = new VirtualConsole();
vc.on('jsdomError', e => { if (!/scrollTo|matchMedia/.test(e.message)) errs.push(e.message); });
const dom = new JSDOM(html, { virtualConsole: vc });
const d = dom.window.document;
const log = []; const check = (n, c, x = '') => log.push((c ? 'PASS ' : 'FAIL ') + n + (x ? ' :: ' + x : ''));

/* ---- الخطوط ---- */
check('6 font faces declared', (css.match(/@font-face/g) || []).length === 6);
check('font-display swap everywhere', (css.match(/font-display:swap/g) || []).length === 6);
check('Arabic subset has unicode-range', css.includes('U+0600-06FF'));
check('body uses Plex Arabic first',
  css.includes("font-family:'Plex Arabic','Plex Latin'"));
check('no legacy Tahoma-only stack', !/font-family:Tahoma,Arial,sans-serif/.test(css));
check('two weight preloads', (html.match(/rel="preload"[^>]*as="font"/g) || []).length === 2);
check('preload uses crossorigin', /as="font"[^>]*crossorigin/.test(html));

/* ---- رموز التصميم ---- */
['--s1', '--r-md', '--ease', '--t-fast', '--shadow-2', '--accent', '--surface', '--ink']
  .forEach(t => check('token ' + t + ' defined', css.includes(t + ':')));
check('spacing scale exists', /--s1:4px/.test(css) && /--s9:56px/.test(css));

/* ---- الوضع الداكن ---- */
check('dark theme block', css.includes(':root[data-theme="dark"]'));
const darkBlock = css.slice(css.indexOf(':root[data-theme="dark"]'));
check('dark overrides surface', /--surface:#0[a-f0-9]/i.test(darkBlock));
check('dark overrides ink', darkBlock.includes('--ink:#eef4f2'));
check('color-scheme declared', css.includes('color-scheme:light') && css.includes('color-scheme:dark'));
check('theme applied before paint', /dataset\.theme = dark/.test(html));
check('no flash script in head', html.indexOf('imprint-theme') < html.indexOf('<body>'));
check('theme-color meta present', html.includes('name="theme-color"'));
check('theme toggle button', !!d.getElementById('themeBtn'));
check('toggle exposes aria-pressed', html.includes('aria-pressed="false"'));

/* ---- الحركة والتسهيل ---- */
check('custom easing tokens', css.includes('--ease:') && css.includes('--ease-out:'));
check('reduced-motion honoured', css.includes('@media (prefers-reduced-motion:reduce)'));
check('scroll helper respects motion', fs.readFileSync(new URL('../cloud.js', import.meta.url), 'utf8')
  .includes("prefers-reduced-motion"));
check('modal entrance animation', css.includes('@keyframes modalIn'));
check('overlay hidden by default in CSS', /\.overlay\{[^}]*display:none/s.test(css));
check('overlay opens via data-open', css.includes('.overlay[data-open="true"]'));

/* ---- إتاحة الوصول ---- */
check('skip link', !!d.querySelector('.skip-link') && html.includes('#main-content'));
check('main landmark has id', d.querySelector('main').id === 'main-content');
check('nav has label', !!d.querySelector('nav[aria-label]'));
check('sidebar nav uses aria-current', html.includes('aria-current="page"'));
check('focus-visible styles', css.includes(':focus-visible'));
check('status is live region', d.getElementById('status').getAttribute('aria-live') === 'polite');
check('icon buttons have sr-only text', !!d.querySelector('#themeBtn .sr-only'));
check('all imgs have alt', [...d.querySelectorAll('img')].every(i => i.hasAttribute('alt')));
check('decorative icons hidden', (html.match(/aria-hidden="true"/g) || []).length > 5);
check('upload has focus-within ring', css.includes('.upload:focus-within'));

/* ---- استجابة ---- */
check('tablet breakpoint', css.includes('@media (max-width:980px)'));
check('mobile breakpoint', css.includes('@media (max-width:720px)'));
check('small phone breakpoint', css.includes('@media (max-width:420px)'));
check('grid collapses on mobile', /@media \(max-width:980px\)\{[^}]*\.grid\{grid-template-columns:1fr\}/s.test(css.replace(/\s+/g,' ')) || css.includes('.grid{grid-template-columns:1fr}'));
check('print stylesheet', css.includes('@media print'));

/* ---- الخصائص الجديدة ---- */
check('platform link dots', (html.match(/linked-dot/g) || []).length >= 4);
check('platform text wrapper', (html.match(/platform-text/g) || []).length >= 4);
check('link button to accounts', html.includes('class="link-btn"'));
check('busy state styling', css.includes('.primary.is-busy'));
check('disabled styling', css.includes(':disabled'));
check('progress bar styled', css.includes('.progress i'));
check('sticky topbar', /\.topbar\{[^}]*position:sticky/.test(css.replace(/\s+/g,' ')));
check('watermark uses token', css.includes('var(--fp)'));

console.log(log.join('\n'));
console.log('parse errors:', errs.length ? errs : 'none');
const f = log.filter(l => l.startsWith('FAIL'));
console.log('SUMMARY:', log.length - f.length, 'passed,', f.length, 'failed');
process.exit(f.length ? 1 : 0);
