-- seed.sql
-- Minimal, non-sensitive seed for the Family Finance MVP. Runs after
-- supabase/migrations/0001_initial_schema.sql.
--
-- IMPORTANT: This seed contains NO real financial data. It only creates the
-- single household ("Casa"), the three investment buckets (caixinhas), and
-- placeholder macro categories with a few subcategories so the app has a
-- taxonomy to map onto. No accounts, cards, transactions, or amounts are seeded.
--
-- Household members are intentionally NOT seeded here: membership links to
-- real auth.users ids, which are provisioned via Supabase Auth + the email
-- allowlist (Task 4), not committed to the repo.

-- Stable household id so later migrations/scripts can reference it.
insert into households (id, name)
values ('00000000-0000-0000-0000-000000000001', 'Casa')
on conflict (id) do nothing;

-- Investment buckets (caixinhas): filhos, casa, independência financeira.
insert into investment_buckets (household_id, slug, name)
values
  ('00000000-0000-0000-0000-000000000001', 'filhos', 'Filhos'),
  ('00000000-0000-0000-0000-000000000001', 'casa', 'Casa'),
  ('00000000-0000-0000-0000-000000000001',
   'independencia_financeira', 'Independência Financeira')
on conflict (household_id, slug) do nothing;

-- Placeholder macro categories. These are starting buckets only; the real
-- taxonomy is consolidated from imports during onboarding, not invented here.
-- Kinds are explicit so the documented migrations-then-seed flow converges to
-- the same state as upgrading an already-seeded database through migration 0021.
insert into categories (household_id, name, kind)
values
  ('00000000-0000-0000-0000-000000000001', 'Alimentação', 'expense'),
  ('00000000-0000-0000-0000-000000000001', 'Moradia', 'expense'),
  ('00000000-0000-0000-0000-000000000001', 'Transporte', 'expense'),
  ('00000000-0000-0000-0000-000000000001', 'Saúde', 'expense'),
  ('00000000-0000-0000-0000-000000000001', 'Lazer', 'expense'),
  ('00000000-0000-0000-0000-000000000001', 'Educação', 'expense'),
  ('00000000-0000-0000-0000-000000000001', 'Receitas', 'income'),
  ('00000000-0000-0000-0000-000000000001', 'Salário', 'income'),
  ('00000000-0000-0000-0000-000000000001', 'Freelas', 'income'),
  ('00000000-0000-0000-0000-000000000001', 'Investimentos', 'income'),
  ('00000000-0000-0000-0000-000000000001', 'Outros', 'expense')
on conflict (household_id, name) do update set kind = excluded.kind;

-- A couple of placeholder subcategories under Alimentação, to exercise the
-- macro -> sub relationship. Still no financial data.
insert into subcategories (household_id, category_id, name)
select
  c.household_id,
  c.id,
  sub.name
from categories c
cross join (values ('Mercado'), ('Restaurante')) as sub(name)
where c.household_id = '00000000-0000-0000-0000-000000000001'
  and c.name = 'Alimentação'
on conflict (household_id, category_id, name) do nothing;
