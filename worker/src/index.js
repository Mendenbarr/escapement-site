// Newsletter signup endpoint for escapementgame.com.
// POST /subscribe  — store email (double opt-in), send confirmation via Resend
// GET  /confirm    — ?t=<token> marks the address confirmed
// GET  /unsubscribe — ?t=<token> marks the address unsubscribed
//
// Secrets: RESEND_API_KEY (wrangler secret put RESEND_API_KEY)
// Bindings: DB (D1, schema.sql)

const SITE = "https://escapementgame.com";
const FROM_ADDRESS = "Escapement <newsletter@updates.escapementgame.com>";
const REPLY_TO = "hello@escapementgame.com";
const ALERT_TO = "hello@escapementgame.com";

// Resend's free tier allows 100 emails/day; stay under it so a signup wave
// degrades politely instead of erroring mid-send.
const DAILY_SEND_CAP = 90;
const PER_IP_PER_10MIN = 3;
const RESEND_COOLDOWN_HOURS = 1;

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    try {
      if (request.method === "OPTIONS") return corsResponse(null, 204);
      if (request.method === "POST" && url.pathname === "/subscribe") {
        return await handleSubscribe(request, env);
      }
      if (request.method === "GET" && url.pathname === "/confirm") {
        return await handleConfirm(url, env);
      }
      if (request.method === "GET" && url.pathname === "/unsubscribe") {
        return await handleUnsubscribe(url, env);
      }
      return corsResponse({ ok: false, message: "Not found." }, 404);
    } catch (err) {
      console.error("unhandled error:", err);
      return corsResponse(
        { ok: false, message: "Something went wrong. Try again later." },
        500
      );
    }
  },
};

// --- Subscribe ---

async function handleSubscribe(request, env) {
  const workerOrigin = new URL(request.url).origin;
  const form = await request.formData();
  const email = (form.get("email") || "").trim().toLowerCase();
  const ref = sanitizeRef(form.get("ref"));
  const honeypot = (form.get("website") || "").trim();
  const isFetch = form.get("js") === "1";

  // Bots fill every field; humans never see this one. Pretend success.
  if (honeypot !== "") return subscribeReply(isFetch, true);

  if (!EMAIL_RE.test(email) || email.length > 254) {
    return subscribeReply(isFetch, false, "Enter a valid email address.", 400);
  }

  const ipHash = await hashIp(request.headers.get("CF-Connecting-IP") || "");

  const recentFromIp = await env.DB.prepare(
    "SELECT COUNT(*) AS n FROM subscribers WHERE ip_hash = ? AND created_at > datetime('now', '-10 minutes')"
  ).bind(ipHash).first("n");
  if (recentFromIp >= PER_IP_PER_10MIN) {
    return subscribeReply(isFetch, false, "Too many signups. Try again in a few minutes.", 429);
  }

  const sentToday = await env.DB.prepare(
    "SELECT COUNT(*) AS n FROM subscribers WHERE confirm_sent_at > datetime('now', '-1 day')"
  ).first("n");
  if (sentToday >= DAILY_SEND_CAP) {
    await maybeSendCapAlert(env, sentToday);
    if (isFetch) {
      return corsResponse(
        { ok: false, capped: true, message: "Signups are briefly paused. Try again tomorrow." },
        429
      );
    }
    return Response.redirect(`${SITE}/?signup=error`, 302);
  }

  const existing = await env.DB.prepare(
    "SELECT id, token, confirmed_at, unsubscribed_at, confirm_sent_at FROM subscribers WHERE email = ?"
  ).bind(email).first();

  if (!existing) {
    const token = crypto.randomUUID().replaceAll("-", "");
    const inserted = await env.DB.prepare(
      "INSERT INTO subscribers (email, token, ref, ip_hash) VALUES (?, ?, ?, ?)"
    ).bind(email, token, ref, ipHash).run();
    await sendConfirmationEmail(env, workerOrigin, email, token);
    // Stamped only after a successful send, so a failed send never starts
    // the resend cooldown.
    await markConfirmSent(env, inserted.meta.last_row_id);
    return subscribeReply(isFetch, true);
  }

  // Already confirmed and active: answer generically (never reveal whether an
  // address is on the list).
  if (existing.confirmed_at && !existing.unsubscribed_at) {
    return subscribeReply(isFetch, true);
  }

  // Returning after unsubscribing: fresh token, fresh double opt-in.
  if (existing.unsubscribed_at) {
    const token = crypto.randomUUID().replaceAll("-", "");
    await env.DB.prepare(
      "UPDATE subscribers SET token = ?, ref = ?, confirmed_at = NULL, unsubscribed_at = NULL, confirm_sent_at = NULL WHERE id = ?"
    ).bind(token, ref, existing.id).run();
    await sendConfirmationEmail(env, workerOrigin, email, token);
    await markConfirmSent(env, existing.id);
    return subscribeReply(isFetch, true);
  }

  // Unconfirmed: re-send at most once per cooldown window.
  const cooledDown = await env.DB.prepare(
    "SELECT COUNT(*) AS n FROM subscribers WHERE id = ? AND (confirm_sent_at IS NULL OR confirm_sent_at < datetime('now', ?))"
  ).bind(existing.id, `-${RESEND_COOLDOWN_HOURS} hours`).first("n");
  if (cooledDown > 0) {
    await sendConfirmationEmail(env, workerOrigin, email, existing.token);
    await markConfirmSent(env, existing.id);
  }
  return subscribeReply(isFetch, true);
}

