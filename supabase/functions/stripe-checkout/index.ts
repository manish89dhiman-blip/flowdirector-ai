// ============================================================================
// stripe-checkout — creates a Stripe Checkout Session for a company.
// ----------------------------------------------------------------------------
// !! NOT YET TESTED AGAINST A REAL STRIPE ACCOUNT !!
// This was written without access to Stripe credentials. Run it in Stripe TEST
// mode and complete a full purchase before pointing it at live keys. See
// BILLING-SETUP.md for the procedure.
//
// Why this has to be server-side: creating a Checkout Session needs the Stripe
// SECRET key. That key can never go in index.html — anyone could read it and
// charge or refund on your account. This function holds it instead.
//
// Deploy:  supabase functions deploy stripe-checkout
// Secrets: supabase secrets set STRIPE_SECRET_KEY=sk_test_...
// ============================================================================

import Stripe from "https://esm.sh/stripe@14.25.0?target=deno";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";

const cors = {
  "Access-Control-Allow-Origin": Deno.env.get("APP_ORIGIN") ?? "*",
  "Access-Control-Allow-Headers": "authorization, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { ...cors, "Content-Type": "application/json" },
  });

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return json({ error: "POST only" }, 405);

  try {
    const stripeKey = Deno.env.get("STRIPE_SECRET_KEY");
    if (!stripeKey) return json({ error: "STRIPE_SECRET_KEY is not set" }, 500);

    // --- who is asking? -----------------------------------------------------
    const authHeader = req.headers.get("Authorization") ?? "";
    const jwt = authHeader.replace(/^Bearer\s+/i, "");
    if (!jwt) return json({ error: "Not signed in" }, 401);

    // A client-scoped Supabase client: RLS applies, so this can only ever see
    // what the caller is allowed to see.
    const asUser = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_ANON_KEY")!,
      { global: { headers: { Authorization: `Bearer ${jwt}` } } },
    );

    const { data: { user }, error: userErr } = await asUser.auth.getUser();
    if (userErr || !user) return json({ error: "Not signed in" }, 401);

    const { plan_code } = await req.json().catch(() => ({}));
    if (!plan_code) return json({ error: "plan_code is required" }, 400);

    // --- is this person allowed to buy for this company? --------------------
    // Never trust an org_id from the request body. Read the caller's own
    // membership instead, and require that they are the owner.
    const { data: membership } = await asUser
      .from("memberships").select("org_id, role").eq("user_id", user.id).maybeSingle();

    if (!membership) return json({ error: "You are not in a company yet" }, 403);
    if (membership.role !== "owner")
      return json({ error: "Only the company owner can change the plan" }, 403);

    const { data: plan } = await asUser
      .from("plans").select("code, name, stripe_price_id").eq("code", plan_code).maybeSingle();

    if (!plan) return json({ error: "Unknown plan" }, 400);
    if (!plan.stripe_price_id)
      return json({ error: `Plan "${plan.name}" has no Stripe price ID set yet` }, 400);

    // --- reuse the existing Stripe customer if there is one ------------------
    const admin = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    );
    const { data: sub } = await admin
      .from("subscriptions").select("stripe_customer_id").eq("org_id", membership.org_id).maybeSingle();

    const stripe = new Stripe(stripeKey, { apiVersion: "2024-06-20" });
    const origin = Deno.env.get("APP_ORIGIN") ?? req.headers.get("origin") ?? "";

    const session = await stripe.checkout.sessions.create({
      mode: "subscription",
      line_items: [{ price: plan.stripe_price_id, quantity: 1 }],
      customer: sub?.stripe_customer_id ?? undefined,
      customer_email: sub?.stripe_customer_id ? undefined : user.email,
      success_url: `${origin}/?billing=success`,
      cancel_url: `${origin}/?billing=cancelled`,
      // The webhook reads these back to know which company to credit.
      // client_reference_id survives even if metadata is dropped.
      client_reference_id: membership.org_id,
      metadata: { org_id: membership.org_id, plan_code: plan.code },
      subscription_data: {
        metadata: { org_id: membership.org_id, plan_code: plan.code },
      },
    });

    return json({ url: session.url });
  } catch (e) {
    console.error("stripe-checkout failed:", e);
    return json({ error: (e as Error).message ?? "Checkout failed" }, 500);
  }
});
