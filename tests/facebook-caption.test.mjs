// فيسبوك: النص كان يضيع بصمت. /photos يقبل `message` وليس `description`،
// والرد يأتي 200 كأن النشر نجح. هذه الاختبارات تمنع تكرار ذلك.
import fs from 'fs';

const pub = fs.readFileSync(new URL('../supabase/functions/imprint-publish/index.ts', import.meta.url), 'utf8');
const log = []; const check = (n, c, x = '') => log.push((c ? 'PASS ' : 'FAIL ') + n + (x ? ' :: ' + x : ''));

const fb = (pub.match(/async function facebook\(p: any[\s\S]*?\n}\n/) || [''])[0];

check('photo posts send the caption as `message`',
  /params\.set\('message', text\)/.test(fb),
  'photos still use a param Facebook ignores');

check('photo posts no longer send `description`',
  !/URLSearchParams\(\{\s*access_token[^}]*description/.test(fb),
  'description still passed on the shared body');

check('video posts still use `description`',
  /params\.set\('description', text\)/.test(fb));

check('caption is not sent when empty',
  /if \(text\)/.test(fb));

check('photo and video bodies are built separately',
  /if \(video\)[\s\S]*?\}\s*else\s*\{/.test(fb),
  'shared body still used for both');

check('prefers post_id so the link opens the post, not the photo',
  /d\.post_id/.test(fb) && /postId \|\|/.test(fb),
  'link still points at the photo id');

check('caption includes title, description and hashtags',
  /\[p\.title, p\.description, p\.hashtags\]/.test(pub));

console.log(log.join('\n'));
const f = log.filter(l => l.startsWith('FAIL'));
console.log('SUMMARY:', log.length - f.length, 'passed,', f.length, 'failed');
process.exit(f.length ? 1 : 0);
