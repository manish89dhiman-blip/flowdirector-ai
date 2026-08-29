# Billing setup

Seats and plans work **without any payment provider**. Run the SQL and the app
already enforces seat limits — you change a company's plan yourself in Supabase.
A provider is only needed when you want people to pay you with a card,
unattended.

Razorpay is the primary provider because the customers are in India. Stripe is
kept for later, for selling abroad. A plan can carry both IDs; the app sells
each tier through whichever one is filled in, preferring Razorpay.

So this file has three parts. Stop after part 1 if you aren't charging yet.

> **Status:** the Edge Functions in `supabase/functions/` were written without
> access to a Razorpay or Stripe account, so **none of them has ever been run
> against a real payment provider**. The SQL and the seat-limit enforcement
> *have* been tested against a real Postgres. Do part 2 in Razorpay **test
> mode** and complete one full mandate authorisation before touching live keys.

---

## Part 1 — Turn on plans and seat limits

1. Supabase → SQL Editor, in order:
   `supabase-setup.sql` → `supabase-phase1-orgs.sql` → `supabase-phase3-kra-kpi.sql`
   → `supabase-phase4-billing.sql` → `supabase-phase4b-razorpay.sql`.
   Each prints `OK` per item when it worked, and each is safe to re-run.

2. Set your real tiers. The seed rows are placeholders:

   ```sql
   update public.plans set name='Team',     seat_limit=10, price_display='₹399 / person / month' where code='team';
   update public.plans set name='Business', seat_limit=50, price_display='₹349 / person / month' where code='business';
   ```

   `seat_limit` is the only number the app enforces. `price_display` is display
   text — it never charges anyone.

   **Write it per person.** Billing is per seat (see the warning in part 2), so
   a tier labelled "₹2,000 / month" will bill a 6-person company ₹12,000. Say
   "per person" in the label and nobody — including you — misreads it later.

3. Settings → Billing now shows the current plan, `seats used / limit`, and the
   tier list.

### What "out of seats" actually does

It blocks **adding** people — a new invite or membership is refused. It never
removes anyone, hides data, or locks a person out of their own planner. Same
when a subscription lapses: the company drops to the free plan's limit so it
can't grow, but everyone already in it carries on untouched.

### Changing a company's plan by hand

The client **cannot** write to `subscriptions` — there is deliberately no write
policy, so a browser can't upgrade itself. Until a provider is wired up, you do
it in the SQL Editor:

```sql
update public.subscriptions
set plan_code = 'team', seats = 10, status = 'active'
where org_id = (select id from public.organizations where name = 'Acme');
```

`seats` overrides the plan's `seat_limit` for that one company — handy for a
custom deal. Leave it `null` to use the plan's number.

---

## Part 2 — Razorpay (India)

You need a Razorpay account with **Subscriptions** activated. It's a separate
product on the dashboard, not on by default — if you can't see Subscriptions in
the sidebar, that's why, and activation needs KYC to be complete.

### 1. Create the plans in Razorpay

Razorpay → Subscriptions → Plans → create one per paid tier. Two things that
catch people out:

- **The amount is PER SEAT, not per company.** `razorpay-checkout` sends
  `quantity` = the seats the company is using, and Razorpay charges
  `amount × quantity`. So ₹399 on a 6-person company bills ₹2,394/month, not
  ₹399. Decide your per-person number and enter *that*. If you'd rather sell
  flat tiers ("₹2,000/month for up to 10 people"), you have to pin
  `quantity: 1` in `razorpay-checkout/index.ts` — it is not a dashboard
  setting.
- **Amounts are in paise.** ₹399 is `39900`. Getting this wrong by 100× is
  the classic first mistake.
- Pick the billing cycle (monthly/yearly) here; it's fixed on the plan and
  can't be edited afterwards. To change a price you create a new plan.

Copy each plan ID (`plan_xxxxx`) into Supabase:

```sql
update public.plans set razorpay_plan_id = 'plan_xxxxx' where code = 'team';
```

A tier only shows a **Choose** button once it has a provider ID. That's the
switch that makes it buyable.

### 2. Deploy the functions

```bash
supabase link --project-ref YOUR-PROJECT-REF
supabase functions deploy razorpay-checkout
supabase functions deploy razorpay-webhook --no-verify-jwt
```

`--no-verify-jwt` on the webhook is **required**: Razorpay calls it, not a
signed-in user, so there's no Supabase JWT to check. The signature is the
authentication there — which is why signature verification in that function is
not optional.

### 3. Set the secrets

From Razorpay → Settings → API Keys (generate test keys first):

```bash
supabase secrets set RAZORPAY_KEY_ID=rzp_test_xxxxx
supabase secrets set RAZORPAY_KEY_SECRET=xxxxx
supabase secrets set APP_ORIGIN=https://your-site.com
```

`SUPABASE_URL`, `SUPABASE_ANON_KEY` and `SUPABASE_SERVICE_ROLE_KEY` are
injected automatically — don't set them, and never put the service_role key or
the Razorpay key secret anywhere near `index.html`.

Optional: `RAZORPAY_TOTAL_COUNT` (default 120). Razorpay subscriptions
**require** a cycle count — there is no "until cancelled" — so 120 monthly
cycles stands in for it. If you sell yearly plans, set this to something like
10 instead, or customers get a 120-year subscription.

