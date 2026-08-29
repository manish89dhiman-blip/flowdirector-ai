-- ============================================================================
-- Command Center · Phase 4b — Razorpay (India) as the primary payment provider
-- ----------------------------------------------------------------------------
-- Run AFTER supabase-phase4-billing.sql. Additive, non-destructive, re-runnable.
--
-- Phase 4 was written Stripe-first. This makes the billing tables
-- provider-agnostic so Razorpay can be the live path for Indian customers,
-- while the Stripe columns stay in place for international expansion later.
-- Nothing Stripe-related is dropped; a plan can carry both IDs and be sold
-- through whichever provider suits the buyer.
--
-- The security model is UNCHANGED and must stay that way: the client can read
-- `plans` and its own `subscriptions` row, and can write neither. The webhook
-- (service_role) remains the only writer. Adding a write policy here hands
-- every user a free upgrade button.
-- ============================================================================


-- ------------------------------------------------------------------ PLANS --
-- A plan may have a Razorpay plan ID, a Stripe price ID, or both. Whichever
-- is set is what the app can sell it through.
alter table public.plans
  add column if not exists razorpay_plan_id text;

comment on column public.plans.razorpay_plan_id is
  'Razorpay plan ID (plan_xxx) from Subscriptions > Plans. Set this to make the tier buyable in INR.';
comment on column public.plans.stripe_price_id is
  'Stripe price ID (price_xxx). Only needed for international billing; leave null while selling in India.';


-- ---------------------------------------------------------- SUBSCRIPTIONS --
alter table public.subscriptions
  add column if not exists provider                text not null default 'razorpay',
  add column if not exists razorpay_customer_id    text,
  add column if not exists razorpay_subscription_id text;

-- Which provider actually owns this company's billing. Manual/free companies
-- stay 'razorpay' by default; it only matters once money is involved.
do $$ begin
  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.subscriptions'::regclass and conname = 'subscriptions_provider_check'
  ) then
    alter table public.subscriptions
      add constraint subscriptions_provider_check check (provider in ('razorpay','stripe'));
  end if;
end $$;

-- One company can't hold two live subscriptions at the same provider.
create unique index if not exists subscriptions_razorpay_sub_idx
  on public.subscriptions (razorpay_subscription_id)
  where razorpay_subscription_id is not null;


-- =========================================================================
-- STATUS MAPPING  (documented here because it is a judgement call, not a
-- lookup table -- the webhook applies it, this is the reasoning)
-- =========================================================================
--
--   Razorpay subscription state   ->  our `status`   Why
--   ---------------------------------------------------------------------
--   authenticated                 ->  trialing       Mandate approved, first
--                                                    charge imminent. Seats are
--                                                    granted a little early on
--                                                    purpose -- forgiving beats
--                                                    locking out a customer who
--                                                    has already paid.
--   active                        ->  active         Charging normally.
--   pending                       ->  past_due       A charge failed; Razorpay
--                                                    is retrying.
--   halted                        ->  past_due       Retries exhausted. Growth
--                                                    stops; NOBODY loses access.
--   paused                        ->  past_due       Same treatment.
--   cancelled / completed /
--   expired                       ->  canceled       Falls back to the free
--                                                    plan's seat limit.
--   created                       ->  (ignored)      Not yet authorised, so it
--                                                    must not grant anything.
--
-- `past_due` and `canceled` both fall back to the FREE plan's limit, never to
-- zero, and never remove a member. That rule is inherited from phase 4 and is
-- deliberate: a failed card should not cost someone the work they already did.


-- =========================================================================
-- VERIFY -- reports only, changes nothing.
-- =========================================================================
select
  c.item as "column",
  case when c.present then 'OK' else 'MISSING - re-run this file' end as status
from (
  select 'plans.razorpay_plan_id' as item,
         exists (select 1 from information_schema.columns
                 where table_schema='public' and table_name='plans'
                   and column_name='razorpay_plan_id') as present
  union all
  select 'subscriptions.provider',
         exists (select 1 from information_schema.columns
                 where table_schema='public' and table_name='subscriptions'
                   and column_name='provider')
  union all
  select 'subscriptions.razorpay_customer_id',
         exists (select 1 from information_schema.columns
                 where table_schema='public' and table_name='subscriptions'
                   and column_name='razorpay_customer_id')
  union all
  select 'subscriptions.razorpay_subscription_id',
         exists (select 1 from information_schema.columns
                 where table_schema='public' and table_name='subscriptions'
                   and column_name='razorpay_subscription_id')
  union all
  select 'subscriptions still has NO client write policy',
         not exists (select 1 from pg_policies
                     where schemaname='public' and tablename='subscriptions'
                       and cmd <> 'SELECT')
) c
order by 1;
