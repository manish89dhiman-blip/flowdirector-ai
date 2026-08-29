# Email setup

There are **two separate email paths**, they use different systems, and getting
one working does nothing for the other:

| What | Sent by | Configure |
|---|---|---|
| Password reset, sign-up confirmation | Supabase Auth | SMTP in Supabase settings — part 1 |
| Team invitations | The `send-invite` Edge Function | Resend — part 2 |

Both are optional. Without part 1 password resets still send, just through
Supabase's shared sender (rate-limited, often lands in spam). Without part 2
invites still work exactly as before — you copy the link and send it yourself.

> **Status:** the Resend account, the verified sending domain and the invite
> email template are confirmed working — a send was delivered to an
> Outlook/Hotmail inbox. `send-invite` itself is deployed but has not yet been
> invoked by a real owner from the Team tab, so its owner check and invite
> lookup are covered by tests rather than by a live run. Send one real invite
> before telling a customer their team will be emailed.
>
> **`INVITE_FROM` must use a domain whose Resend status is `verified`.** A
> domain still showing `pending` will have every send rejected. Check with
> Resend → Domains before you set the secret.

---

## Part 1 — Password reset and sign-up emails (do this first)

The app already has a full self-service password flow: **Forgot password?** on
the sign-in screen, an emailed link, then a screen that asks for the new
password twice. Signed-in users can also change their password directly in
**Settings → Your account** without any email at all.

The catch is who sends the email. Out of the box that's Supabase's shared
service, which is **rate-limited to a handful of emails per hour** and sends
from a Supabase domain, so it frequently lands in spam. Fine for you testing;
not fine for customers.

### Point Supabase at your own sender

1. Supabase dashboard → **Project Settings → Authentication → SMTP Settings**.
2. Enable custom SMTP and fill in your provider's details. Resend, Brevo,
   Postmark, Amazon SES and plain Gmail SMTP all work. If you're already doing
   part 2, use Resend here too and keep it to one vendor.
3. Set the sender to an address on **your own domain** (`no-reply@yourdomain.com`),
   not Gmail — reset mail from a gmail.com address gets filtered hard.
4. **Project Settings → Authentication → URL Configuration**: set **Site URL** to
   your live site, and add it to **Redirect URLs**. The reset link uses this. Get
   it wrong and people click the link and land nowhere.
5. Send yourself a reset from the live site and confirm it arrives and works.

While you're in Authentication settings, turn on **leaked password protection**
(Authentication → Passwords). It checks new passwords against known breaches.
One toggle, worth having.

---

## Part 2 — Team invitation emails

### How invites work

The owner adds an email in the Team tab. That creates an invite row, and the
person joins by signing in with **that exact address** — the invite is waiting
for them. There is no token in the link: their email address matching the
invite row is what authorises it.

That means the email is genuinely just a convenience. If it doesn't send,
**the invite still works** — the owner just has to pass the site link along.
That fallback is deliberate and tested; don't remove it.

### 1. Get a Resend account

1. Sign up at resend.com (free tier is enough to start).
2. **Add and verify your domain** — DNS records they give you. You can send from
   `onboarding@resend.dev` without a domain for testing, but only to your own
   address, so it's no use for real invites.
3. Create an API key.

### 2. Deploy and configure

```bash
supabase functions deploy send-invite

supabase secrets set RESEND_API_KEY=re_xxxxxxxx
supabase secrets set INVITE_FROM="Command Center <invites@yourdomain.com>"
supabase secrets set APP_ORIGIN=https://your-site.com
```

`INVITE_FROM` must be on the domain you verified with Resend, or every send is
rejected. `APP_ORIGIN` is the link in the email — the app's own address.

Note this function does **not** use `--no-verify-jwt`. Unlike the payment
webhooks, it's called by a signed-in owner, so the JWT is exactly what we want
checked.

### 3. Test it

1. Team tab → invite an address you can read.
2. You should see *"Invited x@y.com — the email is on its way."*
3. If you see *"Email isn't set up yet"*, the function is deployed but
   `RESEND_API_KEY` or `INVITE_FROM` is missing.
4. If you see *"the email didn't go out (…)"*, the send was attempted and
   Resend refused. Check `supabase functions logs send-invite` — nearly always
   an unverified sending domain.

Each pending invite also has **Resend email** and **Copy link** buttons, so a
lost invitation doesn't mean starting over.

---

## Who is allowed to send

Only the **owner** of the company the invite belongs to. The function loads the
invite, reads the caller's own membership, and refuses if the two orgs differ —
the `invite_id` in the request is never trusted by itself. Without that check,
anyone signed in could fire invitation emails from your verified domain at any
address they liked, which is a spam complaint waiting to happen.

The function never creates or edits an invite. Worst case it sends nothing.

---

## Things that will bite you

- **Two systems, two configurations.** Setting up Resend for invites does not
  fix password-reset deliverability. That's Supabase SMTP, part 1.
- **Sending from an unverified domain fails silently to the user** — they get a
  clear message, but nothing arrives. Verify the domain first.
- **Supabase's default auth mail is rate-limited.** If resets stop arriving
  during testing, you've probably hit the cap. That's another reason to do
  part 1 before launch.
- **Changing someone's email address isn't self-service**, on purpose: invites
  and memberships are keyed to the address, so changing it would orphan them.
  Settings says so rather than offering a box that half-works.
