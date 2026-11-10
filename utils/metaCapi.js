// ── Meta Conversions API (server-side) ─────────────────────
// Envoie les événements directement du serveur vers Meta.
// Variables d'env requises : META_PIXEL_ID, META_ACCESS_TOKEN
// Optionnel : META_TEST_EVENT_CODE (pour l'onglet "Test events")
const crypto = require("crypto");

const PIXEL_ID = process.env.META_PIXEL_ID || "1523077569645795";
const TOKEN = process.env.META_ACCESS_TOKEN;
const TEST_CODE = process.env.META_TEST_EVENT_CODE;

const sha256 = (v) =>
  v
    ? crypto
        .createHash("sha256")
        .update(String(v).trim().toLowerCase())
        .digest("hex")
    : undefined;

// 0558210430 -> 213558210430 (format attendu par Meta, sans +)
function normalizePhone(p) {
  if (!p) return undefined;
  const d = String(p).replace(/\D/g, "");
  if (d.startsWith("213")) return d;
  if (d.startsWith("0")) return "213" + d.slice(1);
  return d;
}

function clientIp(req) {
  const xff = req.headers["x-forwarded-for"];
  return (xff ? xff.split(",")[0] : req.socket?.remoteAddress || "").trim();
}

async function sendEvent({ eventName, eventId, req, user = {}, custom = {} }) {
  if (!TOKEN) {
    console.warn("[Meta CAPI] META_ACCESS_TOKEN manquant — événement ignoré");
    return;
  }
  try {
    const [first, ...rest] = String(user.name || "")
      .trim()
      .split(/\s+/);
    const payload = {
      data: [
        {
          event_name: eventName,
          event_time: Math.floor(Date.now() / 1000),
          event_id: eventId, // = même ID que le Pixel navigateur (déduplication)
          action_source: "website",
          event_source_url:
            req.headers.referer || process.env.FRONTEND_URL || undefined,
          user_data: {
            client_ip_address: clientIp(req),
            client_user_agent: req.headers["user-agent"],
            fbp: req.cookies?._fbp,
            fbc: req.cookies?._fbc,
            ph: user.phone ? [sha256(normalizePhone(user.phone))] : undefined,
            fn: first ? [sha256(first)] : undefined,
            ln: rest.length ? [sha256(rest.join(" "))] : undefined,
            ct: user.city ? [sha256(user.city.replace(/\s/g, ""))] : undefined,
            country: [sha256("dz")],
          },
          custom_data: custom,
        },
      ],
      ...(TEST_CODE ? { test_event_code: TEST_CODE } : {}),
    };
    const r = await fetch(
      `https://graph.facebook.com/v21.0/${PIXEL_ID}/events?access_token=${TOKEN}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      },
    );
    if (!r.ok) console.error("[Meta CAPI]", r.status, await r.text());
  } catch (e) {
    console.error("[Meta CAPI] erreur:", e.message);
  }
}

module.exports = { sendEvent };
