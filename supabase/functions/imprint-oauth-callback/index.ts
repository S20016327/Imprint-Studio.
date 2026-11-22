// ============================================================================
//  بصمة إبداع — عودة الربط من المنصة (OAuth callback)
//  Supabase Edge Function (Deno) — خادم فقط
// ----------------------------------------------------------------------------
//  1) يتحقق من state الموقّع (HMAC) ويرفض أي state معدّل أو قديم.
//  2) يستبدل code برمز وصول عبر نقطة المنصة (باستخدام client_secret).
//  3) يحفظ الرمز في Vault عبر store_social_token، ويخزّن معرّفه فقط في
//     social_accounts. لا يُخزَّن أي رمز في الجدول ولا في المتصفح.
//  4) يعيد المتصفح إلى الموقع برسالة نتيجة.
//
//  لا يوجد تدفق ربط كامل بدون: تطبيق مطوّر + client_secret + redirect URI
//  مسجّل مطابق تمامًا. أي غياب يعيد خطأً صريحًا.
// ============================================================================

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.45.4';

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
const SERVICE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
const STATE_SECRET = Deno.env.get('OAUTH_STATE_SECRET') ?? '';
const SITE = Deno.env.get('IMPRINT_SITE_URL') ?? 'https://s20016327.github.io/Imprint-Studio./';

const env = (k: string) => Deno.env.get(k);

/** يتحقق من التوقيع ويعيد الحمولة أو null. */
async function verifyState(state: string) {
  const [body, sig] = state.split('.');
  if (!body || !sig) return null;
  const key = await crypto.subtle.importKey(
    'raw', new TextEncoder().encode(STATE_SECRET),
    { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']
  );
  const mac = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(body));
  const expected = btoa(String.fromCharCode(...new Uint8Array(mac))).replace(/=+$/, '');
  if (expected !== sig) return null;
  try {
    const payload = JSON.parse(atob(body));
    // صلاحية 15 دقيقة
    if (!payload.iat || Date.now() - payload.iat > 15 * 60 * 1000) return null;
    return payload as { uid: string; platform: string; origin?: string; nonce: string };
  } catch {
    return null;
  }
}

function back(origin: string, params: Record<string, string>) {
  const dest = new URL(origin || SITE);
  for (const [k, v] of Object.entries(params)) dest.searchParams.set(k, v);
  dest.hash = 'accounts';
  return new Response(null, { status: 302, headers: { Location: dest.toString() } });
}

type Exchange = {
  token: string;
  refresh?: string;
  expiresIn?: number;
  accountId: string;
  displayName?: string;
  scopes?: string[];
};

async function exchangeInstagram(code: string, redirectUri: string): Promise<Exchange> {
  const id = env('INSTAGRAM_CLIENT_ID')!;
  const secret = env('INSTAGRAM_CLIENT_SECRET')!;

  const form = new URLSearchParams({
    client_id: id, client_secret: secret, grant_type: 'authorization_code',
    redirect_uri: redirectUri, code
  });
  const r = await fetch('https://api.instagram.com/oauth/access_token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: form
  });
  const short = await r.json();
  if (!r.ok || !short.access_token) {
    throw new Error('فشل تبادل الرمز مع إنستقرام: ' + JSON.stringify(short.error_message ?? short));
  }

  // رمز قصير (ساعة) → رمز طويل (60 يومًا)
  const longUrl = new URL('https://graph.instagram.com/access_token');
  longUrl.searchParams.set('grant_type', 'ig_exchange_token');
  longUrl.searchParams.set('client_secret', secret);
  longUrl.searchParams.set('access_token', short.access_token);
  const lr = await fetch(longUrl);
  const long = await lr.json();
  const token = long.access_token || short.access_token;
  const expiresIn = long.expires_in ?? short.expires_in;

  const me = await fetch(
    `https://graph.instagram.com/v26.0/me?fields=user_id,username,account_type&access_token=${encodeURIComponent(token)}`
  );
  const profile = await me.json();
  if (profile.account_type && !/BUSINESS|CREATOR|MEDIA_CREATOR/i.test(profile.account_type)) {
    throw new Error(
      'هذا الحساب شخصي. نشر إنستقرام عبر API يتطلب حساب Business أو Creator — حوّل الحساب أولًا.'
    );
  }

  return {
    token,
    expiresIn,
    accountId: String(profile.user_id ?? short.user_id ?? ''),
    displayName: profile.username ? '@' + profile.username : undefined,
    scopes: (short.permissions || '').split(',').filter(Boolean)
  };
}

