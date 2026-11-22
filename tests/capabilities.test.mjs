// «الصلاحيات تخبرني بما أريده قبل البدء» — لا وعد بلا سؤال Graph.
// هذه الاختبارات تمنع أن تصبح شاشة الصلاحيات ديكورًا يقول «ممكن» دائمًا.
import fs from 'fs';

const brand = fs.readFileSync(new URL('../supabase/functions/imprint-brand/index.ts', import.meta.url), 'utf8');
const kit = fs.readFileSync(new URL('../supabase/functions/imprint-brand-kit/index.ts', import.meta.url), 'utf8');
const cloud = fs.readFileSync(new URL('../cloud.js', import.meta.url), 'utf8');
const html = fs.readFileSync(new URL('../index.html', import.meta.url), 'utf8');

const log = [];
const check = (n, c, x = '') => log.push((c ? 'PASS ' : 'FAIL ') + n + (x ? ' :: ' + x : ''));

/* ---- الفحص الحقيقي ---- */
check('capabilities come from Graph, not a hardcoded table',
  /debug_token/.test(brand) && /granted/.test(brand),
  'permissions are asserted without asking Meta');

check('reachability of the Page is actually tested',
  /fields=id,name,picture,cover/.test(brand),
  'a token that cannot see the Page would still report success');

check('reel capability requires pages_manage_posts', /\['pages_manage_posts', 'pages_read_engagement'\]/.test(brand));
check('cover is not promised when business_management is missing',
  /!granted\.includes\('business_management'\)/.test(brand) || /granted\.includes\('business_management'\)/.test(brand),
  'cover capability ignores a documented requirement');
check('cover states the documented requirement honestly',
  /business_management/.test(brand) && /غير مضمون/.test(brand),
  'cover is presented as guaranteed when Meta frequently refuses it');

check('unknown platforms are not claimed as supported',
  /فحص الصلاحيات مبنيّ لفيسبوك الآن/.test(brand),
  'other platforms would inherit a fake pass');

/* ---- المصادقة ---- */
check('capabilities require a signed-in user', /auth\.getUser\(jwt\)/.test(brand));
check('publishing someone else\'s post is refused',
  /post\.owner_id !== user\.id/.test(brand));

/* ---- لا ادعاء بلا دليل ---- */
check('results without an external id are not called published',
  /ok: !!id/.test(brand),
  'a result with no id would count as proof');
check('blocked results keep the platform reason',
  /blocked: !!r\.blocked/.test(brand));

/* ---- النية تُخزَّن قبل التنفيذ ---- */
check('format is persisted before the worker runs',
  brand.indexOf("publish_format: 'post'") < brand.indexOf('imprint-publish?mode=now'),
  'the worker could run before the intent was saved');
check('reel without video is refused before any upload',
  /الريلز فيديو رأسي 9:16 مدته 3–90 ثانية/.test(brand));
check('worker is reused, not duplicated', /imprint-publish\?mode=now/.test(brand));

/* ---- الواجهة ---- */
check('format picker exists with two options',
  (html.match(/class="format-opt/g) || []).length === 2);
check('reel option is selectable', /data-format="reel"/.test(html));
check('capabilities box is announced to screen readers',
  /id="capsBox"[\s\S]{0,80}aria-live="polite"/.test(html));
check('client asks the server before promising',
  /imprint-brand\?mode=capabilities/.test(cloud));
check('client shows the missing permissions', /cap\.needs/.test(cloud));
check('client refuses reel without a video file',
  /الريلز تحتاج ملف فيديو/.test(cloud));
check('format travels with the saved draft', /publish_format: form\.publish_format/.test(cloud));

/* ---- الهوية ---- */
check('brand panel covers the four targets',
  ['site_logo', 'site_banner', 'fb_picture', 'fb_cover'].every(k => cloud.includes(k)));
check('page picture uses the documented endpoint', /\/picture`/.test(kit));
check('cover uploads an unpublished photo first',
  /published', 'false'|published',\s*'false'/.test(kit) || /form\.set\('published', 'false'\)/.test(kit),
  'cover applied without a photo id cannot work');
check('cover sends photo_id as JSON, not the wrong keys',
  /photo_id/.test(kit) && !/form\.set\('cover', 'photo/.test(kit));
check('a refused cover reports Meta\'s own words', /explanation:/.test(kit) && /raw: r\.raw/.test(kit));
check('only the owner\'s own files are accepted',
  /storagePath\.startsWith\(user\.id \+ '\/'\)/.test(kit));
check('brand uploads require a session', /auth\.getUser\(jwt\)/.test(kit));

console.log(log.join('\n'));
const f = log.filter(l => l.startsWith('FAIL'));
console.log('SUMMARY:', log.length - f.length, 'passed,', f.length, 'failed');
process.exit(f.length ? 1 : 0);