async function markConfirmSent(env, id) {
  await env.DB.prepare(
    "UPDATE subscribers SET confirm_sent_at = datetime('now') WHERE id = ?"
  ).bind(id).run();
}

function subscribeReply(isFetch, ok, message, status) {
  if (isFetch) {
    return corsResponse(
      { ok, message: message || "Check your inbox for a confirmation email." },
      status || 200
    );
  }
  // No-JS fallback: plain form navigation, bounce back to the site.
  const param = ok ? "check-inbox" : "error";
  return Response.redirect(`${SITE}/?signup=${param}`, 302);
}

// --- Confirm / unsubscribe ---

async function handleConfirm(url, env) {
  const token = url.searchParams.get("t") || "";
  if (token) {
    await env.DB.prepare(
      "UPDATE subscribers SET confirmed_at = datetime('now') WHERE token = ? AND confirmed_at IS NULL AND unsubscribed_at IS NULL"
    ).bind(token).run();
  }
  return Response.redirect(`${SITE}/?signup=confirmed`, 302);
}

async function handleUnsubscribe(url, env) {
  const token = url.searchParams.get("t") || "";
  let found = false;
  if (token) {
    const result = await env.DB.prepare(
      "UPDATE subscribers SET unsubscribed_at = datetime('now') WHERE token = ? AND unsubscribed_at IS NULL"
    ).bind(token).run();
    found = result.meta.changes > 0;
  }
  const body = found
    ? "You've been unsubscribed. No further emails will be sent to this address."
    : "This unsubscribe link is invalid or was already used.";
  return new Response(
    `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"><title>Escapement newsletter</title></head><body style="font-family:Georgia,serif;max-width:36rem;margin:4rem auto;padding:0 1rem;"><p>${body}</p><p><a href="${SITE}">escapementgame.com</a></p></body></html>`,
    { status: found ? 200 : 404, headers: { "Content-Type": "text/html; charset=utf-8" } }
  );
}

// --- Email ---

async function sendConfirmationEmail(env, workerOrigin, email, token) {
  const confirmUrl = `${workerOrigin}/confirm?t=${token}`;
  await resendSend(env, email, "Confirm your subscription to the Escapement newsletter", [
    "You requested to join the Escapement development newsletter (escapementgame.com).",
    "",
    `Confirm your subscription: ${confirmUrl}`,
    "",
    "If you didn't request this, ignore this email and you won't be subscribed.",
  ].join("\n"));
}

// Emails the author when the daily send cap trips, at most once per 24 hours.
// Best-effort: an alert failure must never affect the visitor's response.
async function maybeSendCapAlert(env, sentToday) {
  try {
    const recent = await env.DB.prepare(
      "SELECT value FROM meta WHERE key = 'last_cap_alert_at' AND value > datetime('now', '-1 day')"
    ).first("value");
    if (recent) return;
    await resendSend(env, ALERT_TO, "Escapement newsletter: daily signup cap hit", [
      `The signup endpoint hit its cap of ${DAILY_SEND_CAP} confirmation emails in the trailing 24 hours (count: ${sentToday}).`,
      "New signups are being refused with a 'try again tomorrow' message until earlier sends age out of the window.",
      "",
      "If this is a real surge: raise DAILY_SEND_CAP in worker/src/index.js and consider Resend's paid tier",
      "(free tier is 100 emails/day, 3,000/month). Refused attempts appear in GoatCounter as signup-capped events.",
    ].join("\n"));
    await env.DB.prepare(
      "INSERT INTO meta (key, value) VALUES ('last_cap_alert_at', datetime('now')) ON CONFLICT(key) DO UPDATE SET value = datetime('now')"
    ).run();
  } catch (err) {
    console.error("cap alert failed:", err);
  }
}

async function resendSend(env, to, subject, text) {
  const response = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${env.RESEND_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      from: FROM_ADDRESS,
      to: [to],
      reply_to: REPLY_TO,
      subject: subject,
      text: text,
    }),
  });
  if (!response.ok) {
    const detail = await response.text();
    const key = env.RESEND_API_KEY || "";
    console.error(`Resend error ${response.status}: ${detail}`);
    console.error(`key looks like re_...=${key.startsWith("re_")} contains whitespace=${/\s/.test(key)}`);
    console.error(`response headers=${JSON.stringify([...response.headers])}`);
    throw new Error("email failed to send");
  }
}

// --- Helpers ---

function sanitizeRef(value) {
  const ref = (value || "").trim().toLowerCase();
  return /^[a-z0-9_-]{1,32}$/.test(ref) ? ref : null;
}

async function hashIp(ip) {
  const data = new TextEncoder().encode(ip);
  const digest = await crypto.subtle.digest("SHA-256", data);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function corsResponse(body, status) {
  return new Response(body === null ? null : JSON.stringify(body), {
    status,
    headers: {
      "Access-Control-Allow-Origin": SITE,
      "Access-Control-Allow-Methods": "POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type",
      ...(body === null ? {} : { "Content-Type": "application/json; charset=utf-8" }),
    },
  });
}
