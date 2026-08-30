// Opened from the link in your notification email.
// GET  -> shows the comment with Approve / Discard buttons (safe: no action taken)
// POST -> performs the chosen action

const env = () => {
  const { SUPABASE_URL, SUPABASE_SERVICE_KEY } = process.env;
  return { SUPABASE_URL, SUPABASE_SERVICE_KEY };
};

const hasSupabase = (e) => Boolean(e.SUPABASE_URL && e.SUPABASE_SERVICE_KEY);

const sbHeaders = (key) => {
  const h = { apikey: key, "Content-Type": "application/json", "User-Agent": "neto-site-server" };
  if (key && !key.startsWith("sb_")) h.Authorization = `Bearer ${key}`;
  return h;
};
const sb = (e, path, opts = {}) =>
  fetch(`${e.SUPABASE_URL}/rest/v1/${path}`, {
    ...opts,
    headers: { ...sbHeaders(e.SUPABASE_SERVICE_KEY), ...(opts.headers || {}) },
  });

const esc = (s) =>
  String(s).replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

const shell = (title, inner) => `<!doctype html><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)}</title>
<body style="font-family:system-ui,sans-serif;background:#F4EFE7;color:#1A1611;margin:0;padding:40px 18px">
<div style="max-width:520px;margin:0 auto;background:#fff;border:1px solid #E5DCCD;border-radius:16px;padding:28px">
<h1 style="font-size:20px;margin:0 0 14px">${esc(title)}</h1>${inner}</div></body>`;

const unavailablePage = (res) =>
  res.status(503).send(shell("Temporarily unavailable", "<p>Comments are temporarily unavailable.</p>"));

export default async function handler(req, res) {
  res.setHeader("Content-Type", "text/html; charset=utf-8");
  try {
    const e = env();
    if (!hasSupabase(e)) {
      console.error("/api/moderate: missing SUPABASE_URL or SUPABASE_SERVICE_KEY");
      return unavailablePage(res);
    }

    const id = (req.query?.id || (req.body && req.body.id) || "").toString();
    const token = (req.query?.token || (req.body && req.body.token) || "").toString();
    if (!id || !token) return res.status(400).send(shell("Invalid link", "<p>This link is missing information.</p>"));

    const r = await sb(e, `comments?id=eq.${id}&select=id,name,body,status,token`);
    if (!r.ok) {
      console.error("/api/moderate: Supabase error", r.status, await r.text().catch(() => ""));
      return unavailablePage(res);
    }
    const rows = await r.json();
    const row = Array.isArray(rows) ? rows[0] : null;
    if (!row || row.token !== token)
      return res.status(403).send(shell("Not available", "<p>This comment no longer exists or the link is invalid.</p>"));

    if (req.method === "POST") {
      const action = (req.body?.action || "").toString();
      if (action === "approve") {
        const patch = await sb(e, `comments?id=eq.${id}`, { method: "PATCH", body: JSON.stringify({ status: "approved", token: null }) });
        if (!patch.ok) {
          console.error("/api/moderate: approve failed", patch.status, await patch.text().catch(() => ""));
          return unavailablePage(res);
        }
        return res.status(200).send(shell("Approved \u2713", "<p>This comment is now live on the page.</p>"));
      }
      if (action === "discard") {
        const del = await sb(e, `comments?id=eq.${id}`, { method: "DELETE" });
        if (!del.ok) {
          console.error("/api/moderate: discard failed", del.status, await del.text().catch(() => ""));
          return unavailablePage(res);
        }
        return res.status(200).send(shell("Discarded", "<p>This comment has been deleted.</p>"));
      }
      return res.status(400).send(shell("Unknown action", "<p>Please go back and try again.</p>"));
    }

    if (row.status === "approved")
      return res.status(200).send(shell("Already approved", "<p>This comment is already live on the page.</p>"));

    const btn = (action, label, color) =>
      `<form method="POST" action="/api/moderate" style="display:inline">
       <input type="hidden" name="id" value="${esc(id)}"><input type="hidden" name="token" value="${esc(token)}">
       <input type="hidden" name="action" value="${action}">
       <button style="background:${color};color:#fff;border:none;padding:12px 22px;border-radius:8px;font-weight:700;font-size:15px;cursor:pointer">${label}</button>
     </form>`;

    return res.status(200).send(shell("Review comment",
      `<p style="color:#6E6456;font-size:13px;margin:0 0 4px">From <strong>${esc(row.name)}</strong></p>
     <blockquote style="border-left:3px solid #C77A2A;margin:0 0 22px;padding:6px 0 6px 14px;white-space:pre-wrap">${esc(row.body)}</blockquote>
     <div style="display:flex;gap:12px">${btn("approve","Approve &amp; publish","#1f7a44")} ${btn("discard","Discard","#9A271F")}</div>`));
  } catch (err) {
    console.error("/api/moderate failed:", err);
    try {
      return unavailablePage(res);
    } catch (sendErr) {
      console.error("/api/moderate: failed to send fallback response:", sendErr);
    }
  }
}
