-- 0008: bot conversation state, keyed by Telegram chat id (spec v1.0 §3.2)
--
-- The bot's multi-turn conversations (draft → awaiting_confirmation) used to
-- live in a module-scope Map, so any process restart lost in-flight drafts.
-- This table persists that state. It is intentionally NOT household-scoped:
-- the row exists BEFORE the sender is resolved to a household member, and the
-- bot process is the only reader/writer.
--
-- Access model: RLS is enabled with ZERO policies, so anon/authenticated are
-- denied every row (the 0005 table grants open the door, RLS closes it).
-- Only the bot's service_role client — which bypasses RLS — can touch it.
create table if not exists bot_conversations (
  chat_id bigint primary key,
  state jsonb not null,
  updated_at timestamptz not null default now()
);

alter table bot_conversations enable row level security;
-- NO policies on purpose: anon/authenticated denied by default; service_role
-- bypasses RLS.
