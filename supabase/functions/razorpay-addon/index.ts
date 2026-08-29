// ============================================================================
// razorpay-addon — Immediate Prorated Addon Charge for Extra Seats (Option 1)
// ----------------------------------------------------------------------------
// Charges the customer immediately for the remaining days of the current month
// when adding extra seats, and updates future recurring billing quantity.
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

    const jwt = (req.headers.get("Authorization") ?? "").replace(/^Bearer\s+/i, "");
    if (!jwt) return json({ error: "Not signed in" }, 401);

    const asUser = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_ANON_KEY")!,
      { global: { headers: { Authorization: `Bearer ${jwt}` } } },
    );

    const { data: { user }, error: userErr } = await asUser.auth.getUser();
    if (userErr || !user) return json({ error: "Not signed in" }, 401);

    const { extra_seats, price_per_seat = 399 } = await req.json().catch(() => ({}));
    const extraCount = Number(extra_seats);
    if (isNaN(extraCount) || extraCount < 1) {
      return json({ error: "extra_seats must be a positive integer" }, 400);
    }

    const { data: membership } = await asUser
      .from("memberships").select("org_id, role").eq("user_id", user.id).maybeSingle();

    if (!membership) return json({ error: "You are not in a company yet" }, 403);
    if (membership.role !== "owner")
      return json({ error: "Only the company owner can buy additional seats" }, 403);

    const admin = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    );

    const [{ data: sub }, { data: org }] = await Promise.all([
      admin.from("subscriptions").select("*").eq("org_id", membership.org_id).maybeSingle(),
      admin.from("organizations").select("name").eq("id", membership.org_id).maybeSingle(),
    ]);

    const currentSeats = sub?.seats || 10;
    const newTotalSeats = currentSeats + extraCount;

    // --- Calculate Prorated Charge for Remaining Days -----------------------
    const now = new Date();
    const periodEnd = sub?.current_period_end ? new Date(sub.current_period_end) : new Date(now.getTime() + 30 * 86400 * 1000);
    const msRemaining = Math.max(periodEnd.getTime() - now.getTime(), 0);
    const daysRemaining = Math.max(Math.ceil(msRemaining / (1000 * 60 * 60 * 24)), 1);
    const totalDaysInCycle = 30; // Standard monthly billing cycle length

    const fullMonthlyExtraFee = extraCount * Number(price_per_seat);
    const proratedINR = Math.round((daysRemaining / totalDaysInCycle) * fullMonthlyExtraFee);
    const proratedPaise = Math.max(proratedINR * 100, 100); // Razorpay minimum charge is ₹1 (100 paise)

    let addonResult = null;
    if (sub?.razorpay_subscription_id) {
      // 1. Create immediate prorated Addon Charge on active Razorpay subscription
      try {
        addonResult = await rzp(keyId, keySecret, `/subscriptions/${sub.razorpay_subscription_id}/addons`, {
          item: {
            name: `${extraCount} Additional Seat${extraCount > 1 ? "s" : ""} (${daysRemaining} days remaining)`,
            amount: proratedPaise,
            currency: "INR",
            description: `Prorated charge for ${extraCount} extra seat(s) on ${org?.name || "Workspace"}`
          }
        });
      } catch (err) {
        console.error("Razorpay Addon creation failed:", (err as Error).message);
      }

      // 2. Update Razorpay subscription quantity for all future monthly renewals
      try {
        await rzp(keyId, keySecret, `/subscriptions/${sub.razorpay_subscription_id}`, {
          quantity: newTotalSeats
        });
      } catch (err) {
        console.error("Razorpay quantity update failed:", (err as Error).message);
      }
    }

    // 3. Update Supabase subscriptions table seat quota
    const { error: subErr } = await admin.from("subscriptions").upsert({
      org_id: membership.org_id,
      seats: newTotalSeats,
      updated_at: new Date().toISOString(),
    }, { onConflict: "org_id" });

    if (subErr) throw subErr;

    return json({
      success: true,
      extra_seats: extraCount,
      new_total_seats: newTotalSeats,
      days_remaining: daysRemaining,
      prorated_charge_inr: proratedINR,
      razorpay_addon: addonResult
    });

  } catch (e) {
    return json({ error: (e as Error).message || "Addon purchase failed" }, 500);
  }
});
