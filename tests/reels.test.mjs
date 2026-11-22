// الريلز ليست فيديو عاديًّا. فيسبوك له مسار /video_reels بثلاث مراحل،
// وإنستقرام يرفض أي فيديو ليس 9:16. هذه الاختبارات تمنع «ادعاء» الريلز.
import fs from 'fs';

const pub = fs.readFileSync(new URL('../supabase/functions/imprint-publish/index.ts', import.meta.url), 'utf8');

const log = [];
const check = (n, c, x = '') => log.push((c ? 'PASS ' : 'FAIL ') + n + (x ? ' :: ' + x : ''));

check('worker declares a reel path', /async function facebookReel\(/.test(pub));
check('reels route before the normal post path',
  /if \(isReel\(p\)\) return facebookReel\(p, c\)/.test(pub),
  'a reel would fall through to /photos or /videos');

check('reels use the /video_reels endpoint', /\/video_reels/.test(pub));
check('start phase is sent', /upload_phase: 'start'/.test(pub));
check('each reel gets its own video_id', /start\.video_id/.test(pub));
check('upload uses the returned upload_url', /start\.upload_url/.test(pub),
  'uploading somewhere else means nothing was uploaded');
check('finish phase publishes, not drafts', /upload_phase: 'finish'[\s\S]{0,120}video_state: 'PUBLISHED'/.test(pub),
  'finish without PUBLISHED leaves an unpublished draft');

check('reel caption uses description (matches /video_reels docs)',
  /finishParams\.set\('description', text\)/.test(pub));

check('reels are read from publish_format, not guessed from media_type',
  /publish_format/.test(pub) && /const isReel = \(p: any\) => String\(p\.publish_format/.test(pub));

check('oversized files are refused before upload', /REEL_MAX_BYTES/.test(pub));
check('empty file is refused', /file\.size === 0/.test(pub));

check('permission failure is reported as blocked, not failed',
  /فيسبوك رفض بدء ريلز لعدم كفاية الصلاحية/.test(pub));

check('a success response without an id is not called published',
  /if \(fin\.success === true\)/.test(pub) && /لم يُعِد رابط منشور/.test(pub),
  'a bare {success:true} was reported as a finished reel');

check('worker version bumped', /imprint-publish-v\d/.test(pub) && !/imprint-publish-v6/.test(pub));
check('publish_format is selected with the post',
  /platforms, publish_format'\)\.eq\('id', job\.post_id\)/.test(pub),
  'the worker would never see the chosen format');

console.log(log.join('\n'));
const f = log.filter(l => l.startsWith('FAIL'));
console.log('SUMMARY:', log.length - f.length, 'passed,', f.length, 'failed');
process.exit(f.length ? 1 : 0);
