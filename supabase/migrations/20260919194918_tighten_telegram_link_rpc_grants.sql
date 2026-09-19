-- CREATE OR REPLACE preserves prior function ACLs. Remove the historical
-- service_role grants from web-session helpers; the trusted backend only needs
-- consume_telegram_link_code(). Function owners retain implicit execution.
revoke execute on function public.current_ofa_user_id() from service_role;
revoke execute on function public.is_current_user_workspace_member(uuid) from service_role;
revoke execute on function public.create_telegram_link_code() from service_role;
