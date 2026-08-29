# Command Center — Time Domination

Task-management + scheduling app built around the Vyas "Time Domination" planning system:
a capture → route → schedule → review loop across five modules, plus Reference and Settings.
Originally a personal planner for Capt. Manish Dhiman (Airlogic Aviation); as of Phase 1 it
also works as a company tool where an owner can see the whole team's plan.

## What this is (and isn't)

- **Each person still owns and edits only their own planner.** Companies add *visibility*
  (owners/managers can read their people's plans) — never shared editing.
- **Solo still works.** A user with no company gets exactly the original personal planner.
  Company setup is opt-in and reversible.
- Built as **one self-contained `index.html`** — no build step, no bundler, no framework CLI.
  React, Tailwind, Babel, and the Supabase client all load from CDNs inside the file.
- Data lives in **Supabase** (Postgres + Auth). This is what makes it multi-device and login-gated.

Keep it a single file unless there's a strong reason to split. The whole point is that Manish
can host it anywhere static (Netlify, Vercel, Hostinger) by dropping one file. The one deliberate
exception is the PWA trio (`manifest.webmanifest`, `sw.js`, `icon.svg`) — a service worker and web
manifest are required by the browser to be separate, root-scoped files; they can't be inlined into
`index.html`.

## Run / preview

Just open `index.html` in a browser, or serve the folder:
```
python3 -m http.server 5173      # then visit http://localhost:5173
```
Auth needs the CDNs to load, so preview online rather than via `file://` if magic-link is added later.

## Configuration

Near the top of `index.html`:
```js
const SUPABASE_URL = "https://YOUR-PROJECT.supabase.co";
const SUPABASE_ANON_KEY = "YOUR-PUBLISHABLE-ANON-KEY";
```
The anon key is safe in client code **only because Row-Level Security is on**. Never disable RLS.
Never paste the `service_role` key into this file.

## Database

Run these once each in Supabase → SQL Editor, **in order**:

1. `supabase-setup.sql` — creates
   `planner_state(user_id uuid PK → auth.users, data jsonb, updated_at timestamptz)`
   with RLS so a user can only select/insert/update their own row. The entire planner is one
   JSONB blob per user (`data`). Load on sign-in, debounced upsert on change.
2. `supabase-phase1-orgs.sql` — adds companies. Additive and non-destructive; existing
   `planner_state` rows are untouched.
3. `supabase-phase3-kra-kpi.sql` — adds KRAs and KPIs. Also additive. Optional: without it
   the Goals tab reports the missing tables and the Dashboard just hides its KPI column.
4. `supabase-phase4-billing.sql` — adds plans and seat limits. Also additive and optional:
   without it Settings → Billing names the missing migration and nothing else changes.
5. `supabase-phase4b-razorpay.sql` — makes billing provider-agnostic (Razorpay primary,
   Stripe kept for international). Additive; needed before any Razorpay tier can be sold.
6. `supabase-phase5-admin.sql` — platform admin, manual plan approval, expiring trials.
   Additive. Without it the Admin tab simply never appears.

`supabase-harden-functions.sql` is optional and can be run any time after those. It closes
the SECURITY DEFINER helpers off from the public REST API. Read its header before editing:
revoking from `anon, authenticated` does nothing (the grant is on PUBLIC), and revoking the
eight functions that RLS policies call would lock signed-in users out of their own data.

Each file ends with a VERIFY block that prints one row per table (`OK` / `MISSING` /
`EXISTS BUT RLS IS OFF`), so running one tells you plainly whether it worked. All of them
are safe to re-run.

### Company tables (Phase 1)
```
profiles      (id → auth.users, email, full_name)   // auth.users isn't client-readable
organizations (id, name, created_by)
memberships   (id, org_id, user_id, role, manager_id, title)  // role: owner|manager|employee
invites       (id, org_id, email, role, manager_id, invited_by, accepted_at)
```

**Visibility rule** (enforced in Postgres, not the client): employee → own planner only;
manager → own + direct reports (`manager_id = auth.uid()`); owner → everyone in the org.
Implemented as `can_view_planner(uuid)`, which the `planner_state` SELECT policy calls.
**Writes stay strictly self-only** — an owner can read a team member's plan, never edit it.
This is verified, not assumed: see "Testing the SQL" below.

`unique(user_id)` on `memberships` limits v1 to **one company per person**. Dropping that
constraint is the migration path to multi-org users; a fair amount of client code assumes
a single membership, so grep before loosening it.

All the RLS helper functions (`current_org_id`, `is_org_owner`, `can_view_planner`,
`shares_org`, `founded_org`, `has_pending_invite`) are **SECURITY DEFINER on purpose**.
That's what breaks the infinite-recursion problem you hit when a `memberships` policy needs
to query `memberships`. Don't "fix" them into plain functions — it will deadlock RLS.

### Invites
An owner creates an invite row; the invitee sees it on their onboarding screen when they sign
in with that exact email, and accepting inserts their own membership row (allowed by
`has_pending_invite`). **There is no token in the invite link** — the invitee's email matching
the row is what authorises acceptance.

The `send-invite` Edge Function emails the invitation (Resend). It is a **pure convenience
layer and must stay one**: it never creates or edits an invite, and if it isn't configured it
returns `{sent:false, reason:"not_configured"}` rather than failing, so the app falls back to
"copy the link and send it yourself" — exactly how invites worked before. All three outcomes
(sent / not configured / send failed) are covered by tests, and in every one the invite itself
is valid. Don't turn a send failure into an invite failure.

Only the **owner** of the invite's own org may send. The function loads the invite server-side
and compares its `org_id` against the caller's membership — the `invite_id` in the request is
never trusted alone, or anyone signed in could spray mail from the verified domain.

`EMAIL-SETUP.md` covers this and the separate Supabase SMTP configuration that password-reset
mail uses. They are two different systems; configuring one does nothing for the other.

### Account self-service
`AccountSection` in Settings lets a person change their **display name** (`profiles.full_name`,
which `update own profile` already allows) and their **password** while signed in, with no
email round-trip. The forgot-password flow on the sign-in screen is separate and predates this.

Changing an **email address is deliberately not offered** — invites and memberships are keyed
to the address, so changing it would orphan both. Settings says that in words rather than
showing a control that half-works. If it's ever wanted it needs a real migration that moves
`invites.email` and re-points memberships, not a client-side `updateUser`.

### Testing the SQL
RLS bugs are silent and dangerous, so the policies are tested against a real Postgres rather
than eyeballed. The approach that works: run a local `postgres`, create an `auth` schema
shim (`auth.users`, `auth.uid()`, `auth.jwt()` reading `request.jwt.claims`) plus an
`authenticated` role, apply both SQL files, then `set role authenticated` and switch identity
between users to assert who can see and change what. Superuser bypasses RLS entirely — if
you forget `set role`, every test will pass and prove nothing.

## Data model (the `data` blob)

```
settings      { income, hours }                      // Owner Hour Value = income / hours
dayThemes     { mon..sun: string }                   // global, headline every week
categories    [string]                               // Capture/Maybe category list, user-editable in Settings
taskTypeLabels { TASK_TYPE_KEY: string }              // display label per fixed Task Type key, user-editable
team          [{ id, name }]                         // people you delegate to (labels only, no login)
captures      [{ id, date, item, category, taskType, details, status, dest, due, time, assignee }]
dailyBackup   [{ id, text, tag, taskType, due, time, assignee }]   // global pool
weeklySomeday [{ id, text, tag, due, time }]          // global pool
daily         { "YYYY-MM-DD": { outcome, priorities[3], marks[3], blocks{}, actual{}, closure{score,ate,family}, routineDone{itemId:bool} } }
weekly        { "weekMondayISO": { grid{ "slot|day": text }, nonneg{focus,review,family}, somedayDone{itemId:bool} } }
monthly       { "YYYY-M": { days{ n: text }, buffers[] } }
monthlyTray   [{ id, text, tag }]                    // MONTHLY captures waiting to be placed on a date
recurringMonthly [{ id, text, tag, day, time }]       // day-of-month templates, auto-filled into every future month
maybe         [{ id, added, item, category, revisit, decision }]
reference     [{ id, text, note }]
```

`due`/`time` are optional date/time fields settable on any capture (not just SCHEDULE) and carry
through to dailyBackup/weeklySomeday on transfer. `assignee` (a name from `team`) is meant for
DELEGATE/WAITING-FOR items; the Follow-up tab lists dailyBackup items of those two types grouped
by assignee, for chasing until resolved.

`dueItemsByDate()` indexes every capture/dailyBackup/weeklySomeday/monthlyTray item with a `due`
by that exact date, so a due date set anywhere in Capture surfaces automatically in Daily ("Due
today"), Weekly ("Due this week", grouped by day), and Monthly (a badge on that day's cell) —
purely as read-only reference badges. It never writes into `daily.blocks`, `weekly.grid`, or
`monthly.days` — those stay hand-typed — to avoid fighting the user's own edits there.

A specific `time` additionally places the item into its matching hour slot (`dailySlotItems()` /
`weeklySlotItems()`, mapping HH:MM → the DAILY_SLOTS/WEEK_SLOTS row whose range contains it) so it
shows up right in the Daily "Plan" column and the Weekly grid cell, not just the summary panels.
Same read-only-badge rule applies — never written into the editable cell itself.

Recurrence is handled differently per task type, matching how each pool already behaves:
- DAILY/WEEKLY items stay in dailyBackup/weeklySomeday forever (global pools, never consumed), so
  they're already "recurring" — the Daily/Weekly views split them into their own "repeats every
  day/week" checklist and track completion in `routineDone`/`somedayDone`, keyed by item id inside
  that specific day/week's record. Checking one off doesn't remove it from the pool, so it reverts
  to unchecked (available again) the next day/week automatically — no separate reset logic needed.
  DAILY items with a `time` also appear in every day's matching slot; WEEKLY items with a `due` set
  recur on that day-of-week (`dayOfWeekKey(due)`) every week, at `time`, in both Daily and Weekly.
- MONTHLY items are different: placing a monthlyTray item on a date used to consume it. Placing one
  now also drops a `{id, text, tag, day, time}` template into `recurringMonthly`; MonthlyView
  backfills that day-of-month into whatever month is currently being viewed, and Daily/Weekly show
  it in the matching slot on the day(s) it lands on.

Every dailyBackup/weeklySomeday/monthlyTray item — including routine/recurring ones — is editable
after Transfer via `BackupItemRow` (shared component): click the text or the ✎ to reveal every
field (text, category, task type, due date/time, assignee), "Done" to collapse. `recurringMonthly`
templates get their own small editor (`RecurringMonthlyRow`) since their shape differs (`day`
instead of `due`). Maybe/Reference item text is a plain controlled input now too, editable inline
like their other fields already were.

dailyBackup/weeklySomeday/monthlyTray items also carry an optional `done` bool. `BackupItemRow`
shows a done-toggle for them everywhere except the routine/recurring checklists (those already have
their own day/week-scoped completion via `routineDone`/`somedayDone` — a second checkbox there would
be redundant). Marking done never removes the item or hides it — it just renders struck-through,
per the "should still show but as done" requirement; the overdue/due-today red banner
(`collectDueItems`) does skip done items, since flagging a finished task as overdue would be noise.
Daily's "Backup list" excludes any dailyBackup item that has both a `due` and a `time` set — once
something is fully scheduled it shows in "Due today" and its matching Plan slot instead, since the
flexible backup pool is meant for work that doesn't have a fixed time yet. Those Plan-slot badges
are interactive for anything traceable back to dailyBackup/weeklySomeday/monthlyTray (edit and
done-toggle, via the same `BackupItemRow`); slot items that only exist through recurrence
(DAILY/WEEKLY/MONTHLY templates, which don't have a single due-dated instance) stay read-only badges.

### Overdue section (Daily, Weekly)
`overdueEntries(data)` derives from `dueItemsByDate()` — every entry whose key is before
`todayKey()`, filtered to `!done` — so it needed no new state and no SQL. It's rendered by
`OverduePanel` at the top of both `DailyView` and `WeeklyView`, above the existing "Due
today"/"Due this week" panels, in rose to read as urgent rather than informational.

Items are chips shared via `DueChips` (`tone="rose"` for Overdue, `tone="sky"` for the
pre-existing due-today/due-this-week panels — same component, just the color and whether the
date prefix or the time prefix shows). A chip is clickable and toggles `done` in place when its
`source` traces back to `dailyBackup`/`weeklySomeday`/`monthlyTray` (via the shared
`SOURCE_ARRAY`/`updateSourceItem`, hoisted out of `DailyView` so `WeeklyView` can reuse them
too); a capture still sitting in the inbox has no `done` flag of its own, so it renders as a
plain read-only badge, same rule as the "Due today" chips already followed.

Marking an overdue item done removes it from the Overdue panel — deliberately different from
the Backup-list rule that a done item never disappears. The two views answer different
questions: the Backup list is "what's in the pool" (a done item still belongs there, struck
through); the Overdue panel is "what needs action" (a done item no longer does). It still shows,
struck through, wherever else it already rendered (Backup list, Due-today, the slot chart).

The old top-of-every-page `DueBanner` (plain comma-joined names, no interaction) is suppressed
on the `daily`/`weekly` tabs specifically (`tab!=="daily" && tab!=="weekly"`) now that those two
have their own richer, actionable version — showing both would be the same information twice in
two different visual styles. It still renders on every other tab (Capture, Monthly, Maybe,
Reference, Settings, …), which have no dedicated overdue view of their own.

Daily's selected date (`dk`) is lifted up to `Planner` (`dailyDate`/`setDailyDate`), not local state
inside `DailyView`, specifically so `MonthlyView`'s day-number buttons can jump straight to that day
(`onGoToDay` sets the shared date and switches `tab` to `"daily"` in one call).

### Customizing categories and task types
`categories` (Settings) is fully user-editable — add, rename, or remove freely. Renaming cascades
into `captures[].category` and `maybe[].category` so nothing goes stale; removing only stops
offering it for new items. `TASK_TYPES`/`TYPE_HELP` stay a fixed 12-key `const` — those keys drive
the Transfer routing switch, DAILY/WEEKLY recurrence detection, and Follow-up's DELEGATE/WAITING-FOR
filter, so they can't be renamed or removed without breaking that logic. `taskTypeLabels` (Settings)
only overrides the *display text* per key — every render site does
`(data.taskTypeLabels||DEFAULT_TASK_TYPE_LABELS)[key]||key` rather than printing the raw key.

`team` is a flat label list scoped to the signed-in
user's own account — there is no separate login or cross-account visibility for team members (see
Guardrails: this is intentionally not the "real multi-user" architecture from the roadmap).

### Transfer routing (manual — never automatic)
Nothing leaves Capture until the user presses **Transfer**. On transfer the item routes by its
Task Type: SCHEDULE/DAILY/WAITING/WAITING-FOR/PROJECT/DELEGATE → dailyBackup · WEEKLY → weeklySomeday ·
MONTHLY → monthlyTray · MAYBE → maybe · REFERENCE/AUTOMATE → reference · DELETE → removed.

## Conventions

- **Design:** slate-900 cockpit header, amber-400 accent, amber-50 = editable ("yellow cell") fields.
  Keep the Hinglish coaching callouts ("Likh do — dimaag chhod dega", etc.) — they're intentional.
- **Icons:** unicode glyphs via the `ICON`/`Ic` helper. No icon library (keeps it single-file).
- **State:** one `data` object; mutate via `patch(fn)` which deep-clones then applies. Debounced save.
- **Tailwind:** loaded via the Play CDN, so arbitrary values are fine here (unlike the Claude artifact env).
- Backup and Someday are **global pools** by design, so tasks don't vanish when the date changes.
- `SEED` is a genuinely blank starting state (no demo captures) — it's what new sign-ups start
  from and what `loadState`'s missing-key merge falls back to. Settings > Danger zone > "Clear all
  my data" upserts it straight into the user's Supabase row (not just local state), for a real
  reset. There is no "reset to seed demo content" option — don't reintroduce one.

## Company layer (client side)

`Root` loads `loadOrgContext(userId, email)` once per signed-in user and routes on the result:

- **membership found** → straight into `Planner`, which gets `orgCtx` and shows the extra tabs.
- **no membership** → `OnboardingScreen`: accept a pending invite, create a company, or
  "just me for now". The solo choice is remembered in `localStorage` (`cc-solo-mode`) so
  returning solo users aren't nagged; Settings → Company can undo it either way.
- **the lookup throws** (typically: Phase 1 SQL hasn't been run) → `degraded: true`, and the
  user drops into their personal planner instead of a dead screen. Keep that fallback; it's
  the difference between "companies aren't set up yet" and "the app is broken".

Tabs are role-gated in `Planner`: **Dashboard** for owner+manager, **Team** for owner only.
That gating is a UX convenience, *not* the security boundary — the real boundary is RLS.
`PeopleView` (the Dashboard) deliberately re-applies the same visibility rule client-side when
building its roster, purely so it never offers a row the server will then refuse.

## Rollup metrics (Phase 2)

`loadAllVisiblePlanners()` issues a bare `select user_id, data from planner_state` — **no
client-side filter on purpose**, because the `can_view_planner` policy already returns exactly
the rows this user may read. The server does the scoping; the client just aggregates.

`personMetrics(plan, dayKeys)` derives everything from data the planner already stores:

| Metric | Derived from |
|---|---|
| Days planned | `daily[k].outcome` non-empty |
| Priority completion | `daily[k].marks[i]` — done / moved / delegated / dropped over priorities actually set |
| Avg day score | `daily[k].closure.score`, over days that count as closed |
| Non-negotiables | `weekly[monday].nonneg` across the weeks the period touches |
| Overdue / due today | `collectDueItems(plan)` (already skips `done` items) |
| Waiting on others | open DELEGATE / WAITING-FOR items in `dailyBackup` |

Two judgement calls worth preserving:

- **`closure.score` is ambiguous.** It defaults to `0` and clicking the "0" button also stores
  `0`, so the number alone can't distinguish "never closed out" from "genuinely a zero day".
  `dayWasClosed()` resolves it by requiring some *other* trace of the ritual (score > 0, or
  text in `ate`/`family`). Unclosed days are excluded from the average rather than counted as
  zero, and the UI says so in plain language — don't silently change that to counting zeros,
  it would make every team's score look worse than reality.
- **No "how long has this been delegated" metric.** `dailyBackup` items carry no created-at
  timestamp, so age is genuinely uncomputable. Open and overdue counts are shown instead. If
  age is wanted, add a timestamp at Transfer first — don't infer it.

**Scaling limit, deliberate for now:** the dashboard downloads every visible planner blob and
aggregates in the browser. That's fine for a company of tens; beyond that the fix is a
normalised schema with server-side aggregation, not a bigger download. Don't paper over it
with pagination.

## KRAs and KPIs (Phase 3)

```
kras       (id, org_id, user_id, title, description, sort_order, created_by)
kpis       (id, org_id, user_id, kra_id?, name, unit, target, direction, cadence, created_by)
kpi_values (id, kpi_id, period, actual, note, updated_by)   unique(kpi_id, period)
```

`direction` is `up` (higher is better) or `down` (cost, delay — lower is better); it decides
which side of target is green. `cadence` is `monthly` or `quarterly`, and `period` is
`YYYY-MM` or `YYYY-Qn`, enforced by a check constraint so a typo can't create a stray bucket.

**The access model here deliberately differs from `planner_state`, and that is not a
regression.** A planner is someone's private working space, so writes there stay self-only,
forever. A KRA/KPI is a *target assigned by management*, so:

| Action | Who |
|---|---|
| Define/edit/delete KRAs and KPIs | `can_manage_person()` — owner (anyone in org, incl. self), or the person's own manager. Never self for a manager, never an employee. |
| Read them | `can_view_planner()` — the same rule as planners, reused verbatim |
| Record the actual | the person themselves, **or** their manager/owner |

That last row is the only cross-user write in the app. It's intentional: the person is closest
to the number, and management needs to correct or backfill it. `planner_state` is untouched by
this and there's a regression test asserting an owner still can't edit a planner.

`can_manage_person()` returning false for a manager acting on themselves is deliberate — their
targets come from the owner. An owner can set their own because nobody is above them.

**UI:** the Goals tab is visible to *every* role, unlike Dashboard/Team. Employees need to see
their own targets and report actuals; they just get no person-picker and no editing controls.
`GoalsView` re-applies `can_manage_person` client-side purely to avoid offering controls the
server would refuse.

The month selector drives both cadences: quarterly KPIs resolve to the quarter *containing*
the selected month (`quarterOfMonth`). The Dashboard's KPI column always shows the current
month/quarter regardless of its own 7/30-day selector — mixing a day-range with a KPI period
would be a meaningless number.

Two different "team" concepts coexist on purpose, and the Settings copy says so:
`data.team` is a list of **labels** for delegating on your own board (the original feature),
while `memberships` is **real accounts with logins**. Don't merge them without a migration —
`assignee` on backup items is a name string, not a user id.

## Plans, seats and billing (Phase 4)

```
plans         (code PK, name, seat_limit, price_display, sort_order,
               razorpay_plan_id, stripe_price_id)
subscriptions (org_id PK → organizations, plan_code → plans, status, seats, provider,
               current_period_end, updated_at,
               razorpay_customer_id, razorpay_subscription_id,
               stripe_customer_id, stripe_subscription_id)
```

**Razorpay is the primary provider** (the customers are in India); Stripe is kept, wired and
unused for international expansion later. A plan may carry either ID or both;
`providerForPlan()` in the client prefers Razorpay, falls back to Stripe, and a plan with
neither is simply not buyable ("Not set up for checkout yet"). If routing should ever depend
on where the *buyer* is rather than which ID exists, that needs a country on the org — it is
not a one-line change to `providerForPlan`.

**`subscriptions` has a SELECT policy and no write policy at all — that is the entire
security model here.** The client cannot upgrade itself no matter what it POSTs. The only
writer is the Stripe webhook, using `service_role`, which bypasses RLS. If anyone ever adds
a client write policy to this table "to make testing easier", they have shipped a free
upgrade button to every user. `plans` is the same: readable by anyone signed in, writable by
nobody from the browser.

Seat enforcement is a `before insert` trigger (`check_seat_limit`) on **both** `memberships`
and `invites`, so a pending invite reserves a seat and you can't queue up more invites than
you can pay for. `org_seats_used` = members + unaccepted invites. Accepting an invite is
exempted (it converts a reserved seat into a filled one — counting both would refuse the
last person their own seat). The exception message starts with `SEAT_LIMIT:` purely so
`isSeatLimitError`/`friendlyError` in the client can recognise it and print English instead
of a Postgres error; it's wired into the TeamView invite, the TeamView role change, and the
onboarding accept handler.

Two behaviours that are deliberate and should survive any refactor:

- **Running out of seats blocks adding people. It never removes anyone.** No eviction, no
  hidden data, no lockout from your own planner.
- **A lapsed subscription (`past_due`/`canceled`) falls back to the *free plan's* limit**
  rather than zero, and existing members stay. Verified in the RLS tests: after `past_due`,
  the limit drops to 1 while both members remain and can still read their org.

`price_display` is display text only — it never charges anyone. Stripe is the sole source of
truth for what's actually billed, and `seat_limit`/`seats` is the only number the app
enforces. `seats` on a subscription overrides the plan's `seat_limit` for that one company
(custom deals); `null` means "use the plan's number", and a `null` `seat_limit` is unlimited.

`BillingSection` degrades like Goals does: if the tables aren't there it names
`supabase-phase4-billing.sql` and the rest of Settings keeps working.

### The payment functions (NOT yet verified against any real provider)

`supabase/functions/` holds four: `razorpay-checkout`, `razorpay-webhook`, `stripe-checkout`,
`stripe-webhook`. **None has ever been run against a real Razorpay or Stripe account** — all
were written without credentials. Each carries that warning at the top; don't quietly delete
it, and don't describe billing as working end to end until someone has completed a test-mode
purchase. `BILLING-SETUP.md` has the procedure.

Rules both providers follow, and any third one would have to:

- The webhook verifies the signature against the **raw, unparsed** body. Parsing first
  changes the bytes and breaks the check — and without the check the endpoint is a public
  free-upgrade URL. Razorpay's is HMAC-SHA256 hex in `x-razorpay-signature`, compared in
  constant time.
- Checkout **never trusts an `org_id` from the request body**. It reads the caller's own
  membership and requires `role = 'owner'`.
- Both webhooks need `--no-verify-jwt`: the provider has no Supabase JWT, so the signature
  *is* the authentication.
- **Opening checkout grants nothing.** `razorpay-checkout` records the pending subscription
  id so the webhook can be matched later, but never touches `plan_code` or `status`. Only
  the webhook upgrades a company, after the provider confirms. Keep it that way, or loading
  the checkout page becomes a free upgrade.
- The webhook matches on the recorded `razorpay_subscription_id` **first**, falling back to
  `notes.org_id` only if nothing matched — so a forged `notes` payload can't credit someone
  else's company (it would have to clear signature verification first anyway).

Razorpay specifics worth remembering: amounts are in **paise**; `total_count` is mandatory
(there is no "until cancelled" — `RAZORPAY_TOTAL_COUNT`, default 120, stands in for it);
`authenticated` maps to `trialing` on purpose, granting seats slightly early rather than
locking out someone whose mandate is still settling; and `created` is ignored entirely
because it isn't authorised yet. The full status table is in the phase 4b SQL and the setup
doc.

Seats come from the subscription quantity. `razorpay-checkout` bills for seats actually in
use, floored at 1 and capped at the tier's `seat_limit`, so an upgrade can't undercount and
lock an owner out of their own team.

## Platform admin, manual approval, trials (Phase 5)

```
platform_admins (user_id PK → auth.users, email, added_at)
plan_requests   (id, org_id, plan_code, requested_by, note, status, decided_by, decided_at)
```

**Payments are switched off.** `PAYMENTS_ENABLED = false` near the top of `index.html` is the
single switch: it makes `providerForPlan()` return null, so no Choose button renders and no
checkout function is ever called. Owners press **Request this plan** instead, which writes a
`plan_requests` row, and a platform admin approves it in the Admin tab. The Razorpay and
Stripe code paths stay wired and **stay tested** — `billingtest.js` compiles a variant with
the flag on precisely so the routing can't rot while it's dark. Flip the flag once a provider
account is live and a test purchase has cleared; nothing else changes.

### The deliberate exception to "no client writes on billing"

Phases 4/4b say `plans` and `subscriptions` have no client write policy, because a write
policy for `authenticated` is a free upgrade button for every user. **That still holds.** What
Phase 5 adds is narrower: policies guarded by `is_platform_admin()`, which reads `auth.uid()`
and checks it against a table nobody can write from the browser. For an ordinary user the
policy evaluates false and their UPDATE touches zero rows — verified. Routing the same writes
through an Edge Function would trust the very same JWT, so it would be no safer, only harder
to follow. What must never appear is a write policy on these tables *without* the admin guard;
the VERIFY block in the migration fails loudly if one does.

`platform_admins` itself has **no write policy at all** — add or remove an admin by running
SQL deliberately. That table is the root of trust for billing.

**Admin is a billing role, not a master key.** There is deliberately no admin access to
`planner_state`, `kras`, `kpis` or `kpi_values`, and a regression test asserts an admin reads
zero rows from planners. Operating the service doesn't entitle you to read what customers
write in their planners. Don't "helpfully" add it.

### Trials
A trial is just `status='trialing'` plus `current_period_end`. There is no scheduler, so
`org_seat_limit()` treats a trialing subscription whose end date has passed as lapsed and
falls back to the free plan's limit — trials expire themselves. `trialExpired()` in the client
mirrors that exactly, including in the Billing banner: without it `seatLimitOf` would silently
drop a company from 10 seats to 1 while the UI said only "Every seat is taken", which is how
the inconsistency was found.

**Only trials auto-expire.** A paid plan past its `current_period_end` is left alone on
purpose — a late webhook must not downgrade someone who has paid. Paid plans lapse via
`status`, which only the provider's webhook sets.

## Deploy

Static host. Fastest: drag `index.html` to Netlify Drop, or `vercel` from this folder, or upload to Hostinger.
After deploying, add the site URL under Supabase → Authentication → URL Configuration (needed once you
add magic-link or OAuth redirects; email+password works without it).

## Roadmap / good next tasks

The "company OS" build-out was planned in four phases. **All four are done.**

1. ~~**Companies, roles, invites, org-scoped visibility.**~~ Done — see the Database section.
2. ~~**Rollup dashboards.**~~ Done — see "Rollup metrics" above. The Dashboard tab covers
   completion rates, planning discipline, score trends, and delegation load, over
   today / 7 / 30 days, with per-person drill-down.
3. ~~**KRA / KPI module.**~~ Done — see "KRAs and KPIs" above. Held to a number, a target and
   a status colour on purpose. It is **not** a performance-review workflow: no ratings, no
   review cycles, no sign-off, no comment threads. Resist all four — that's a different
   product and it would swallow this one.
4. ~~**Subscription tiers + billing.**~~ Done — see "Plans, seats and billing" above. Seat
   enforcement is live and tested; the payment half ships unconfigured and **unverified**
   (no Razorpay or Stripe account was available), so it needs a test-mode purchase before
   it can be called finished. Proration, dunning, invoicing and tax stay the provider's
   job — don't hand-roll any of them here. GST in particular is a business decision for
   Manish's CA, not app logic.

Other good next tasks:

- **Auth options:** magic-link and/or Google sign-in alongside email+password. (Password reset,
  in-app password change, and invite email are all done.)
- **Split the single file.** Now that there's an org layer, `index.html` is past the size where
  one file is a help rather than a hindrance. Deferred on purpose in Phase 1 so the existing
  zero-build Cloudflare deploy kept working — but a real build step is the right call before
  Phase 3.
- ~~**PWA**~~ / ~~**Import/restore**~~ — both done.

## Guardrails

- Don't commit real Supabase keys or any `.env` to git.
- Keep RLS enabled on every table. Every new table gets its own policies.
- **Never let the client decide who can see what.** Role checks in React are for hiding
  irrelevant UI; every actual restriction has to hold in a Postgres policy, because anyone
  can call the REST API directly with the anon key.
- **Cross-user writes stay closed.** Reading a colleague's plan is a feature; editing it is
  not. If shared editing is ever wanted, that's a deliberate design decision with its own
  policies — not a loosened `using` clause.
- **`subscriptions` and `plans` take no *unguarded* client writes.** The only write policies
  permitted are ones guarded by `is_platform_admin()` (Phase 5); a policy granting
  `authenticated` write access without that guard is a free upgrade button for every user.
  The payment webhook (service_role) is the other writer. Never paste the `service_role` key,
  a Razorpay key secret, or a Stripe secret key anywhere but a Supabase secret.
- **Platform admin never gets planner access.** It's a billing role. No policy on
  `planner_state`, `kras`, `kpis` or `kpi_values` may reference `is_platform_admin()`.
- Test RLS changes against a real Postgres with `set role authenticated` before shipping.
  Superuser bypasses RLS, so an untested policy that "works" locally proves nothing.
- Preserve the manual-transfer rule and the module structure unless Manish asks to change them.
- Solo mode must keep working. Someone with no company should never be blocked, nagged into
  creating one, or lose access to their own planner.
