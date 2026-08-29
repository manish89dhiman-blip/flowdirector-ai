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
    const { email, code } = await req.json().catch(() => ({}));
    if (!email || !code) return json({ error: "email and code are required" }, 400);

    const apiKey = Deno.env.get("RESEND_API_KEY");
    // Fallback to onboarding@resend.dev if custom domain is not yet verified in Resend dashboard
    const configuredFrom = Deno.env.get("INVITE_FROM");
    const from = configuredFrom || "FlowDirector <onboarding@resend.dev>";

    if (!apiKey) {
      return json({ sent: false, reason: "resend_not_configured", code });
    }

    const html = `
      <div style="font-family:system-ui,-apple-system,sans-serif;max-width:480px;margin:0 auto;padding:24px;color:#0f172a;background:#ffffff;border:1px solid #e2e8f0;border-radius:16px">
        <h2 style="font-size:20px;font-weight:800;color:#0f172a;margin-bottom:8px">FlowDirector Verification Code</h2>
        <p style="font-size:14px;color:#475569;line-height:1.5">
          Use the 6-digit security code below to verify your email address:
        </p>
        <div style="margin:24px 0;padding:16px;background:#f8fafc;border:1px solid #cbd5e1;border-radius:12px;text-align:center">
          <span style="font-family:monospace;font-size:32px;font-weight:900;letter-spacing:6px;color:#0f172a">${code}</span>
        </div>
        <p style="font-size:12px;color:#64748b;font-medium">
          This code expires in 10 minutes. If you did not request this code, you can safely ignore this email.
        </p>
      </div>`;

    const res = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        from,
        to: [email],
        subject: `${code} is your FlowDirector verification code`,
        html,
      }),
    });

    const resBody = await res.json().catch(() => ({}));
    if (!res.ok) {
      console.error("send-otp resend failed:", res.status, resBody);
      // Return code in response so UI can show a fallback hint if Resend domain is unverified
      return json({ sent: false, status: res.status, error: resBody?.message || "Resend API error", code });
    }

    return json({ sent: true, to: email, code });
  } catch (e) {
    console.error("send-otp failed:", e);
    return json({ error: (e as Error).message ?? "Couldn't send OTP" }, 500);
  }
});
