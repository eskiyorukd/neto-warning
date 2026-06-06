// GET  /api/comments  -> returns approved comments (for the public page)
// POST /api/comments  -> stores a new comment as "pending" and emails you to review it
import crypto from "node:crypto";

const { SUPABASE_URL, SUPABASE_SERVICE_KEY, RESEND_API_KEY,
        NOTIFY_EMAIL, FROM_EMAIL, SITE_URL = "" } = process.env;

const sbHeaders = () => {
  const h = { apikey: SUPABASE_SERVICE_KEY, "Content-Type": "application/json", "User-Agent": "neto-site-server" };
  // New sb_secret_ keys must NOT send an Authorization header (they aren't JWTs).
  // Legacy service_role JWT keys still need one — support both.
  if (SUPABASE_SERVICE_KEY && !SUPABASE_SERVICE_KEY.startsWith("sb_")) h.Authorization = `Bearer ${SUPABASE_SERVICE_KEY}`;
  return h;
};
const sb = (path, opts = {}) =>
  fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    ...opts,
    headers: { ...sbHeaders(), ...(opts.headers || {}) },
  });

const escapeHtml = (s) =>
  String(s).replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

export default async function handler(req, res) {
  if (req.method === "GET") {
    const r = await sb("comments?status=eq.approved&select=name,body,created_at&order=created_at.desc");
    const data = await r.json();
    res.setHeader("Cache-Control", "s-maxage=30, stale-while-revalidate=300");
    return res.status(200).json(Array.isArray(data) ? data : []);
  }

  if (req.method === "POST") {
    const { name, body } = req.body || {};
    const text = (body || "").toString().trim();
    if (!text) return res.status(400).json({ error: "Comment is empty." });
    if (text.length > 1500) return res.status(400).json({ error: "Comment too long." });
    const cleanName = ((name || "").toString().trim().slice(0, 60)) || "Anonymous";
    const token = crypto.randomBytes(24).toString("hex");

    const ins = await sb("comments", {
      method: "POST",
      headers: { Prefer: "return=representation" },
      body: JSON.stringify({ name: cleanName, body: text, status: "pending", token }),
    });
    const rows = await ins.json();
    const row = Array.isArray(rows) ? rows[0] : null;

    if (RESEND_API_KEY && NOTIFY_EMAIL && FROM_EMAIL && row) {
      const reviewUrl = `${SITE_URL}/api/moderate?id=${row.id}&token=${token}`;
      await fetch("https://api.resend.com/emails", {
        method: "POST",
        headers: { Authorization: `Bearer ${RESEND_API_KEY}`, "Content-Type": "application/json" },
        body: JSON.stringify({
          from: FROM_EMAIL,
          to: NOTIFY_EMAIL,
          subject: `New comment pending review — ${cleanName}`,
          html: `<p style="font-family:sans-serif"><strong>${escapeHtml(cleanName)}</strong> submitted a comment on your Neto Flooring page:</p>
<blockquote style="font-family:sans-serif;border-left:3px solid #ccc;margin:0 0 16px;padding:4px 0 4px 14px;color:#333">${escapeHtml(text)}</blockquote>
<p style="font-family:sans-serif"><a href="${reviewUrl}" style="display:inline-block;background:#9A271F;color:#fff;padding:11px 20px;border-radius:8px;text-decoration:none;font-weight:700">Review this comment</a></p>
<p style="font-family:sans-serif;color:#888;font-size:12px">Nothing is published until you approve it.</p>`,
        }),
      }).catch(() => {});
    }
    return res.status(200).json({ ok: true });
  }

  res.setHeader("Allow", "GET, POST");
  return res.status(405).end();
}
