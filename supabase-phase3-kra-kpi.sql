-- ============================================================================
-- Command Center · Phase 3 — KRAs and KPIs
-- ----------------------------------------------------------------------------
-- Run ONCE in Supabase -> SQL Editor, AFTER supabase-setup.sql and
-- supabase-phase1-orgs.sql. Additive and non-destructive; safe to re-run.
--
--   kras       - a few qualitative responsibility areas per person
--   kpis       - a numeric target hanging off a KRA (or standing alone)
--   kpi_values - the actual for one KPI in one period ('2026-08' / '2026-Q3')
--
-- ACCESS MODEL — read this before changing anything.
--
-- This is deliberately NOT the same rule as planner_state, and that is not an
-- oversight. A planner is someone's private working space, so writes there are
-- self-only, always. A KRA/KPI is a *target assigned by management*, so:
--
--   defining KRAs/KPIs  -> owner, or the person's own manager. Never self
--                          (except an owner, who has nobody above them).
--   reading them        -> the person themselves, plus whoever can see them
--                          (same rule as planners: manager -> direct reports,
--                          owner -> everyone).
--   entering the actual -> the person themselves AND their manager/owner.
--                          The person is closest to the number; management
--                          needs to be able to correct or backfill it.
--
-- So writes here do cross users, on purpose, in one narrow direction
-- (management -> their own people). planner_state stays self-write-only.
-- ============================================================================


-- ------------------------------------------------------------------- KRAs --
create table if not exists public.kras (
  id          uuid primary key default gen_random_uuid(),
  org_id      uuid not null references public.organizations(id) on delete cascade,
  user_id     uuid not null references auth.users(id) on delete cascade,
  title       text not null,
  description text,
  sort_order  int  not null default 0,
  created_by  uuid not null references auth.users(id) on delete cascade,
  created_at  timestamptz not null default now()
);

create index if not exists kras_user_idx on public.kras(user_id);
create index if not exists kras_org_idx  on public.kras(org_id);

alter table public.kras enable row level security;


-- ------------------------------------------------------------------- KPIs --
-- direction: 'up' = higher is better (revenue), 'down' = lower is better
-- (cost, response time). It decides which side of target counts as green.
create table if not exists public.kpis (
  id         uuid primary key default gen_random_uuid(),
  org_id     uuid not null references public.organizations(id) on delete cascade,
  user_id    uuid not null references auth.users(id) on delete cascade,
  kra_id     uuid references public.kras(id) on delete set null,
  name       text not null,
  unit       text,
  target     numeric not null,
  direction  text not null default 'up'     check (direction in ('up','down')),
  cadence    text not null default 'monthly' check (cadence  in ('monthly','quarterly')),
  sort_order int  not null default 0,
  created_by uuid not null references auth.users(id) on delete cascade,
  created_at timestamptz not null default now()
);

create index if not exists kpis_user_idx on public.kpis(user_id);
create index if not exists kpis_kra_idx  on public.kpis(kra_id);

alter table public.kpis enable row level security;


-- ------------------------------------------------------------- KPI VALUES --
-- period is 'YYYY-MM' for monthly KPIs, 'YYYY-Qn' for quarterly ones.
create table if not exists public.kpi_values (
  id         uuid primary key default gen_random_uuid(),
  kpi_id     uuid not null references public.kpis(id) on delete cascade,
  period     text not null check (period ~ '^[0-9]{4}-(0[1-9]|1[0-2]|Q[1-4])$'),
  actual     numeric,
  note       text,
  updated_by uuid references auth.users(id) on delete set null,
  updated_at timestamptz not null default now(),
  unique (kpi_id, period)
);

create index if not exists kpi_values_kpi_idx on public.kpi_values(kpi_id);

alter table public.kpi_values enable row level security;


