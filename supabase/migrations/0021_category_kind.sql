-- 0021_category_kind.sql
-- 0019 is already the installment idempotency migration on main. Category
-- kinds were first applied manually under that occupied number, so their
-- canonical repository version is 0021.

alter table categories add column if not exists kind text;

update categories set kind = 'expense' where kind is null;

alter table categories alter column kind set default 'expense';
alter table categories alter column kind set not null;

do $$ begin
  alter table categories add constraint categories_kind_check
    check (kind in ('expense', 'income'));
exception when duplicate_object then null;
end $$;

-- The seeded "Receitas" bucket becomes the income fallback category.
update categories set kind = 'income' where name = 'Receitas';

-- Seed the single-household defaults only when that household exists. This
-- keeps the migration safe before seed.sql and safe to apply repeatedly.
insert into categories (household_id, name, kind)
select household.id, category.name, 'income'
from households as household
cross join (
  values ('Salário'), ('Freelas'), ('Investimentos')
) as category(name)
where household.id = '00000000-0000-0000-0000-000000000001'
on conflict (household_id, name) do update set kind = excluded.kind;
