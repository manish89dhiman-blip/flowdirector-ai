// ============================================================================
// calendar-feed — Live Dynamic iCalendar (WebCal) Subscription Feed
// ----------------------------------------------------------------------------
// Serves an always-live, auto-updating .ics feed for Google Calendar,
// Apple Calendar (Mac & iPhone), and Outlook.
//
// Endpoint: GET https://wvojomugsrcarewmlemy.supabase.co/functions/v1/calendar-feed?u=[userId]
// Webcal:   webcal://wvojomugsrcarewmlemy.supabase.co/functions/v1/calendar-feed?u=[userId]
// ============================================================================

import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, content-type, apikey",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
};

const pad = (n: number) => String(n).padStart(2, "0");

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });

  try {
    const url = new URL(req.url);
    const userId = url.searchParams.get("u") || url.searchParams.get("user_id");

    if (!userId) {
      return new Response("Missing user_id parameter (?u=...)", {
        status: 400,
        headers: { ...cors, "Content-Type": "text/plain" },
      });
    }

    const admin = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
    );

    // Fetch user planner state
    const { data: stateRow, error: stateErr } = await admin
      .from("planner_state")
      .select("data, updated_at")
      .eq("user_id", userId)
      .maybeSingle();

    if (stateErr) {
      console.error("Error fetching planner state:", stateErr);
      return new Response("Error fetching calendar data", { status: 500 });
    }

    const plannerData = stateRow?.data || {};
    const dailyMap = plannerData.daily || {};
    const monthlyMap = plannerData.monthly || {};
    const recurringMonthly = plannerData.recurringMonthly || [];
    const dailyBackup = plannerData.dailyBackup || [];
    const monthlyTray = plannerData.monthlyTray || [];

    const events: string[] = [];
    const nowIso = new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");

    // 1. Iterate through Daily Outcomes, Priorities, and Hourly Blocks
    Object.entries(dailyMap).forEach(([dk, dayObj]: [string, any]) => {
      if (!dk || !dayObj || typeof dayObj !== "object") return;
      const [yr, mo, dy] = dk.split("-").map(Number);
      if (!yr || !mo || !dy) return;

      // 1a. One Main Outcome (★)
      if (dayObj.outcome && String(dayObj.outcome).trim()) {
        const startStr = `${yr}${pad(mo)}${pad(dy)}T090000`;
        const endStr = `${yr}${pad(mo)}${pad(dy)}T100000`;
        events.push([
          "BEGIN:VEVENT",
          `UID:fd-outcome-${userId}-${dk}@flowdirector.co`,
          `DTSTAMP:${nowIso}`,
          `DTSTART:${startStr}`,
          `DTEND:${endStr}`,
          `SUMMARY:★ MAIN OUTCOME: ${String(dayObj.outcome).replace(/\n/g, " ")}`,
          `DESCRIPTION:FlowDirector One Main Outcome for ${dk}.\\nStatus: ${dayObj.marks?.[0] || "Planned"}`,
          "STATUS:CONFIRMED",
          "BEGIN:VALARM",
          "TRIGGER:-PT15M",
          "ACTION:DISPLAY",
          "DESCRIPTION:FlowDirector Reminder: Time to execute your Main Outcome!",
          "END:VALARM",
          "END:VEVENT"
        ].join("\r\n"));
      }

      // 1b. Top 3 Priorities
      (dayObj.priorities || []).forEach((p: string, idx: number) => {
        if (!p || !String(p).trim()) return;
        const startHour = 10 + idx;
        const startStr = `${yr}${pad(mo)}${pad(dy)}T${pad(startHour)}0000`;
        const endStr = `${yr}${pad(mo)}${pad(dy)}T${pad(startHour + 1)}0000`;
        events.push([
          "BEGIN:VEVENT",
          `UID:fd-prio-${userId}-${dk}-${idx}@flowdirector.co`,
          `DTSTAMP:${nowIso}`,
          `DTSTART:${startStr}`,
          `DTEND:${endStr}`,
          `SUMMARY:Priority ${idx + 1}: ${String(p).replace(/\n/g, " ")}`,
          `DESCRIPTION:Priority ${idx + 1} from FlowDirector Daily Cockpit.\\nMark: ${dayObj.marks?.[idx] || "Planned"}`,
          "STATUS:CONFIRMED",
          "BEGIN:VALARM",
          "TRIGGER:-PT10M",
          "ACTION:DISPLAY",
          `DESCRIPTION:Upcoming: Priority ${idx + 1} - ${p}`,
          "END:VALARM",
          "END:VEVENT"
        ].join("\r\n"));
      });

      // 1c. Hourly Planned Blocks
      Object.entries(dayObj.blocks || {}).forEach(([slotTime, text]: [string, any]) => {
        if (!text || !String(text).trim()) return;
        const match = slotTime.match(/(\d{1,2}):(\d{2})\s*(AM|PM)?/i);
        let h = match ? parseInt(match[1], 10) : 9;
        const m = match ? parseInt(match[2], 10) : 0;
        const ampm = match && match[3] ? match[3].toUpperCase() : "";
        if (ampm === "PM" && h < 12) h += 12;
        if (ampm === "AM" && h === 12) h = 0;

        const startStr = `${yr}${pad(mo)}${pad(dy)}T${pad(h)}${pad(m)}00`;
        const endStr = `${yr}${pad(mo)}${pad(dy)}T${pad((h + 1) % 24)}${pad(m)}00`;

        events.push([
          "BEGIN:VEVENT",
          `UID:fd-block-${userId}-${dk}-${h}-${m}@flowdirector.co`,
          `DTSTAMP:${nowIso}`,
          `DTSTART:${startStr}`,
          `DTEND:${endStr}`,
          `SUMMARY:Focus: ${String(text).replace(/\n/g, " ")}`,
          `DESCRIPTION:Planned Focus Block in FlowDirector`,
          "STATUS:CONFIRMED",
          "END:VEVENT"
        ].join("\r\n"));
      });
    });

    // 2. Monthly Fixed Commitments & Buffer Days
    Object.entries(monthlyMap).forEach(([mk, monthObj]: [string, any]) => {
      if (!mk || !monthObj || typeof monthObj !== "object") return;
      const [yr, mo] = mk.split("-").map(Number);
      if (!yr || !mo) return;

      // 2a. Monthly Fixed Commitments
      Object.entries(monthObj.days || {}).forEach(([dayNumStr, text]: [string, any]) => {
        const dy = Number(dayNumStr);
        if (!dy || !text || !String(text).trim()) return;
        const startStr = `${yr}${pad(mo)}${pad(dy)}T093000`;
        const endStr = `${yr}${pad(mo)}${pad(dy)}T103000`;

        events.push([
          "BEGIN:VEVENT",
          `UID:fd-monthly-fixed-${userId}-${mk}-${dy}@flowdirector.co`,
          `DTSTAMP:${nowIso}`,
          `DTSTART:${startStr}`,
          `DTEND:${endStr}`,
          `SUMMARY:📅 MONTHLY COMMITMENT: ${String(text).replace(/\n/g, " ")}`,
          `DESCRIPTION:Fixed Monthly Commitment from Monthly Blueprint`,
          "STATUS:CONFIRMED",
          "BEGIN:VALARM",
          "TRIGGER:-PT15M",
          "ACTION:DISPLAY",
          `DESCRIPTION:Monthly Commitment: ${text}`,
          "END:VALARM",
          "END:VEVENT"
        ].join("\r\n"));
      });

      // 2b. Buffer Days (Protected 0-Meeting Days)
      (monthObj.buffers || []).forEach((dy: number) => {
        if (!dy) return;
        const startStr = `${yr}${pad(mo)}${pad(dy)}T080000`;
        const endStr = `${yr}${pad(mo)}${pad(dy)}T180000`;

        events.push([
          "BEGIN:VEVENT",
          `UID:fd-monthly-buffer-${userId}-${mk}-${dy}@flowdirector.co`,
          `DTSTAMP:${nowIso}`,
          `DTSTART:${startStr}`,
          `DTEND:${endStr}`,
          `SUMMARY:⭐ BUFFER DAY (Protected Zero-Meeting Focus)`,
          `DESCRIPTION:Reserved Buffer Day in FlowDirector — No external meetings. Catch-up, strategy & delegation.`,
          "STATUS:CONFIRMED",
          "END:VEVENT"
        ].join("\r\n"));
      });
    });

    // 3. Recurring Monthly Rules (e.g. TDS on 7th, GSTR-1 on 11th, PF on 15th, GSTR-3B on 20th)
    const curDate = new Date();
    for (let offset = -1; offset <= 6; offset++) {
      const d = new Date(curDate.getFullYear(), curDate.getMonth() + offset, 1);
      const yr = d.getFullYear();
      const mo = d.getMonth() + 1;
      const daysInMonth = new Date(yr, mo, 0).getDate();

      recurringMonthly.forEach((r: any, idx: number) => {
        if (!r || !r.text) return;
        const dy = Math.min(r.day || 1, daysInMonth);
        const timeStr = r.time || "10:00";
        const [hStr, mStr] = timeStr.split(":");
        const h = Number(hStr) || 10;
        const m = Number(mStr) || 0;

        const startStr = `${yr}${pad(mo)}${pad(dy)}T${pad(h)}${pad(m)}00`;
        const endStr = `${yr}${pad(mo)}${pad(dy)}T${pad(h + 1)}${pad(m)}00`;

        events.push([
          "BEGIN:VEVENT",
          `UID:fd-recurring-monthly-${userId}-${yr}-${mo}-${dy}-${idx}@flowdirector.co`,
          `DTSTAMP:${nowIso}`,
          `DTSTART:${startStr}`,
          `DTEND:${endStr}`,
          `SUMMARY:🔁 ${r.tag ? `[${r.tag}] ` : ""}${String(r.text).replace(/\n/g, " ")}`,
          `DESCRIPTION:Monthly Recurring Rule / Tax Event in FlowDirector`,
          "STATUS:CONFIRMED",
          "BEGIN:VALARM",
          "TRIGGER:-PT15M",
          "ACTION:DISPLAY",
          `DESCRIPTION:Recurring Monthly Task: ${r.text}`,
          "END:VALARM",
          "END:VEVENT"
        ].join("\r\n"));
      });
    }

    // 4. Yearly & Statutory Deadlines & Milestones (from dailyBackup & monthlyTray)
    const allDatedItems = [...(Array.isArray(dailyBackup) ? dailyBackup : []), ...(Array.isArray(monthlyTray) ? monthlyTray : [])];
    allDatedItems.forEach((item: any) => {
      if (!item || !item.due || !item.text) return;
      const [yr, mo, dy] = item.due.split("-").map(Number);
      if (!yr || !mo || !dy) return;

      const timeStr = item.time || "10:00";
      const [hStr, mStr] = timeStr.split(":");
      const h = Number(hStr) || 10;
      const m = Number(mStr) || 0;

      const startStr = `${yr}${pad(mo)}${pad(dy)}T${pad(h)}${pad(m)}00`;
      const endStr = `${yr}${pad(mo)}${pad(dy)}T${pad(h + 1)}${pad(m)}00`;
      const icon = item.tag === "Holiday" ? "🎆 " : item.tag === "Finance" ? "📊 " : "📌 ";

      events.push([
        "BEGIN:VEVENT",
        `UID:fd-deadline-${userId}-${item.id || item.due}@flowdirector.co`,
        `DTSTAMP:${nowIso}`,
        `DTSTART:${startStr}`,
        `DTEND:${endStr}`,
        `SUMMARY:${icon}${String(item.text).replace(/\n/g, " ")}`,
        `DESCRIPTION:Annual Milestone / Statutory Deadline in FlowDirector.\\nTag: ${item.tag || "General"}`,
        "STATUS:CONFIRMED",
        "BEGIN:VALARM",
        "TRIGGER:-PT15M",
        "ACTION:DISPLAY",
        `DESCRIPTION:Deadline: ${item.text}`,
        "END:VALARM",
        "END:VEVENT"
      ].join("\r\n"));
    });

    const icsContent = [
      "BEGIN:VCALENDAR",
      "VERSION:2.0",
      "PRODID:-//FlowDirector//Executive Live Calendar Feed//EN",
      "CALSCALE:GREGORIAN",
      "METHOD:PUBLISH",
      "X-WR-CALNAME:FlowDirector Focus Schedule",
      "X-WR-TIMEZONE:Asia/Kolkata",
      "X-WR-CALDESC:Always live synced focus blocks, monthly fixed commitments, buffer days and statutory deadlines from FlowDirector",
      ...events,
      "END:VCALENDAR"
    ].join("\r\n");

    return new Response(icsContent, {
      status: 200,
      headers: {
        ...cors,
        "Content-Type": "text/calendar; charset=utf-8",
        "Content-Disposition": 'inline; filename="flowdirector-live-feed.ics"',
        "Cache-Control": "no-cache, no-store, max-age=0, must-revalidate",
        "Pragma": "no-cache"
      }
    });
  } catch (err) {
    console.error("calendar-feed error:", err);
    return new Response("Internal calendar feed error", { status: 500 });
  }
});
