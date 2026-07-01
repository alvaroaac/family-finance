-- 0006_mercado_pago_import_source.sql
-- New import source: Mercado Pago credit-card fatura (PDF). The web action maps
-- the logical source "mercado-pago" to this enum value; confirm_import casts
-- batch_payload->>'source' to import_source, so the value must exist first.
-- ALTER TYPE ... ADD VALUE is safe inside a single-statement migration on PG 12+
-- (the new value just cannot be used in the same transaction that adds it).
alter type import_source add value if not exists 'mercado_pago_pdf';
