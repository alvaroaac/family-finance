-- 0022_category_kind.sql
-- 0020/0021 are reserved by the migration-control PR. Safe before seeding
-- and when upgrading databases that already have the category-kind column.
alter table categories
  add column if not exists kind text not null default 'expense'
    check (kind in ('expense', 'income'));

update categories set kind = 'income' where name = 'Receitas';

-- Preserve identity, activation state and references of existing income buckets.
insert into categories (household_id, name, kind)
select h.id, income.name, 'income'
from households h
cross join (values ('Salário'), ('Freelas'), ('Investimentos')) as income(name)
where h.id = '00000000-0000-0000-0000-000000000001'
on conflict (household_id, name) do update set kind = excluded.kind;
