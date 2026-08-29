// ============================================================================
// stripe-webhook — the ONLY thing that may change a company's plan.
// ----------------------------------------------------------------------------
// !! NOT YET TESTED AGAINST A REAL STRIPE ACCOUNT !!
// Written without Stripe credentials. Drive it with `stripe trigger` in TEST
// mode and confirm the subscriptions row updates before going live.
// See BILLING-SETUP.md.
//
// Two things here are load-bearing; don't "simplify" either one:
//
// 1. SIGNATURE VERIFICATION. Without it this endpoint is a public URL that
//    hands out free upgrades to anyone who can POST JSON. The raw body must be
//    passed to constructEventAsync untouched — parsing it first breaks the
//    signature check.
// 2. SERVICE ROLE. The subscriptions table has no client write policy at all,
//    by design. This function is the only writer, and it uses the service_role
//    key, which bypasses RLS. That key must never leave this function.
//
// Deploy:  supabase functions deploy stripe-webhook --no-verify-jwt
//          (--no-verify-jwt is required: Stripe calls this, not a signed-in
//           user, so there is no Supabase JWT. The Stripe signature is the
//           authentication here.)
// Secrets: supabase secrets set STRIPE_SECRET_KEY=sk_test_...
//          supabase secrets set STRIPE_WEBHOOK_SECRET=whsec_...
// ============================================================================

import Stripe from "https://esm.sh/stripe@14.25.0?target=deno";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";

const STATUS_MAP: Record<string, string> = {
  active: "active",
  trialing: "trialing",
  past_due: "past_due",
  unpaid: "past_due",
  canceled: "canceled",
  incomplete: "past_due",
  incomplete_expired: "canceled",
  paused: "past_due",
};

Deno.serve(async (req) => {
  const stripeKey = Deno.env.get("STRIPE_SECRET_KEY");
  const whSecret = Deno.env.get("STRIPE_WEBHOOK_SECRET");
  if (!stripeKey || !whSecret) {
    console.error("STRIPE_SECRET_KEY or STRIPE_WEBHOOK_SECRET missing");
    return new Response("not configured", { status: 500 });
  }

  const stripe = new Stripe(stripeKey, { apiVersion: "2024-06-20" });
  const sig = req.headers.get("stripe-signature");
  if (!sig) return new Response("missing signature", { status: 400 });

  const raw = await req.text();          // raw, unparsed — required for the check
  let event: Stripe.Event;
  try {
    event = await stripe.webhooks.constructEventAsync(raw, sig, whSecret);
  } catch (e) {
    console.error("bad signature:", (e as Error).message);
    return new Response("bad signature", { status: 400 });
  }

  const admin = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
  );

  // Map a Stripe subscription onto our row. Seats come from the line item
  // quantity so "5 seats" in Stripe means 5 seats in the app.
  const applySubscription = async (subscription: Stripe.Subscription) => {
    const orgId = subscription.metadata?.org_id;
    if (!orgId) { console.error("subscription has no org_id metadata", subscription.id); return; }

    const planCode = subscription.metadata?.plan_code;
    const item = subscription.items?.data?.[0];
    const seats = item?.quantity ?? null;

    const patch: Record<string, unknown> = {
      status: STATUS_MAP[subscription.status] ?? "past_due",
      seats,
      current_period_end: subscription.current_period_end
        ? new Date(subscription.current_period_end * 1000).toISOString()
        : null,
      stripe_customer_id: typeof subscription.customer === "string"
        ? subscription.customer : subscription.customer?.id ?? null,
      stripe_subscription_id: subscription.id,
      updated_at: new Date().toISOString(),
    };
    if (planCode) patch.plan_code = planCode;

    const { error } = await admin.from("subscriptions").update(patch).eq("org_id", orgId);
    if (error) console.error("failed to update subscription for org", orgId, error.message);
  };

  try {
    switch (event.type) {
      case "checkout.session.completed": {
        const session = event.data.object as Stripe.Checkout.Session;
        const orgId = session.client_reference_id ?? session.metadata?.org_id;
        if (orgId && session.subscription) {
          const full = await stripe.subscriptions.retrieve(String(session.subscription));
          // Checkout may not have propagated metadata onto the subscription yet.
          if (!full.metadata?.org_id) {
            full.metadata = { ...(full.metadata ?? {}), org_id: orgId,
                              plan_code: session.metadata?.plan_code ?? "" };
          }
          await applySubscription(full);
        }
        break;
      }
      case "customer.subscription.created":
      case "customer.subscription.updated":
      case "customer.subscription.deleted":
        await applySubscription(event.data.object as Stripe.Subscription);
        break;

      case "invoice.payment_failed": {
        const inv = event.data.object as Stripe.Invoice;
        if (inv.subscription) {
          const full = await stripe.subscriptions.retrieve(String(inv.subscription));
          await applySubscription(full);
        }
        break;
      }
      default:
        // Everything else is ignored on purpose. Returning 200 stops Stripe
        // retrying events we simply don't care about.
        break;
    }
  } catch (e) {
    // 500 tells Stripe to retry, which is what we want for a transient failure.
    console.error("webhook handling failed:", e);
    return new Response("handler error", { status: 500 });
  }

  return new Response(JSON.stringify({ received: true }), {
    status: 200, headers: { "Content-Type": "application/json" },
  });
});
