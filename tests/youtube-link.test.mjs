// ربط يوتيوب: عنوان العودة كان يجب أن يُطابق المسجّل في Google حرفيًا،
// ورسالة رفض Google كانت تُرسل المستخدم إلى المكان الخطأ (Credentials).
// هذان الاختباران يمنعان تكرار الحالتين.
import fs from 'fs';

const start = fs.readFileSync(new URL('../supabase/functions/imprint-oauth-start/index.ts', import.meta.url), 'utf8');
const cb = fs.readFileSync(new URL('../supabase/functions/imprint-oauth-callback/index.ts', import.meta.url), 'utf8');
const link = fs.readFileSync(new URL('../supabase/functions/imprint-account-link/index.ts', import.meta.url), 'utf8');
const cloud = fs.readFileSync(new URL('../cloud.js', import.meta.url), 'utf8');

const log = [];
const check = (n, c, x = '') => log.push((c ? 'PASS ' : 'FAIL ') + n + (x ? ' :: ' + x : ''));

/* ---- عنوان العودة ---- */
check('redirect uri is derived when the secret is absent',
  /function googleRedirect\(\)/.test(start) && /imprint-oauth-callback/.test(start),
  'a missing GOOGLE_REDIRECT_URI leaves YouTube unlinkable');

check('start and callback derive the SAME uri',
  /imprint-oauth-callback/.test(cb) && /googleRedirect\(\)/.test(cb),
  'mismatched redirect URIs fail with redirect_uri_mismatch');

check('an explicit secret still wins',
  /explicit && explicit\.startsWith\('http'\)/.test(start));
check('configuration no longer needs the redirect secret',
  /redirectUri: googleRedirect\(\)/.test(start));
check('status endpoint reports the effective redirect',
  /YouTube: googleRedirect\(\)/.test(start),
  'the UI could not tell the user which URI to register');

/* ---- الرسالة المضلّلة ---- */
check('the exact Google error has its own explanation',
  /Expected OAuth 2 access token/.test(link),
  'the raw Google text is still echoed with a misleading destination');

check('it no longer sends users to Credentials for a token',
  !/where: 'Google Cloud Console ← Credentials'/.test(link),
  'Credentials builds a client id, not an access token');

check('OAuth Playground is named as the manual route',
  /oauthplayground/.test(link));

/* ---- الواجهة ---- */
check('the one-click link is offered first when OAuth is ready',
  /oauthReady/.test(cloud) && /ربط بحسابك/.test(cloud),
  'the token box is still the primary path even when OAuth is configured');
check('pasting a token remains available as a secondary option',
  /أو الصق رمزًا/.test(cloud));
check('the accounts summary explains the OAuth rejection',
  /ما لُصق ليس رمز وصول/.test(cloud));

console.log(log.join('\n'));
const f = log.filter(l => l.startsWith('FAIL'));
console.log('SUMMARY:', log.length - f.length, 'passed,', f.length, 'failed');
process.exit(f.length ? 1 : 0);
