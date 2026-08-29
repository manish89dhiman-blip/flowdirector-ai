-- ============================================================================
-- Phase 6b — Multi-Frequency Billing & Admin Plan Management
-- Run this in Supabase → SQL Editor to add yearly billing columns
-- ============================================================================

alter table public.plans
  add column if not exists razorpay_plan_id_yearly text,
  add column if not exists price_display_yearly text;

comment on column public.plans.razorpay_plan_id_yearly is
  'Razorpay plan ID for annual billing with discounted rate (plan_xxx).';
comment on column public.plans.price_display_yearly is
  'Display string for annual discounted rate (e.g. ₹299 / person / month billed yearly).';
