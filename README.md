# Command Center

A Time Domination planner — Capture, Daily, Weekly, Monthly, Maybe, Reference — with Supabase
login so it opens on any device. Use it solo, or set up a company so owners and managers can
see their team's plans in one place.

## Files
- `index.html` — the whole app (React + Tailwind + Supabase via CDN, no build step)
- `supabase-setup.sql` — run once: creates the planner table + security rules
- `supabase-phase1-orgs.sql` — run once after that: adds companies, roles, and invites
- `supabase-phase3-kra-kpi.sql` — run once after that: adds KRAs and KPIs
- `supabase-phase4-billing.sql` — run once after that: adds plans and seat limits
- `supabase-phase4b-razorpay.sql` — run once after that: Razorpay (India) as the payment provider
- `supabase-phase5-admin.sql` — run once after that: admin panel, plan approval, trials
- `supabase-harden-functions.sql` — optional: closes internal functions off from the REST API
- `supabase/functions/` — the Razorpay and Stripe Edge Functions (optional; see `BILLING-SETUP.md`)
- `manifest.webmanifest`, `sw.js`, `icon.svg` — PWA install + offline app-shell caching
- `Command-Center-Guide.pdf` — the business-owner guide to using the system
- `BILLING-SETUP.md` — how to set your tiers, and how to wire up payments when you're ready
- `EMAIL-SETUP.md` — invite emails, and making password-reset mail actually arrive
- `CLAUDE.md` — project context for Claude Code

## First run
1. Create a Supabase project → in its SQL Editor run `supabase-setup.sql`, then
   `supabase-phase1-orgs.sql`, then `supabase-phase3-kra-kpi.sql`, then
   `supabase-phase4-billing.sql`, `supabase-phase4b-razorpay.sql`, then
   `supabase-phase5-admin.sql` (in that order). Each one ends by printing whether it worked,
   and each is safe to re-run.
2. In `index.html`, paste your Supabase URL + anon key into the CONFIG block near the top.
3. Serve the folder and open it:
   ```
   python3 -m http.server 5173
   ```
4. Create an account, sign in, start planning.

## Companies, roles, and visibility
On first sign-in you can create a company, accept an invite, or stay solo (and change your
mind later in Settings → Company).

| Role | Sees |
|---|---|
| **Owner** | Every person's planner; manages the team and sends invites |
| **Manager** | Their own planner plus their direct reports' |
| **Employee** | Their own planner only |

Viewing is strictly **read-only** — nobody can edit anyone else's plan, and that's enforced in
the database, not just the UI. Invites work by email: the owner adds an address in the Team
tab, and it's waiting for that person when they sign in with it.

Set up sending (see `EMAIL-SETUP.md`) and Command Center emails the invitation for you, with
**Resend email** and **Copy link** on every pending invite. Skip it and invites still work —
you just pass the site link along yourself.

Each person manages their own account in **Settings → Your account**: display name, and a
password change with no email round-trip. Forgotten passwords are handled from the sign-in
screen.

## Dashboard
Owners and managers get a **Dashboard** tab covering today, the last 7 days, or the last 30:

- **Priorities completed** — of the priorities people actually set, how many got marked done
  (versus moved, delegated, or dropped)
- **Days planned** — how often the day got a main outcome at all
- **Avg day score** — the 0–3 evening-closure score, averaged over days that were genuinely
  closed out (days with no closure are excluded, not counted as zero)
- **Overdue** and **waiting on others** — current load and delegation follow-through

Click any person for their detail: today's plan, a score sparkline, and a breakdown of what
happened to every priority they set in the period.

## Goals (KRAs and KPIs)
Everyone in a company gets a **Goals** tab.

- A **KRA** is a responsibility area — a few per person, in plain words.
- A **KPI** is one number under it: a target, a unit, and whether higher or lower is better,
  measured monthly or quarterly.

Owners set targets for anyone; managers set them for their direct reports. **The person
reports their own actual** (their manager can correct it), and each KPI shows attainment with
a status colour — green on target, amber within 20%, red below. Team KPI attainment also
appears as a column on the Dashboard.

It stops there on purpose: a number and a colour, not a performance-review workflow.

## Plans and seats
Settings → **Billing** shows the company's plan, how many seats are used, and the tier list.
You set the tiers yourself in the `plans` table — `seat_limit` is what's enforced, the price
text is display only.

Running out of seats stops you **adding** people. It never removes anyone, hides data, or
locks a person out of their own planner — and a lapsed payment behaves the same way: the
company can't grow until it's sorted, but everyone already in it carries on untouched.

### Admin panel
Card payments are **switched off** (`PAYMENTS_ENABLED = false` in `index.html`) until a
Razorpay account is live. So an owner presses **Request this plan**, and you approve it in the
**Admin** tab — visible only to accounts listed in `platform_admins`.

From there you can move any company between plans, set seats, start a 14/30/90-day trial, and
create or edit tiers without touching SQL. Trials carry an end date and expire themselves;
when one ends the company drops to the free seat limit, and **nobody is ever removed**.

Being a platform admin is a billing role: you can see every company, its owner and its seat
count, and **not one word of anyone's planner**.

When Razorpay is live, set each tier's `razorpay_plan_id`, flip `PAYMENTS_ENABLED` to true,
and self-serve checkout comes back. `BILLING-SETUP.md` covers that, plus the India-specific
traps that aren't code: GST, and the RBI e-mandate cap that forces customer approval on every
charge above a threshold.

## Deploy
Static host — Netlify Drop, `vercel`, or upload to your own domain.

## Continue building with Claude Code
From this folder, run `claude` and try prompts like:
- "Add Google sign-in as a login option."
- "Add a monthly score-trend chart to the Daily module."
- "Migrate to a normalized schema so teammates can log in and see their own assigned tasks."
