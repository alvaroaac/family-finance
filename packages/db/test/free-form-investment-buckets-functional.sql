-- Run after 202610080002 on a database where household A had the three enum buckets
-- (filhos 100, casa 200, independencia_financeira 300) before the migration,
-- and household B exists without buckets.
do $$
declare
  a uuid := '00000000-0000-0000-0000-000000000001';
  b uuid := '00000000-0000-0000-0000-000000000002';
begin
  if to_regtype('public.investment_bucket_slug') is not null
    or (select data_type from information_schema.columns
      where table_schema = 'public' and table_name = 'investment_buckets'
        and column_name = 'slug') <> 'text' then
    raise exception 'slug is still the investment_bucket_slug enum';
  end if;

  if (select string_agg(slug || ':' || name || ':' || balance_cents, ',' order by slug)
      from investment_buckets where household_id = a)
    <> 'casa:Casa:200,filhos:Filhos:100,independencia_financeira:Independência Financeira:300' then
    raise exception 'existing buckets lost their slug, name or balance';
  end if;

  insert into investment_buckets (household_id, slug, name)
    values (a, 'viagem_2027', 'Viagem 2027');

  begin
    insert into investment_buckets (household_id, slug, name)
      values (a, 'Viagem 2027', 'Viagem 2027');
    raise exception 'slug outside the format was accepted';
  exception when check_violation then null;
  end;

  begin
    insert into investment_buckets (household_id, slug, name)
      values (a, '', 'Vazio');
    raise exception 'empty slug was accepted';
  exception when check_violation then null;
  end;

  begin
    insert into investment_buckets (household_id, slug, name)
      values (a, 'viagem_2027', 'Viagem 2027 de novo');
    raise exception 'duplicate slug in one household was accepted';
  exception when unique_violation then null;
  end;

  insert into investment_buckets (household_id, slug, name)
    values (b, 'casa', 'Casa');
  if (select count(*) from investment_buckets where slug = 'casa') <> 2 then
    raise exception 'two households cannot share a slug';
  end if;
end $$;
