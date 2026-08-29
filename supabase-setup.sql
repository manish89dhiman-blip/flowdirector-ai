-- Command Center · Time Domination — Supabase setup
-- Run this once in Supabase → SQL Editor → New query → Run.
-- It creates one table that holds each user's planner as a single JSON blob,
-- locked down so every user can only ever see and edit their own row.

create table if not exists public.planner_state (
  user_id    uuid primary key references auth.users(id) on delete cascade,
  data       jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now()
);

-- Turn on Row-Level Security (this is what makes it user-specific).
alter table public.planner_state enable row level security;

-- A user can read only their own row.
create policy "read own planner"
  on public.planner_state for select
  using (auth.uid() = user_id);

-- A user can create only their own row.
create policy "insert own planner"
  on public.planner_state for insert
  with check (auth.uid() = user_id);

-- A user can update only their own row.
create policy "update own planner"
  on public.planner_state for update
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);
