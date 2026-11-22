-- ٢٢ نوفمبر ٢٠٢٦ — نطاق الـAPI لكل رمز + قراءة آمنة للأسرار من الخادم فقط.
--
-- المشكلة الجذرية: رمز Meta الموحّد (EAA…) يعمل على graph.facebook.com فقط.
-- الكود القديم كان يستدعي graph.instagram.com دائمًا فيُعيد
-- "Unsupported get request" مهما كان الرمز صحيحًا.
-- الحل: عمود api_host يُضبط وقت الربط من بادئة الرمز، والعامل يقرأه.

alter table public.social_accounts
  add column if not exists api_host text not null default 'graph.instagram.com';

comment on column public.social_accounts.api_host is
  'نطاق الـAPI الذي يعمل عليه الرمز. EAA… ⇒ graph.facebook.com، IGAA… ⇒ graph.instagram.com';

-- قراءة سر واحد — للاستخدام الداخلي (service_role) فقط
create or replace function public.get_social_token(p_secret_id uuid)
returns text
language plpgsql
security definer
set search_path to 'vault', 'public'
as $$
declare v text;
begin
  select decrypted_secret into v from vault.decrypted_secrets where id = p_secret_id;
  return v;
end;
$$;

revoke all on function public.get_social_token(uuid) from public, anon, authenticated;

-- بيانات اعتماد جاهزة للعامل: الرمز + النطاق + الحساب + الانتهاء
create or replace function public.get_social_credentials(p_owner_id uuid, p_platform text)
returns table (
  access_token text,
  refresh_token text,
  api_host text,
  external_account_id text,
  expires_at timestamptz
)
language sql
security definer
set search_path to 'vault', 'public'
as $$
  select
    public.get_social_token(sa.access_secret_id) as access_token,
    case when sa.refresh_secret_id is not null
         then public.get_social_token(sa.refresh_secret_id) end as refresh_token,
    coalesce(sa.api_host, 'graph.instagram.com') as api_host,
    sa.external_account_id,
    sa.expires_at
  from public.social_accounts sa
  where sa.owner_id = p_owner_id
    and sa.platform = p_platform
    and sa.status = 'connected'
  order by sa.updated_at desc nulls last
  limit 1;
$$;

revoke all on function public.get_social_credentials(uuid, text) from public, anon, authenticated;

-- فهرس سحب الوظائف المستحقة
create index if not exists publish_jobs_due_idx
  on public.publish_jobs (run_after)
  where status = 'queued';
