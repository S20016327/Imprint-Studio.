-- ٢٢ نوفمبر ٢٠٢٦ — جدولة عامل النشر عبر pg_cron + pg_net.
--
-- ثلاث مهام:
--   imprint-enqueue-due   كل دقيقة   يحوّل المنشورات المستحقة إلى مهام
--   imprint-publish-tick  كل دقيقة   يشغّل العامل ليأخذ من الطابور
--   imprint-requeue-stale كل ١٠ دقائق يعيد المهام العالقة (انقطاع/مهلة)
--
-- السر محفوظ في Vault ولا يُكتب في أي مكان ظاهر.

do $$
begin
  if not exists (select 1 from vault.secrets where name = 'cron worker secret') then
    perform vault.create_secret(
      encode(gen_random_bytes(32), 'hex'),
      'cron worker secret',
      'imprint-cron-worker'
    );
  end if;
end $$;

create or replace function public.imprint_trigger_publish_worker(p_mode text default 'due')
returns bigint
language plpgsql
security definer
set search_path to 'vault', 'net', 'public'
as $$
declare
  v_secret text;
  v_req    bigint;
begin
  select decrypted_secret into v_secret
    from vault.decrypted_secrets where name = 'cron worker secret' limit 1;
  if v_secret is null then
    raise warning 'imprint: worker secret missing';
    return null;
  end if;

  select net.http_post(
           url     := 'https://yxmetzdoxbqndecslhlu.supabase.co/functions/v1/imprint-publish?mode=' || coalesce(p_mode,'due'),
           headers := jsonb_build_object('Content-Type','application/json','x-worker-secret',v_secret),
           body    := '{}'::jsonb,
           timeout_milliseconds := 55000
         ) into v_req;
  return v_req;
end;
$$;

revoke all on function public.imprint_trigger_publish_worker(text) from public, anon, authenticated;

select cron.unschedule(jobname)
  from cron.job
 where jobname in ('imprint-enqueue-due','imprint-publish-tick','imprint-requeue-stale');

select cron.schedule('imprint-enqueue-due',   '* * * * *',  $$select public.enqueue_due_posts()$$);
select cron.schedule('imprint-publish-tick',  '* * * * *',  $$select public.imprint_trigger_publish_worker('due')$$);
select cron.schedule('imprint-requeue-stale', '*/10 * * * *', $$select public.requeue_stale_jobs()$$);
