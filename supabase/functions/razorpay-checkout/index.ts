// ============================================================================
// razorpay-checkout — starts a Razorpay subscription for a company.
// ----------------------------------------------------------------------------
// !! NOT YET TESTED AGAINST A REAL RAZORPAY ACCOUNT !!
// Written without credentials. Run it in Razorpay TEST mode and complete a
// full mandate authorisation before pointing it at live keys.
// See BILLING-SETUP.md.
//
// Why this is server-side: creating a subscription needs the Razorpay KEY
// SECRET. That can never go in index.html — anyone could read it and create
// or refund charges on your account.
//
// Deploy:  supabase functions deploy razorpay-checkout
// Secrets: supabase secrets set RAZORPAY_KEY_ID=rzp_test_xxx
//          supabase secrets set RAZORPAY_KEY_SECRET=xxx
// ============================================================================

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

// Razorpay authenticates with HTTP Basic: key_id as user, key_secret as pass.
const rzp = async (keyId: string, keySecret: string, path: string, body?: unknown) => {
  const res = await fetch(`https://api.razorpay.com/v1${path}`, {
    method: body ? "POST" : "GET",
    headers: {
      Authorization: "Basic " + btoa(`${keyId}:${keySecret}`),
      "Content-Type": "application/json",
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const out = await res.json().catch(() => ({}));
  if (!res.ok) {
    // Razorpay nests the useful bit under error.description.
    throw new Error(out?.error?.description ?? `Razorpay ${path} failed (${res.status})`);
  }
  return out;
};

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return json({ error: "POST only" }, 405);

  try {
    const keyId = Deno.env.get("RAZORPAY_KEY_ID");
    const keySecret = Deno.env.get("RAZORPAY_KEY_SECRET");
    if (!keyId || !keySecret)
      return json({ error: "RAZORPAY_KEY_ID / RAZORPAY_KEY_SECRET are not set" }, 500);

    // --- who is asking? -----------------------------------------------------
    const jwt = (req.headers.get("Authorization") ?? "").replace(/^Bearer\s+/i, "");
    if (!jwt) return json({ error: "Not signed in" }, 401);

    // Client-scoped: RLS applies, so this can only see what the caller may see.
    const asUser = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_ANON_KEY")!,
      { global: { headers: { Authorization: `Bearer ${jwt}` } } },
    );

    const { data: { user }, error: userErr } = await asUser.auth.getUser();
    if (userErr || !user) return json({ error: "Not signed in" }, 401);

    const { plan_code, interval = "monthly" } = await req.json().catch(() => ({}));
    if (!plan_code) return json({ error: "plan_code is required" }, 400);

    // --- may this person buy for this company? ------------------------------
    // Never trust an org_id from the request body. Read the caller's own
    // membership and require that they are the owner.
    const { data: membership } = await asUser
      .from("memberships").select("org_id, role").eq("user_id", user.id).maybeSingle();

    if (!membership) return json({ error: "You are not in a company yet" }, 403);
    if (membership.role !== "owner")
      return json({ error: "Only the company owner can change the plan" }, 403);

    const admin = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    );

    const { data: plan } = await admin
      .from("plans").select("code, name, seat_limit, razorpay_plan_id, razorpay_plan_id_yearly, trial_days")
      .eq("code", plan_code).maybeSingle();

    if (!plan) return json({ error: "Unknown plan" }, 400);

    const isYearly = interval === "yearly";
    const selectedPlanId = isYearly && plan.razorpay_plan_id_yearly ? plan.razorpay_plan_id_yearly : plan.razorpay_plan_id;

    if (!selectedPlanId)
      return json({ error: `Plan "${plan.name}" has no ${interval} Razorpay plan ID configured yet` }, 400);

    // --- seats to bill for --------------------------------------------------
    // Flat plan tier pricing: quantity is always 1 for the whole company seat quota.
    const quantity = 1;

    // --- reuse the Razorpay customer if we already made one -----------------
    const [{ count: memberCount }, { count: inviteCount }, { data: sub }] = await Promise.all([
      admin.from("memberships").select("id", { count: "exact", head: true })
        .eq("org_id", membership.org_id),
      admin.from("invites").select("id", { count: "exact", head: true })
        .eq("org_id", membership.org_id).is("accepted_at", null),
      admin.from("subscriptions").select("razorpay_customer_id")
        .eq("org_id", membership.org_id).maybeSingle(),
    ]);

    let customerId: string | null = sub?.razorpay_customer_id ?? null;
    if (!customerId) {
      try {
        const cust = await rzp(keyId, keySecret, "/customers", {
          email: user.email,
          fail_existing: "0",
          notes: { org_id: membership.org_id },
        });
        customerId = cust?.id ?? null;
      } catch (e) {
        console.error("customer create failed, continuing without one:", (e as Error).message);
      }
    }

    // --- calculate trial period start_at mandate schedule -------------------
    const trialDays = plan.trial_days != null ? Number(plan.trial_days) : 15;
    const startAt = trialDays > 0 ? Math.floor(Date.now() / 1000) + (trialDays * 86400) : undefined;

    // --- create the subscription -------------------------------------------
    // total_count: 120 cycles for monthly (10 yrs), 10 cycles for yearly (10 yrs).
    const totalCount = isYearly 
      ? Number(Deno.env.get("RAZORPAY_YEARLY_TOTAL_COUNT") ?? 10) 
      : Number(Deno.env.get("RAZORPAY_TOTAL_COUNT") ?? 120);

    const subPayload: Record<string, any> = {
      plan_id: selectedPlanId,
      total_count: totalCount,
      quantity,
      customer_notify: 1,
      ...(customerId ? { customer_id: customerId } : {}),
      ...(startAt ? { start_at: startAt } : {}),
      notes: {
        org_id: membership.org_id,
        plan_code: plan.code,
        interval: isYearly ? "yearly" : "monthly",
        trial_days: trialDays,
      },
    };

    const subscription = await rzp(keyId, keySecret, "/subscriptions", subPayload);

    if (!subscription?.short_url)
      return json({ error: "Razorpay did not return a checkout link" }, 502);

    // Record the pending subscription id up front so the webhook can still be
    // matched to this company even if the notes don't come back.
    await admin.from("subscriptions").update({
      provider: "razorpay",
      razorpay_customer_id: customerId,
      razorpay_subscription_id: subscription.id,
      updated_at: new Date().toISOString(),
    }).eq("org_id", membership.org_id);

    // NOTE: no plan/status change here. The company is upgraded only when
    // Razorpay confirms the mandate via webhook — otherwise opening the
    // checkout page would be enough to get a free upgrade.
    return json({ url: subscription.short_url });
  } catch (e) {
    console.error("razorpay-checkout failed:", e);
    return json({ error: (e as Error).message ?? "Checkout failed" }, 500);
  }
});
