// ============================================================================
// send-invite — emails a pending invite to the person it's for.
// ----------------------------------------------------------------------------
// Dispatches invite emails directly via Resend API
// ============================================================================

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, content-type, apikey",
  "Access-Control-Allow-Methods": "POST, GET, OPTIONS",
};

const esc = (s: string) =>
  String(s ?? "").replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]!)
  );

const ROLE_WORD: Record<string, string> = {
  owner: "an Owner",
  manager: "a Manager",
  employee: "an Employee",
};

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") {
    return new Response(JSON.stringify({ error: "POST only" }), {
      status: 405,
      headers: { ...cors, "Content-Type": "application/json" }
    });
  }

  try {
    // --- who is asking? -----------------------------------------------------
    const jwt = (req.headers.get("Authorization") ?? "").replace(/^Bearer\s+/i, "");
    if (!jwt) return json({ error: "Not signed in" }, 401);

    const asUser = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_ANON_KEY")!,
      { global: { headers: { Authorization: `Bearer ${jwt}` } } },
    );
    const { data: { user }, error: userErr } = await asUser.auth.getUser();
    if (userErr || !user) return json({ error: "Not signed in" }, 401);

    const { invite_id } = await req.json().catch(() => ({}));
    if (!invite_id) return json({ error: "invite_id is required" }, 400);

    // --- may this person send it? -------------------------------------------
    const { data: membership } = await asUser
      .from("memberships").select("org_id, role").eq("user_id", user.id).maybeSingle();
    if (!membership) return json({ error: "You are not in a company" }, 403);
    if (membership.role !== "owner")
      return json({ error: "Only the company owner can send invites" }, 403);

    const admin = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    );

    const { data: invite } = await admin
      .from("invites").select("id, org_id, email, role, accepted_at")
      .eq("id", invite_id).maybeSingle();

    if (!invite) return json({ error: "That invite no longer exists" }, 404);
    // The caller's own org is the authority — not anything they sent us.
    if (invite.org_id !== membership.org_id)
      return json({ error: "That invite belongs to another company" }, 403);
    if (invite.accepted_at)
      return json({ error: "That invite has already been accepted" }, 400);

    // --- is email switched on? ----------------------------------------------
    const apiKey = Deno.env.get("RESEND_API_KEY");
    const from = Deno.env.get("INVITE_FROM") ?? "FlowDirector <hello@flowdirector.co>";
    const origin = Deno.env.get("APP_ORIGIN") ?? req.headers.get("origin") ?? "https://flowdirector.web.app";
    const inviteLink = `${origin}/signup?email=${encodeURIComponent(invite.email)}&invite=${invite.id}`;

    if (!apiKey) {
      // Not an error. The invite is valid and usable; there's just no sender
      // configured, so the app tells the owner to pass the link along.
      return json({ sent: false, reason: "not_configured", link: inviteLink });
    }

    const { data: org } = await admin
      .from("organizations").select("name").eq("id", invite.org_id).maybeSingle();
    const { data: inviter } = await admin
      .from("profiles").select("full_name, email").eq("id", user.id).maybeSingle();

    const orgName   = org?.name ?? "a company";
    const fromName  = inviter?.full_name || inviter?.email || "The owner";
    const roleWord  = ROLE_WORD[invite.role] ?? "a team member";

    // Direct invitation email template with 1-click account setup link
    const html = `
      <div style="font-family:system-ui,-apple-system,Segoe UI,sans-serif;max-width:520px;margin:0 auto;color:#1e293b">
        <p style="font-size:15px">Hello,</p>
        <p style="font-size:15px">
          <b>${esc(fromName)}</b> has invited you to join <b>${esc(orgName)}</b>
          on FlowDirector as ${esc(roleWord)}.
        </p>
        <p style="font-size:15px">
          FlowDirector is a premier executive planning workspace for running your day, your week and your month.
          Your seat is fully covered by ${esc(orgName)}.
        </p>
        <p style="margin:28px 0">
          <a href="${esc(inviteLink)}"
             style="background:#0f172a;color:#fff;padding:12px 22px;border-radius:8px;
                    text-decoration:none;font-size:15px;display:inline-block;font-weight:bold">
            Accept Invitation &amp; Join ${esc(orgName)}
          </a>
        </p>
        <p style="font-size:14px;color:#475569">
          Sign up using <b>${esc(invite.email)}</b> — this exact address — and your workspace
          will be waiting for you. If you already have an account, simply sign in.
        </p>
        <p style="font-size:12px;color:#94a3b8;margin-top:28px">
          Not expecting this? You can ignore this email — nothing has been charged or created for you.
        </p>
      </div>`;

    const res = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        from,
        to: [invite.email],
        subject: `${fromName} invited you to ${orgName} on FlowDirector`,
        html,
      }),
    });

    if (!res.ok) {
      const detail = await res.text().catch(() => "");
      console.error("resend failed:", res.status, detail);
      // The invite itself is fine — say so rather than implying it failed.
      return json({
        sent: false,
        reason: "send_failed",
        error: `The email didn't go out (${res.status}). The invite is still valid.`,
        link: origin,
      });
    }

    return json({ sent: true, to: invite.email });
  } catch (e) {
    console.error("send-invite failed:", e);
    return json({ error: (e as Error).message ?? "Couldn't send the invite" }, 500);
  }
});
