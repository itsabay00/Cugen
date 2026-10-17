// OPTIONAL direct email sending. Nothing in the app needs this: by default "Send to customer" opens the
// advisor's own email app (a mailto: link) — free, no setup, no account.
//
// Only if you later want Resolve to send on its own: add RESEND_API_KEY (and EMAIL_FROM) in
// Vercel → Settings → Environment Variables and redeploy. Until then GET /api/send-email says
// { configured: false } and the app keeps the "Send directly" option hidden.
//
// Swappable: add another branch here (checking for a different env var) and nothing on the frontend
// needs to change — same idea as the AI provider selection in api/claude.js.

async function sendViaResend(apiKey, { to, subject, body }) {
  const from = process.env.EMAIL_FROM || "onboarding@resend.dev";
  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      from,
      to: [to],
      subject: subject || "Re: your inquiry",
      text: body,
    }),
  });
  const data = await res.json().catch(() => ({}));

  if (!res.ok) {
    const message = data && data.message ? data.message : "";
    if (/testing emails|verify a domain|own email/i.test(message)) {
      return {
        ok: false,
        status: res.status,
        code: "sandbox_restricted",
        message:
          "This account can only send to its own address until a sending domain is verified. Add one at resend.com/domains, or send a test to the address you signed up with.",
      };
    }
    if (res.status === 401 || res.status === 403) {
      return { ok: false, status: res.status, code: "invalid_key", message: `The email service rejected the key${message ? ` (“${message}”)` : ""}. Check RESEND_API_KEY in Vercel.` };
    }
    return { ok: false, status: res.status, code: "send_failed", message: message || "Couldn't send the email." };
  }
  return { ok: true, id: data.id };
}

export default async function handler(req, res) {
  const resendKey = (process.env.RESEND_API_KEY || "").trim();

  if (req.method === "GET") {
    res.status(200).json({ configured: Boolean(resendKey) });
    return;
  }

  if (req.method !== "POST") {
    res.setHeader("Allow", "GET, POST");
    res.status(405).json({ error: "Method not allowed", code: "method_not_allowed" });
    return;
  }

  if (!resendKey) {
    res.status(503).json({
      error: "Direct sending isn't set up (it's optional). Use “Open in email app”, or add RESEND_API_KEY in your Vercel project's Environment Variables and redeploy.",
      code: "missing_email_key",
    });
    return;
  }

  const { to, subject, body } = req.body || {};
  if (!to || !body) {
    res.status(400).json({ error: "Missing recipient or message body", code: "bad_request" });
    return;
  }
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(to)) {
    res.status(400).json({ error: "That doesn't look like a valid email address.", code: "bad_request" });
    return;
  }

  try {
    const result = await sendViaResend(resendKey, { to, subject, body });
    if (!result.ok) {
      res.status(result.status || 500).json({ error: result.message, code: result.code });
      return;
    }
    res.status(200).json({ ok: true, id: result.id });
  } catch (err) {
    res.status(502).json({ error: "Couldn't reach the email service. Try again shortly.", code: "upstream_unreachable" });
  }
}
