-- ============================================================================
-- Command Center · Phase 1 — Companies, roles, invites, org-scoped visibility
-- ----------------------------------------------------------------------------
-- Run this ONCE in Supabase -> SQL Editor -> New query -> Run, AFTER
-- supabase-setup.sql has already been run.
--
-- This is additive and non-destructive: existing planner_state rows are left
-- exactly as they are. A user with no company keeps working solo, unchanged.
--
-- What it creates:
--   profiles       - readable name/email per user (auth.users isn't client-readable)
--   organizations  - one row per company
--   memberships    - user x org x role (owner | manager | employee), plus manager_id
--   invites        - pending email invitations to join a company
--
-- Visibility rule this enforces:
--   employee -> sees only their own planner
--   manager  -> sees their own + their direct reports'
--   owner    -> sees everyone in the company
-- Viewing is read-only: nobody can edit anyone else's planner.
-- ============================================================================


-- ---------------------------------------------------------------- PROFILES --
create table if not exists public.profiles (
  id         uuid primary key references auth.users(id) on delete cascade,
  email      text,
  full_name  text,
  created_at timestamptz not null default now()
);

alter table public.profiles enable row level security;

-- Backfill anyone who signed up before this migration.
insert into public.profiles (id, email, full_name)
select u.id, u.email,
       coalesce(u.raw_user_meta_data ->> 'full_name', split_part(u.email, '@', 1))
from auth.users u
on conflict (id) do nothing;

-- Keep profiles in sync as new users sign up.
create or replace function public.handle_new_user()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  insert into public.profiles (id, email, full_name)
  values (new.id, new.email,
          coalesce(new.raw_user_meta_data ->> 'full_name', split_part(new.email, '@', 1)))
  on conflict (id) do nothing;
  return new;
end $$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();


-- ----------------------------------------------------------- ORGANIZATIONS --
create table if not exists public.organizations (
  id         uuid primary key default gen_random_uuid(),
  name       text not null,
  created_by uuid not null references auth.users(id) on delete cascade,
  created_at timestamptz not null default now()
);

alter table public.organizations enable row level security;


-- ------------------------------------------------------------- MEMBERSHIPS --
-- unique(user_id) deliberately limits v1 to ONE company per person. Dropping
-- that constraint later is the migration path to multi-org users.
create table if not exists public.memberships (
  id         uuid primary key default gen_random_uuid(),
  org_id     uuid not null references public.organizations(id) on delete cascade,
  user_id    uuid not null references auth.users(id) on delete cascade,
  role       text not null check (role in ('owner','manager','employee')),
  manager_id uuid references auth.users(id) on delete set null,
  title      text,
  created_at timestamptz not null default now(),
  unique (org_id, user_id),
  unique (user_id)
);

create index if not exists memberships_org_idx     on public.memberships(org_id);
create index if not exists memberships_manager_idx on public.memberships(manager_id);

alter table public.memberships enable row level security;


-- ----------------------------------------------------------------- INVITES --
create table if not exists public.invites (
  id          uuid primary key default gen_random_uuid(),
  org_id      uuid not null references public.organizations(id) on delete cascade,
  email       text not null,
  role        text not null check (role in ('owner','manager','employee')),
  manager_id  uuid references auth.users(id) on delete set null,
  invited_by  uuid not null references auth.users(id) on delete cascade,
  created_at  timestamptz not null default now(),
  accepted_at timestamptz,
  unique (org_id, email)
);

create index if not exists invites_email_idx on public.invites(lower(email));

alter table public.invites enable row level security;


-- =========================================================================
-- HELPER FUNCTIONS
-- All SECURITY DEFINER on purpose: they bypass RLS internally, which is what
-- breaks the infinite-recursion problem you get when a memberships policy
-- needs to query memberships. Each one is narrowly scoped to auth.uid().
-- =========================================================================

create or replace function public.current_org_id()
returns uuid language sql stable security definer set search_path = public as $$
  select org_id from public.memberships where user_id = auth.uid() limit 1
$$;

create or replace function public.current_role_in_org()
returns text language sql stable security definer set search_path = public as $$
  select role from public.memberships where user_id = auth.uid() limit 1
$$;

create or replace function public.is_org_owner()
returns boolean language sql stable security definer set search_path = public as $$
  select coalesce(
    (select role = 'owner' from public.memberships where user_id = auth.uid() limit 1),
    false)
$$;

-- Do I share a company with this user?
create or replace function public.shares_org(target uuid)
returns boolean language sql stable security definer set search_path = public as $$
  select exists (
    select 1
    from public.memberships me
    join public.memberships them on them.org_id = me.org_id
    where me.user_id = auth.uid() and them.user_id = target
  )
$$;

-- The core visibility rule: self, or (owner of their org), or (their manager).
create or replace function public.can_view_planner(target uuid)
returns boolean language sql stable security definer set search_path = public as $$
  select
    target = auth.uid()
    or exists (
      select 1
      from public.memberships me
      join public.memberships them on them.org_id = me.org_id
      where me.user_id = auth.uid()
        and them.user_id = target
        and (
          me.role = 'owner'
          or (me.role = 'manager' and them.manager_id = auth.uid())
        )
    )
$$;

-- Did I create this org? (used to bootstrap the founder's own owner row)
create or replace function public.founded_org(p_org uuid)
returns boolean language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from public.organizations o
    where o.id = p_org and o.created_by = auth.uid()
  )
$$;

-- Is there a pending invite matching my email for this org + role?
create or replace function public.has_pending_invite(p_org uuid, p_role text)
returns boolean language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from public.invites i
    where i.org_id = p_org
      and lower(i.email) = lower(auth.jwt() ->> 'email')
      and i.accepted_at is null
      and i.role = p_role
  )
