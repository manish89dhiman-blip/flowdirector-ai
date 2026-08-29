-- ============================================================================
-- Command Center · Phase 4 — Subscription tiers and seat limits
-- ----------------------------------------------------------------------------
-- Run AFTER phases 1 and 3. Additive, non-destructive, safe to re-run.
--
--   plans         - the tier list. YOU edit these numbers; they are placeholders.
--   subscriptions - one row per company: which plan, how many seats, status.
--
-- TWO THINGS TO UNDERSTAND BEFORE CHANGING ANY OF THIS:
--
-- 1. The client can NEVER write to `subscriptions`. There is deliberately no
--    insert/update/delete policy for the `authenticated` role, so a browser
--    cannot upgrade its own plan no matter what it sends. Only the Stripe
--    webhook writes here, using the service_role key, which bypasses RLS.
--    If you ever add a client-side write policy to this table, you have given
--    every user a free upgrade button.
--
-- 2. Running out of seats blocks ADDING people. It never removes anyone and
--    never locks anyone out of their own planner. A failed card should not
--    cost someone access to the work they already did — it just stops the
--    company growing until billing is sorted.
-- ============================================================================


-- ------------------------------------------------------------------ PLANS --
create table if not exists public.plans (
  code             text primary key,
  name             text not null,
  seat_limit       int,            -- null = unlimited
  price_display    text,           -- shown in the UI only, never used for charging
  stripe_price_id  text,           -- paste from your Stripe dashboard
  sort_order       int not null default 0
);

alter table public.plans enable row level security;

-- Placeholder tiers. CHANGE THESE to match your actual pricing, and paste the
-- matching Stripe price IDs. Nothing here charges anyone — price_display is
-- display text; Stripe is the only source of truth for what is actually billed.
insert into public.plans (code, name, seat_limit, price_display, sort_order) values
  ('free',     'Solo',     1,    'Free',              0),
  ('team',     'Team',     10,   'set your price',    1),
  ('business', 'Business', 50,   'set your price',    2),
  ('unlimited','Unlimited',null, 'talk to us',        3)
on conflict (code) do nothing;


-- ---------------------------------------------------------- SUBSCRIPTIONS --
create table if not exists public.subscriptions (
  org_id                 uuid primary key references public.organizations(id) on delete cascade,
  plan_code              text not null references public.plans(code),
  status                 text not null default 'active'
                           check (status in ('active','trialing','past_due','canceled')),
  seats                  int,      -- purchased seats; null = use the plan's seat_limit
  current_period_end     timestamptz,
  stripe_customer_id     text,
  stripe_subscription_id text,
  updated_at             timestamptz not null default now()
);

alter table public.subscriptions enable row level security;

-- Grandfather every company that already exists so nothing that works today
-- stops working. They get at least 3 seats regardless of current headcount.
insert into public.subscriptions (org_id, plan_code, status, seats)
select o.id, 'free', 'active',
       greatest((select count(*) from public.memberships m where m.org_id = o.id), 3)
from public.organizations o
on conflict (org_id) do nothing;

-- New companies start on the free plan.
create or replace function public.give_new_org_a_plan()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  insert into public.subscriptions (org_id, plan_code, status)
  values (new.id, 'free', 'active')
  on conflict (org_id) do nothing;
  return new;
end $$;

drop trigger if exists organizations_default_plan on public.organizations;
create trigger organizations_default_plan
  after insert on public.organizations
  for each row execute function public.give_new_org_a_plan();


-- =========================================================================
-- SEAT LIMITS
-- =========================================================================

-- Seats a company may fill right now. A lapsed subscription falls back to the
-- free plan's limit — enough to stop growth, never enough to evict anyone.
create or replace function public.org_seat_limit(p_org uuid)
returns int language sql stable security definer set search_path = public as $$
  select case
    when s.status in ('active','trialing') then coalesce(s.seats, p.seat_limit)
    else (select seat_limit from public.plans where code = 'free')
  end
  from public.subscriptions s
  join public.plans p on p.code = s.plan_code
  where s.org_id = p_org
$$;

-- Seats already spoken for: members plus invites nobody has accepted yet.
create or replace function public.org_seats_used(p_org uuid)
returns int language sql stable security definer set search_path = public as $$
  select (select count(*) from public.memberships where org_id = p_org)
       + (select count(*) from public.invites
          where org_id = p_org and accepted_at is null)
$$;

-- Blocks the insert that would exceed the limit. Raises a message starting
-- with SEAT_LIMIT: so the client can recognise it and say something useful
-- instead of dumping a Postgres error on screen.
create or replace function public.check_seat_limit()
returns trigger language plpgsql security definer set search_path = public as $$
declare
  lim  int;
  used int;
begin
  lim := public.org_seat_limit(new.org_id);
  if lim is null then return new; end if;          -- unlimited plan

  -- Accepting an invite converts a reserved seat into a filled one, so it
  -- must not be counted twice. Those inserts are already within the limit.
  if tg_table_name = 'memberships'
     and exists (select 1 from public.invites i
                 where i.org_id = new.org_id
                   and lower(i.email) = lower(auth.jwt() ->> 'email')
                   and i.accepted_at is null)
  then
    return new;
  end if;

  used := public.org_seats_used(new.org_id);
  if used >= lim then
    raise exception 'SEAT_LIMIT: this company has % of % seats in use. Free up a seat or move to a bigger plan.', used, lim;
  end if;
  return new;
end $$;

drop trigger if exists memberships_seat_limit on public.memberships;
create trigger memberships_seat_limit
  before insert on public.memberships
  for each row execute function public.check_seat_limit();

drop trigger if exists invites_seat_limit on public.invites;
create trigger invites_seat_limit
  before insert on public.invites
  for each row execute function public.check_seat_limit();


-- =========================================================================
-- POLICIES
-- =========================================================================

-- The tier list is a price list: everyone signed in may read it, nobody may
-- write it from the client.
drop policy if exists "anyone signed in can read plans" on public.plans;
create policy "anyone signed in can read plans" on public.plans for select
  using (auth.uid() is not null);

-- A company may see its own subscription. There is intentionally NO write
-- policy here — see the note at the top of this file.
drop policy if exists "read my company subscription" on public.subscriptions;
create policy "read my company subscription" on public.subscriptions for select
  using (org_id = public.current_org_id());


-- ============================================================================
-- VERIFY -- reports only, changes nothing.
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
from (values ('plans'),('subscriptions')) as t(name)
left join pg_class c on c.relname = t.name and c.relnamespace = 'public'::regnamespace
order by 1;
