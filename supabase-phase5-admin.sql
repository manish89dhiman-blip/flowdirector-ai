-- ============================================================================
-- Command Center · Phase 5 — Platform admin, manual plan approval, trials
-- ----------------------------------------------------------------------------
-- Run AFTER phases 1, 3, 4 and 4b. Additive, non-destructive, safe to re-run.
--
-- Razorpay isn't live yet, so this replaces self-serve checkout with a
-- request-and-approve loop:
--
--   owner asks for a plan  ->  plan_requests row
--   platform admin approves ->  subscription updated, seats change
--
-- WHY THIS IS A DELIBERATE EXCEPTION TO THE "NO CLIENT WRITES" RULE
--
-- Phases 4/4b say `plans` and `subscriptions` have no client write policy at
-- all, because a write policy for `authenticated` is a free upgrade button for
-- every user. That still holds. What is added here is narrower: a policy
-- guarded by is_platform_admin(), which reads auth.uid() from the caller's
-- JWT and checks it against a table nobody can write from the browser.
--
-- An ordinary signed-in user gains nothing from it -- the policy evaluates
-- false for them, so their UPDATE touches zero rows. Routing the same writes
-- through an Edge Function would trust the very same JWT, so it would be no
-- safer, only harder to reason about. What must never appear is a policy that
-- lets `authenticated` write these tables *without* the admin check.
--
-- `platform_admins` itself has NO write policy. Add or remove an admin by
-- running SQL here, deliberately. That is the root of trust for billing.
-- ============================================================================


-- --------------------------------------------------------- PLATFORM ADMINS --
create table if not exists public.platform_admins (
  user_id  uuid primary key references auth.users(id) on delete cascade,
  email    text not null,
  added_at timestamptz not null default now()
);

alter table public.platform_admins enable row level security;

-- Seed the first admin. Matching on email because that is what a human knows;
-- the user must have signed up already or there is nothing to point at.
insert into public.platform_admins (user_id, email)
select u.id, u.email
from auth.users u
where lower(u.email) = lower('manish89dhiman@gmail.com')
on conflict (user_id) do nothing;

-- A person may check whether THEY are an admin, and see nothing else. Without
-- this the app can't decide whether to show the Admin tab.
drop policy if exists "see whether I am an admin" on public.platform_admins;
create policy "see whether I am an admin" on public.platform_admins for select
  using (user_id = auth.uid());

-- SECURITY DEFINER for the same reason as the other helpers: policies on other
-- tables call it, and it must not be blocked by platform_admins' own RLS.
create or replace function public.is_platform_admin()
returns boolean language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.platform_admins where user_id = auth.uid())
$$;


-- ----------------------------------------------------------- PLAN REQUESTS --
create table if not exists public.plan_requests (
  id           uuid primary key default gen_random_uuid(),
  org_id       uuid not null references public.organizations(id) on delete cascade,
  plan_code    text not null references public.plans(code),
  requested_by uuid references auth.users(id),
  note         text,
  status       text not null default 'pending'
                 check (status in ('pending','approved','declined')),
  decided_by   uuid references auth.users(id),
  decided_at   timestamptz,
  created_at   timestamptz not null default now()
);

alter table public.plan_requests enable row level security;

-- One open request per company, so a keen owner can't flood the queue.
create unique index if not exists plan_requests_one_pending
  on public.plan_requests (org_id) where status = 'pending';

drop policy if exists "read my company requests" on public.plan_requests;
create policy "read my company requests" on public.plan_requests for select
  using (org_id = public.current_org_id() or public.is_platform_admin());

drop policy if exists "owner asks for a plan" on public.plan_requests;
create policy "owner asks for a plan" on public.plan_requests for insert
  with check (org_id = public.current_org_id() and public.is_org_owner());

-- Deciding is the admin's job. An owner cannot approve their own request:
-- there is no update policy for them at all.
drop policy if exists "admin decides requests" on public.plan_requests;
create policy "admin decides requests" on public.plan_requests for all
  using (public.is_platform_admin()) with check (public.is_platform_admin());

-- An owner may withdraw their own request while it is still pending.
drop policy if exists "owner withdraws pending request" on public.plan_requests;
create policy "owner withdraws pending request" on public.plan_requests for delete
  using (org_id = public.current_org_id() and public.is_org_owner() and status = 'pending');


-- ------------------------------------------------- ADMIN WRITE + VISIBILITY --
-- The narrow exception explained at the top of this file.
drop policy if exists "platform admin manages plans" on public.plans;
create policy "platform admin manages plans" on public.plans for all
  using (public.is_platform_admin()) with check (public.is_platform_admin());

