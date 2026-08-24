-- 0019_category_kind.sql
-- Categories are tagged by transaction kind so the "Novo lançamento" form can
-- offer income categories (Salário, Freelas, Investimentos) when Tipo=Entrada
-- and keep expense categories out of that dropdown (and vice versa).

alter table categories
  add column if not exists kind text not null default 'expense'
    check (kind in ('expense', 'income'));

-- The seeded "Receitas" bucket becomes the income fallback category.
update categories set kind = 'income' where name = 'Receitas';

-- Income starting buckets for the single household. `on conflict do nothing`
-- keeps any same-named category the household already created untouched.
insert into categories (household_id, name, kind)
values
  ('00000000-0000-0000-0000-000000000001', 'Salário', 'income'),
  ('00000000-0000-0000-0000-000000000001', 'Freelas', 'income'),
  ('00000000-0000-0000-0000-000000000001', 'Investimentos', 'income')
on conflict (household_id, name) do nothing;