$$;


-- =========================================================================
-- ROW-LEVEL SECURITY POLICIES
-- =========================================================================

-- ---- profiles ------------------------------------------------------------
drop policy if exists "read own and org profiles" on public.profiles;
create policy "read own and org profiles" on public.profiles for select
  using (id = auth.uid() or public.shares_org(id));

drop policy if exists "update own profile" on public.profiles;
create policy "update own profile" on public.profiles for update
  using (id = auth.uid()) with check (id = auth.uid());

drop policy if exists "insert own profile" on public.profiles;
create policy "insert own profile" on public.profiles for insert
  with check (id = auth.uid());


-- ---- organizations -------------------------------------------------------
drop policy if exists "read own org" on public.organizations;
create policy "read own org" on public.organizations for select
  using (id = public.current_org_id() or created_by = auth.uid());

drop policy if exists "anyone can found an org" on public.organizations;
create policy "anyone can found an org" on public.organizations for insert
  with check (created_by = auth.uid());

drop policy if exists "owner renames org" on public.organizations;
create policy "owner renames org" on public.organizations for update
  using (id = public.current_org_id() and public.is_org_owner())
  with check (id = public.current_org_id() and public.is_org_owner());


-- ---- memberships ---------------------------------------------------------
drop policy if exists "read memberships in my org" on public.memberships;
create policy "read memberships in my org" on public.memberships for select
  using (user_id = auth.uid() or org_id = public.current_org_id());

-- Two legitimate ways a membership row gets created by the client:
--   1. You just founded the org -> you insert your own 'owner' row.
--   2. You have a pending invite for your email -> you insert your own row.
drop policy if exists "join org via founding or invite" on public.memberships;
create policy "join org via founding or invite" on public.memberships for insert
  with check (
    user_id = auth.uid()
    and (
      (role = 'owner' and public.founded_org(org_id))
      or public.has_pending_invite(org_id, role)
    )
  );

drop policy if exists "owner manages memberships" on public.memberships;
create policy "owner manages memberships" on public.memberships for update
  using (org_id = public.current_org_id() and public.is_org_owner())
  with check (org_id = public.current_org_id() and public.is_org_owner());

