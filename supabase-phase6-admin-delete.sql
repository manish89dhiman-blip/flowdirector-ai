-- ============================================================================
-- Phase 6 — Admin Deletion Functions & Trigger Fix (Companies & Users)
-- Run this in Supabase → SQL Editor to enable seamless company and user deletion
-- from the Admin Panel.
-- ============================================================================

-- 0. Update protect_last_owner() trigger function to bypass check for platform admins
create or replace function public.protect_last_owner()
returns trigger language plpgsql security definer set search_path = public as $$
declare
  remaining int;
  target_org uuid;
  org_exists boolean;
begin
  target_org := coalesce(old.org_id, new.org_id);

  if tg_op = 'DELETE' and old.role <> 'owner' then return old; end if;
  if tg_op = 'UPDATE' and old.role <> 'owner' then return new; end if;
  if tg_op = 'UPDATE' and new.role = 'owner' then return new; end if;

  -- Allow platform admins to delete any owner membership
  if public.is_platform_admin() then
    if tg_op = 'DELETE' then return old; else return new; end if;
  end if;

  -- Check if the organization itself is being deleted or no longer exists
  select exists(select 1 from public.organizations where id = target_org) into org_exists;
  if not org_exists then
    if tg_op = 'DELETE' then return old; else return new; end if;
  end if;

  select count(*) into remaining
  from public.memberships
  where org_id = target_org and role = 'owner' and id <> old.id;

  if remaining = 0 then
    raise exception 'Cannot remove or demote the last owner of a company. Promote someone else to owner first.';
  end if;

  if tg_op = 'DELETE' then return old; else return new; end if;
end $$;

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
