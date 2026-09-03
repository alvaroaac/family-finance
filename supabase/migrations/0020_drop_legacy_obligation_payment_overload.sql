-- 0020_drop_legacy_obligation_payment_overload.sql
-- 0018 is already the obligation account-override migration on main. The
-- legacy three-argument RPC cleanup was first applied manually under that
-- occupied number, so its canonical repository version is 0020.

drop function if exists materialize_obligation_payment(uuid, text, date);
