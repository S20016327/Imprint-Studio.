-- ٢٢ نوفمبر ٢٠٢٦ — «منشور أم ريلز؟» يُحسم قبل النشر + أصول الهوية (شعار وبانر).
--
-- المشكلة الجذرية: العامل كان يخمّن النوع من media_type وحده. فيسبوك يرفض
-- الريلز إذا أُرسلت إلى /videos (تصبح فيديو عاديًّا لا ريلز)، وإنستقرام يرفض
-- الريلز إذا لم تكن 9:16 ومدتها ≤ 90 ثانية. التخمين الصامت يعني ادعاءً.
-- الحل: يُختار النوع صراحةً ويُخزَّن، والعامل ينفّذه أو يرفض بسبب واضح.

alter table public.imprint_posts
  add column if not exists publish_format text not null default 'post';

do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'imprint_posts_publish_format_check'
  ) then
    alter table public.imprint_posts
      add constraint imprint_posts_publish_format_check
      check (publish_format in ('post', 'reel'));
  end if;
end $$;

comment on column public.imprint_posts.publish_format is
  'post = منشور عادي (صورة/فيديو عادي). reel = ريلز رأسية تُنشر عبر /video_reels.';

-- أصول الهوية: شعار الموقع وبانره (عامّان للقراءة)، وشعار/غلاف صفحة فيسبوك.
create table if not exists public.brand_assets (
  owner_id   uuid not null references auth.users (id) on delete cascade,
  kind       text not null check (kind in ('site_logo', 'site_banner', 'fb_picture', 'fb_cover')),
  storage_path text,
  updated_at timestamptz not null default now(),
  primary key (owner_id, kind)
);

comment on table public.brand_assets is
  'أصول الهوية. site_* تُقرأ من الموقع العام، وfb_* مرجع آخر صورة أُرسلت لفيسبوك.';

alter table public.brand_assets enable row level security;

-- القراءة عامة: شعار الموقع يجب أن يظهر للزائر قبل تسجيل الدخول.
drop policy if exists brand_assets_read on public.brand_assets;
create policy brand_assets_read on public.brand_assets
  for select using (true);

-- لا كتابة مباشرة من المتصفح: كل كتابة تمر بالدالة imprint-brand.
drop policy if exists brand_assets_no_write on public.brand_assets;
create policy brand_assets_no_write on public.brand_assets
  for insert with check (false);
