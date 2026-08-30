import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
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

  const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
  const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
  const resendApiKey = Deno.env.get("RESEND_API_KEY");
  const configuredFrom = Deno.env.get("INVITE_FROM");
  const fromEmail = configuredFrom || "FlowDirector <onboarding@resend.dev>";

  const admin = createClient(supabaseUrl, serviceRoleKey);

  try {
    const { action, email, code, user_id, new_email } = await req.json().catch(() => ({}));

    // -------------------------------------------------------------
    // ACTION: SEND OTP
    // -------------------------------------------------------------
    if (action === "send") {
      const targetEmail = (new_email || email || "").toLowerCase().trim();
      if (!targetEmail || !targetEmail.includes("@")) {
        return json({ error: "Please provide a valid email address." }, 400);
      }

      // Generate 6-digit numeric OTP
      const otpCode = Math.floor(100000 + Math.random() * 900000).toString();
      const expiresAt = new Date(Date.now() + 10 * 60 * 1000).toISOString(); // 10 minutes

      // Store in DB
      const { error: dbErr } = await admin.from("otp_verifications").insert({
        email: targetEmail,
        code: otpCode,
        expires_at: expiresAt,
        used: false
      });
      if (dbErr) {
        console.error("Failed to insert OTP:", dbErr);
        return json({ error: "Database error storing verification code." }, 500);
      }

      // Send via Resend directly
      if (!resendApiKey) {
        console.warn("RESEND_API_KEY not configured, mock code:", otpCode);
        return json({ sent: true, mocked: true, code: otpCode });
      }

      const html = `
        <!DOCTYPE html>
        <html>
        <head><meta charset="utf-8"/></head>
        <body style="margin:0;padding:0;background-color:#f8fafc;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;">
          <div style="max-width:520px;margin:32px auto;background:#ffffff;border-radius:24px;border:1px solid #e2e8f0;padding:36px;box-shadow:0 4px 20px rgba(0,0,0,0.04);">
            <div style="display:flex;align-items:center;gap:8px;margin-bottom:24px;">
              <div style="font-size:22px;font-weight:900;letter-spacing:-0.5px;color:#09090b;">FlowDirector</div>
            </div>
            <div style="background:#fef3c7;border:1px solid #fde68a;color:#92400e;font-size:11px;font-weight:800;padding:4px 10px;border-radius:999px;display:inline-block;margin-bottom:16px;text-transform:uppercase;letter-spacing:0.5px;">
              Email Verification
            </div>
            <h1 style="font-size:22px;font-weight:800;color:#09090b;margin:0 0 12px 0;">Verify Your Executive Email</h1>
            <p style="font-size:14px;color:#475569;line-height:1.6;margin:0 0 24px 0;">
              Use the 6-digit confirmation code below to verify your email address on FlowDirector:
            </p>
            <div style="background:#f8fafc;border:2px dashed #cbd5e1;border-radius:16px;padding:20px;text-align:center;margin-bottom:24px;">
              <span style="font-family:ui-monospace,SFMono-Regular,Menlo,Monaco,Consolas,monospace;font-size:36px;font-weight:900;letter-spacing:8px;color:#09090b;">${otpCode}</span>
            </div>
            <p style="font-size:12px;color:#64748b;line-height:1.5;margin:0 0 16px 0;">
              ⏱️ This code will expire in <b>10 minutes</b>. If you did not request this verification, you can safely ignore this email.
            </p>
            <hr style="border:none;border-top:1px solid #f1f5f9;margin:24px 0;"/>
            <p style="font-size:11px;color:#94a3b8;margin:0;">
              FlowDirector · Executive Operating System · Built for high-leverage founders.
            </p>
          </div>
        </body>
        </html>
      `;

      const res = await fetch("https://api.resend.com/emails", {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${resendApiKey}`,
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          from: fromEmail,
          to: [targetEmail],
          subject: `${otpCode} is your FlowDirector verification code`,
          html
        })
      });

      const resBody = await res.json().catch(() => ({}));
      if (!res.ok) {
        console.error("Resend API error:", res.status, resBody);
        return json({ error: resBody?.message || "Failed to dispatch email via Resend." }, 500);
      }

      return json({ sent: true, to: targetEmail });
    }

    // -------------------------------------------------------------
    // ACTION: VERIFY OTP & INSTANT ADMIN UPDATE
    // -------------------------------------------------------------
    if (action === "verify") {
      const targetEmail = (new_email || email || "").toLowerCase().trim();
      const inputCode = (code || "").toString().trim();

      if (!targetEmail || !inputCode) {
        return json({ error: "Email and 6-digit verification code are required." }, 400);
      }

      // Check DB for matching valid OTP
      const { data: records, error: fetchErr } = await admin
        .from("otp_verifications")
        .select("*")
        .eq("email", targetEmail)
        .eq("code", inputCode)
        .eq("used", false)
        .gt("expires_at", new Date().toISOString())
        .order("created_at", { ascending: false })
        .limit(1);

      if (fetchErr) {
        console.error("OTP check query error:", fetchErr);
        return json({ error: "Failed to verify code." }, 500);
      }

      if (!records || records.length === 0) {
        return json({ error: "Invalid or expired 6-digit code. Please check your code or request a new one." }, 400);
      }

      // Mark OTP as used
      await admin
        .from("otp_verifications")
        .update({ used: true })
        .eq("id", records[0].id);

      // Perform Instant Supabase Admin Update
      if (user_id) {
        const updatePayload: Record<string, any> = {
          email_confirm: true
        };
        if (new_email && new_email.toLowerCase().trim() !== (email || "").toLowerCase().trim()) {
          updatePayload.email = new_email.toLowerCase().trim();
        }

        const { error: authUpdateErr } = await admin.auth.admin.updateUserById(user_id, updatePayload);
        if (authUpdateErr) {
          console.error("Admin user update error:", authUpdateErr);
          return json({ error: authUpdateErr.message || "Failed to update user email in auth system." }, 500);
        }

        // Also update public.profiles
        const profileUpdates: Record<string, any> = {
          email_verified: true
        };
        if (new_email) {
          profileUpdates.email = new_email.toLowerCase().trim();
        }

        await admin.from("profiles").update(profileUpdates).eq("id", user_id);
      }

      return json({
        ok: true,
        verified: true,
        email: targetEmail
      });
    }

    return json({ error: "Invalid action. Use 'send' or 'verify'." }, 400);
  } catch (e) {
    console.error("verify-email-otp exception:", e);
    return json({ error: (e as Error).message ?? "Internal Server Error" }, 500);
  }
});
