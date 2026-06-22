# Project Goals

## MVP Goal

Build a private family finance MVP for Alvaro and Karol that makes it fast to register daily expenses, import historical data, improve categorization through real usage, and see a simple monthly household summary.

## Primary User Experience

- Daily expense entry should happen in seconds.
- Telegram is the first quick-entry channel.
- Confirmation is enabled by default.
- Web app supports review, import, dashboard, categories, accounts, cards, and caixinhas.

## MVP Scope

- Web app responsive on desktop and mobile.
- Supabase Auth with Google login and an email allowlist.
- Supabase Postgres with RLS.
- Single household workspace: Casa.
- Users: Alvaro and Karol.
- Expenses and basic income.
- Checking account, investment account, investment buckets, and simple credit cards.
- Card purchases à vista or parcelado with generated installments.
- Minhas Financas and Nubank import pipeline.
- Macro categories and subcategories.
- Hybrid categorization: deterministic rules plus AI fallback.
- Simple monthly dashboard.

## Non-Goals For MVP

- WhatsApp.
- Native mobile app.
- Multiple households.
- Public signup.
- Advanced permissions.
- Detailed investment portfolio tracking.
- Sophisticated budgeting.
- Advanced projections and comparative analytics.
- Permanent storage of raw imported files.

## Success Signals

- A real historical export can be imported, reviewed, categorized, and confirmed.
- A Telegram text message can become a confirmed transaction.
- A Telegram audio message can follow the same confirmation flow.
- A corrected category improves future suggestions.
- A parcelado credit card purchase affects future monthly totals correctly.
- The dashboard gives a useful month summary without manual spreadsheet work.