drop policy if exists "platform admin manages subscriptions" on public.subscriptions;
create policy "platform admin manages subscriptions" on public.subscriptions for all
  using (public.is_platform_admin()) with check (public.is_platform_admin());

-- Running the business needs the customer list: which companies exist, how
-- many seats they fill, and who to contact.
drop policy if exists "platform admin reads all orgs" on public.organizations;
create policy "platform admin reads all orgs" on public.organizations for select
  using (public.is_platform_admin());

drop policy if exists "platform admin reads all memberships" on public.memberships;
create policy "platform admin reads all memberships" on public.memberships for select
  using (public.is_platform_admin());

drop policy if exists "platform admin reads all profiles" on public.profiles;
create policy "platform admin reads all profiles" on public.profiles for select
  using (public.is_platform_admin());

-- DELIBERATELY ABSENT: any admin access to planner_state, kras, kpis or
-- kpi_values. Being the platform operator is a billing role, not a licence to
-- read what customers write in their planners. Don't "helpfully" add it.


-- ===========================================================================
-- TRIALS THAT ACTUALLY EXPIRE
-- ---------------------------------------------------------------------------
-- A trial is status='trialing' with current_period_end set to its last day.
-- Without this change nothing would ever end it -- there is no scheduler --
-- so a 14-day trial would grant seats forever.
--
-- Only TRIALS auto-expire. A paid plan whose period_end has passed is left
-- alone on purpose: a late webhook would otherwise downgrade a paying
-- customer. Paid plans lapse when the provider says so, via `status`.
-- ===========================================================================
create or replace function public.org_seat_limit(p_org uuid)
returns int language sql stable security definer set search_path = public as $$
  select case
    when s.status = 'trialing'
         and s.current_period_end is not null
         and s.current_period_end < now()
      then (select seat_limit from public.plans where code = 'free')
    when s.status in ('active','trialing') then coalesce(s.seats, p.seat_limit)
    else (select seat_limit from public.plans where code = 'free')
  end
  from public.subscriptions s
  join public.plans p on p.code = s.plan_code
  where s.org_id = p_org
$$;

-- CREATE OR REPLACE keeps existing grants, but re-assert them so this file is
-- safe to run before OR after supabase-harden-functions.sql.
revoke execute on function public.org_seat_limit(uuid) from public, anon, authenticated;
revoke execute on function public.is_platform_admin() from public, anon;
grant  execute on function public.is_platform_admin() to authenticated;


-- ============================================================================
-- VERIFY -- reports only, changes nothing.
-- ============================================================================
select item, status from (
  select 1 as ord, 'platform_admins table' as item,
         case when exists (select 1 from pg_class
                           where relname='platform_admins'
                             and relnamespace='public'::regnamespace
                             and relrowsecurity)
              then 'OK - exists, RLS on' else 'MISSING - re-run this file' end as status
  union all
  select 2, 'admin seeded (manish89dhiman@gmail.com)',
         case when exists (select 1 from public.platform_admins
                           where lower(email)=lower('manish89dhiman@gmail.com'))
              then 'OK'
              else 'NOT SEEDED - that address has no account yet. Sign up first, then re-run.' end
  union all
  select 3, 'plan_requests table',
         case when exists (select 1 from pg_class
                           where relname='plan_requests'
                             and relnamespace='public'::regnamespace
                             and relrowsecurity)
              then 'OK - exists, RLS on' else 'MISSING - re-run this file' end
  union all
  select 4, 'admin can write plans',
         case when exists (select 1 from pg_policies where tablename='plans'
                           and policyname='platform admin manages plans')
              then 'OK' else 'MISSING' end
  union all
  select 5, 'ordinary users still cannot write billing',
         case when not exists (
                select 1 from pg_policies
                where schemaname='public' and tablename in ('plans','subscriptions')
                  and cmd <> 'SELECT'
                  and coalesce(qual,'') || coalesce(with_check,'') not like '%is_platform_admin%')
              then 'OK - every write policy is admin-guarded'
              else 'DANGER - an unguarded write policy exists' end
  union all
  select 6, 'planner contents still private from admin',
         case when not exists (
                select 1 from pg_policies
                where schemaname='public'
                  and tablename in ('planner_state','kras','kpis','kpi_values')
                  and coalesce(qual,'') like '%is_platform_admin%')
              then 'OK - admin has no planner access' else 'DANGER - admin can read planners' end
) v order by ord;
