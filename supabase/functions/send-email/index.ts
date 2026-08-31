// ============================================================================
// send-email — Direct Resend Email Dispatcher
// ----------------------------------------------------------------------------
// Sends transactional emails directly via Resend API (api.resend.com/emails)
// ============================================================================

import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, content-type, apikey",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { ...cors, "Content-Type": "application/json" },
  });

const esc = (s: string) =>
  String(s ?? "").replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]!)
  );

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return json({ error: "POST only" }, 405);

  try {
    const payload = await req.json().catch(() => ({}));
    const { type, email, data = {} } = payload;

    if (!type || !email) {
      return json({ error: "type and email are required parameters" }, 400);
    }

    const apiKey = Deno.env.get("RESEND_API_KEY");
    const configuredFrom = Deno.env.get("INVITE_FROM");
    const from = configuredFrom || "FlowDirector <onboarding@resend.dev>";
    const origin = Deno.env.get("APP_ORIGIN") ?? req.headers.get("origin") ?? "https://flowdirector.web.app";

    if (!apiKey) {
      console.error("RESEND_API_KEY is not configured.");
      return json({ sent: false, reason: "resend_api_key_missing" }, 500);
    }

    const admin = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
    );

    let subject = "";
    let html = "";

    if (type === "welcome") {
      const companyName = data.company_name || "Your Workspace";
      const planName = data.plan_name || "Solo Executive";
      const founderName = data.full_name || "Leader";

      subject = `Welcome to FlowDirector — Your 15-Day Trial is Active`;
      html = `
        <div style="font-family:system-ui,-apple-system,sans-serif;max-width:540px;margin:0 auto;padding:24px;background:#fff;border:1px solid #e2e8f0;border-radius:16px;">
          <h2 style="font-size:20px;font-weight:bold;color:#0f172a;">Welcome to FlowDirector, ${esc(founderName)}</h2>
          <p style="font-size:14px;color:#475569;line-height:1.6;">
            Your workspace <b>${esc(companyName)}</b> is active on the <b>${esc(planName)}</b> plan with a 15-day free trial.
          </p>
          <div style="margin:24px 0;">
            <a href="${esc(origin)}" style="background:#0f172a;color:#fff;padding:12px 24px;border-radius:10px;text-decoration:none;font-weight:bold;display:inline-block;">
              Open FlowDirector Workspace →
            </a>
          </div>
          <p style="font-size:12px;color:#94a3b8;margin-top:24px;">FlowDirector · flowdirector.co</p>
        </div>
      `;
    } else if (type === "invite") {
      const orgName = data.org_name || "Your Workspace";
      const inviterName = data.inviter_name || "The Workspace Owner";
      const role = data.role || "team member";
      const inviteLink = data.link || `${origin}/signup?email=${encodeURIComponent(email)}`;

      subject = `${inviterName} invited you to join ${orgName} on FlowDirector`;
      html = `
        <div style="font-family:system-ui,-apple-system,sans-serif;max-width:540px;margin:0 auto;padding:24px;background:#fff;border:1px solid #e2e8f0;border-radius:16px;">
          <h2 style="font-size:20px;font-weight:bold;color:#0f172a;">You're Invited to Join ${esc(orgName)}</h2>
          <p style="font-size:14px;color:#475569;line-height:1.6;">
            <b>${esc(inviterName)}</b> has invited you to join <b>${esc(orgName)}</b> on FlowDirector as a <b>${esc(role)}</b>.
            Your seat is fully covered by your company.
          </p>
          <div style="margin:24px 0;">
            <a href="${esc(inviteLink)}" style="background:#0f172a;color:#fff;padding:12px 24px;border-radius:10px;text-decoration:none;font-weight:bold;display:inline-block;">
              Accept Invitation &amp; Join Workspace →
            </a>
          </div>
          <p style="font-size:13px;color:#64748b;line-height:1.5;">
            Sign up using <b>${esc(email)}</b> (or sign in if you already have an account) and your team workspace will be waiting for you.
          </p>
          <p style="font-size:12px;color:#94a3b8;margin-top:24px;">FlowDirector · Team Delegation &amp; Focus Engine</p>
        </div>
      `;
    } else if (type === "password_reset") {
      const { data: linkData, error: linkErr } = await admin.auth.admin.generateLink({
        type: "recovery",
        email: email,
        options: { redirectTo: `${origin}/#reset-password` },
      });

      if (linkErr) {
        return json({ error: linkErr.message || "Couldn't generate recovery link" }, 400);
      }

      const resetUrl = linkData?.properties?.action_link || `${origin}/#reset-password`;

      subject = `Reset your FlowDirector password`;
      html = `
        <div style="font-family:system-ui,-apple-system,sans-serif;max-width:520px;margin:0 auto;padding:24px;background:#fff;border:1px solid #e2e8f0;border-radius:16px;">
          <h2 style="font-size:20px;font-weight:bold;color:#0f172a;">Reset Your Password</h2>
          <p style="font-size:14px;color:#475569;line-height:1.6;">
            We received a request to reset your password for your FlowDirector account (<b>${esc(email)}</b>). Click below to choose a new password:
          </p>
          <div style="margin:24px 0;">
            <a href="${esc(resetUrl)}" style="background:#0f172a;color:#fff;padding:12px 24px;border-radius:10px;text-decoration:none;font-weight:bold;display:inline-block;">
              Set New Password →
            </a>
          </div>
        </div>
      `;
    } else if (type === "task_delegated") {
      const taskTitle = data.task_title || "New Deliverable";
      const delegatorName = data.delegator_name || "Founder / Leadership";
      const companyName = data.company_name || "Workspace";
      const dueDate = data.due_date || "Today";
      const notes = data.notes || "";
      const memberName = data.member_name || "Team Member";

      subject = `New Deliverable Assigned: ${taskTitle} (Due: ${dueDate})`;
      html = `
        <div style="font-family:system-ui,-apple-system,sans-serif;max-width:540px;margin:0 auto;padding:24px;background:#fff;border:1px solid #e2e8f0;border-radius:16px;">
          <h2 style="font-size:20px;font-weight:bold;color:#0f172a;">Hello ${esc(memberName)},</h2>
          <p style="font-size:14px;color:#475569;line-height:1.6;">
            <b>${esc(delegatorName)}</b> (${esc(companyName)}) has assigned a new deliverable to your Focus Desk.
          </p>
          <div style="background:#f8fafc;padding:16px;border-radius:12px;margin:16px 0;">
            <p style="margin:0 0 8px 0;font-weight:bold;color:#0f172a;">${esc(taskTitle)}</p>
            <p style="margin:0;font-size:13px;color:#d97706;font-weight:bold;">📅 Due: ${esc(dueDate)}</p>
            ${notes ? `<p style="margin:8px 0 0 0;font-size:13px;color:#475569;">${esc(notes)}</p>` : ""}
          </div>
          <div style="margin:24px 0;">
            <a href="${esc(origin)}" style="background:#0f172a;color:#fff;padding:12px 24px;border-radius:10px;text-decoration:none;font-weight:bold;display:inline-block;">
              Open My Focus Desk →
            </a>
          </div>
        </div>
      `;
    } else {
      return json({ error: `Unknown email type: ${type}` }, 400);
    }

    // Dispatch via Resend API
    const res = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        from,
        to: [email],
        subject,
        html,
      }),
    });

    const resData = await res.json().catch(() => ({}));
    if (!res.ok) {
      console.error("Resend API failed:", res.status, resData);
      return json({ sent: false, status: res.status, error: resData?.message || "Resend dispatch failed" }, 502);
    }

    return json({ sent: true, id: resData.id, to: email });
  } catch (e) {
    console.error("send-email execution error:", e);
    return json({ error: (e as Error).message ?? "Email dispatch error" }, 500);
  }
});
