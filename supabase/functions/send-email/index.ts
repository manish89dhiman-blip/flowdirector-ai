// ============================================================================
// send-email — Direct Resend Email Dispatcher
// ----------------------------------------------------------------------------
// Sends transactional emails directly via the Resend API (api.resend.com/emails)
// without relying on Supabase internal mailers.
//
// Supported types:
//  - "welcome": Welcome to FlowDirector, 15-day trial active, founder message, OHV guide
//  - "training_booked": 1:1 Google Meet strategy call confirmation & calendar link
//  - "password_reset": Secure password recovery link generated via Admin API & sent via Resend
//  - "mandate_active": Mandate authorization confirmation
// ============================================================================

import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";

const cors = {
  "Access-Control-Allow-Origin": Deno.env.get("APP_ORIGIN") ?? "*",
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

function parseSlotUtc(dateStr: string, slotStr: string) {
  let startHour = 11, startMin = 30;
  let endHour = 12, endMin = 0;

  const match = String(slotStr || "").match(/(\d{1,2}):(\d{2})\s*(AM|PM)/i);
  if (match) {
    let h = parseInt(match[1], 10);
    const m = parseInt(match[2], 10);
    const ampm = match[3].toUpperCase();
    if (ampm === "PM" && h < 12) h += 12;
    if (ampm === "AM" && h === 12) h = 0;
    startHour = h;
    startMin = m;

    const endMatch = slotStr.match(/-\s*(\d{1,2}):(\d{2})\s*(AM|PM)/i);
    if (endMatch) {
      let eh = parseInt(endMatch[1], 10);
      const em = parseInt(endMatch[2], 10);
      const eampm = endMatch[3].toUpperCase();
      if (eampm === "PM" && eh < 12) eh += 12;
      if (eampm === "AM" && eh === 12) eh = 0;
      endHour = eh;
      endMin = em;
    } else {
      const totalMin = startHour * 60 + startMin + 30;
      endHour = Math.floor(totalMin / 60) % 24;
      endMin = totalMin % 60;
    }
  }

  const [yr, mo, dy] = (dateStr || new Date().toISOString().slice(0, 10)).split("-").map(Number);
  const startDateIST = new Date(Date.UTC(yr || 2026, (mo || 1) - 1, dy || 1, startHour, startMin, 0));
  const startUTC = new Date(startDateIST.getTime() - 5.5 * 60 * 60 * 1000);
  const endDateIST = new Date(Date.UTC(yr || 2026, (mo || 1) - 1, dy || 1, endHour, endMin, 0));
  const endUTC = new Date(endDateIST.getTime() - 5.5 * 60 * 60 * 1000);

  const formatIsoUtc = (d: Date) => d.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");

  return {
    startUtcStr: formatIsoUtc(startUTC),
    endUtcStr: formatIsoUtc(endUTC),
    isoStart: startUTC.toISOString(),
  };
}

function buildCalendarData(opts: { title: string; description: string; location: string; dateStr: string; slotStr: string }) {
  const { startUtcStr, endUtcStr } = parseSlotUtc(opts.dateStr, opts.slotStr);
  const gcalUrl = `https://calendar.google.com/calendar/render?action=TEMPLATE&text=${encodeURIComponent(opts.title)}&dates=${startUtcStr}/${endUtcStr}&details=${encodeURIComponent(opts.description)}&location=${encodeURIComponent(opts.location)}`;
  const outlookUrl = `https://outlook.live.com/calendar/0/deeplink/compose?path=/calendar/action/compose&rru=addevent&subject=${encodeURIComponent(opts.title)}&startdt=${startUtcStr}&enddt=${endUtcStr}&body=${encodeURIComponent(opts.description)}&location=${encodeURIComponent(opts.location)}`;

  const ics = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//FlowDirector//Executive Strategy Session//EN",
    "CALSCALE:GREGORIAN",
    "METHOD:REQUEST",
    "BEGIN:VEVENT",
    `UID:flowdirector-${Date.now()}@flowdirector.co`,
    `DTSTAMP:${startUtcStr}`,
    `DTSTART:${startUtcStr}`,
    `DTEND:${endUtcStr}`,
    `SUMMARY:${opts.title}`,
    `DESCRIPTION:${opts.description.replace(/\n/g, "\\n")}`,
    `LOCATION:${opts.location}`,
    `URL:${opts.location}`,
    "STATUS:CONFIRMED",
    "BEGIN:VALARM",
    "TRIGGER:-PT15M",
    "ACTION:DISPLAY",
    "DESCRIPTION:Reminder: FlowDirector Strategy Call in 15 minutes!",
    "END:VALARM",
    "BEGIN:VALARM",
    "TRIGGER:-PT1H",
    "ACTION:DISPLAY",
    "DESCRIPTION:Reminder: FlowDirector Strategy Call in 1 hour!",
    "END:VALARM",
    "END:VEVENT",
    "END:VCALENDAR"
  ].join("\r\n");

  return { gcalUrl, outlookUrl, ics };
}

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
    const origin = Deno.env.get("APP_ORIGIN") ?? req.headers.get("origin") ?? "https://flowdirector.co";

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
    let icsAttachment: { filename: string; content: string } | null = null;

    // --------------------------------------------------------------------------
    // 1. WELCOME EMAIL
    // --------------------------------------------------------------------------
    if (type === "welcome") {
      const companyName = data.company_name || "Your Workspace";
      const planName = data.plan_name || "Solo Executive";
      const founderName = data.full_name || "Leader";

      subject = `Welcome to FlowDirector — Your 15-Day Trial is Active`;
      html = `
        <!DOCTYPE html>
        <html>
        <head><meta charset="utf-8"/></head>
        <body style="font-family:system-ui,-apple-system,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;margin:0;padding:24px;background-color:#f8fafc;color:#0f172a;">
          <div style="max-width:560px;margin:0 auto;background:#ffffff;border:1px solid #e2e8f0;border-radius:24px;padding:36px;box-shadow:0 4px 6px -1px rgba(0,0,0,0.05);">
            <div style="margin-bottom:24px;display:flex;align-items:center;gap:12px;">
              <span style="font-size:24px;font-weight:900;letter-spacing:-0.5px;color:#0f172a;">FLOW<span style="color:#d97706;">DIRECTOR</span></span>
            </div>
            
            <div style="background:#fef3c7;border:1px solid #fde68a;border-radius:12px;padding:12px 16px;margin-bottom:24px;">
              <span style="font-size:12px;font-weight:800;color:#92400e;text-transform:uppercase;letter-spacing:0.5px;">✓ 15-Day Executive Trial Activated</span>
            </div>

            <h1 style="font-size:22px;font-weight:800;color:#0f172a;line-height:1.3;margin:0 0 12px 0;">Welcome to Time Domination, ${esc(founderName)}.</h1>
            
            <p style="font-size:15px;line-height:1.6;color:#475569;margin:0 0 16px 0;">
              Your workspace <b>${esc(companyName)}</b> is ready on the <b>${esc(planName)}</b> plan. FlowDirector was built to do one thing: eliminate low-leverage work and direct your focus where your hour value is highest.
            </p>

            <div style="background:#f8fafc;border-left:4px solid #0f172a;padding:16px;border-radius:8px;margin:24px 0;">
              <p style="font-size:14px;font-weight:700;color:#0f172a;margin:0 0 4px 0;">The Core Principle:</p>
              <p style="font-size:13px;color:#475569;margin:0;line-height:1.5;">
                <i>"Jo pehle likha, wahi bachega"</i> — what is scheduled first survives. Calculate your Owner Hour Value (OHV) today and ruthlessly delegate every task priced below it.
              </p>
            </div>

            <div style="margin:32px 0;text-align:center;">
              <a href="${esc(origin)}" style="background:#0f172a;color:#ffffff;text-decoration:none;font-weight:700;font-size:15px;padding:14px 28px;border-radius:14px;display:inline-block;box-shadow:0 4px 12px rgba(15,23,42,0.15);">
                Open FlowDirector Cockpit →
              </a>
            </div>

            <div style="border-top:1px solid #f1f5f9;padding-top:24px;margin-top:32px;">
              <p style="font-size:13px;font-weight:700;color:#0f172a;margin:0 0 6px 0;">Need 1-on-1 Help Setting Up?</p>
              <p style="font-size:13px;color:#64748b;margin:0 0 12px 0;line-height:1.5;">
                You are entitled to a complimentary 20-minute 1-on-1 strategy call with our product implementation specialists over Google Meet.
              </p>
              <a href="${esc(origin)}" style="font-size:13px;font-weight:700;color:#2563eb;text-decoration:none;">
                Book Your Google Meet Call from Cockpit ↗
              </a>
            </div>

            <p style="font-size:12px;color:#94a3b8;margin-top:32px;border-top:1px solid #f1f5f9;padding-top:16px;">
              FlowDirector · Time Domination for Founders & Executives · flowdirector.co
            </p>
          </div>
        </body>
        </html>
      `;
    }

    // --------------------------------------------------------------------------
    // --------------------------------------------------------------------------
    // 2. 1:1 STRATEGY & TRAINING BOOKED EMAIL (with Calendar & .ICS Alarms)
    // --------------------------------------------------------------------------
    else if (type === "training_booked") {
      const scheduledTime = data.scheduled_time || "Soon";
      const topic = data.topic || "Owner Hour Value & Delegation Setup";
      const meetLink = data.meet_link || "https://meet.google.com";
      const notes = data.notes || "";
      const dateStr = data.date_str || "";
      const slotStr = data.slot_str || scheduledTime;
      const coachName = data.coach_name || "Executive Onboarding Specialist";

      const calData = buildCalendarData({
        title: "FlowDirector 1:1 Executive Strategy & Onboarding Call",
        description: `20-minute onboarding strategy call with ${coachName}.\nFocus: ${topic}\nJoin Video Room: ${meetLink}`,
        location: meetLink,
        dateStr,
        slotStr
      });

      if (calData.ics) {
        icsAttachment = {
          filename: "flowdirector-strategy-session.ics",
          content: btoa(calData.ics)
        };
      }

      subject = `Confirmed: 1-on-1 Strategy Call · ${scheduledTime}`;
      html = `
        <!DOCTYPE html>
        <html>
        <head><meta charset="utf-8"/></head>
        <body style="font-family:system-ui,-apple-system,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;margin:0;padding:24px;background-color:#f8fafc;color:#0f172a;">
          <div style="max-width:560px;margin:0 auto;background:#ffffff;border:1px solid #e2e8f0;border-radius:24px;padding:36px;box-shadow:0 4px 6px -1px rgba(0,0,0,0.05);">
            <div style="margin-bottom:24px;display:flex;align-items:center;gap:12px;">
              <span style="font-size:24px;font-weight:900;letter-spacing:-0.5px;color:#0f172a;">FLOW<span style="color:#d97706;">DIRECTOR</span></span>
            </div>

            <div style="background:#ecfdf5;border:1px solid #a7f3d0;border-radius:12px;padding:12px 16px;margin-bottom:24px;">
              <span style="font-size:12px;font-weight:800;color:#065f46;text-transform:uppercase;letter-spacing:0.5px;">✓ 1-on-1 Session Confirmed</span>
            </div>

            <h1 style="font-size:22px;font-weight:800;color:#0f172a;line-height:1.3;margin:0 0 12px 0;">Your Strategy & Onboarding Call is Scheduled</h1>
            
            <p style="font-size:15px;line-height:1.6;color:#475569;margin:0 0 20px 0;">
              In this 20-minute executive session, we will align your monthly KRAs, dial in your Owner Hour Value (OHV), and configure your delegation workflows.
            </p>

            <div style="background:#f8fafc;border:1px solid #e2e8f0;border-radius:16px;padding:20px;margin:24px 0;">
              <div style="margin-bottom:12px;">
                <span style="font-size:11px;font-weight:800;color:#64748b;text-transform:uppercase;letter-spacing:0.5px;display:block;">Scheduled Date & Time</span>
                <span style="font-size:16px;font-weight:800;color:#0f172a;">${esc(scheduledTime)}</span>
              </div>
              <div style="margin-bottom:12px;">
                <span style="font-size:11px;font-weight:800;color:#64748b;text-transform:uppercase;letter-spacing:0.5px;display:block;">Assigned Coach</span>
                <span style="font-size:14px;font-weight:700;color:#0f172a;">${esc(coachName)}</span>
              </div>
              <div style="margin-bottom:12px;">
                <span style="font-size:11px;font-weight:800;color:#64748b;text-transform:uppercase;letter-spacing:0.5px;display:block;">Focus Objective</span>
                <span style="font-size:14px;font-weight:700;color:#0f172a;">${esc(topic)}</span>
              </div>
              ${notes ? `
              <div>
                <span style="font-size:11px;font-weight:800;color:#64748b;text-transform:uppercase;letter-spacing:0.5px;display:block;">Notes / Context</span>
                <span style="font-size:13px;color:#475569;">${esc(notes)}</span>
              </div>` : ""}
            </div>

            <!-- Join Video Room Button -->
            <div style="margin:28px 0;text-align:center;">
              <a href="${esc(meetLink)}" style="background:#059669;color:#ffffff;text-decoration:none;font-weight:700;font-size:15px;padding:14px 28px;border-radius:14px;display:inline-block;box-shadow:0 4px 12px rgba(5,150,105,0.2);">
                📹 Join Video Meeting Room →
              </a>
            </div>

            <!-- 1-Click Calendar Sync Options -->
            <div style="background:#f1f5f9;border-radius:14px;padding:16px;margin:24px 0;text-align:center;">
              <span style="font-size:11px;font-weight:800;color:#475569;text-transform:uppercase;letter-spacing:0.5px;display:block;margin-bottom:10px;">
                📅 1-Click Add to Your Calendar (With Auto-Reminders)
              </span>
              <div style="display:flex;justify-content:center;gap:12px;flex-wrap:wrap;">
                <a href="${esc(calData.gcalUrl)}" target="_blank" style="background:#ffffff;border:1px solid #cbd5e1;color:#1e293b;text-decoration:none;font-weight:700;font-size:12px;padding:8px 16px;border-radius:10px;display:inline-block;">
                  Google Calendar ↗
                </a>
                <a href="${esc(calData.outlookUrl)}" target="_blank" style="background:#ffffff;border:1px solid #cbd5e1;color:#1e293b;text-decoration:none;font-weight:700;font-size:12px;padding:8px 16px;border-radius:10px;display:inline-block;">
                  Outlook / Office 365 ↗
                </a>
              </div>
              <p style="font-size:11px;color:#64748b;margin:10px 0 0 0;">
                Includes automated 1-hour & 15-minute alarms on your phone & laptop. The <b>.ics</b> invite is also attached below.
              </p>
            </div>

            <p style="font-size:13px;color:#64748b;line-height:1.5;margin-top:24px;">
              Need to reschedule or change the time? You can modify your slot anytime right from the <b>Book / Reschedule Training</b> button in your FlowDirector cockpit.
            </p>

            <p style="font-size:12px;color:#94a3b8;margin-top:32px;border-top:1px solid #f1f5f9;padding-top:16px;">
              FlowDirector · Time Domination for Founders & Executives · flowdirector.co
            </p>
          </div>
        </body>
        </html>
      `;
    }

    // --------------------------------------------------------------------------
    // 3. PASSWORD RESET EMAIL (Direct via Resend)
    // --------------------------------------------------------------------------
    else if (type === "password_reset") {
      // Generate secure action recovery link via Supabase Auth Admin API
      const { data: linkData, error: linkErr } = await admin.auth.admin.generateLink({
        type: "recovery",
        email: email,
        options: {
          redirectTo: `${origin}/#reset-password`,
        },
      });

      if (linkErr) {
        console.error("Admin generateLink recovery error:", linkErr);
        return json({ error: linkErr.message || "Couldn't generate recovery link" }, 400);
      }

      const resetUrl = linkData?.properties?.action_link || `${origin}/#reset-password`;

      subject = `Reset your FlowDirector password`;
      html = `
        <!DOCTYPE html>
        <html>
        <head><meta charset="utf-8"/></head>
        <body style="font-family:system-ui,-apple-system,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;margin:0;padding:24px;background-color:#f8fafc;color:#0f172a;">
          <div style="max-width:520px;margin:0 auto;background:#ffffff;border:1px solid #e2e8f0;border-radius:24px;padding:36px;box-shadow:0 4px 6px -1px rgba(0,0,0,0.05);">
            <div style="margin-bottom:24px;display:flex;align-items:center;gap:12px;">
              <span style="font-size:24px;font-weight:900;letter-spacing:-0.5px;color:#0f172a;">FLOW<span style="color:#d97706;">DIRECTOR</span></span>
            </div>

            <h1 style="font-size:20px;font-weight:800;color:#0f172a;line-height:1.3;margin:0 0 12px 0;">Reset Your Password</h1>
            
            <p style="font-size:14px;line-height:1.6;color:#475569;margin:0 0 24px 0;">
              We received a request to reset your password for your FlowDirector account (<b>${esc(email)}</b>). Click the button below to set a new password:
            </p>

            <div style="margin:28px 0;text-align:center;">
              <a href="${esc(resetUrl)}" style="background:#0f172a;color:#ffffff;text-decoration:none;font-weight:700;font-size:15px;padding:14px 28px;border-radius:14px;display:inline-block;box-shadow:0 4px 12px rgba(15,23,42,0.15);">
                Set New Password →
              </a>
            </div>

            <p style="font-size:12px;color:#64748b;line-height:1.5;margin-top:24px;">
              If you did not request a password reset, you can safely ignore this email. Your password will remain unchanged.
            </p>

            <p style="font-size:11px;color:#94a3b8;margin-top:28px;border-top:1px solid #f1f5f9;padding-top:16px;word-break:break-all;">
              Button not working? Copy and paste this link in your browser:<br/>
              <a href="${esc(resetUrl)}" style="color:#64748b;">${esc(resetUrl)}</a>
            </p>
          </div>
        </body>
        </html>
      `;
    }

    // --------------------------------------------------------------------------
    // 4. COACH NOTIFICATION EMAIL (New Session Assigned to Trainer)
    // --------------------------------------------------------------------------
    else if (type === "training_coach_assigned") {
      const coachName = data.coach_name || "Coach";
      const founderName = data.founder_name || "Executive Leader";
      const founderEmail = data.founder_email || "";
      const founderPhone = data.founder_phone || "";
      const companyName = data.company_name || "New Workspace";
      const industry = data.industry || "General";
      const teamSize = data.team_size || "Solo / Team";
      const scheduledTime = data.scheduled_time || "Scheduled Slot";
      const topic = data.topic || "Executive Strategy & Onboarding";
      const notes = data.notes || "";
      const meetLink = data.meet_link || "https://meet.google.com";
      const dateStr = data.date_str || "";
      const slotStr = data.slot_str || scheduledTime;

      const calData = buildCalendarData({
        title: `FlowDirector Coaching: ${founderName} (${companyName})`,
        description: `1:1 Strategy session with ${founderName}.\nCompany: ${companyName}\nPhone: ${founderPhone}\nFocus: ${topic}\nJoin Room: ${meetLink}`,
        location: meetLink,
        dateStr,
        slotStr
      });

      if (calData.ics) {
        icsAttachment = {
          filename: `flowdirector-coaching-${founderName.replace(/[^a-zA-Z0-9]/g, "_")}.ics`,
          content: btoa(calData.ics)
        };
      }

      subject = `New 1:1 Session Assigned: ${founderName} (${companyName}) · ${scheduledTime}`;
      html = `
        <!DOCTYPE html>
        <html>
        <head><meta charset="utf-8"/></head>
        <body style="font-family:system-ui,-apple-system,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;margin:0;padding:24px;background-color:#f8fafc;color:#0f172a;">
          <div style="max-width:560px;margin:0 auto;background:#ffffff;border:1px solid #e2e8f0;border-radius:24px;padding:36px;box-shadow:0 4px 6px -1px rgba(0,0,0,0.05);">
            <div style="margin-bottom:24px;display:flex;align-items:center;gap:12px;">
              <span style="font-size:24px;font-weight:900;letter-spacing:-0.5px;color:#0f172a;">FLOW<span style="color:#d97706;">DIRECTOR</span></span>
            </div>

            <div style="background:#eff6ff;border:1px solid #bfdbfe;border-radius:12px;padding:12px 16px;margin-bottom:24px;">
              <span style="font-size:12px;font-weight:800;color:#1e40af;text-transform:uppercase;letter-spacing:0.5px;">📹 New Coaching Session Assigned</span>
            </div>

            <h1 style="font-size:20px;font-weight:800;color:#0f172a;line-height:1.3;margin:0 0 12px 0;">Hello ${esc(coachName)},</h1>
            
            <p style="font-size:14px;line-height:1.6;color:#475569;margin:0 0 20px 0;">
              A new 1-on-1 Executive Strategy & Onboarding Call has been automatically scheduled with you on FlowDirector.
            </p>

            <div style="background:#f8fafc;border:1px solid #e2e8f0;border-radius:16px;padding:20px;margin:24px 0;">
              <div style="margin-bottom:12px;">
                <span style="font-size:11px;font-weight:800;color:#64748b;text-transform:uppercase;letter-spacing:0.5px;display:block;">Scheduled Date & Time</span>
                <span style="font-size:16px;font-weight:800;color:#0f172a;">${esc(scheduledTime)}</span>
              </div>
              <div style="margin-bottom:12px;">
                <span style="font-size:11px;font-weight:800;color:#64748b;text-transform:uppercase;letter-spacing:0.5px;display:block;">Founder / Executive</span>
                <span style="font-size:15px;font-weight:700;color:#0f172a;">${esc(founderName)} (${esc(companyName)})</span>
              </div>
              <div style="margin-bottom:12px;font-size:13px;color:#334155;">
                <b>Email:</b> <a href="mailto:${esc(founderEmail)}" style="color:#2563eb;">${esc(founderEmail)}</a><br/>
                ${founderPhone ? `<b>Phone / WhatsApp:</b> <a href="https://wa.me/${esc(founderPhone.replace(/\D/g, ''))}" style="color:#059669;font-weight:700;">${esc(founderPhone)} (Message on WhatsApp ↗)</a><br/>` : ""}
                <b>Industry:</b> ${esc(industry)} · <b>Team Size:</b> ${esc(teamSize)}
              </div>
              <div style="margin-bottom:12px;">
                <span style="font-size:11px;font-weight:800;color:#64748b;text-transform:uppercase;letter-spacing:0.5px;display:block;">Focus Objective</span>
                <span style="font-size:14px;font-weight:700;color:#0f172a;">${esc(topic)}</span>
              </div>
              ${notes ? `
              <div>
                <span style="font-size:11px;font-weight:800;color:#64748b;text-transform:uppercase;letter-spacing:0.5px;display:block;">Founder's Notes</span>
                <span style="font-size:13px;color:#475569;">${esc(notes)}</span>
              </div>` : ""}
            </div>

            <div style="margin:28px 0;text-align:center;">
              <a href="${esc(meetLink)}" style="background:#0f172a;color:#ffffff;text-decoration:none;font-weight:700;font-size:15px;padding:14px 28px;border-radius:14px;display:inline-block;box-shadow:0 4px 12px rgba(15,23,42,0.15);">
                📹 Join Video Meeting Room →
              </a>
            </div>

            <!-- 1-Click Calendar Sync Options -->
            <div style="background:#f1f5f9;border-radius:14px;padding:16px;margin:24px 0;text-align:center;">
              <span style="font-size:11px;font-weight:800;color:#475569;text-transform:uppercase;letter-spacing:0.5px;display:block;margin-bottom:10px;">
                📅 1-Click Add to Your Coach Calendar
              </span>
              <div style="display:flex;justify-content:center;gap:12px;flex-wrap:wrap;">
                <a href="${esc(calData.gcalUrl)}" target="_blank" style="background:#ffffff;border:1px solid #cbd5e1;color:#1e293b;text-decoration:none;font-weight:700;font-size:12px;padding:8px 16px;border-radius:10px;display:inline-block;">
                  Google Calendar ↗
                </a>
                <a href="${esc(calData.outlookUrl)}" target="_blank" style="background:#ffffff;border:1px solid #cbd5e1;color:#1e293b;text-decoration:none;font-weight:700;font-size:12px;padding:8px 16px;border-radius:10px;display:inline-block;">
                  Outlook / Office 365 ↗
                </a>
              </div>
            </div>

            <div style="border-top:1px solid #f1f5f9;padding-top:20px;text-align:center;">
              <a href="${esc(origin)}/#coach" style="font-size:13px;font-weight:700;color:#2563eb;text-decoration:none;">
                Open Coach Operations Desk ↗
              </a>
            </div>

            <p style="font-size:12px;color:#94a3b8;margin-top:32px;border-top:1px solid #f1f5f9;padding-top:16px;">
              FlowDirector · Coach Operations & Executive Training System
            </p>
          </div>
        </body>
        </html>
      `;
    }

    // --------------------------------------------------------------------------
    // 5. TRAINING PRE-CALL REMINDER EMAIL (Dispatched to Founder)
    // --------------------------------------------------------------------------
    else if (type === "training_reminder") {
      const scheduledTime = data.scheduled_time || "Today";
      const meetLink = data.meet_link || "https://meet.google.com";
      const coachName = data.coach_name || "Your Executive Coach";
      const founderName = data.founder_name || "Leader";
      const topic = data.topic || "Executive Strategy & Onboarding";

      subject = `Reminder: Your 1-on-1 Strategy Call Starts in 1 Hour (${scheduledTime})`;
      html = `
        <!DOCTYPE html>
        <html>
        <head><meta charset="utf-8"/></head>
        <body style="font-family:system-ui,-apple-system,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;margin:0;padding:24px;background-color:#f8fafc;color:#0f172a;">
          <div style="max-width:540px;margin:0 auto;background:#ffffff;border:1px solid #e2e8f0;border-radius:24px;padding:36px;box-shadow:0 4px 6px -1px rgba(0,0,0,0.05);">
            <div style="margin-bottom:24px;">
              <span style="font-size:24px;font-weight:900;letter-spacing:-0.5px;color:#0f172a;">FLOW<span style="color:#d97706;">DIRECTOR</span></span>
            </div>

            <div style="background:#fef3c7;border:1px solid #fde68a;border-radius:12px;padding:12px 16px;margin-bottom:24px;">
              <span style="font-size:12px;font-weight:800;color:#92400e;text-transform:uppercase;">⏰ Meeting Starting in 1 Hour</span>
            </div>

            <h1 style="font-size:20px;font-weight:800;color:#0f172a;line-height:1.3;margin:0 0 12px 0;">Hello ${esc(founderName)},</h1>
            
            <p style="font-size:14px;line-height:1.6;color:#475569;margin:0 0 20px 0;">
              This is a quick reminder that your 1-on-1 strategy call with <b>${esc(coachName)}</b> is scheduled for <b>${esc(scheduledTime)}</b>.
            </p>

            <div style="background:#f8fafc;border:1px solid #e2e8f0;border-radius:16px;padding:20px;margin:20px 0;">
              <div style="font-size:13px;color:#334155;margin-bottom:8px;">
                <b>Scheduled Slot:</b> ${esc(scheduledTime)}
              </div>
              <div style="font-size:13px;color:#334155;">
                <b>Focus Objective:</b> ${esc(topic)}
              </div>
            </div>

            <div style="margin:28px 0;text-align:center;">
              <a href="${esc(meetLink)}" style="background:#059669;color:#ffffff;text-decoration:none;font-weight:700;font-size:15px;padding:14px 28px;border-radius:14px;display:inline-block;box-shadow:0 4px 12px rgba(5,150,105,0.2);">
                📹 Enter Meeting Room →
              </a>
            </div>

            <p style="font-size:12px;color:#94a3b8;margin-top:32px;border-top:1px solid #f1f5f9;padding-top:16px;">
              FlowDirector · Time Domination for Founders & Executives · flowdirector.co
            </p>
          </div>
        </body>
        </html>
      `;
    }

    // --------------------------------------------------------------------------
    // 5. MANDATE / TRIAL CONFIRMATION EMAIL
    // --------------------------------------------------------------------------
    else if (type === "mandate_active") {
      const planName = data.plan_name || "Solo Executive";
      const interval = data.interval === "yearly" ? "Annual" : "Monthly";

      subject = `Payment Mandate Active — 15-Day Free Trial Confirmed`;
      html = `
        <!DOCTYPE html>
        <html>
        <head><meta charset="utf-8"/></head>
        <body style="font-family:system-ui,-apple-system,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;margin:0;padding:24px;background-color:#f8fafc;color:#0f172a;">
          <div style="max-width:520px;margin:0 auto;background:#ffffff;border:1px solid #e2e8f0;border-radius:24px;padding:36px;box-shadow:0 4px 6px -1px rgba(0,0,0,0.05);">
            <div style="margin-bottom:24px;">
              <span style="font-size:24px;font-weight:900;color:#0f172a;">FLOW<span style="color:#d97706;">DIRECTOR</span></span>
            </div>

            <div style="background:#ecfdf5;border:1px solid #a7f3d0;border-radius:12px;padding:12px 16px;margin-bottom:24px;">
              <span style="font-size:12px;font-weight:800;color:#065f46;text-transform:uppercase;">✓ Razorpay Mandate Active</span>
            </div>

            <h1 style="font-size:20px;font-weight:800;color:#0f172a;margin:0 0 12px 0;">Your 15-Day Free Trial is Confirmed</h1>
            
            <p style="font-size:14px;color:#475569;line-height:1.6;margin:0 0 20px 0;">
              Your recurring ${esc(interval)} subscription for <b>${esc(planName)}</b> is active. No charges have been processed today. Your first billing cycle will begin after your 15-day trial period.
            </p>

            <div style="margin:28px 0;text-align:center;">
              <a href="${esc(origin)}" style="background:#0f172a;color:#ffffff;text-decoration:none;font-weight:700;font-size:15px;padding:14px 28px;border-radius:14px;display:inline-block;">
                Launch Cockpit →
              </a>
            </div>

            <p style="font-size:12px;color:#94a3b8;margin-top:32px;border-top:1px solid #f1f5f9;padding-top:16px;">
              FlowDirector · Time Domination for Founders & Executives · flowdirector.co
            </p>
          </div>
        </body>
        </html>
      `;
    // --------------------------------------------------------------------------
    // 6. TASK DELEGATION NOTIFICATION EMAIL (Dispatched to Team Member)
    // --------------------------------------------------------------------------
    else if (type === "task_delegated") {
      const taskTitle = data.task_title || "New Deliverable";
      const delegatorName = data.delegator_name || "Founder / Leadership";
      const companyName = data.company_name || "Workspace";
      const dueDate = data.due_date || "Today";
      const taskLink = data.link || "";
      const notes = data.notes || "";
      const memberName = data.member_name || "Team Member";

      subject = `New Deliverable Assigned: ${taskTitle} (Due: ${dueDate})`;
      html = `
        <!DOCTYPE html>
        <html>
        <head><meta charset="utf-8"/></head>
        <body style="font-family:system-ui,-apple-system,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;margin:0;padding:24px;background-color:#f8fafc;color:#0f172a;">
          <div style="max-width:540px;margin:0 auto;background:#ffffff;border:1px solid #e2e8f0;border-radius:24px;padding:36px;box-shadow:0 4px 6px -1px rgba(0,0,0,0.05);">
            <div style="margin-bottom:24px;display:flex;align-items:center;gap:12px;">
              <span style="font-size:24px;font-weight:900;letter-spacing:-0.5px;color:#0f172a;">FLOW<span style="color:#d97706;">DIRECTOR</span></span>
            </div>

            <div style="background:#eff6ff;border:1px solid #bfdbfe;border-radius:12px;padding:12px 16px;margin-bottom:24px;">
              <span style="font-size:12px;font-weight:800;color:#1e40af;text-transform:uppercase;letter-spacing:0.5px;">📥 New Task Delegated to You</span>
            </div>

            <h1 style="font-size:20px;font-weight:800;color:#0f172a;line-height:1.3;margin:0 0 12px 0;">Hello ${esc(memberName)},</h1>
            
            <p style="font-size:14px;line-height:1.6;color:#475569;margin:0 0 20px 0;">
              <b>${esc(delegatorName)}</b> (${esc(companyName)}) has assigned a new deliverable to your Focus Desk.
            </p>

            <div style="background:#f8fafc;border:1px solid #e2e8f0;border-radius:16px;padding:20px;margin:24px 0;">
              <div style="margin-bottom:12px;">
                <span style="font-size:11px;font-weight:800;color:#64748b;text-transform:uppercase;letter-spacing:0.5px;display:block;">Deliverable Title</span>
                <span style="font-size:16px;font-weight:800;color:#0f172a;">${esc(taskTitle)}</span>
              </div>
              <div style="margin-bottom:12px;">
                <span style="font-size:11px;font-weight:800;color:#64748b;text-transform:uppercase;letter-spacing:0.5px;display:block;">Due Date</span>
                <span style="font-size:14px;font-weight:700;color:#d97706;">📅 ${esc(dueDate)}</span>
              </div>
              ${taskLink ? `
              <div style="margin-bottom:12px;">
                <span style="font-size:11px;font-weight:800;color:#64748b;text-transform:uppercase;letter-spacing:0.5px;display:block;">Context Link / Document</span>
                <a href="${esc(taskLink)}" target="_blank" style="font-size:13px;font-weight:700;color:#2563eb;word-break:break-all;">${esc(taskLink)} ↗</a>
              </div>` : ""}
              ${notes ? `
              <div>
                <span style="font-size:11px;font-weight:800;color:#64748b;text-transform:uppercase;letter-spacing:0.5px;display:block;">Instructions / Notes</span>
                <span style="font-size:13px;color:#475569;">${esc(notes)}</span>
              </div>` : ""}
            </div>

            <div style="margin:28px 0;text-align:center;">
              <a href="${esc(origin)}" style="background:#0f172a;color:#ffffff;text-decoration:none;font-weight:700;font-size:15px;padding:14px 28px;border-radius:14px;display:inline-block;box-shadow:0 4px 12px rgba(15,23,42,0.15);">
                Open My Focus Desk &amp; Complete Task →
              </a>
            </div>

            <p style="font-size:12px;color:#64748b;line-height:1.5;margin-top:20px;">
              When you complete this task, click <b>[ ✓ Mark as Done &amp; Notify Founder ]</b> in your Focus Desk to automatically resolve it in leadership's radar.
            </p>

            <p style="font-size:12px;color:#94a3b8;margin-top:32px;border-top:1px solid #f1f5f9;padding-top:16px;">
              FlowDirector · Team Delegation &amp; Focus Engine · flowdirector.co
            </p>
          </div>
        </body>
        </html>
      `;
    } else {
      return json({ error: `Unknown email type: ${type}` }, 400);
    }

    // --------------------------------------------------------------------------
    // DISPATCH VIA RESEND API
    // --------------------------------------------------------------------------
    const resendBody: Record<string, unknown> = {
      from,
      to: [email],
      subject,
      html,
    };

    if (icsAttachment) {
      resendBody.attachments = [icsAttachment];
    }

    const res = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(resendBody),
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
