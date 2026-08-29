-- ============================================================================
-- Command Center · Optional hardening — stop internal functions being callable
-- over the REST API.
-- ----------------------------------------------------------------------------
-- Run any time AFTER phases 1, 3 and 4. Additive, safe to re-run, and it
-- changes no data and no policy.
--
-- WHY: Supabase exposes every function in the `public` schema as an RPC
-- endpoint (/rest/v1/rpc/<name>). The database linter flags all of ours. None
-- of them is currently exploitable — the trigger functions raise "can only be
-- called as a trigger" if you call them directly, and the permission helpers
-- return false for a signed-out caller because auth.uid() is null. This just
-- removes the surface.
--
-- !! TWO TRAPS. BOTH ARE EASY TO WALK INTO. !!
--
-- TRAP 1 — you must revoke from PUBLIC, not from the roles.
-- Postgres grants EXECUTE on every new function to PUBLIC automatically, and
-- `anon`/`authenticated` inherit it from there. So
--     revoke execute on function f() from anon, authenticated;
-- revokes a grant they never had and changes nothing at all — the function
-- stays wide open. (Verified: the ACL still reads `=X/postgres`, where the
-- empty left-hand side is PUBLIC.) Every revoke below therefore names PUBLIC.
--
-- TRAP 2 — revoking too much locks users out of their own data.
-- An RLS policy expression is evaluated with the permissions of the role
-- running the query. Revoke EXECUTE on a function that a policy calls and
-- every query against that table starts failing for signed-in users.
--
-- Hence two lists, which are NOT interchangeable:
--
--   LIST A - functions no policy calls. Revoked from everyone.
--   LIST B - functions policies DO call. Revoked from PUBLIC (which is what
--            was really exposing them to `anon`), then granted back to
--            `authenticated` explicitly.
--
-- To check which list a new function belongs in:
--
--   select p.tablename, p.policyname
--   from pg_policies p
--   where p.schemaname = 'public'
--     and (coalesce(p.qual,'') || ' ' || coalesce(p.with_check,''))
--         like '%your_function_name(%';
--
-- No rows back means list A. Any rows back means list B.
-- ============================================================================


-- ---- LIST A: internal only — no policy calls these, the client never does ---
--
-- The four trigger functions fire from the table's trigger, which runs
-- regardless of whether the caller holds EXECUTE, so revoking costs nothing.
-- org_seat_limit / org_seats_used are only ever called from inside
-- check_seat_limit(), which is SECURITY DEFINER and therefore runs as its
-- owner — again unaffected. current_role_in_org() is unused.

revoke execute on function public.check_seat_limit()    from public, anon, authenticated;
revoke execute on function public.give_new_org_a_plan() from public, anon, authenticated;
revoke execute on function public.handle_new_user()     from public, anon, authenticated;
revoke execute on function public.protect_last_owner()  from public, anon, authenticated;
revoke execute on function public.org_seat_limit(uuid)  from public, anon, authenticated;
revoke execute on function public.org_seats_used(uuid)  from public, anon, authenticated;
revoke execute on function public.current_role_in_org() from public, anon, authenticated;


-- ---- LIST B: policy helpers — take away, then give back to signed-in users --
--
-- Revoke from PUBLIC (the grant that was actually exposing these to anon),
-- then grant explicitly to `authenticated`, because the policies on
-- planner_state, memberships, profiles, kras, kpis and kpi_values call these
-- and are evaluated as the signed-in caller. Skip the grant and every one of
-- those tables goes unreadable.

revoke execute on function public.current_org_id()               from public, anon;
revoke execute on function public.is_org_owner()                 from public, anon;
revoke execute on function public.can_view_planner(uuid)         from public, anon;
revoke execute on function public.can_manage_person(uuid)        from public, anon;
revoke execute on function public.shares_org(uuid)               from public, anon;
revoke execute on function public.founded_org(uuid)              from public, anon;
revoke execute on function public.has_pending_invite(uuid, text) from public, anon;
revoke execute on function public.kpi_owner(uuid)                from public, anon;

grant execute on function public.current_org_id()               to authenticated;
grant execute on function public.is_org_owner()                 to authenticated;
grant execute on function public.can_view_planner(uuid)         to authenticated;
grant execute on function public.can_manage_person(uuid)        to authenticated;
grant execute on function public.shares_org(uuid)               to authenticated;
grant execute on function public.founded_org(uuid)              to authenticated;
grant execute on function public.has_pending_invite(uuid, text) to authenticated;
grant execute on function public.kpi_owner(uuid)                to authenticated;


-- ============================================================================
-- VERIFY -- reports only, changes nothing.
--
-- Every row should read OK. A "STILL EXPOSED" row means the revoke above
-- didn't match that function's signature — check the argument types.
-- ============================================================================
select
  f.fn as "function",
  case
    when has_function_privilege('anon', f.fn, 'EXECUTE') then 'STILL EXPOSED to anon'
    when f.keep_auth and not has_function_privilege('authenticated', f.fn, 'EXECUTE')
      then 'BROKEN - policies need this, re-grant to authenticated'
    else 'OK'
  end as status
from (values
  ('public.check_seat_limit()',          false),
  ('public.give_new_org_a_plan()',       false),
  ('public.handle_new_user()',           false),
  ('public.protect_last_owner()',        false),
  ('public.org_seat_limit(uuid)',        false),
  ('public.org_seats_used(uuid)',        false),
  ('public.current_role_in_org()',       false),
  ('public.current_org_id()',            true),
  ('public.is_org_owner()',              true),
  ('public.can_view_planner(uuid)',      true),
  ('public.can_manage_person(uuid)',     true),
  ('public.shares_org(uuid)',            true),
  ('public.founded_org(uuid)',           true),
  ('public.has_pending_invite(uuid,text)', true),
  ('public.kpi_owner(uuid)',             true)
) as f(fn, keep_auth)
order by 2 desc, 1;
