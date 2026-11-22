// فيسبوك: اختبارات تمنع أخطاء حقيقية —
// ١) رسالة «لا توجد صفحة» كانت تضلّع المستخدم: السبب قد يكون الصلاحيات لا الإسناد
// ٢) رمز المستخدم يُستخدم للنشر على الصفحة فيفشل بشكل متقطع
// ٣) اختيار الصفحة الأولى عشوائيًا بدل الصفحة الصحيحة
import fs from 'fs';

const link = fs.readFileSync(new URL('../supabase/functions/imprint-account-link/index.ts', import.meta.url), 'utf8');
const pub = fs.readFileSync(new URL('../supabase/functions/imprint-publish/index.ts', import.meta.url), 'utf8');

const log = []; const check = (n, c, x = '') => log.push((c ? 'PASS ' : 'FAIL ') + n + (x ? ' :: ' + x : ''));

const fb = (link.match(/async function fbPage[\s\S]*?\n}\n/) || [''])[0];

check('checks which permissions the token actually has',
  /me\/permissions/.test(fb), 'no /me/permissions probe');

check('distinguishes missing pages_show_list from no assigned page',
  /pages_show_list/.test(fb) && /لا صفحة مسندة/.test(fb));

check('tells the user the exact fix for an unassigned page',
  /مستخدمو النظام/.test(fb) && /رمزًا جديدًا/.test(fb));

check('reads page tasks to verify post permission',
  /tasks/.test(fb) && /CREATE_CONTENT/.test(fb));

check('guides the user when they lack page admin rights',
  /أدوار الصفحة/.test(fb));

check('saves the page token, not just the user token',
  /pageToken/.test(fb) && /access_token/.test(fb),
  'page access_token not captured');

check('supports selecting a specific page by name',
  /wantPage/.test(fb) && /الصفحات المتاحة/.test(fb));

// العامل
const fbPub = (pub.match(/async function facebook[\s\S]*?\n}\n/) || [''])[0];
check('publisher prefers the page token',
  /refresh_token \|\| c\.access_token/.test(fbPub),
  'publisher still posts with the user token');

check('publisher posts to the page id from the account row',
  /external_account_id/.test(fbPub));

// الربط
check('account-link stores the page token as the secondary secret',
  /id\.pageToken/.test(link),
  'page token not persisted');

check('declares pageToken on the Identity type',
  /pageToken\?: string/.test(link));

console.log(log.join('\n'));
const f = log.filter(l => l.startsWith('FAIL'));
console.log('SUMMARY:', log.length - f.length, 'passed,', f.length, 'failed');
process.exit(f.length ? 1 : 0);