drop policy if exists "owner removes member or self leaves" on public.memberships;
create policy "owner removes member or self leaves" on public.memberships for delete
  using (
    user_id = auth.uid()
    or (org_id = public.current_org_id() and public.is_org_owner())
  );

-- Guard: never let the last owner be removed or demoted, which would strand
-- the company with nobody able to administer it.
create or replace function public.protect_last_owner()
returns trigger language plpgsql security definer set search_path = public as $$
declare
  remaining int;
  target_org uuid;
begin
  target_org := coalesce(old.org_id, new.org_id);

  if tg_op = 'DELETE' and old.role <> 'owner' then return old; end if;
  if tg_op = 'UPDATE' and old.role <> 'owner' then return new; end if;
  if tg_op = 'UPDATE' and new.role = 'owner' then return new; end if;

  select count(*) into remaining
  from public.memberships
  where org_id = target_org and role = 'owner' and id <> old.id;

  if remaining = 0 then
    raise exception 'Cannot remove or demote the last owner of a company. Promote someone else to owner first.';
  end if;

  if tg_op = 'DELETE' then return old; else return new; end if;
end $$;

drop trigger if exists memberships_protect_last_owner on public.memberships;
create trigger memberships_protect_last_owner
  before update or delete on public.memberships
  for each row execute function public.protect_last_owner();


-- ---- invites -------------------------------------------------------------
drop policy if exists "read invites for my org or my email" on public.invites;
create policy "read invites for my org or my email" on public.invites for select
  using (
    org_id = public.current_org_id()
    or lower(email) = lower(auth.jwt() ->> 'email')
  );

drop policy if exists "owner sends invites" on public.invites;
create policy "owner sends invites" on public.invites for insert
  with check (
    org_id = public.current_org_id()
    and public.is_org_owner()
    and invited_by = auth.uid()
  );

-- Invitee marks it accepted; owner can also touch it (e.g. re-issue).
drop policy if exists "accept or manage invite" on public.invites;
create policy "accept or manage invite" on public.invites for update
  using (
    lower(email) = lower(auth.jwt() ->> 'email')
    or (org_id = public.current_org_id() and public.is_org_owner())
  )
  with check (
    lower(email) = lower(auth.jwt() ->> 'email')
    or (org_id = public.current_org_id() and public.is_org_owner())
  );

drop policy if exists "owner revokes invite" on public.invites;
create policy "owner revokes invite" on public.invites for delete
  using (org_id = public.current_org_id() and public.is_org_owner());


-- ---- planner_state (extend the existing owner-only read) -----------------
-- Read widens to the visibility rule above. Write stays strictly self-only:
-- an owner can SEE a team member's plan, never edit it.
drop policy if exists "read own planner" on public.planner_state;
drop policy if exists "read planner self or permitted" on public.planner_state;
create policy "read planner self or permitted" on public.planner_state for select
  using (public.can_view_planner(user_id));

-- (insert/update policies from supabase-setup.sql remain unchanged and
--  continue to restrict writes to auth.uid() = user_id.)


-- ============================================================================
-- VERIFY -- reports only, changes nothing.
-- After running this file you should get 5 rows, every status starting "OK".
-- If any row says MISSING, the file didn't finish: scroll up for the first
-- red error, fix that, and run it again (it's safe to re-run).
-- ============================================================================
select
  t.name as "table",
  case
    when c.relname is null            then 'MISSING - re-run this file'
    when not c.relrowsecurity         then 'EXISTS BUT RLS IS OFF - do not go live like this'
    else 'OK - exists, RLS on, ' || (
      select count(*) from pg_policies p
      where p.schemaname = 'public' and p.tablename = t.name) || ' policies'
  end as status
from (values ('profiles'),('organizations'),('memberships'),('invites'),('planner_state')) as t(name)
left join pg_class c
  on c.relname = t.name and c.relnamespace = 'public'::regnamespace
order by 1;