-- =========================================================================
-- HELPERS (SECURITY DEFINER, same reasoning as Phase 1: they must be able to
-- read memberships without tripping that table's own RLS.)
-- =========================================================================

-- Am I allowed to SET targets for this person?
-- Owner: anyone in their org, including themselves (nobody is above an owner).
-- Manager: their own direct reports only — not themselves, not peers.
-- Employee: nobody.
create or replace function public.can_manage_person(target uuid)
returns boolean language sql stable security definer set search_path = public as $$
  select exists (
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

-- Whose KPI is this? Used so kpi_values policies can resolve the person
-- without kpi_values having to duplicate (and risk drifting from) user_id.
create or replace function public.kpi_owner(p_kpi uuid)
returns uuid language sql stable security definer set search_path = public as $$
  select user_id from public.kpis where id = p_kpi
$$;


-- =========================================================================
-- POLICIES
-- can_view_planner() from Phase 1 is reused for reads: it already encodes
-- "me, or someone I'm allowed to see". Same people, same rule.
-- =========================================================================

-- ---- kras ----------------------------------------------------------------
drop policy if exists "read kras i can see" on public.kras;
create policy "read kras i can see" on public.kras for select
  using (public.can_view_planner(user_id));

drop policy if exists "manager sets kras" on public.kras;
create policy "manager sets kras" on public.kras for insert
  with check (public.can_manage_person(user_id) and created_by = auth.uid());

drop policy if exists "manager edits kras" on public.kras;
create policy "manager edits kras" on public.kras for update
  using (public.can_manage_person(user_id))
  with check (public.can_manage_person(user_id));

drop policy if exists "manager deletes kras" on public.kras;
create policy "manager deletes kras" on public.kras for delete
  using (public.can_manage_person(user_id));


-- ---- kpis ----------------------------------------------------------------
drop policy if exists "read kpis i can see" on public.kpis;
create policy "read kpis i can see" on public.kpis for select
  using (public.can_view_planner(user_id));

drop policy if exists "manager sets kpis" on public.kpis;
create policy "manager sets kpis" on public.kpis for insert
  with check (public.can_manage_person(user_id) and created_by = auth.uid());

drop policy if exists "manager edits kpis" on public.kpis;
create policy "manager edits kpis" on public.kpis for update
  using (public.can_manage_person(user_id))
  with check (public.can_manage_person(user_id));

drop policy if exists "manager deletes kpis" on public.kpis;
create policy "manager deletes kpis" on public.kpis for delete
  using (public.can_manage_person(user_id));


-- ---- kpi_values ----------------------------------------------------------
-- Read follows the KPI. Write is the one place a person other than the
-- subject may write: the subject reports their own number, and their
-- manager/owner can correct or backfill it.
drop policy if exists "read kpi values i can see" on public.kpi_values;
create policy "read kpi values i can see" on public.kpi_values for select
  using (public.can_view_planner(public.kpi_owner(kpi_id)));

drop policy if exists "subject or manager records actual" on public.kpi_values;
create policy "subject or manager records actual" on public.kpi_values for insert
  with check (
    public.kpi_owner(kpi_id) = auth.uid()
    or public.can_manage_person(public.kpi_owner(kpi_id))
  );

drop policy if exists "subject or manager updates actual" on public.kpi_values;
create policy "subject or manager updates actual" on public.kpi_values for update
  using (
    public.kpi_owner(kpi_id) = auth.uid()
    or public.can_manage_person(public.kpi_owner(kpi_id))
  )
  with check (
    public.kpi_owner(kpi_id) = auth.uid()
    or public.can_manage_person(public.kpi_owner(kpi_id))
  );

drop policy if exists "manager clears actual" on public.kpi_values;
create policy "manager clears actual" on public.kpi_values for delete
  using (
    public.kpi_owner(kpi_id) = auth.uid()
    or public.can_manage_person(public.kpi_owner(kpi_id))
  );


-- ============================================================================
-- VERIFY -- reports only, changes nothing.
-- Expect 3 rows, every status starting "OK".
-- ============================================================================
select
  t.name as "table",
  case
    when c.relname is null    then 'MISSING - re-run this file'
    when not c.relrowsecurity then 'EXISTS BUT RLS IS OFF - do not go live like this'
    else 'OK - exists, RLS on, ' || (
      select count(*) from pg_policies p
      where p.schemaname = 'public' and p.tablename = t.name) || ' policies'
  end as status
from (values ('kras'),('kpis'),('kpi_values')) as t(name)
left join pg_class c
  on c.relname = t.name and c.relnamespace = 'public'::regnamespace
order by 1;
