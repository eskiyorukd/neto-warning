// GET  /api/comments  -> returns approved comments (for the public page)
// POST /api/comments  -> stores a new comment as "pending" and emails you to review it
import crypto from "node:crypto";

const UNAVAILABLE = "Comments are temporarily unavailable.";

const env = () => {
  const { SUPABASE_URL, SUPABASE_SERVICE_KEY, RESEND_API_KEY,
          NOTIFY_EMAIL, FROM_EMAIL, SITE_URL = "" } = process.env;
  return { SUPABASE_URL, SUPABASE_SERVICE_KEY, RESEND_API_KEY, NOTIFY_EMAIL, FROM_EMAIL, SITE_URL };
};

const hasSupabase = (e) => Boolean(e.SUPABASE_URL && e.SUPABASE_SERVICE_KEY);

const sbHeaders = (key) => {
  const h = { apikey: key, "Content-Type": "application/json", "User-Agent": "neto-site-server" };
  // New sb_secret_ keys must NOT send an Authorization header (they aren't JWTs).
  // Legacy service_role JWT keys still need one — support both.
  if (key && !key.startsWith("sb_")) h.Authorization = `Bearer ${key}`;
  return h;
};
const sb = (e, path, opts = {}) =>
  fetch(`${e.SUPABASE_URL}/rest/v1/${path}`, {
    ...opts,
    headers: { ...sbHeaders(e.SUPABASE_SERVICE_KEY), ...(opts.headers || {}) },
  });

const escapeHtml = (s) =>
  String(s).replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

const sendGetEmpty = (res) => {
  res.setHeader("Cache-Control", "s-maxage=30, stale-while-revalidate=300");
  return res.status(200).json([]);
};

const sendUnavailable = (res) => res.status(503).json({ error: UNAVAILABLE });

export default async function handler(req, res) {
  try {
    const e = env();

    if (req.method === "GET") {
      try {
        if (!hasSupabase(e)) {
          console.error("GET /api/comments: missing SUPABASE_URL or SUPABASE_SERVICE_KEY");
          return sendGetEmpty(res);
        }
        const r = await sb(e, "comments?status=eq.approved&select=name,body,created_at&order=created_at.desc");
        if (!r.ok) {
          console.error("GET /api/comments: Supabase error", r.status, await r.text().catch(() => ""));
          return sendGetEmpty(res);
        }
        const data = await r.json();
        res.setHeader("Cache-Control", "s-maxage=30, stale-while-revalidate=300");
        return res.status(200).json(Array.isArray(data) ? data : []);
      } catch (err) {
        console.error("GET /api/comments failed:", err);
        return sendGetEmpty(res);
      }
    }

    if (req.method === "POST") {
      try {
        if (!hasSupabase(e)) {
          console.error("POST /api/comments: missing SUPABASE_URL or SUPABASE_SERVICE_KEY");
          return sendUnavailable(res);
        }
        const { name, body } = req.body || {};
        const text = (body || "").toString().trim();
        if (!text) return res.status(400).json({ error: "Comment is empty." });
        if (text.length > 1500) return res.status(400).json({ error: "Comment too long." });
        const cleanName = ((name || "").toString().trim().slice(0, 60)) || "Anonymous";
        const token = crypto.randomBytes(24).toString("hex");

        const ins = await sb(e, "comments", {
          method: "POST",
          headers: { Prefer: "return=representation" },
          body: JSON.stringify({ name: cleanName, body: text, status: "pending", token }),
        });
        if (!ins.ok) {
          console.error("POST /api/comments: Supabase error", ins.status, await ins.text().catch(() => ""));
          return sendUnavailable(res);
        }
        const rows = await ins.json();
        const row = Array.isArray(rows) ? rows[0] : null;

        if (e.RESEND_API_KEY && e.NOTIFY_EMAIL && e.FROM_EMAIL && row) {
          const reviewUrl = `${e.SITE_URL}/api/moderate?id=${row.id}&token=${token}`;
          await fetch("https://api.resend.com/emails", {
            method: "POST",
            headers: { Authorization: `Bearer ${e.RESEND_API_KEY}`, "Content-Type": "application/json" },
            body: JSON.stringify({
              from: e.FROM_EMAIL,
              to: e.NOTIFY_EMAIL,
              subject: `New comment pending review — ${cleanName}`,
              html: `<p style="font-family:sans-serif"><strong>${escapeHtml(cleanName)}</strong> submitted a comment on your Neto Flooring page:</p>
<blockquote style="font-family:sans-serif;border-left:3px solid #ccc;margin:0 0 16px;padding:4px 0 4px 14px;color:#333">${escapeHtml(text)}</blockquote>
<p style="font-family:sans-serif"><a href="${reviewUrl}" style="display:inline-block;background:#9A271F;color:#fff;padding:11px 20px;border-radius:8px;text-decoration:none;font-weight:700">Review this comment</a></p>
<p style="font-family:sans-serif;color:#888;font-size:12px">Nothing is published until you approve it.</p>`,
            }),
          }).catch((err) => { console.error("POST /api/comments: notify email failed:", err); });
        }
        return res.status(200).json({ ok: true });
      } catch (err) {
        console.error("POST /api/comments failed:", err);
        return sendUnavailable(res);
      }
    }

    res.setHeader("Allow", "GET, POST");
    return res.status(405).end();
  } catch (err) {
    console.error("/api/comments handler failed:", err);
    try {
      if (req.method === "GET") return sendGetEmpty(res);
      return sendUnavailable(res);
    } catch (sendErr) {
      console.error("/api/comments: failed to send fallback response:", sendErr);
    }
  }
}