### 4. Register the webhook

Razorpay → Settings → Webhooks → Add New Webhook:

```
https://YOUR-PROJECT-REF.supabase.co/functions/v1/razorpay-webhook
```

You **choose** the secret yourself here (unlike Stripe, which generates one).
Use a long random string, then:

```bash
supabase secrets set RAZORPAY_WEBHOOK_SECRET=the-same-string
```

Subscribe to these events:

- `subscription.authenticated`
- `subscription.activated`
- `subscription.charged`
- `subscription.pending`
- `subscription.halted`
- `subscription.cancelled`
- `subscription.completed`
- `subscription.paused`
- `subscription.resumed`

### 5. How Razorpay states map onto ours

The webhook applies this. It's a judgement call, not a lookup table:

| Razorpay | Ours | Why |
|---|---|---|
| `authenticated` | `trialing` | Mandate approved, first charge imminent. Seats are granted slightly early on purpose — forgiving beats locking out someone who has already paid. |
| `active` | `active` | Charging normally. |
| `pending` | `past_due` | A charge failed; Razorpay is retrying. |
| `halted` | `past_due` | Retries exhausted. Growth stops, **nobody loses access**. |
| `paused` | `past_due` | Same treatment. |
| `cancelled` / `completed` / `expired` | `canceled` | Falls back to the free plan's seat limit. |
| `created` | *ignored* | Not yet authorised, so it must grant nothing. |

### 6. Test it before trusting it

Still in test mode:

1. Sign in as a company **owner** → Settings → Billing → **Choose** on a paid
   tier. You should land on a Razorpay-hosted page.
2. Complete the mandate with a test card (Razorpay's docs list the current
   set — `4111 1111 1111 1111` is the usual one; the e-mandate flow may ask
   for a simulated bank approval).
3. Back in Supabase, check the row actually moved:

   ```sql
   select provider, plan_code, status, seats, current_period_end,
          razorpay_subscription_id
   from public.subscriptions;
   ```

   If it didn't change, the webhook is what's wrong. Read its logs with
   `supabase functions logs razorpay-webhook`. A `bad signature` line means
   `RAZORPAY_WEBHOOK_SECRET` doesn't match what you typed into the dashboard.

4. Then check a failure path. Razorpay's dashboard can replay a webhook — send
   a `subscription.halted` and confirm Settings → Billing shows the overdue
   banner **and** the "nobody has lost access" reassurance, and that no member
   was removed.

Only once all of that works: generate live keys, swap both secrets, re-register
the webhook against live mode with a fresh secret, and re-test with a real card
you can refund.

---

## Part 3 — Stripe (only when you sell outside India)

The Stripe functions (`stripe-checkout`, `stripe-webhook`) are already written
and follow the same rules. To bring a tier online internationally, set
`stripe_price_id` on it instead of (or as well as) `razorpay_plan_id`, deploy
those two functions, and set `STRIPE_SECRET_KEY` / `STRIPE_WEBHOOK_SECRET`.

The app prefers Razorpay when a plan has both IDs. If you want to route by
where the *customer* is rather than by which ID exists, that's a real change —
you'd need to know the buyer's country, and the sensible place to decide is
`providerForPlan()` in `index.html` plus a country field on the org.

---

## India-specific things that will bite you

These are business decisions, not code. Get them wrong and the code works
perfectly while the money doesn't.

- **GST.** SaaS sold in India attracts GST (18% at the time of writing).
  Razorpay does **not** compute or file it for you the way Stripe Tax does. You
  either price inclusive of GST or add it to the plan amount, and you still
  have to invoice and file correctly. Talk to your CA before you set prices —
  don't hand-roll tax logic in this app.
- **RBI e-mandate limits.** Recurring card payments in India need additional
  authentication above a per-charge cap (₹15,000 for most categories; verify
  the current figure, RBI has revised it before). Above it, the customer has to
  approve **every** charge, which quietly wrecks the "unattended renewal"
  experience. If a tier would cross that line, consider annual invoicing or
  UPI Autopay / e-NACH instead of card mandates.
- **Mandate authorisation isn't instant.** e-NACH in particular can take days
  to register. That's why `authenticated` maps to `trialing` — the customer
  gets access when they've committed, not when the bank finishes.
- **Refunds and proration are the provider's job.** Razorpay handles the money;
  don't rebuild any of it here.

---

## Things that will bite you, provider-independent

- **The webhook is the only writer.** If you add a client-side write policy to
  `subscriptions` "just to make testing easier", you have shipped a free
  upgrade button to every user. Change plans in the SQL Editor instead.
- **Don't parse the webhook body before verifying it.** The raw bytes are what
  the signature covers; parse and re-serialise first and every event gets
  rejected.
- **Opening a checkout page grants nothing.** `razorpay-checkout` records the
  pending subscription ID but never changes the plan or status — only the
  webhook does, after the provider confirms. Keep it that way.
- **Seats come from the subscription quantity.** The checkout function bills
  for the seats the company is actually using, floored at 1 and capped at the
  tier's limit. Sell a flat-rate plan and you'll want to set `seats` by hand or
  let the plan's `seat_limit` do the work.
