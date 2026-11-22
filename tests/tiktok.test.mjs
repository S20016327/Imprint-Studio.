// تيك توك: اختبارات تمنع ثلاثة أخطاء حقيقية كانت في الكود —
// ١) افتراض PUBLIC_TO_EVERYONE (يفشل دائمًا لتطبيق غير مدقَّق)
// ٢) الإعلان عن النشر بعد init قبل PUBLISH_COMPLETE
// ٣) إخفاء أن المنشور «أنا فقط» عن المستخدم
import fs from 'fs';

const pub = fs.readFileSync(new URL('../supabase/functions/imprint-publish/index.ts', import.meta.url), 'utf8');
const cloud = fs.readFileSync(new URL('../cloud.js', import.meta.url), 'utf8');

const log = []; const check = (n, c, x = '') => log.push((c ? 'PASS ' : 'FAIL ') + n + (x ? ' :: ' + x : ''));

// ---------- العامل ----------
check('asks TikTok which privacy levels are allowed before posting',
  /creator_info\/query/.test(pub), 'no creator_info call');

check('never hardcodes PUBLIC_TO_EVERYONE',
  !/privacy_level:\s*'PUBLIC_TO_EVERYONE'/.test(pub),
  'hardcoded PUBLIC_TO_EVERYONE still present');

check('falls back to SELF_ONLY for unaudited clients',
  /SELF_ONLY/.test(pub));

check('waits for PUBLISH_COMPLETE before declaring success',
  /PUBLISH_COMPLETE/.test(pub) && /status\/fetch/.test(pub),
  'no status polling');

check('treats FAILED status as a real failure',
  /'FAILED'/.test(pub));

check('explains the private-account rule in Arabic',
  /unaudited_client_can_only_post_to_private_accounts/.test(pub) && /اجعل حسابك خاصًّا/.test(pub));

check('explains the unverified-domain rule in Arabic',
  /url_ownership|verified|domain/i.test(pub) && /غير موثَّق/.test(pub));

check('returns the privacy note to the caller',
  /note:\s*priv\.note/.test(pub));

check('does not claim public posting for unaudited apps',
  /لا أحد غيرك يراه/.test(pub));

// ---------- الواجهة ----------
check('surfaces the privacy note to the user',
  /r\.note/.test(cloud) && /notes\.length/.test(cloud),
  'privacy note dropped by the UI');

check('warns about the TikTok audit gate before saving',
  /TIKTOK_NEEDS_AUDIT/.test(cloud));

check('points the user to the path that works today',
  /نسخ إلى TikTok Studio/.test(cloud));

check('manual target opens TikTok Studio',
  /TikTok:\s*\{\s*url:\s*'https:\/\/www\.tiktok\.com\/tiktokstudio/.test(cloud));

check('manual flow needs no TikTok token',
  !/tiktok/i.test(
    (cloud.match(/function copyToPlatform[\s\S]{0,900}/) || [''])[0]
  ),
  'copyToPlatform references tiktok auth');

console.log(log.join('\n'));
const f = log.filter(l => l.startsWith('FAIL'));
console.log('SUMMARY:', log.length - f.length, 'passed,', f.length, 'failed');
process.exit(f.length ? 1 : 0);
