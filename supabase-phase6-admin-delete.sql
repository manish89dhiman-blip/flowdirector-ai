-- ============================================================================
-- Phase 6 — Admin Deletion Functions (Companies & Users)
-- Run this in Supabase → SQL Editor to enable company and user deletion
-- from the Admin Panel.
-- ============================================================================

-- 1. Admin Delete Company Function
create or replace function public.admin_delete_company(target_org_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if not public.is_platform_admin() then
    raise exception 'Only platform admins can delete companies.';
  end if;

  delete from public.invites where org_id = target_org_id;
  delete from public.memberships where org_id = target_org_id;
  delete from public.subscriptions where org_id = target_org_id;
  delete from public.plan_requests where org_id = target_org_id;
  delete from public.organizations where id = target_org_id;
end;
$$;

revoke execute on function public.admin_delete_company(uuid) from public, anon;
grant execute on function public.admin_delete_company(uuid) to authenticated;

-- 2. Admin Delete User Function
create or replace function public.admin_delete_user(target_user_id uuid)
returns void
language plpgsql
security definer
set search_path = public, auth
as $$
begin
  if not public.is_platform_admin() then
    raise exception 'Only platform admins can delete users.';
  end if;

  delete from public.memberships where user_id = target_user_id;
  delete from public.planner_state where user_id = target_user_id;
  delete from public.profiles where id = target_user_id;
  delete from auth.users where id = target_user_id;
end;
$$;

revoke execute on function public.admin_delete_user(uuid) from public, anon;
grant execute on function public.admin_delete_user(uuid) to authenticated;

-- 3. Policy for direct delete if needed
drop policy if exists "platform admin deletes orgs" on public.organizations;
create policy "platform admin deletes orgs" on public.organizations for delete
  using (public.is_platform_admin());

drop policy if exists "platform admin deletes memberships" on public.memberships;
create policy "platform admin deletes memberships" on public.memberships for delete
  using (public.is_platform_admin());

drop policy if exists "platform admin deletes profiles" on public.profiles;
create policy "platform admin deletes profiles" on public.profiles for delete
  using (public.is_platform_admin());
