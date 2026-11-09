-- Kept separate: PostgreSQL enum values must commit before use.
alter type public.import_source add value if not exists 'agent_structured';