async function exchangeGoogle(code: string, redirectUri: string): Promise<Exchange> {
  const form = new URLSearchParams({
    code, client_id: env('GOOGLE_CLIENT_ID')!, client_secret: env('GOOGLE_CLIENT_SECRET')!,
    redirect_uri: redirectUri, grant_type: 'authorization_code'
  });
  const r = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: form
  });
  const d = await r.json();
  if (!r.ok || !d.access_token) throw new Error('فشل تبادل الرمز مع Google: ' + (d.error_description ?? d.error));
  return {
    token: d.access_token,
    refresh: d.refresh_token,
    expiresIn: d.expires_in,
    accountId: '',
    scopes: (d.scope || '').split(' ').filter(Boolean)
  };
}

Deno.serve(async (req) => {
  const url = new URL(req.url);
  const code = url.searchParams.get('code');
  const stateRaw = url.searchParams.get('state');
  const err = url.searchParams.get('error') || url.searchParams.get('error_description');

  if (err) return back(SITE, { linked: 'error', reason: err });
  if (!code || !stateRaw) return back(SITE, { linked: 'error', reason: 'missing_code' });
  if (!STATE_SECRET) return back(SITE, { linked: 'error', reason: 'server_misconfigured' });

  const state = await verifyState(stateRaw);
  if (!state) return back(SITE, { linked: 'error', reason: 'invalid_state' });

  const origin = state.origin || SITE;
  const admin = createClient(SUPABASE_URL, SERVICE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false }
  });

  try {
    let result: Exchange;
    if (state.platform === 'Instagram') {
      result = await exchangeInstagram(code, env('INSTAGRAM_REDIRECT_URI')!);
    } else if (state.platform === 'YouTube') {
      result = await exchangeGoogle(code, env('GOOGLE_REDIRECT_URI')!);
    } else {
      throw new Error(`منصة ${state.platform} غير مدعومة في العودة بعد.`);
    }

    // 1) خزّن السر في Vault — يُحفظ معرّفه فقط
    const accessId = await admin.rpc('store_social_token', {
      p_owner_id: state.uid, p_platform: state.platform,
      p_token: result.token, p_label: 'access'
    });
    if (accessId.error) throw accessId.error;

    let refreshId: string | null = null;
    if (result.refresh) {
      const r2 = await admin.rpc('store_social_token', {
        p_owner_id: state.uid, p_platform: state.platform,
        p_token: result.refresh, p_label: 'refresh'
      });
      if (!r2.error) refreshId = r2.data as unknown as string;
    }

    // 2) أنشئ/حدّث صف الحساب
    const expiresAt = result.expiresIn
      ? new Date(Date.now() + result.expiresIn * 1000).toISOString()
      : null;

    const { error: upsertErr } = await admin.from('social_accounts').upsert({
      owner_id: state.uid,
      platform: state.platform,
      external_account_id: result.accountId || state.uid,
      display_name: result.displayName ?? null,
      access_secret_id: accessId.data,
      refresh_secret_id: refreshId,
      scopes: result.scopes ?? [],
      status: 'connected',
      expires_at: expiresAt,
      last_error: null
    }, { onConflict: 'owner_id,platform,external_account_id' });
    if (upsertErr) throw upsertErr;

    return back(origin, { linked: 'ok', platform: state.platform });
  } catch (e) {
    const msg = (e as Error).message || 'تعذر إكمال الربط.';
    return back(origin, { linked: 'error', reason: msg.slice(0, 200) });
  }
});
