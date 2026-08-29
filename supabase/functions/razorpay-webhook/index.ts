// ============================================================================
// razorpay-webhook — the ONLY thing that may change a company's plan.
// ----------------------------------------------------------------------------
// !! NOT YET TESTED AGAINST A REAL RAZORPAY ACCOUNT !!
// Written without credentials. Drive it from the Razorpay dashboard's webhook
// test tool in TEST mode and confirm the subscriptions row updates before
// going live. See BILLING-SETUP.md.
//
// Two things here are load-bearing; don't "simplify" either one:
//
// 1. SIGNATURE VERIFICATION. Without it this endpoint is a public URL that
//    hands out free upgrades to anyone who can POST JSON. Razorpay signs the
//    RAW body with HMAC-SHA256 and sends the hex digest in x-razorpay-
//    signature. Parsing the body first and re-serialising it changes the bytes
//    and breaks the check.
// 2. SERVICE ROLE. `subscriptions` has no client write policy at all, by
//    design. This function is the only writer and it uses the service_role
//    key, which bypasses RLS. That key must never leave this function.
//
// Deploy:  supabase functions deploy razorpay-webhook --no-verify-jwt
//          (--no-verify-jwt is required: Razorpay calls this, not a signed-in
//           user, so there is no Supabase JWT. The signature IS the auth.)
// Secrets: supabase secrets set RAZORPAY_WEBHOOK_SECRET=xxx
// ============================================================================

import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";

// See the status-mapping note in supabase-phase4b-razorpay.sql for the
// reasoning behind each of these.
const STATUS_MAP: Record<string, string> = {
  authenticated: "trialing",   // mandate approved, first charge imminent
  active:        "active",
  pending:       "past_due",   // a charge failed, Razorpay is retrying
  halted:        "past_due",   // retries exhausted — stops growth, evicts nobody
  paused:        "past_due",
  cancelled:     "canceled",
  completed:     "canceled",
  expired:       "canceled",
  // 'created' is deliberately absent: not yet authorised, so it grants nothing.
};

const hex = (buf: ArrayBuffer) =>
  Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, "0")).join("");

// Constant-time compare so the signature can't be guessed a byte at a time.
const safeEqual = (a: string, b: string) => {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
};

Deno.serve(async (req) => {
  const secret = Deno.env.get("RAZORPAY_WEBHOOK_SECRET");
  if (!secret) {
    console.error("RAZORPAY_WEBHOOK_SECRET missing");
    return new Response("not configured", { status: 500 });
  }

  const sig = req.headers.get("x-razorpay-signature");
  if (!sig) return new Response("missing signature", { status: 400 });

  const raw = await req.text();          // raw, unparsed — required for the check

  const key = await crypto.subtle.importKey(
    "raw", new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" }, false, ["sign"],
  );
  const expected = hex(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(raw)));
  if (!safeEqual(expected, sig)) {
    console.error("bad signature");
    return new Response("bad signature", { status: 400 });
  }

  let event: any;
  try { event = JSON.parse(raw); }
  catch { return new Response("bad payload", { status: 400 }); }

  const admin = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
  );

  try {
    const subscription = event?.payload?.subscription?.entity;
    if (!subscription) {
      // Not a subscription event. 200 so Razorpay stops retrying something we
      // simply don't care about.
      return new Response(JSON.stringify({ ignored: event?.event ?? "unknown" }), {
        status: 200, headers: { "Content-Type": "application/json" },
      });
    }

    const mapped = STATUS_MAP[subscription.status];
    if (!mapped) {
      return new Response(JSON.stringify({ ignored: subscription.status }), {
        status: 200, headers: { "Content-Type": "application/json" },
      });
    }

    const patch: Record<string, unknown> = {
      provider: "razorpay",
      status: mapped,
      seats: subscription.quantity ?? null,
      current_period_end: subscription.current_end
        ? new Date(subscription.current_end * 1000).toISOString()
        : null,
      razorpay_subscription_id: subscription.id,
      updated_at: new Date().toISOString(),
    };
    if (subscription.customer_id) patch.razorpay_customer_id = subscription.customer_id;

    const planCode = subscription.notes?.plan_code;
    if (planCode) patch.plan_code = planCode;

    // Prefer the subscription id we recorded at checkout; fall back to the
    // org_id in notes. Matching on the id first means a company can't be
    // credited by someone else's forged notes.
    const orgId = subscription.notes?.org_id;
    const byId = await admin.from("subscriptions")
      .update(patch).eq("razorpay_subscription_id", subscription.id).select("org_id");

    if (byId.error) {
      console.error("update by subscription id failed:", byId.error.message);
      return new Response("handler error", { status: 500 });
    }

    if ((byId.data?.length ?? 0) === 0) {
      if (!orgId) {
        console.error("no row matched subscription", subscription.id, "and no org_id in notes");
        return new Response(JSON.stringify({ received: true, matched: false }), {
          status: 200, headers: { "Content-Type": "application/json" },
        });
      }
      const byOrg = await admin.from("subscriptions").update(patch).eq("org_id", orgId);
      if (byOrg.error) {
        console.error("update by org_id failed:", byOrg.error.message);
        return new Response("handler error", { status: 500 });
      }
    }
  } catch (e) {
    // 500 tells Razorpay to retry, which is what we want for a transient fault.
    console.error("webhook handling failed:", e);
    return new Response("handler error", { status: 500 });
  }

  return new Response(JSON.stringify({ received: true }), {
    status: 200, headers: { "Content-Type": "application/json" },
  });
});
